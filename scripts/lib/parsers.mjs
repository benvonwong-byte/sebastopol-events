// Parsers for the non-ICS formats org websites expose. Each returns raw
// instances: { title, startMs, endMs, allDay, url, location, description,
// lat, lng, image } and leaves filtering to the caller.

import { parseIcs, stripHtml } from "./ics.mjs";
import { parseLooseDate } from "./time.mjs";

const clip = (s, n = 400) => {
  const t = stripHtml(s ?? "");
  return t ? (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t) : null;
};

// Squarespace: <events page>?format=json gives { upcoming: [...] } or { items: [...] }
export function parseSquarespace(text, src) {
  const data = JSON.parse(text);
  const origin = new URL(src.url).origin;
  const items = data.upcoming ?? data.items ?? [];
  return items
    .filter((i) => i.startDate)
    .map((i) => {
      const loc = i.location ?? {};
      const address = [loc.addressTitle, loc.addressLine1, loc.addressLine2].filter(Boolean).join(", ");
      const hasPin = loc.markerLat && loc.markerLng && !(loc.markerLat === 40.7207559 && loc.markerLng === -74.0007613);
      return {
        title: i.title,
        startMs: i.startDate,
        endMs: i.endDate ?? null,
        allDay: false,
        url: i.fullUrl ? origin + i.fullUrl : src.url.replace(/\?.*$/, ""),
        location: address || null,
        description: clip(i.excerpt || i.body),
        lat: hasPin ? loc.markerLat : null,
        lng: hasPin ? loc.markerLng : null,
        image: i.assetUrl || null,
      };
    });
}

// WordPress "The Events Calendar" REST: /wp-json/tribe/events/v1/events
export function parseTribe(text, src) {
  const data = JSON.parse(text);
  return (data.events ?? []).map((e) => {
    const v = e.venue && !Array.isArray(e.venue) ? e.venue : {};
    const address = [v.venue, v.address, v.city, v.zip].filter(Boolean).join(", ");
    const tz = e.timezone || undefined;
    return {
      title: stripHtml(e.title),
      startMs: e.utc_start_date ? Date.parse(e.utc_start_date.replace(" ", "T") + "Z") : parseLooseDate(e.start_date, tz),
      endMs: e.utc_end_date ? Date.parse(e.utc_end_date.replace(" ", "T") + "Z") : parseLooseDate(e.end_date, tz),
      allDay: !!e.all_day,
      url: e.url || src.url,
      location: address || null,
      description: clip(e.excerpt || e.description),
      lat: v.geo_lat ? Number(v.geo_lat) : null,
      lng: v.geo_lng ? Number(v.geo_lng) : null,
      image: e.image?.url || null,
      organizer: stripHtml([].concat(e.organizer ?? [])[0]?.organizer ?? "") || null,
    };
  });
}

// Mobilize public API: /v1/organizations/<id>/events
export function parseMobilize(text) {
  const data = JSON.parse(text);
  const out = [];
  for (const e of data.data ?? []) {
    const loc = e.location ?? {};
    const address = [loc.venue, (loc.address_lines ?? []).filter(Boolean).join(", "), loc.locality, loc.postal_code]
      .filter(Boolean)
      .join(", ");
    for (const slot of e.timeslots ?? []) {
      out.push({
        title: e.title,
        startMs: slot.start_date * 1000,
        endMs: slot.end_date ? slot.end_date * 1000 : null,
        allDay: false,
        url: e.browser_url,
        location: e.is_virtual ? "Online" : address || null,
        description: clip(e.summary || e.description),
        lat: loc.location?.latitude ?? null,
        lng: loc.location?.longitude ?? null,
        image: e.featured_image_url || null,
        organizer: e.sponsor?.name ?? null,
      });
    }
  }
  return out;
}

// RSS where pubDate is the event date (some WordPress event plugins do this).
export function parseRssFuture(text, src) {
  const out = [];
  for (const item of text.split("<item>").slice(1)) {
    const pick = (tag) =>
      item.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`))?.[1]?.trim();
    const title = pick("title");
    const link = pick("link");
    const when = pick("ev:startdate") || pick("event:startdate") || pick("pubDate");
    if (!title || !when) continue;
    const t = parseLooseDate(when);
    if (!t) continue;
    out.push({
      title: stripHtml(title),
      startMs: t,
      endMs: null,
      allDay: false,
      url: link || src.url,
      location: pick("ev:location") || null,
      description: clip(pick("description")),
      lat: null,
      lng: null,
      image: null,
    });
  }
  return out;
}

// JSON-LD Event objects embedded in an HTML page.
export function parseJsonLd(html, src) {
  const out = [];
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = [].concat(node["@type"] ?? []).join(" ");
    if (/Event\b/.test(type) && node.startDate) {
      const place = [].concat(node.location ?? [])[0] ?? {};
      const addr = place.address;
      const address =
        typeof addr === "string"
          ? addr
          : addr
            ? [addr.streetAddress, addr.addressLocality, addr.postalCode].filter(Boolean).join(", ")
            : null;
      const geo = place.geo ?? {};
      out.push({
        title: stripHtml(node.name),
        startMs: parseLooseDate(node.startDate),
        endMs: parseLooseDate(node.endDate),
        allDay: /^\d{4}-\d{2}-\d{2}$/.test(String(node.startDate)),
        url: node.url || src.url,
        location: [place.name, address].filter(Boolean).join(", ") || null,
        description: clip(node.description),
        lat: geo.latitude != null ? Number(geo.latitude) : null,
        lng: geo.longitude != null ? Number(geo.longitude) : null,
        image: [].concat(node.image ?? [])[0]?.url ?? [].concat(node.image ?? [])[0] ?? null,
        organizer: [].concat(node.organizer ?? [])[0]?.name ?? null,
      });
    }
    for (const k of ["@graph", "itemListElement", "item", "event", "events", "subEvent"]) if (node[k]) visit(node[k]);
  };
  for (const b of blocks) {
    const json = b.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try {
      visit(JSON.parse(json));
    } catch {
      /* malformed block, skip */
    }
  }
  return out.filter((e) => e.startMs);
}

// Eventbrite organizer pages (eventbrite.com/o/...) list upcoming events in
// the page's Next.js data, props.pageProps.upcomingEvents, with local dates,
// times and a venue address. Falls back to any JSON-LD on the page.
export function parseEventbriteOrganizer(html, src) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let list = [];
  try {
    list = JSON.parse(m?.[1] ?? "{}")?.props?.pageProps?.upcomingEvents ?? [];
  } catch {
    list = [];
  }
  if (!list.length) return parseJsonLd(html, src);
  const out = [];
  for (const e of list) {
    if (!e?.name || !e.start_date || e.is_cancelled) continue;
    const tz = e.timezone || undefined;
    const v = e.primary_venue ?? {};
    const a = v.address ?? {};
    const address = a.localized_address_display ?? [a.address_1, a.city, a.postal_code].filter(Boolean).join(", ");
    out.push({
      title: stripHtml(e.name),
      startMs: parseLooseDate(e.start_time ? `${e.start_date}T${e.start_time}` : e.start_date, tz),
      endMs: e.end_date && e.end_time ? parseLooseDate(`${e.end_date}T${e.end_time}`, tz) : null,
      allDay: !e.start_time,
      url: e.url || src.url,
      location: e.is_online_event ? "Online" : [v.name, address].filter(Boolean).join(", ") || null,
      description: clip(e.summary),
      lat: a.latitude != null ? Number(a.latitude) : null,
      lng: a.longitude != null ? Number(a.longitude) : null,
      image: e.image?.url ?? null,
      organizer: null,
      uid: e.id ? `eventbrite-${e.id}` : undefined,
    });
  }
  return out.filter((e) => e.startMs);
}

// Mahina, a Shopify events app (Black Bird Bookstore, Sealevel): POST {}
// returns { events: [...] } with UTC times and no per-event URL.
export function parseMahina(text, src) {
  const out = [];
  for (const e of JSON.parse(text).events ?? []) {
    const sessions = (e.sessions ?? []).filter((s) => s?.startDate);
    for (const s of sessions.length ? sessions : [e]) {
      const online = e.location?.medium === "online";
      out.push({
        title: stripHtml(e.title),
        startMs: Date.parse(s.startDate),
        endMs: s.endDate ? Date.parse(s.endDate) : null,
        allDay: false,
        url: src.page ? `${src.page}#?event-id=${e.id}` : src.url,
        location: online ? "Online" : e.location?.name || null,
        description: clip(e.description),
        lat: null,
        lng: null,
        image: e.image || null,
        free: e.tickets?.priceType === "free" ? true : null,
      });
    }
  }
  return out;
}

// FullCalendar-style JSON: [{ title, start, end, allDay, url, location }].
// `naiveLocal` reads the times as Pacific wall-clock even when the feed
// stamps them +00:00 (the SF Zoo does).
export function parseFullCalendar(text, src) {
  const list = JSON.parse(text);
  const when = (v) => (v && src.naiveLocal ? parseLooseDate(String(v).replace(/([+-]\d{2}:?\d{2}|Z)$/, "")) : parseLooseDate(v));
  return (Array.isArray(list) ? list : list.events ?? []).map((e) => ({
    title: stripHtml(e.title),
    startMs: when(e.start),
    endMs: when(e.end),
    allDay: !!e.allDay,
    url: e.url || src.url,
    location: e.location ? stripHtml(e.location) : null,
    description: clip(e.content || e.description),
    lat: null,
    lng: null,
    image: e.featured_image || e.image || null,
  }));
}

export function parseByFormat(format, text, src, window) {
  switch (format) {
    case "ics":
    case "luma":
    case "meetup":
    case "tockify":
    case "civicplus":
      return parseIcs(text, window);
    case "squarespace":
      return parseSquarespace(text, src);
    case "tribe":
      // A tribe feed may be the REST endpoint or the ?ical=1 export.
      return text.trimStart().startsWith("BEGIN:VCALENDAR") ? parseIcs(text, window) : parseTribe(text, src);
    case "mobilize":
      return parseMobilize(text, src);
    case "rss":
    case "rss-future":
      return parseRssFuture(text, src);
    case "jsonld":
      return parseJsonLd(text, src);
    case "eventbrite":
      return parseEventbriteOrganizer(text, src);
    case "mahina":
      return parseMahina(text, src);
    case "fullcalendar":
      return parseFullCalendar(text, src);
    default:
      if (text.trimStart().startsWith("BEGIN:VCALENDAR")) return parseIcs(text, window);
      throw new Error(`no parser for format "${format}"`);
  }
}
