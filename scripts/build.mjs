#!/usr/bin/env node
// Assembles dist/ for GitHub Pages: the static site, the public data files,
// the two rings for the map (data/geo.json), subscribable calendar feeds
// (everything, Sebastopol only, and one per category), an RSS feed and a
// JSON Feed of the same listings for other sites and tools, and JSON-LD for
// the next fifty events.
//
// SITE_URL is the address the site is served from (canonical links, share
// card, calendar links). INDEX=1 lets search engines index it; until then it
// ships with noindex.

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { AREAS, CENTER, RADIUS_KM, CORE_OUTLINE, CORE_HOLES, TOWNS } from "./lib/geo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const BASE = (process.env.SITE_URL || "https://benvonwong-byte.github.io/sebastopol-events/").replace(/\/*$/, "/");
const HOST = new URL(BASE).host;
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const events = existsSync(join(ROOT, "data/events.json"))
  ? read("data/events.json")
  : { fetchedAt: null, horizonDays: 60, sources: [], events: [] };
const orgs = read("data/orgs.json");
const domains = read("data/domains.json");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "data"), { recursive: true });
cpSync(join(ROOT, "site"), DIST, { recursive: true });

// --- Public data ---------------------------------------------------------
const publicOrgs = orgs.map(({ evidence, notes, ...o }) => ({
  ...o,
  feeds: (o.feeds ?? []).filter((f) => !f.disabled).map(({ format, url }) => ({ format, url })),
}));
writeFileSync(join(DIST, "data/events.json"), JSON.stringify(events));
writeFileSync(join(DIST, "data/orgs.json"), JSON.stringify(publicOrgs));
writeFileSync(join(DIST, "data/domains.json"), JSON.stringify(domains));
writeFileSync(
  join(DIST, "data/geo.json"),
  JSON.stringify({ areas: AREAS, center: CENTER, radiusKm: RADIUS_KM, core: { outer: CORE_OUTLINE, holes: CORE_HOLES }, towns: TOWNS })
);

// --- Calendar feeds ------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const utc = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const dateOnly = (day, plus = 0) =>
  new Date(Date.parse(day + "T12:00:00Z") + plus * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (parts.length ? 74 : 75), bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return parts.join("\r\n ");
}
const domainLabel = Object.fromEntries(domains.map((d) => [d.id, d.label]));
const stamp = utc(events.fetchedAt ?? new Date().toISOString());
const whereOf = (e) =>
  e.venue && e.address?.toLowerCase().startsWith(e.venue.toLowerCase()) ? e.address : [e.venue, e.address].filter(Boolean).join(", ");

function ics(list, name) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sebastopol Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    "X-WR-TIMEZONE:America/Los_Angeles",
    `X-WR-CALDESC:${esc("Public events in and around Sebastopol, California, rebuilt every morning. " + BASE)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  for (const e of list) {
    const end = e.end ?? new Date(Date.parse(e.start) + 3600000).toISOString();
    const desc = [e.org ? `Hosted by ${e.org}.` : "", e.url ?? "", e.description ?? "", `${BASE}#view=events&event=${e.id}`]
      .filter(Boolean)
      .join("\n\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@${HOST}`,
      `DTSTAMP:${stamp}`,
      e.allDay ? `DTSTART;VALUE=DATE:${dateOnly(e.day)}` : `DTSTART:${utc(e.start)}`,
      e.allDay ? `DTEND;VALUE=DATE:${dateOnly(e.day, 1)}` : `DTEND:${utc(end)}`,
      `SUMMARY:${esc(e.title)}`,
      `LOCATION:${esc(whereOf(e))}`,
      ...(e.url && /^https?:\/\//.test(e.url) ? [`URL:${e.url}`] : []),
      `CATEGORIES:${esc(domainLabel[e.domain] ?? "")}`,
      `DESCRIPTION:${esc(desc)}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
writeFileSync(join(DIST, "events.ics"), ics(events.events, "Sebastopol and nearby"));
writeFileSync(join(DIST, "events-sebastopol.ics"), ics(events.events.filter((e) => e.area === "sebastopol"), "Sebastopol"));
for (const d of domains) {
  writeFileSync(join(DIST, `events-${d.id}.ics`), ics(events.events.filter((e) => e.domain === d.id), `Sebastopol and nearby: ${d.label}`));
}

// --- RSS and JSON Feed -----------------------------------------------------
// The same listings for newsletters, other calendars and scrapers. One item
// per event, dated by when it starts, with the place and the ring it is in.
const xml = (s) => String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const ptDay = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
const ptTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
const whenOf = (e) => `${ptDay.format(new Date(e.start))}${e.allDay ? "" : ", " + ptTime.format(new Date(e.start)).replace(":00", "").toLowerCase()}`;
const ringOf = (e) => (e.area === "sebastopol" ? "Sebastopol" : e.area === "nearby" ? `Nearby${e.town && e.town !== "Sebastopol" ? `, ${e.town}` : ""}` : "West Sonoma County");
const pageOf = (e) => `${BASE}#view=events&event=${e.id}`;
const summaryOf = (e) =>
  [`${whenOf(e)}. ${e.online ? "Online" : whereOf(e) || ringOf(e)} (${ringOf(e)}).`, e.org ? `Hosted by ${e.org}.` : "", e.description ?? ""]
    .filter(Boolean)
    .join("\n\n");

const rss = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`,
  `<channel>`,
  `<title>Sebastopol Events</title>`,
  `<link>${xml(BASE)}</link>`,
  `<atom:link href="${xml(BASE)}events.rss" rel="self" type="application/rss+xml"/>`,
  `<description>Public events in Sebastopol, California, and the towns within about 22 km, rebuilt every morning.</description>`,
  `<language>en-us</language>`,
  `<ttl>360</ttl>`,
  `<lastBuildDate>${new Date(events.fetchedAt ?? Date.now()).toUTCString()}</lastBuildDate>`,
  ...events.events.map((e) =>
    [
      `<item>`,
      `<title>${xml(`${whenOf(e)}: ${e.title}`)}</title>`,
      `<link>${xml(e.url && /^https?:\/\//.test(e.url) ? e.url : pageOf(e))}</link>`,
      `<guid isPermaLink="false">${xml(`${e.id}@${HOST}`)}</guid>`,
      `<pubDate>${new Date(e.start).toUTCString()}</pubDate>`,
      ...(domainLabel[e.domain] ? [`<category>${xml(domainLabel[e.domain])}</category>`] : []),
      `<category>${xml(ringOf(e))}</category>`,
      `<description>${xml(summaryOf(e))}</description>`,
      `</item>`,
    ].join("")
  ),
  `</channel>`,
  `</rss>`,
].join("\n");
writeFileSync(join(DIST, "events.rss"), rss + "\n");

writeFileSync(
  join(DIST, "feed.json"),
  JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title: "Sebastopol Events",
    home_page_url: BASE,
    feed_url: `${BASE}feed.json`,
    description: "Public events in Sebastopol, California, and the towns within about 22 km, rebuilt every morning.",
    language: "en-US",
    items: events.events.map((e) => ({
      id: `${e.id}@${HOST}`,
      url: pageOf(e),
      ...(e.url && /^https?:\/\//.test(e.url) ? { external_url: e.url } : {}),
      title: `${whenOf(e)}: ${e.title}`,
      content_text: summaryOf(e),
      date_published: e.start,
      tags: [domainLabel[e.domain], ringOf(e)].filter(Boolean),
      _event: {
        title: e.title,
        start: e.start,
        end: e.end ?? null,
        allDay: !!e.allDay,
        venue: e.venue ?? null,
        address: e.address ?? null,
        lat: e.lat ?? null,
        lng: e.lng ?? null,
        area: e.area,
        town: e.town ?? null,
        host: e.org ?? null,
        listedBy: e.sourceLabel ?? e.source ?? null,
      },
    })),
  })
);

// --- index.html ----------------------------------------------------------
const version = createHash("sha1")
  .update(readFileSync(join(ROOT, "site/app.js")))
  .update(readFileSync(join(ROOT, "site/style.css")))
  .update(String(events.fetchedAt))
  .digest("hex")
  .slice(0, 10);
const next = events.events.filter((e) => e.area === "sebastopol").slice(0, 50);
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": BASE,
      url: BASE,
      name: "Sebastopol Events",
      description: "Public events, groups and places in Sebastopol, California, and the towns around it, gathered every morning.",
      inLanguage: "en",
    },
    {
      "@type": "ItemList",
      name: "Upcoming events in Sebastopol",
      numberOfItems: next.length,
      itemListElement: next.map((e, i) => ({
        "@type": "ListItem",
        position: i + 1,
        item: {
          "@type": "Event",
          name: e.title,
          startDate: e.start,
          ...(e.end ? { endDate: e.end } : {}),
          url: e.url,
          eventAttendanceMode: e.online ? "https://schema.org/OnlineEventAttendanceMode" : "https://schema.org/OfflineEventAttendanceMode",
          location: e.online
            ? { "@type": "VirtualLocation", url: e.url }
            : { "@type": "Place", name: e.venue ?? "Sebastopol", address: e.address ?? "Sebastopol, CA 95472" },
          ...(e.org ? { organizer: { "@type": "Organization", name: e.org } } : {}),
        },
      })),
    },
  ],
};
const ldTag = `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`;
const robotsMeta = process.env.INDEX === "1" ? "" : `<meta name="robots" content="noindex, follow">`;
let html = readFileSync(join(DIST, "index.html"), "utf8");
html = html.replaceAll("__VERSION__", version).replaceAll("__BASE__", BASE).replace("<!--ROBOTS-->", robotsMeta).replace("<!--JSONLD-->", ldTag);
writeFileSync(join(DIST, "index.html"), html);
writeFileSync(join(DIST, ".nojekyll"), "");
writeFileSync(join(DIST, "robots.txt"), `User-agent: *\nAllow: /\n`);

console.log(
  `build: dist/ ready at ${BASE} (${events.events.length} events, ${publicOrgs.length} groups, ${domains.length + 2} calendar feeds plus RSS and JSON Feed, version ${version}${robotsMeta ? ", noindex" : ""})`
);
