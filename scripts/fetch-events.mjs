#!/usr/bin/env node
// Builds data/events.json: every upcoming public event we can find in
// Sebastopol (ZIP 95472) and the ring around it (scripts/lib/geo.mjs) over
// the next HORIZON_DAYS. Each event is marked "sebastopol" or "nearby".
//
// Two kinds of source:
//   1. Org feeds. Each group in data/orgs.json can list feeds (ICS, Luma,
//      Meetup, Squarespace, WordPress, JSON-LD...). A feed's `scope` says
//      how to treat locations: "local" keeps events unless they are clearly
//      elsewhere, "filter" keeps only events with a place inside the ring.
//      Optional: `skip` (regex of titles to drop), `only` (regex of titles
//      to keep, for school calendars full of drills and minimum days) and
//      `maxPerDay` (for calendars that list every daily session).
//   2. Aggregators (scripts/lib/aggregators.mjs, notes in docs/aggregators.md):
//      Luma, Eventbrite, Meetup, the Bohemian and Press Democrat calendars,
//      the county library, What's Happening in Sebastopol, the city, the
//      chamber, regional parks, Farm Trails and Sonoma County Tourism,
//      filtered to the ring.
//
// Never fails the build: a broken source is logged and skipped, and if most
// sources fail at once the previous file is kept.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { get, sleep, UA } from "./lib/http.mjs";
import { readFeed } from "./lib/read-feed.mjs";
import { inRegion, areaFor, areaByText, namesElsewhere, townFor, townFromText } from "./lib/geo.mjs";
import { classify } from "./lib/classify.mjs";
import { openGeocoder } from "./lib/geocode.mjs";
import { toPacificIso, pacificDayKey, parseLooseDate, partsIn } from "./lib/time.mjs";
import { decodeEntities } from "./lib/ics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "events.json");
const ORGS = JSON.parse(readFileSync(join(ROOT, "data", "orgs.json"), "utf8"));

const HORIZON_DAYS = 60;
const PER_ORG_PER_DAY = 6;
const TOTAL_CAP = 3000;
const GEOCODE_BUDGET = Number(process.env.GEOCODE_BUDGET ?? 150);

// Which copy wins when two sources list the same event.
// Which copy wins when two sources list the same event: the group's own
// calendar, then public institutions, then the big platforms.
const PRIORITY = {
  org: 0,
  manual: 1,
  sonomalibrary: 1,
  sebcity: 1,
  feed: 2,
  sebcalendar: 2,
  farmtrails: 2,
  parks: 2,
  srjc: 2,
  chamber: 3,
  luma: 3,
  eventbrite: 4,
  tourism: 4,
  cityspark: 5,
  meetup: 5,
};
const SOURCE_LABELS = {
  org: "Group calendar",
  manual: "Added through the site",
  luma: "Luma",
  eventbrite: "Eventbrite",
  meetup: "Meetup",
};

const now = Date.now();
const from = now - 6 * 3600 * 1000;
const to = now + HORIZON_DAYS * 86400 * 1000;
const geo = openGeocoder(join(ROOT, "data", "geocache.json"));

const ONLINE_RE = /^(online|virtual|zoom|google meet|livestream|webinar)\b|zoom\.us|meet\.google/i;
// Electoral campaign work stays off a neighborhood calendar whichever side
// it is on. Candidate forums and voter registration stay.
const CAMPAIGN_RE =
  /\b(canvass?(ing)? (in|for|with|on)|canvass(ing)?|phone ?bank(ing)?|text ?bank(ing)?|door ?knock(ing)?|lit(erature)? drop|get out the vote|gotv|day of action)\b|\b(yes|no) on (prop(osition)? ?)?[a-z0-9]{1,2}\b|\b(yes|no) on (prop(osition)?|measure)\b/i;
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|and|of|at|in|sf|san francisco)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const ORG_INDEX = ORGS.map((o) => ({ org: o, key: norm(o.name) })).filter((x) => x.key.length >= 5);
function matchOrg(...names) {
  for (const n of names) {
    const k = norm(n);
    if (k.length < 5) continue;
    // Exact name, or text that contains a group's whole name. Never the
    // reverse: "Golden Gate Park" is not the Golden Gate Park Band.
    const hit =
      ORG_INDEX.find((x) => x.key === k) ??
      ORG_INDEX.filter((x) => ` ${k} `.includes(` ${x.key} `)).sort((a, b) => b.key.length - a.key.length)[0];
    if (hit) return hit.org;
  }
  return null;
}

function pickDomain(org, title, description) {
  if (!org) return classify(title, description);
  if (org.domains.length === 1) return org.domains[0];
  const guess = classify(title, description);
  return org.domains.includes(guess) ? guess : org.domains[0];
}

// Words that say what kind of thing an event is, not which one it is.
const STOP = new Set(
  "the and for with from your our its sebastopol event night day free tour tours class classes workshop meeting open community group session program series talk walk".split(" ")
);
const words = (t) => new Set(norm(t).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)));

const idFor = (...parts) => createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);

// Decide where an org-feed instance happens and whether it is inside the ring.
async function placeOrgInstance(inst, org, scope) {
  const location = inst.location?.trim() || null;
  if (location && ONLINE_RE.test(location)) {
    return scope === "local" ? { keep: true, online: true, lat: null, lng: null } : { keep: false };
  }
  let lat = inst.lat;
  let lng = inst.lng;
  if (!Number.isFinite(lat) && location) {
    const textSays = areaByText(location);
    if (textSays === false) return { keep: false };
    const g = await geo.geocode(location, { budget: GEOCODE_BUDGET });
    if (g) ({ lat, lng } = g);
    else if (textSays) return { keep: true, lat: org.lat ?? null, lng: org.lng ?? null, approx: true, textArea: textSays };
  }
  if (Number.isFinite(lat)) return { keep: inRegion(lat, lng) && !namesElsewhere(location), lat, lng };
  if (!location && scope === "local") return { keep: true, lat: org.lat ?? null, lng: org.lng ?? null, approx: true };
  return { keep: scope === "local" && areaByText(location) !== false, lat: org.lat ?? null, lng: org.lng ?? null, approx: true };
}

function venueFrom(location, fallback) {
  if (!location) return fallback ?? null;
  const first = location.split(/,(?![^(]*\))/)[0].trim();
  return /^\d/.test(first) ? fallback ?? first : first;
}

const sources = [];
const all = [];

// When a source fails (a site down for the morning, or one that blocks
// GitHub's servers), reuse its still-upcoming events from the last good
// read, for up to KEEP_DAYS. The footer says which sources this happened to.
const KEEP_DAYS = 14;
const PREV = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
function lastGoodOf(id) {
  const s = PREV?.sources?.find((x) => x.id === id);
  return s?.lastGood ?? (s?.ok ? PREV.fetchedAt : null);
}
function reuse(id) {
  const lastGood = lastGoodOf(id);
  if (!lastGood || now - Date.parse(lastGood) > KEEP_DAYS * 86400000) return [];
  return (PREV.events ?? [])
    .filter((e) => e.feedId === id && Date.parse(e.start) > now)
    .map((e) => ({ ...e, startMs: Date.parse(e.start), endMs: e.end ? Date.parse(e.end) : null }));
}
function failed(entry) {
  const old = reuse(entry.id);
  all.push(...old);
  sources.push({ ...entry, ok: false, count: old.length, lastGood: lastGoodOf(entry.id) });
  if (old.length) console.warn(`fetch-events: ${entry.label}: reusing ${old.length} events from ${lastGoodOf(entry.id)}`);
}

// --- 1. Group feeds and citywide feeds -----------------------------------
// data/feeds.json lists regional calendars and the ones people add through
// the site (scripts/intake.mjs). They are not groups in the directory (Rec & Park, cleanup crews,
// nature roundups) that are not groups in the directory. They always run
// with scope "filter", and an event is credited to a directory group when
// its organizer or venue matches one.
const CITYWIDE = existsSync(join(ROOT, "data", "feeds.json"))
  ? JSON.parse(readFileSync(join(ROOT, "data", "feeds.json"), "utf8"))
  : [];
const jobs = [
  ...ORGS.flatMap((org) => (org.feeds ?? []).filter((f) => !f.disabled).map((feed) => ({ org, feed }))),
  ...CITYWIDE.filter((f) => !f.disabled).map((feed) => ({ org: null, feed: { ...feed, scope: "filter" } })),
];

for (const { org, feed } of jobs) {
  const scope = feed.scope ?? (inRegion(org?.lat, org?.lng) ? "local" : "filter");
  const name = org?.name ?? feed.name;
  const label = `${name} (${feed.format})`;
  const sourceId = org ? `${org.id}:${feed.format}` : `feed:${feed.id ?? feed.name}`;
  try {
    const instances = await readFeed(feed, { from, to });
    const skip = feed.skip ? new RegExp(feed.skip, "i") : null;
    const only = feed.only ? new RegExp(feed.only, "i") : null;
    const perDay = {};
    let kept = 0;
    instances.sort((a, b) => a.startMs - b.startMs);
    for (const inst of instances) {
      if (!inst.title || !Number.isFinite(inst.startMs)) continue;
      if (inst.startMs < from || inst.startMs > to) continue;
      if ((skip && skip.test(inst.title)) || CAMPAIGN_RE.test(inst.title)) continue;
      if (only && !only.test(inst.title)) continue;
      const dk = pacificDayKey(inst.startMs);
      if ((perDay[dk] = (perDay[dk] ?? 0) + 1) > (feed.maxPerDay ?? Infinity)) continue;
      const place = await placeOrgInstance(inst, org ?? {}, scope);
      if (!place.keep) continue;
      const host = org ?? matchOrg(inst.organizer, venueFrom(inst.location, null));
      kept++;
      all.push({
        feedId: sourceId,
        id: idFor(org ? "org" : "feed", org?.id ?? feed.name, inst.uid ?? inst.url ?? inst.title, inst.startMs),
        title: inst.title.trim(),
        startMs: inst.startMs,
        endMs: inst.endMs ?? null,
        allDay: !!inst.allDay,
        url: inst.url || org?.eventsPage || org?.url || feed.page || feed.url,
        venue: place.online ? "Online" : venueFrom(inst.location, org?.name),
        address: place.online ? null : inst.location ?? org?.address ?? null,
        lat: place.lat ?? null,
        lng: place.lng ?? null,
        approxLocation: place.approx || undefined,
        online: place.online || undefined,
        org: host?.name ?? inst.organizer ?? null,
        orgId: host?.id ?? null,
        source: org ? "org" : "feed",
        sourceLabel: `${name} calendar`,
        domain: feed.domain ?? pickDomain(host, inst.title, inst.description),
        description: inst.description ?? null,
        image: inst.image ?? null,
      });
    }
    sources.push({ id: sourceId, label, kind: org ? "org" : "feed", ok: true, count: kept, lastGood: new Date().toISOString() });
    console.log(`fetch-events: ${label}: ${kept} in window and in the ring (${instances.length} parsed)`);
  } catch (err) {
    console.warn(`fetch-events: ${label} failed (${err.message ?? err})`);
    failed({ id: sourceId, label, kind: org ? "org" : "feed", error: String(err.message ?? err) });
  }
  await sleep(150);
}

// --- Events added by hand through the site's form (scripts/intake.mjs) ---
const MANUAL_PATH = join(ROOT, "data", "manual-events.json");
const MANUAL = existsSync(MANUAL_PATH) ? JSON.parse(readFileSync(MANUAL_PATH, "utf8")) : [];
let manualKept = 0;
for (const m of MANUAL) {
  const startMs = Date.parse(m.start);
  if (!m.title || !startMs || startMs < from || startMs > to || CAMPAIGN_RE.test(m.title)) continue;
  let { lat, lng } = m;
  if (!Number.isFinite(lat) && m.address) {
    const g = await geo.geocode(m.address, { budget: GEOCODE_BUDGET });
    if (g) ({ lat, lng } = g);
  }
  if (Number.isFinite(lat) ? !inRegion(lat, lng) : !areaByText(m.address)) continue;
  const org = matchOrg(m.org, m.venue);
  manualKept++;
  all.push({
    feedId: "manual",
    id: "m-" + m.id,
    title: m.title,
    startMs,
    endMs: m.end ? Date.parse(m.end) : null,
    allDay: !!m.allDay,
    url: m.url ?? null,
    venue: m.venue ?? null,
    address: m.address ?? null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    org: org?.name ?? m.org ?? null,
    orgId: org?.id ?? null,
    source: "manual",
    sourceLabel: "Added through the site",
    domain: pickDomain(org, m.title, m.description),
    description: m.description ?? null,
    image: null,
  });
}
sources.push({ id: "manual", label: "Added through the site", kind: "feed", ok: true, count: manualKept, lastGood: new Date().toISOString() });

// --- 2. Aggregators ------------------------------------------------------
// Each source runs in parallel and never throws; see scripts/lib/aggregators.mjs
// and docs/aggregators.md for the endpoints.
let bySource = {};
try {
  const mod = await import("./lib/aggregators.mjs");
  const { fetchAll, DEFAULT_SOURCES } = mod;
  Object.assign(SOURCE_LABELS, mod.LABELS ?? {});
  const only = process.env.SOURCES ? process.env.SOURCES.split(",") : DEFAULT_SOURCES;
  ({ bySource } = await fetchAll({ days: HORIZON_DAYS }, only));
} catch (err) {
  console.warn(`fetch-events: aggregators failed to load (${err.message})`);
}
for (const [name, { events: list }] of Object.entries(bySource)) {
  const label = SOURCE_LABELS[name] ?? name;
  // An empty list from a source that normally has events means it blocked
  // us or broke; treat it as a failure so the last good read is reused.
  if (!list.length) {
    failed({ id: name, label, kind: "aggregator", error: "returned nothing" });
    console.log(`fetch-events: aggregator ${label}: returned nothing`);
    continue;
  }
  let kept = 0;
  for (const e of list) {
    const startMs = parseLooseDate(e.start);
    if (!e.title || !startMs || startMs < from || startMs > to || CAMPAIGN_RE.test(e.title)) continue;
    let { lat, lng } = e;
    if (!Number.isFinite(lat)) {
      lat = null;
      lng = null;
    }
    const where = [e.venue, e.address].filter(Boolean).join(", ");
    if (namesElsewhere(where)) continue;
    // A street address with no pin: place it, rather than trust the text.
    if (lat == null && /\d+\s+\w/.test(e.address ?? "")) {
      const g = await geo.geocode(e.address, { budget: GEOCODE_BUDGET });
      if (g) ({ lat, lng } = g);
    }
    if (lat != null ? !inRegion(lat, lng) : !areaByText(where)) continue;
    const org = matchOrg(e.org, e.venue);
    const source = e.source ?? name;
    kept++;
    all.push({
      feedId: name,
      id: idFor(source, e.url, startMs),
      title: String(e.title).trim(),
      startMs,
      endMs: parseLooseDate(e.end) ?? null,
      allDay: !!e.allDay,
      url: e.url,
      venue: e.venue ?? null,
      address: e.address ?? null,
      lat,
      lng,
      org: org?.name ?? e.org ?? null,
      orgId: org?.id ?? null,
      source,
      sourceLabel: SOURCE_LABELS[source] ?? label,
      domain: pickDomain(org, e.title, e.description),
      description: e.description ?? null,
      image: e.image ?? null,
      free: e.free ?? undefined,
    });
  }
  sources.push({ id: name, label, kind: "aggregator", ok: true, count: kept, lastGood: new Date().toISOString() });
  console.log(`fetch-events: aggregator ${label}: ${kept} in the ring (${list.length} returned)`);
}

// --- 3. Merge duplicates across sources ----------------------------------
all.sort((a, b) => a.startMs - b.startMs || (PRIORITY[a.source] ?? 9) - (PRIORITY[b.source] ?? 9));
const byKey = new Map();
const byDay = new Map();
const merged = [];
for (const e of all) {
  const key = norm(e.title).slice(0, 48) + "|" + pacificDayKey(e.startMs);
  const twins = byKey.get(key) ?? [];
  let twin = twins.find((t) => Math.abs(t.startMs - e.startMs) <= 90 * 60000);
  // "Scaregrove" and "Scaregrove Halloween Event" at the same time and place
  if (!twin) {
    const t1 = norm(e.title);
    twin = (byDay.get(pacificDayKey(e.startMs)) ?? []).find((t) => {
      if (Math.abs(t.startMs - e.startMs) > 30 * 60000) return false;
      const t2 = norm(t.title);
      const [a, b] = t1.length < t2.length ? [t1, t2] : [t2, t1];
      const near = t.lat == null || e.lat == null || (Math.abs(t.lat - e.lat) < 0.003 && Math.abs(t.lng - e.lng) < 0.003);
      return a.length >= 6 && near && new RegExp(`^${a}\\b|\\b${a}$`).test(b) && !/\bvolunteer/.test(b.replace(a, ""));
    });
  }
  // One show, three names: "DJ Damon 80s nite" and "80s Nite: Friday I'm in
  // Love" from the same group at the same time are the same night out.
  if (!twin && e.orgId) {
    const w1 = words(e.title);
    twin = (byDay.get(pacificDayKey(e.startMs)) ?? []).find(
      (t) => {
        if (t.orgId !== e.orgId || Math.abs(t.startMs - e.startMs) > 15 * 60000) return false;
        const w2 = words(t.title);
        const shared = [...w2].filter((w) => w1.has(w)).length;
        return shared >= 2 && shared >= Math.min(w1.size, w2.size) / 2;
      }
    );
  }
  if (twin) {
    const eWins = (PRIORITY[e.source] ?? 9) < (PRIORITY[twin.source] ?? 9);
    const winner = { ...(eWins ? e : twin) };
    const loser = eWins ? { ...twin } : e;
    for (const f of ["lat", "lng", "image", "description", "address", "venue", "endMs", "orgId", "org"]) {
      if (winner[f] == null && loser[f] != null) winner[f] = loser[f];
    }
    if (winner.approxLocation && loser.lat != null && !loser.approxLocation) {
      winner.lat = loser.lat;
      winner.lng = loser.lng;
      delete winner.approxLocation;
    }
    const also = [...(twin.alsoAt ?? []), loser.url].filter((u) => u && u !== winner.url);
    if (also.length) winner.alsoAt = [...new Set(also)];
    // Replace in place: `twin` is the object already in `merged`.
    for (const k of Object.keys(twin)) delete twin[k];
    Object.assign(twin, winner);
    continue;
  }
  twins.push(e);
  byKey.set(key, twins);
  const dk = pacificDayKey(e.startMs);
  if (!byDay.has(dk)) byDay.set(dk, []);
  byDay.get(dk).push(e);
  merged.push(e);
}

// --- 4. Cap runaway series, finish fields --------------------------------
// Titles that announce a closure, a cancellation or a private rental.
const NOT_AN_EVENT = /\b(cancel+ed|postponed|private event|office closed)\b|^\s*closed\b|\(closed\)|^\s*holiday\s*[-:]|^\s*no (meeting|class|classes|service)\b/i;
// A series (one group, one title) shows its next SERIES_CAP dates. A weekly
// class or an exhibit listed every day would otherwise fill the whole list.
const SERIES_CAP = 6;
const perSeries = {};
const perOrgDay = {};
const events = [];
merged.sort((a, b) => a.startMs - b.startMs);
for (const e of merged) {
  if (NOT_AN_EVENT.test(e.title)) continue;
  const sk = (e.orgId ?? e.org ?? e.source) + "|" + norm(e.title).replace(/\d+/g, "#");
  perSeries[sk] = (perSeries[sk] ?? 0) + 1;
  if (perSeries[sk] > SERIES_CAP) continue;
  const day = pacificDayKey(e.startMs);
  const k = (e.orgId ?? e.org ?? e.source) + "|" + day;
  perOrgDay[k] = (perOrgDay[k] ?? 0) + 1;
  if (perOrgDay[k] > PER_ORG_PER_DAY) continue;
  const { startMs, endMs, ...rest } = e;
  for (const f of ["title", "venue", "address", "org", "description"]) {
    // Decode only. Titles and descriptions are the organizers' own words.
    if (rest[f]) rest[f] = decodeEntities(rest[f]).trim();
  }
  // Feeds that post all-day events as midnight starts
  const p = partsIn(startMs);
  if (!rest.allDay && p.h === 0 && p.mi === 0) {
    const q = endMs ? partsIn(endMs) : null;
    if (!q || (q.h === 23 && q.mi >= 59) || (q.h === 0 && q.mi === 0)) rest.allDay = true;
  }
  events.push({
    ...rest,
    start: toPacificIso(startMs),
    end: endMs ? toPacificIso(endMs) : null,
    day,
    area: areaFor(e.lat, e.lng) ?? (areaByText([e.venue, e.address].filter(Boolean).join(", ")) || null) ?? ORGS.find((o) => o.id === e.orgId)?.area ?? "area-wide",
    town: townFor(e.lat, e.lng) ?? townFromText([e.venue, e.address].filter(Boolean).join(", ")) ?? ORGS.find((o) => o.id === e.orgId)?.town ?? null,
  });
  if (events.length >= TOTAL_CAP) break;
}

geo.save();
const failures = sources.filter((s) => !s.ok).length;
if (events.length === 0 && failures > sources.length / 2 && existsSync(OUT)) {
  console.warn("fetch-events: run came back empty with most sources failing; keeping the previous file");
} else {
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        horizonDays: HORIZON_DAYS,
        note: "Generated by scripts/fetch-events.mjs. Do not edit by hand.",
        sources,
        events,
      },
      null,
      1
    ) + "\n"
  );
  const s = geo.stats();
  console.log(
    `fetch-events: wrote ${events.length} events from ${sources.length - failures}/${sources.length} sources (geocoder: ${s.lookups} new lookups, ${s.cached} cached)`
  );
}
