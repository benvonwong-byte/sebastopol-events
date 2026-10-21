// Where is Sebastopol? Two rings:
//   core    ZIP 95472, from the Census Bureau's 2020 ZIP Code Tabulation
//           Area boundary (data/core-95472.json, simplified to about 80 m).
//           Graton (95444) is a hole inside it and counts as nearby.
//   nearby  everything within RADIUS_KM of downtown Sebastopol that is not
//           core: Graton, Forestville, Occidental, Bodega Bay, the river
//           towns, Santa Rosa, Rohnert Park, Cotati, Windsor.
// Every keep-or-drop decision runs through inRegion(); areaFor() says which
// ring. BOX is only a coarse prefilter for searches.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = JSON.parse(readFileSync(join(ROOT, "data", "core-95472.json"), "utf8"));

export const CENTER = [38.4021, -122.8242]; // downtown Sebastopol
export const RADIUS_KM = 22;
export const BOX = { south: 38.2, north: 38.6, west: -123.075, east: -122.57 };
export const CORE_OUTLINE = CORE.outer;
export const CORE_HOLES = CORE.holes;

export const AREAS = [
  { id: "sebastopol", label: "Sebastopol" },
  { id: "nearby", label: "Nearby" },
  { id: "area-wide", label: "West County" },
];

// Town centers from OpenStreetMap (October 2026), for "Nearby · Graton".
// Graton and Occidental use their downtown crossroads: OSM gives census-area
// centroids for both, and those land inside ZIP 95472.
export const TOWNS = [
  ["Sebastopol", 38.4021, -122.8242],
  ["Graton", 38.4363, -122.869],
  ["Forestville", 38.4838, -122.8857],
  ["Occidental", 38.4074, -122.9486],
  ["Freestone", 38.3724, -122.9156],
  ["Bodega", 38.3494, -122.9737],
  ["Bodega Bay", 38.3217, -123.0288],
  ["Valley Ford", 38.3238, -122.9124],
  ["Monte Rio", 38.4679, -123.0144],
  ["Guerneville", 38.5179, -122.9782],
  ["Rio Nido", 38.521, -122.9769],
  ["Duncans Mills", 38.4531, -123.0537],
  ["Camp Meeker", 38.4252, -122.9594],
  ["Bloomfield", 38.3145, -122.8467],
  ["Two Rock", 38.2663, -122.7922],
  ["Cotati", 38.3267, -122.7068],
  ["Rohnert Park", 38.3396, -122.7011],
  ["Penngrove", 38.2976, -122.6757],
  ["Santa Rosa", 38.4405, -122.7141],
  ["Fulton", 38.4952, -122.7715],
  ["Larkfield-Wikiup", 38.5067, -122.7601],
  ["Windsor", 38.5471, -122.8164],
];

export function km(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inCore(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return inRing(lat, lng, CORE.outer) && !CORE.holes.some((h) => inRing(lat, lng, h));
}

export function inRegion(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return inCore(lat, lng) || km(CENTER[0], CENTER[1], lat, lng) <= RADIUS_KM;
}

// "sebastopol", "nearby", or null when outside both rings.
export function areaFor(lat, lng) {
  if (inCore(lat, lng)) return "sebastopol";
  return inRegion(lat, lng) ? "nearby" : null;
}

export function townFor(lat, lng) {
  if (!Number.isFinite(lat)) return null;
  let best = null;
  let bestKm = Infinity;
  for (const [name, tlat, tlng] of TOWNS) {
    const d = km(lat, lng, tlat, tlng);
    if (d < bestKm) [best, bestKm] = [name, d];
  }
  return inCore(lat, lng) ? "Sebastopol" : best;
}

// ---- Text tests for listings without coordinates --------------------------
// "Sebastopol Road" and "Sebastopol Avenue" run through Santa Rosa and
// Roseland, so a street named for the town does not place anything in it.
const CORE_TEXT = /\b95472\b|\bsebastopol\b(?!\s+(?:rd|road|ave|avenue|st|street|hwy|highway|blvd)\b)/i;
const NEARBY_TOWNS = TOWNS.filter(([t]) => t !== "Sebastopol").map(([t]) => t.toLowerCase().replace(/-/g, "[- ]"));
const NEARBY_TEXT = new RegExp(`\\b(${NEARBY_TOWNS.join("|")})\\b`, "i");
// ZIPs inside the ring: Graton, Forestville, Occidental, Bodega, Bodega Bay,
// Valley Ford, Monte Rio, Guerneville, Rio Nido, Duncans Mills, Camp Meeker,
// Cotati, Rohnert Park, Penngrove, Santa Rosa, Fulton, Windsor.
const NEARBY_ZIPS = /\b(95444|95436|95465|94922|94923|94972|95462|95446|95471|95430|95419|94931|94928|94951|9540[1-9]|95439|95492)\b/;
// Places outside the ring that turn up in regional feeds.
const ELSEWHERE =
  /\b(petaluma|healdsburg|sonoma(?! county| state| west| land| mountain)|glen ellen|kenwood|cloverdale|geyserville|jenner|cazadero|napa|novato|san rafael|mill valley|sausalito|san francisco|oakland|berkeley|vallejo|ukiah|calistoga|st\.? helena)\b/i;

// True when the text names a place outside the ring outright. Used as a veto
// even when a listing has coordinates.
export function namesElsewhere(text) {
  if (!text) return false;
  const s = String(text);
  return ELSEWHERE.test(s) && !CORE_TEXT.test(s) && !NEARBY_TEXT.test(s);
}

// "sebastopol", "nearby", false (clearly elsewhere) or null (says nothing).
export function areaByText(text) {
  if (!text) return null;
  const s = String(text);
  if (namesElsewhere(s)) return false;
  if (CORE_TEXT.test(s)) return "sebastopol";
  if (NEARBY_TEXT.test(s) || NEARBY_ZIPS.test(s)) return "nearby";
  if (/\b9[45]\d{3}\b/.test(s)) return false; // some other ZIP
  return null;
}

export function townFromText(text) {
  if (!text) return null;
  const s = String(text);
  for (const [name] of TOWNS) if (new RegExp(`\\b${name.replace(/-/g, "[- ]")}\\b`, "i").test(s)) return name;
  return null;
}

// A few places the geocoders handle badly, by name. Coordinates from
// OpenStreetMap (October 2026).
export const LANDMARKS = [
  [/\bives park\b/i, 38.4, -122.8265],
  [/\bragle ranch\b/i, 38.4051, -122.8458],
  [/\bthe barlow\b/i, 38.4042, -122.8208],
  [/\b(sebastopol (town )?plaza|free speech (town )?plaza)\b/i, 38.4031, -122.8237],
];
export function landmark(text) {
  for (const [re, lat, lng] of LANDMARKS) if (re.test(text)) return { lat, lng };
  return null;
}
