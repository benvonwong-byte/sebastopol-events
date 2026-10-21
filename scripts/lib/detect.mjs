// Turn whatever link someone pastes into a feed the fetcher can read.
//
// detectSource(url) returns { format, url, kind, note } or throws with a
// plain-language reason. It recognizes, in order:
//   Luma calendar pages        luma.com/<slug>, lu.ma/<slug>  -> the calendar's ICS
//   Google Calendar            embed, share, cid or ical links -> public basic.ics
//   Meetup groups              meetup.com/<group>              -> the group's ICS
//   Mobilize organizations     mobilize.us/<org>               -> the public API
//   Tockify calendars          tockify.com/<name>              -> its ICS
//   Eventbrite organizers      eventbrite.com/o/<name>-<id>    -> the page's event markup
//   webcal:// and .ics links                                    -> ICS
//   RSS and Atom feeds                                          -> rss
//   WordPress "The Events Calendar" sites                       -> REST API
//   Squarespace events pages                                    -> ?format=json
//   any page with schema.org Event markup                       -> jsonld
// Every guess is confirmed by fetching it, so a detected source is one the
// fetcher has already read once.

import { get, UA } from "./http.mjs";

const ok = (format, url, kind, note) => ({ format, url, kind, note });

async function tryGet(url, accept) {
  try {
    return await get(url, { accept, timeout: 20000 });
  } catch {
    return null;
  }
}

function googleCalendarId(u) {
  const src = u.searchParams.get("src") || u.searchParams.get("cid");
  if (src) {
    try {
      // cid links are base64 of the calendar id
      return /@|%40/.test(src) ? decodeURIComponent(src) : Buffer.from(src, "base64").toString("utf8");
    } catch {
      return src;
    }
  }
  const m = u.pathname.match(/\/calendar\/ical\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]) : null;
}

export async function detectSource(raw) {
  let input = String(raw ?? "").trim();
  if (!input) throw new Error("Paste a link first.");
  if (/^webcals?:\/\//i.test(input)) input = input.replace(/^webcals?:/i, "https:");
  if (!/^https?:\/\//i.test(input)) input = "https://" + input;
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error("That does not look like a web address.");
  }
  const host = u.hostname.replace(/^www\./, "");

  // Luma: the calendar page names its id (cal-...) in the HTML.
  if (/^(lu\.ma|luma\.com)$/.test(host)) {
    if (/^\/ics\//.test(u.pathname) || u.searchParams.get("entity") === "calendar") return ok("luma", u.href, "Luma calendar");
    const html = await tryGet(u.href, "text/html");
    const id = html?.match(/"(cal-[A-Za-z0-9]{10,})"/)?.[1];
    if (!id) throw new Error("That Luma page is not a calendar. Paste the link to the calendar page, not a single event.");
    return ok("luma", `https://api.lu.ma/ics/get?entity=calendar&id=${id}`, "Luma calendar");
  }

  // Google Calendar: embed, share (cid) or ical links all name the calendar id.
  if (host === "calendar.google.com") {
    const id = googleCalendarId(u);
    if (!id) throw new Error("That Google Calendar link does not name a calendar. In Google Calendar, open the calendar's settings and copy its public address.");
    if (/@gmail\.com$/i.test(id)) throw new Error("That is a personal Google Calendar. Make a separate calendar for the group's public events and paste that one: see the guide.");
    return ok("ics", `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`, "Google Calendar");
  }

  // Meetup group
  if (host === "meetup.com") {
    const group = u.pathname.split("/").filter(Boolean)[0];
    if (!group) throw new Error("Paste the Meetup group's page, for example meetup.com/your-group.");
    return ok("meetup", `https://www.meetup.com/${group}/events/ical/`, "Meetup group");
  }

  // Mobilize organization page: mobilize.us/<slug>/ -> organization id via the API
  if (host === "mobilize.us" && !/^\/api\//.test(u.pathname)) {
    const slug = u.pathname.split("/").filter(Boolean)[0];
    const html = slug ? await tryGet(`https://www.mobilize.us/${slug}/`, "text/html") : null;
    const id = html?.match(/"organization_id"\s*:\s*(\d+)|organizations\/(\d+)/);
    if (!id) throw new Error("Could not find that Mobilize organization.");
    return ok("mobilize", `https://api.mobilize.us/v1/organizations/${id[1] ?? id[2]}/events`, "Mobilize organization");
  }
  if (host === "api.mobilize.us") return ok("mobilize", u.href, "Mobilize organization");

  // Tockify
  if (host === "tockify.com") {
    const name = u.pathname.split("/").filter(Boolean).pop();
    return ok("tockify", `https://tockify.com/api/feeds/ics/${name}`, "Tockify calendar");
  }

  // Eventbrite organizer page. Eventbrite turns away most cloud servers, so
  // this one is not fetched here; scripts/intake.mjs says so in its reply.
  if (/(^|\.)eventbrite\.[a-z.]+$/.test(host)) {
    if (!/^\/o\//.test(u.pathname)) throw new Error("That is one Eventbrite event. Paste the organizer's page instead: open the event, click the organizer's name, and copy that address (it has /o/ in it).");
    return ok("eventbrite", `https://www.eventbrite.com${u.pathname.replace(/\/$/, "")}`, "Eventbrite organizer page");
  }

  // Direct ICS
  if (/\.ics($|\?)/i.test(u.pathname + u.search) || /[?&]ical=1\b/.test(u.search)) return ok("ics", u.href, "Calendar file (.ics)");

  // Fetch the page once and look at what it is.
  const body = await tryGet(u.href, "text/html,application/xhtml+xml,application/xml,text/calendar,*/*");
  if (body == null) throw new Error("That address did not load. Check it opens in a browser, and that it is public.");
  const head = body.trimStart().slice(0, 400);
  if (head.startsWith("BEGIN:VCALENDAR")) return ok("ics", u.href, "Calendar file (.ics)");
  if (/^<\?xml|<rss[\s>]|<feed[\s>]/i.test(head)) return ok("rss", u.href, "RSS feed");

  // A page that advertises its own calendar or feed
  const icsLink = body.match(/href=["']((?:webcal|https?):\/\/[^"']+\.ics[^"']*)["']/i)?.[1] ?? body.match(/href=["']([^"']*\?ical=1)["']/i)?.[1];
  if (icsLink) return ok("ics", new URL(icsLink.replace(/^webcal:/i, "https:"), u.href).href, "Calendar file (.ics) linked from the page");
  const embed = body.match(/calendar\.google\.com\/calendar\/(?:embed\?[^"']*src=|ical\/)([^"'&/]+)/i)?.[1];
  if (embed) {
    const id = decodeURIComponent(embed);
    if (/@gmail\.com$/i.test(id)) throw new Error("The calendar on that page is a personal Google Calendar. Make a separate calendar for the group's public events and paste that one: see the guide.");
    return ok("ics", `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`, "Google Calendar embedded on the page");
  }
  const lumaId = body.match(/(?:lu\.ma|luma\.com)\/embed\/calendar\/(cal-[A-Za-z0-9]{10,})/)?.[1];
  if (lumaId) return ok("luma", `https://api.lu.ma/ics/get?entity=calendar&id=${lumaId}`, "Luma calendar embedded on the page");

  // WordPress with The Events Calendar
  if (/tribe-events|wp-content\/plugins\/the-events-calendar/i.test(body)) {
    const api = `${u.origin}/wp-json/tribe/events/v1/events`;
    if (await tryGet(api, "application/json")) return ok("tribe", api, "WordPress events calendar");
  }

  // Squarespace events page
  if (/squarespace/i.test(body)) {
    const json = await tryGet(`${u.origin}${u.pathname}?format=json`, "application/json");
    if (json && /"(upcoming|items)"/.test(json)) return ok("squarespace", `${u.origin}${u.pathname}?format=json`, "Squarespace events page");
  }

  const rss = body.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]+href=["']([^"']+)["']/i)?.[1];
  if (/"@type"\s*:\s*"(?:\w+)?Event"/.test(body)) return ok("jsonld", u.href, "Events marked up on the page");
  if (rss) return ok("rss", new URL(rss, u.href).href, "RSS feed linked from the page");

  throw new Error(
    "We could not find a calendar on that page. If the group lists events only as text or images, a free Luma or Google Calendar fixes that: see the guide."
  );
}

export { UA };
