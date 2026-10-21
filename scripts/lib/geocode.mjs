// Address to coordinates, cached in data/geocache.json so a daily run only
// looks up strings it has never seen. Street addresses go to the US Census
// geocoder; venue names fall back to OpenStreetMap Nominatim, limited to the
// box around the ring (scripts/lib/geo.mjs) and paced at one request a second
// per its usage policy. An address with no town is read as Sebastopol.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { UA, sleep } from "./http.mjs";
import { landmark, townFromText, BOX } from "./geo.mjs";

const RETRY_AFTER_MS = 30 * 86400000;
const VIEWBOX = `${BOX.west},${BOX.north},${BOX.east},${BOX.south}`;

const GENERIC = new Set(
  "the and of at park street st ave avenue blvd boulevard road way lane hwy highway center centre church school sebastopol sonoma county california lawn field room hall library branch building garden gardens cafe house main north south east west upper lower".split(" ")
);
function significantWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w) && !/^\d+$/.test(w));
}

export function openGeocoder(cachePath) {
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  let lastNominatim = 0;
  let lookups = 0;

  const key = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.,]+$/, "").trim();

  async function census(q) {
    const u = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
    u.searchParams.set("address", q);
    u.searchParams.set("benchmark", "Public_AR_Current");
    u.searchParams.set("format", "json");
    const res = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const m = (await res.json()).result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lng: m.coordinates.x } : null;
  }

  async function nominatim(q) {
    const wait = 1100 - (Date.now() - lastNominatim);
    if (wait > 0) await sleep(wait);
    lastNominatim = Date.now();
    const u = new URL("https://nominatim.openstreetmap.org/search");
    u.searchParams.set("q", q);
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("limit", "1");
    u.searchParams.set("viewbox", VIEWBOX);
    u.searchParams.set("bounded", "1");
    const res = await fetch(u, {
      headers: { "User-Agent": `${UA} (+https://github.com/benvonwong-byte/sebastopol-events)` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const hit = (await res.json())[0];
    if (!hit) return null;
    // Free-text search happily matches part of a name ("Main Street Cafe"
    // lands on Main Street). Every distinctive word of the place has to show
    // up in the answer, or it is not the place.
    const words = significantWords(q.split(",")[0]);
    const found = String(hit.display_name).toLowerCase();
    if (!words.length || !words.every((w) => found.includes(w))) return null;
    return { lat: Number(hit.lat), lng: Number(hit.lon) };
  }

  async function geocode(raw, { budget = Infinity } = {}) {
    if (!raw || /^(online|virtual|zoom|tbd|tba)\b/i.test(raw.trim())) return null;
    // Landmarks need no network and no cache.
    const local = landmark(raw);
    if (local) return local;
    const k = key(raw);
    const hit = cache[k];
    if (hit && (hit.lat != null || Date.now() - hit.at < RETRY_AFTER_MS)) {
      return hit.lat != null ? { lat: hit.lat, lng: hit.lng } : null;
    }
    if (lookups >= budget) return null;
    lookups++;
    let q = raw.replace(/\s+/g, " ").trim();
    const named = townFromText(q) || /\b9[45]\d{3}\b/.test(q) || /,\s*[a-z .]+,?\s*(ca|california)\b/i.test(q);
    if (!named) q += ", Sebastopol, CA";
    else if (!/\b(ca|california)\b/i.test(q)) q += ", CA";
    let result = null;
    try {
      // Census wants the street first: drop a venue name in front of it.
      const parts = q.split(",").map((p) => p.trim());
      const at = parts.findIndex((p) => /^\d+[a-z]?\s+\w/i.test(p));
      if (at >= 0) result = await census(parts.slice(at).join(", "));
      if (!result) result = await nominatim(q);
    } catch (err) {
      console.warn(`geocode: "${raw}" failed (${err.message})`);
      return null;
    }
    cache[k] = result ? { ...result, at: Date.now() } : { lat: null, lng: null, at: Date.now() };
    return result;
  }

  function save() {
    const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(cachePath, JSON.stringify(sorted, null, 1) + "\n");
  }

  return { geocode, save, stats: () => ({ lookups, cached: Object.keys(cache).length }) };
}
