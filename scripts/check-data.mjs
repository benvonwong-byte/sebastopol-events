#!/usr/bin/env node
// Validates data/orgs.json so a hand edit cannot break the site: required
// fields, known categories, areas and kinds, unique ids, https
// links, and feed formats the fetcher can read.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AREAS, inRegion } from "./lib/geo.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const orgs = JSON.parse(readFileSync(join(ROOT, "data/orgs.json"), "utf8"));
const domains = new Set(JSON.parse(readFileSync(join(ROOT, "data/domains.json"), "utf8")).map((d) => d.id));
const areas = new Set(AREAS.map((a) => a.id));
const KINDS = new Set(["nonprofit", "civic", "government", "business", "faith", "school", "informal", "venue", "market", "media", "farm"]);
const FORMATS = new Set(["ics", "luma", "meetup", "tockify", "civicplus", "squarespace", "tribe", "mobilize", "rss", "rss-future", "jsonld", "eventbrite", "mahina", "fullcalendar"]);

// A Google Calendar whose id is a Gmail address may be someone's own
// calendar. Group calendars have ids ending in @group.calendar.google.com.
const PERSONAL_CAL = /calendar\/ical\/[^/]*(%40|@)gmail\.com\//i;

const errors = [];
const warnings = [];
const ids = new Set();
const isHttp = (u) => typeof u === "string" && /^https?:\/\/[^\s]+$/.test(u);

for (const [i, o] of orgs.entries()) {
  const at = `orgs[${i}] ${o.id ?? o.name ?? "?"}`;
  if (!o.id || !/^[a-z0-9-]+$/.test(o.id)) errors.push(`${at}: id must be lowercase-kebab`);
  if (ids.has(o.id)) errors.push(`${at}: duplicate id`);
  ids.add(o.id);
  if (!o.name) errors.push(`${at}: missing name`);
  if (!isHttp(o.url)) errors.push(`${at}: url must be http(s)`);
  if (!o.what || o.what.length > 260) errors.push(`${at}: "what" is missing or longer than 260 characters`);
  if (!Array.isArray(o.domains) || !o.domains.length) errors.push(`${at}: needs at least one domain`);
  for (const d of o.domains ?? []) if (!domains.has(d)) errors.push(`${at}: unknown domain "${d}"`);
  if (!areas.has(o.area)) errors.push(`${at}: unknown area "${o.area}"`);
  if (o.town != null && typeof o.town !== "string") errors.push(`${at}: town must be a string or null`);
  if (!KINDS.has(o.kind)) errors.push(`${at}: unknown kind "${o.kind}"`);
  for (const k of ["eventsPage", "instagram"]) if (o[k] != null && !isHttp(o[k])) errors.push(`${at}: ${k} must be http(s) or null`);
  if ((o.lat == null) !== (o.lng == null)) errors.push(`${at}: lat and lng go together`);
  if (o.lat != null && !inRegion(o.lat, o.lng)) warnings.push(`${at}: coordinates fall outside the ring`);
  for (const f of o.feeds ?? []) {
    if (!FORMATS.has(f.format)) errors.push(`${at}: unknown feed format "${f.format}"`);
    if (PERSONAL_CAL.test(f.url)) errors.push(`${at}: a Google Calendar whose id is a Gmail address is not recorded here (AGENTS.md)`);
    if (!isHttp(f.url)) errors.push(`${at}: feed url must be http(s)`);
    if (f.scope && !["local", "filter"].includes(f.scope)) errors.push(`${at}: feed scope must be "local" or "filter"`);
    for (const k of ["skip", "only", "follow"]) {
      if (!f[k]) continue;
      try {
        new RegExp(f[k], "i");
      } catch {
        errors.push(`${at}: feed ${k} is not a valid regex`);
      }
    }
  }
}

// Regional calendars (always filtered to the ring)
const feedsPath = join(ROOT, "data/feeds.json");
const citywide = existsSync(feedsPath) ? JSON.parse(readFileSync(feedsPath, "utf8")) : [];
const feedIds = new Set();
for (const [i, f] of citywide.entries()) {
  const at = `feeds[${i}] ${f.id ?? f.name ?? "?"}`;
  if (!f.id || feedIds.has(f.id)) errors.push(`${at}: needs a unique id`);
  feedIds.add(f.id);
  if (!f.name) errors.push(`${at}: missing name`);
  if (!FORMATS.has(f.format)) errors.push(`${at}: unknown feed format "${f.format}"`);
  if (!isHttp(f.url)) errors.push(`${at}: url must be http(s)`);
  if (PERSONAL_CAL.test(f.url)) errors.push(`${at}: a Google Calendar whose id is a Gmail address is not recorded here (AGENTS.md)`);
  if (f.domain && !domains.has(f.domain)) errors.push(`${at}: unknown domain "${f.domain}"`);
}

for (const w of warnings) console.warn("check-data: warning: " + w);
if (errors.length) {
  console.error(`check-data: ${errors.length} error(s)\n` + errors.map((e) => "  " + e).join("\n"));
  process.exit(1);
}
console.log(`check-data: ${orgs.length} groups valid (${orgs.filter((o) => o.feeds?.length).length} with feeds), ${citywide.length} citywide feeds`);
