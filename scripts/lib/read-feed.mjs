// Fetch and parse one feed, shared by the morning fetch (scripts/fetch-events.mjs)
// and the submission checker (scripts/intake.mjs).

import { get, sleep, UA } from "./http.mjs";
import { parseByFormat } from "./parsers.mjs";

// Fetch and parse one feed. Most are one GET; a few need more:
//   tribe (WordPress REST)  follows next_rest_url until past the horizon, and
//                            falls back to the site's ?ical=1 export when the
//                            REST endpoint answers with a block page
//   mobilize                 follows `next`, 100 events a page
//   mahina                   is a POST
//   any format with `follow` crawls the links on the page that match the
//                            regex (a listing page whose events each have
//                            their own page) and parses each one
const JSON_FORMATS = new Set(["squarespace", "tribe", "mobilize", "fullcalendar", "mahina"]);

export async function readFeed(feed, window) {
  const accept = JSON_FORMATS.has(feed.format) ? "application/json" : "*/*";
  if (feed.format === "tribe" && /wp-json\/tribe/.test(feed.url)) {
    try {
      return await readTribeRest(feed, window, accept);
    } catch (err) {
      // Some hosts send datacenter IPs a block page in place of the JSON
      // while still serving the calendar export. Try that before failing.
      const ics = `${new URL(feed.url).origin}/events/?ical=1`;
      let text = null;
      try {
        text = await get(ics, { accept: "text/calendar,*/*" });
      } catch {
        text = null;
      }
      if (text?.trimStart().startsWith("BEGIN:VCALENDAR")) return parseByFormat("ics", text, { ...feed, url: ics }, window);
      throw err;
    }
  }
  if (feed.format === "mobilize") return readMobilize(feed, window, accept);
  if (feed.format === "mahina") return readMahina(feed, window, accept);
  return readPage(feed, window, accept);
}

async function readTribeRest(feed, window, accept) {
  const { from, to } = window;
  const url = new URL(feed.url);
  if (!url.searchParams.has("per_page")) url.searchParams.set("per_page", "50");
  if (!url.searchParams.has("start_date")) url.searchParams.set("start_date", new Date(from).toISOString().slice(0, 10));
  const events = [];
  let next = url.href;
  for (let page = 0; next && page < 20; page++) {
    const data = JSON.parse(await get(next, { accept }));
    events.push(...(data.events ?? []));
    const last = data.events?.at(-1);
    if (!last || Date.parse(last.utc_start_date?.replace(" ", "T") + "Z") > to) break;
    next = data.next_rest_url ?? null;
    await sleep(200);
  }
  return parseByFormat("tribe", JSON.stringify({ events }), feed, window);
}

async function readMobilize(feed, window, accept) {
  const url = new URL(feed.url);
  url.searchParams.set("per_page", "100");
  if (!url.searchParams.has("timeslot_start")) url.searchParams.set("timeslot_start", "gte_now");
  const data = [];
  let next = url.href;
  for (let page = 0; next && page < 10; page++) {
    const body = JSON.parse(await get(next, { accept }));
    data.push(...(body.data ?? []));
    next = body.next ?? null;
    await sleep(200);
  }
  return parseByFormat("mobilize", JSON.stringify({ data }), feed, window);
}

async function readMahina(feed, window, accept) {
  const res = await fetch(feed.url, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json", Accept: accept },
    body: "{}",
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseByFormat("mahina", await res.text(), feed, window);
}

async function readPage(feed, window, accept) {
  const text = await get(feed.url, { accept });
  if (!feed.follow) return parseByFormat(feed.format, text, feed, window);
  const re = new RegExp(feed.follow);
  const links = [...new Set([...text.matchAll(/href="([^"#]+)"/g)].map((m) => new URL(m[1], feed.url).href))]
    .filter((u) => re.test(u))
    .slice(0, 15);
  const out = [];
  for (const link of links) {
    try {
      out.push(...parseByFormat(feed.format, await get(link), { ...feed, url: link }, window));
    } catch (err) {
      console.warn(`fetch-events: ${link} failed (${err.message})`);
    }
    await sleep(300);
  }
  return out;
}
