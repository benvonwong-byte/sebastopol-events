// West Sonoma County event aggregators, centred on Sebastopol (ZIP 95472).
//
// Node 20+, zero dependencies (global fetch only). Every exported fetcher takes
// `{ region, days, now, budgetMs }`, never throws, paces its own requests
// sequentially, and returns normalized events:
//
//   { title, start, end, allDay, url, venue, address, lat, lng, org, source,
//     image, description, free }
//
// `start`/`end` are ISO 8601 with a numeric offset (America/Los_Angeles wall
// time). The returned array also has a non-enumerable `stats` property,
// `{ dropped: { outside, noLocation, online, ... }, error? }`, counting rows
// inside the time window that the fetcher threw away.
//
// A region is `{ center: [lat, lng], radiusKm, box: { minLat, maxLat, minLng,
// maxLng }, core? }`. Fetchers keep events within `radiusKm` of `center`
// (haversine). APIs that take a rectangle (Eventbrite) get `box`; APIs that
// take a point and radius (Luma, Meetup, CitySpark) get `center`. Rows with no
// coordinates are placed by text (`locateByText`: named places, then town
// names, then ZIP centroids). `classify(event, region)` splits kept events into
// "core" (ZIP 95472 / Sebastopol) and "nearby".
//
// Research notes, endpoints and caveats: aggregators.md (same folder).
//
// Run `node aggregators.mjs` to hit every source and print counts and samples.
// Flags: --days=N, --only=luma,meetup, --out=events.json, --samples=N

const TZ = "America/Los_Angeles";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const DEFAULT_BUDGET_MS = 100_000; // per source; the whole run is parallel across sources

// ---------------------------------------------------------------- region

const KM_PER_DEG_LAT = 111.32;

/** Build a region (centre, radius, bounding box) from a point and a radius in km. */
export function regionAround([lat, lng], radiusKm, extra = {}) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  const r4 = (x) => Math.round(x * 10_000) / 10_000;
  return {
    center: [lat, lng],
    radiusKm,
    box: { minLat: r4(lat - dLat), maxLat: r4(lat + dLat), minLng: r4(lng - dLng), maxLng: r4(lng + dLng) },
    ...extra,
  };
}

/**
 * Default region: downtown Sebastopol, 22 km radius (reaches Bodega Bay at
 * 20 km, Guerneville and Monte Rio at 18 km, Windsor at 16 km; Petaluma at
 * 25 km and Healdsburg at 23.5 km fall outside). Box: lat 38.2045..38.5997,
 * lng -123.0761..-122.5717. `core` is only used by `classify()`.
 */
export const REGION = regionAround([38.4021, -122.8239], 22, {
  name: "Sebastopol",
  core: {
    zips: ["95472", "95473"], // 95473 is Sebastopol PO boxes
    towns: ["sebastopol", "freestone"], // Freestone is inside 95472
    box: { minLat: 38.33, maxLat: 38.47, minLng: -122.93, maxLng: -122.76 },
  },
});

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Distance from the region centre in km, or null without coordinates. */
export function distanceKm(region, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return haversineKm(region.center[0], region.center[1], lat, lng);
}

export function inRegion(region, lat, lng) {
  const d = distanceKm(region, lat, lng);
  return d !== null && d <= region.radiusKm;
}

const inBox = (box, lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng;

// ---------------------------------------------------------------- gazetteer
//
// Coordinates were looked up once (October 2026) with the US Census geocoder
// and OpenStreetMap Nominatim, then hard-coded so the daily run needs no
// geocoder. They place coordinate-less rows for the radius test only; a
// fetcher copies them into `lat`/`lng` only when a named place matched.

// Towns: [key, names (first is canonical), lat, lng, strictOnly]
// strictOnly: match only as "Town, CA" / "Town 9xxxx" (the word also appears
// in venue names that are elsewhere, e.g. "Sonoma County Library").
const TOWNS = [
  ["sebastopol", ["Sebastopol"], 38.4021, -122.82422],
  ["freestone", ["Freestone"], 38.37242, -122.91555],
  ["graton", ["Graton"], 38.43862, -122.8657],
  ["forestville", ["Forestville"], 38.48383, -122.88566],
  ["mirabel", ["Mirabel Heights", "Mirabel"], 38.49047, -122.89055],
  ["hacienda", ["Hacienda"], 38.51125, -122.9277, true],
  ["occidental", ["Occidental"], 38.40103, -122.93121],
  ["campmeeker", ["Camp Meeker"], 38.42519, -122.95944],
  ["monterio", ["Monte Rio"], 38.46792, -123.01437],
  ["guerneville", ["Guerneville"], 38.5179, -122.97819],
  ["rionido", ["Rio Nido"], 38.52102, -122.97694],
  ["bodegabay", ["Bodega Bay"], 38.32165, -123.02884],
  ["bodega", ["Bodega"], 38.34942, -122.97367],
  ["valleyford", ["Valley Ford"], 38.32379, -122.91239],
  ["bloomfield", ["Bloomfield"], 38.31451, -122.84668],
  ["tworock", ["Two Rock"], 38.2513, -122.7966], // approximate
  ["tomales", ["Tomales"], 38.24681, -122.9063],
  ["dillonbeach", ["Dillon Beach"], 38.2481, -122.95521],
  ["duncansmills", ["Duncans Mills"], 38.45308, -123.05371],
  ["jenner", ["Jenner"], 38.4506, -123.11996],
  ["cazadero", ["Cazadero"], 38.52839, -123.10348],
  ["santarosa", ["Santa Rosa"], 38.44049, -122.7141],
  ["rohnertpark", ["Rohnert Park"], 38.33964, -122.7011],
  ["cotati", ["Cotati"], 38.32668, -122.70684],
  ["penngrove", ["Penngrove"], 38.29758, -122.67566],
  ["petaluma", ["Petaluma"], 38.23258, -122.63647],
  ["windsor", ["Windsor"], 38.54713, -122.81638],
  ["healdsburg", ["Healdsburg"], 38.61068, -122.87014],
  ["fulton", ["Fulton"], 38.49522, -122.77154],
  ["larkfield", ["Larkfield-Wikiup", "Larkfield", "Wikiup"], 38.50668, -122.76012],
  ["markwest", ["Mark West"], 38.50422, -122.73979, true],
  ["kenwood", ["Kenwood"], 38.41356, -122.53475],
  ["glenellen", ["Glen Ellen"], 38.35553, -122.53907],
  ["sonoma", ["Sonoma"], 38.292, -122.45786, true],
  ["geyserville", ["Geyserville"], 38.7129, -122.901],
  ["cloverdale", ["Cloverdale"], 38.80646, -123.01788],
  ["calistoga", ["Calistoga"], 38.5788, -122.57971],
  ["napa", ["Napa"], 38.29714, -122.28553, true],
  ["novato", ["Novato"], 38.1062, -122.56812],
  ["marshall", ["Marshall"], 38.16048, -122.89416, true],
  ["pointreyes", ["Point Reyes Station", "Point Reyes"], 38.08751, -122.81449],
  ["annapolis", ["Annapolis"], 38.72186, -123.36973, true],
  ["searanch", ["The Sea Ranch", "Sea Ranch"], 38.71498, -123.45501],
  ["gualala", ["Gualala"], 38.76744, -123.52983],
];

// ZIP centroids (OSM). PO-box ZIPs use their town's centre.
const ZIPS = {
  95472: [38.39953, -122.83262], 95473: [38.4021, -122.82422], 95444: [38.43638, -122.86921], 95436: [38.49274, -122.91976],
  95465: [38.3999, -122.94043], 95419: [38.42533, -122.96107], 95462: [38.47259, -123.01253], 95446: [38.50743, -122.99408],
  95471: [38.52403, -122.97919], 94922: [38.34598, -122.97133], 94923: [38.31725, -123.02685], 94972: [38.31473, -122.92985],
  94971: [38.2463, -122.90468], 95450: [38.59708, -123.22938], 95430: [38.45308, -123.05371], 95421: [38.53276, -123.0858],
  95401: [38.44303, -122.74086], 95402: [38.44419, -122.7126], 95403: [38.46912, -122.74447], 95404: [38.44457, -122.70315],
  95405: [38.43921, -122.6735], 95406: [38.44049, -122.7141], 95407: [38.41461, -122.73205], 95409: [38.45902, -122.64274],
  94928: [38.34757, -122.68323], 94931: [38.32823, -122.70377], 94951: [38.30997, -122.67155], 94952: [38.24021, -122.64732],
  94954: [38.25582, -122.62339], 95492: [38.53943, -122.81816], 95448: [38.62147, -122.87543], 95439: [38.50381, -122.78004],
  95452: [38.37403, -122.46864], 95442: [38.36775, -122.52762], 95476: [38.28982, -122.46325], 95441: [38.71622, -122.89727],
  95425: [38.80848, -123.0295], 94929: [38.25356, -122.96543], 94940: [38.15547, -122.88777], 94956: [38.0657, -122.80724],
  94945: [38.10956, -122.5731], 94947: [38.08474, -122.55513], 94949: [38.0681, -122.53307], 94558: [38.31225, -122.28646],
  94515: [38.57973, -122.57643], 95480: [38.67148, -123.40313], 95412: [38.67906, -123.28539], 95497: [38.68501, -123.42857],
  95445: [38.77461, -123.5387], 95433: [38.68869, -122.70844], 95431: [38.34851, -122.51774],
};

// Named places that appear in venue strings without a usable address:
// Regional Parks, library branches, campuses, civic buildings.
// [regex, lat, lng]
const PLACES = [
  // Sonoma County Regional Parks
  [/ragle ranch/i, 38.40515, -122.84585],
  [/west county (regional )?trail/i, 38.40925, -122.83508],
  [/joe rodota trail/i, 38.43514, -122.72178],
  [/laguna de santa rosa (foundation|trail)|900 sanford r/i, 38.43051, -122.8251],
  [/foothill regional park/i, 38.5618, -122.79037],
  [/shiloh ranch/i, 38.52882, -122.75193],
  [/doran (regional )?(park|beach)/i, 38.314, -123.04136],
  [/spud point/i, 38.33556, -123.04988],
  [/westside regional park/i, 38.32286, -123.05589],
  [/pinnacle gulch/i, 38.31265, -123.01383],
  [/shorttail gulch|bodega bay trail/i, 38.30631, -123.01069],
  [/environmental discovery center|\bEDC\b/i, 38.456, -122.643], // approximate, Violetti Rd entrance
  [/spring lake/i, 38.44792, -122.65372],
  [/taylor mountain/i, 38.41002, -122.68413],
  [/mark west creek regional/i, 38.535, -122.69], // approximate, Porter Creek Rd
  [/helen putnam/i, 38.21642, -122.65807],
  [/crane creek/i, 38.34544, -122.64524],
  [/colgan creek/i, 38.40199, -122.72957],
  [/hood mountain/i, 38.4705, -122.5755], // approximate
  [/north sonoma mountain/i, 38.3548, -122.57905],
  [/sonoma valley regional park/i, 38.35937, -122.51999],
  [/maxwell farms/i, 38.30076, -122.48101],
  [/tolay lake/i, 38.19496, -122.49993],
  [/riverfront regional park/i, 38.5172, -122.85454],
  [/steelhead beach/i, 38.4995, -122.9013],
  [/sunset beach river park/i, 38.50288, -122.93273],
  [/healdsburg veterans memorial beach/i, 38.60331, -122.85933],
  [/cloverdale river park/i, 38.81596, -123.01185],
  [/gualala point/i, 38.76217, -123.52859],
  [/stillwater cove/i, 38.54881, -123.30299],
  [/andy'?s unity park|3399 moorland/i, 38.39448, -122.71863],
  [/watson school/i, 38.35592, -122.93861],
  [/bayer farm|1550 west ave/i, 38.42148, -122.72789],
  // Sebastopol civic places
  [/ives park/i, 38.40001, -122.82655],
  [/\bthe barlow\b/i, 38.40418, -122.8208],
  [/sebastopol city hall|7120 bodega av/i, 38.40186, -122.82504],
  [/youth annex|425 morris st/i, 38.40883, -122.82035],
  // Library branches (also used for BiblioBus stops that name a branch)
  [/sebastopol (regional )?library|7140 bodega av/i, 38.40181, -122.82517],
  [/occidental (community )?library/i, 38.4066, -122.94743],
  [/forestville (community )?library|7050 covey r/i, 38.48184, -122.89024],
  [/guerneville (regional )?library|14107 armstrong woods/i, 38.50348, -122.99757],
  [/roseland (regional )?library/i, 38.4304, -122.7259],
  [/northwest santa rosa library|coddingtown/i, 38.45806, -122.72688],
  [/central santa rosa library|211 e st(reet)?\b/i, 38.44123, -122.71027],
  [/rincon valley (regional )?library/i, 38.47986, -122.65727],
  [/rohnert park[- ]cotati (regional )?library|library headquarters|6135 state farm/i, 38.35114, -122.70617],
  [/windsor (regional )?library/i, 38.54945, -122.81404],
  // Campuses and halls
  [/green music center|weill hall|sonoma state univ/i, 38.344, -122.66991],
  [/srjc petaluma|petaluma campus|680 sonoma mountain p/i, 38.26829, -122.63487],
  [/shone farm/i, 38.50254, -122.87231],
  [/santa rosa junior college|srjc santa rosa|santa rosa campus|1501 mendocino av/i, 38.45464, -122.72161],
  [/veterans? memorial (building|bldg)[^,]*,?\s*(santa rosa|1351 maple)|1351 maple av/i, 38.43382, -122.69988],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOWN_INDEX = [];
for (const [key, names, lat, lng, strictOnly] of TOWNS) {
  for (const name of names) TOWN_INDEX.push({ key, name, lat, lng, strictOnly: !!strictOnly });
}
TOWN_INDEX.sort((a, b) => b.name.length - a.name.length);
const TOWN_BY_NAME = new Map(TOWN_INDEX.map((t) => [t.name.toLowerCase(), t]));
const TOWN_ALT = TOWN_INDEX.map((t) => escapeRe(t.name).replace(/\\?-/g, "[- ]?").replace(/ /g, "\\s+")).join("|");
// "Santa Rosa, CA", "Sebastopol 95472", "..., Graton" (end of string)
const TOWN_STRICT = new RegExp(`\\b(${TOWN_ALT})\\b(?=\\s*(?:,|\\bCA\\b|\\bCalif(?:ornia)?\\b|\\b9\\d{4}\\b|$|[|;)\\n]))`, "gi");
// "Forestville Methodist Church", but not "Sebastopol Rd" or "Petaluma Hill Rd"
const STREET_WORD = "rd|road|ave|avenue|av|blvd|boulevard|hwy|highway|st|street|way|ln|lane|dr|drive|ct|court|pkwy|parkway|pl|place|cir|circle";
const TOWN_LOOSE = new RegExp(`\\b(${TOWN_ALT})\\b(?!\\.?\\s+(?:[a-z]+\\s+)?(?:${STREET_WORD})\\b\\.?)`, "gi");

const normText = (text) => (squash(decodeEntities(String(text || ""))) || "").replace(/[‘’`´]/g, "'");

function townOf(match) {
  return TOWN_BY_NAME.get(match.toLowerCase().replace(/\s+/g, " ")) || TOWN_BY_NAME.get(match.toLowerCase().replace(/[- ]+/g, "-")) || null;
}

/** The town an address string names: last "Town, CA"-style match, else first loose mention. */
export function findTown(text) {
  const t = normText(text);
  if (!t) return null;
  let strict = null;
  for (const m of t.matchAll(TOWN_STRICT)) strict = townOf(m[1]) || strict;
  if (strict) return strict;
  for (const m of t.matchAll(TOWN_LOOSE)) {
    const town = townOf(m[1]);
    if (town && !town.strictOnly) return town;
  }
  return null;
}

/** Last 9xxxx ZIP in a string (the address ZIP, not a street number). */
export function findZip(text) {
  const all = normText(text).match(/\b9[45]\d{3}\b/g);
  return all ? all.at(-1) : null;
}

/**
 * Place a coordinate-less venue/address string. Returns
 * `{ lat, lng, precision: "place"|"town"|"zip", town, zip }` or null.
 * Order: named place, town name, ZIP centroid.
 */
export function locateByText(text) {
  const t = normText(text);
  if (!t) return null;
  const zip = findZip(t);
  const town = findTown(t);
  for (const [re, lat, lng] of PLACES) {
    if (re.test(t)) return { lat, lng, precision: "place", town: town?.key || null, zip };
  }
  if (town) return { lat: town.lat, lng: town.lng, precision: "town", town: town.key, zip };
  if (zip && ZIPS[zip]) return { lat: ZIPS[zip][0], lng: ZIPS[zip][1], precision: "zip", town: null, zip };
  return null;
}

/**
 * Ring test the site can reuse: "core" | "nearby" | "out" | "unknown".
 * Core = the address ZIP is a core ZIP (95472); with no ZIP, the address names
 * a core town (Sebastopol, Freestone); with neither, the coordinates fall in
 * the core box. Anything else within radiusKm is "nearby". A named non-core
 * town (Graton, Forestville) wins over the core box, which overlaps both.
 */
export function classify(e, region = REGION) {
  const text = [e.venue, e.address].filter(Boolean).join(", ");
  const core = region.core || {};
  const zip = findZip(text);
  const town = findTown(text);
  if (zip && core.zips?.includes(zip)) return "core";
  if (!zip && town && core.towns?.includes(town.key)) return "core";
  let lat = e.lat;
  let lng = e.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const g = locateByText(text);
    if (!g) return "unknown";
    ({ lat, lng } = g);
  }
  if (!inRegion(region, lat, lng)) return "out";
  if (!zip && !town && core.box && inBox(core.box, lat, lng)) return "core";
  return "nearby";
}

/**
 * Coordinates for a fetcher's radius test. Source coordinates win; otherwise
 * the text gazetteer. `fill` is true when the match is a named place, so the
 * fetcher may copy the coordinates into the event.
 */
function placeEvent(lat, lng, text) {
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) return { lat, lng, fill: true, from: "source" };
  const g = locateByText(text);
  if (!g) return null;
  return { lat: g.lat, lng: g.lng, fill: g.precision === "place", from: g.precision };
}

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, { method = "GET", headers = {}, body, timeout = 25_000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
        headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", ...headers },
      });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const throttled = res.status === 429 || res.status === 503 || res.status === 529;
        await sleep((throttled ? 5000 : 2000) * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < retries) {
        await sleep(1500);
        continue;
      }
      throw err;
    }
  }
}

async function getJSON(url, opts = {}) {
  const res = await http(url, { ...opts, headers: { accept: "application/json", ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getText(url, opts = {}) {
  const res = await http(url, { ...opts, headers: { accept: "text/html,application/xhtml+xml,*/*", ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// --- time zones

const offsetFmt = new Map();
function tzOffsetMinutes(ms, tz = TZ) {
  let f = offsetFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset", year: "numeric" });
    offsetFmt.set(tz, f);
  }
  const name = f.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
}

const fmtOffset = (min) => {
  const a = Math.abs(min);
  return `${min < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
};

/** Any instant (ms, Date, or parseable string) -> "YYYY-MM-DDTHH:mm:ss-07:00" in tz. */
export function toZonedISO(input, tz = TZ) {
  const ms = typeof input === "number" ? input : input instanceof Date ? input.getTime() : Date.parse(input);
  if (!Number.isFinite(ms)) return null;
  const off = tzOffsetMinutes(ms, tz);
  return new Date(ms + off * 60_000).toISOString().slice(0, 19) + fmtOffset(off);
}

/** Wall-clock parts in tz -> ISO with that zone's offset (DST-correct). */
function wallToISO(y, mo, d, h = 0, mi = 0, s = 0, tz = TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!Number.isFinite(guess)) return null;
  const off1 = tzOffsetMinutes(guess, tz);
  let ms = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(ms, tz);
  if (off2 !== off1) ms = guess - off2 * 60_000;
  return toZonedISO(ms, tz);
}

/** "2026-10-10 14:00", "2026-10-10T14:00:00", "2026-10-10" + "14:00" -> ISO in tz. */
function wallStringToISO(date, time = "", tz = TZ) {
  const s = `${date || ""} ${time || ""}`.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return wallToISO(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), tz);
}

/** "YYYY-MM-DD" of an instant in Pacific time. */
const ymd = (ms) => toZonedISO(ms).slice(0, 10);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = (s) => MONTHS[String(s || "").slice(0, 3).toLowerCase()] || null;

/** "6:00 pm", "10:00am", "6pm" -> [h, m] (24 h) */
function parseClock(s) {
  const m = String(s || "").match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/i);
  if (!m) return null;
  let h = +m[1] % 12;
  if (/p/i.test(m[3])) h += 12;
  return [h, +(m[2] || 0)];
}

/** "9:30 am - 11:30 am", "10:00am - 3:00pm", "9:30 - 11:30 am" -> { start, end } */
function parseTimeRange(s) {
  const parts = String(s || "").split(/\s*(?:-|\u2013|\u2014|\bto\b)\s*/i).filter(Boolean);
  const end = parts[1] ? parseClock(parts[1]) : null;
  let start = parseClock(parts[0]);
  if (!start && end) {
    const m = String(parts[0]).match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (m) {
      let h = +m[1] % 12;
      if (end[0] >= 12 && h + 12 <= end[0]) h += 12;
      start = [h, +(m[2] || 0)];
    }
  }
  return { start, end };
}

/**
 * "October 21, 2026", "November 23 - 24, 2026", "Nov. 30 - Dec. 2, 2026",
 * "December 31, 2026 - January 1, 2027" -> { y, m, d, y2, m2, d2 }
 */
function parseDateRange(s) {
  const t = squash(String(s || "")) || "";
  const m = t.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s*[-–]\s*(?:([A-Za-z]{3,9})\.?\s+)?(\d{1,2}))?(?:,\s*(\d{4}))?/);
  if (!m || !monthNum(m[1])) return null;
  const mo = monthNum(m[1]);
  const mo2 = m[4] ? monthNum(m[4]) || mo : mo;
  const y2 = +(m[6] || m[3]);
  const y = m[3] ? +m[3] : m[5] && mo2 < mo ? y2 - 1 : y2;
  if (!y) return null;
  return { y, m: mo, d: +m[2], y2, m2: mo2, d2: m[5] ? +m[5] : null };
}

// --- text

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", eacute: "é", aacute: "á", iacute: "í", oacute: "ó",
  uacute: "ú", ntilde: "ñ", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™",
};
export function decodeEntities(s) {
  if (!s) return s;
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (n === 150) return "–"; // cp1252 en dash
      if (n === 146) return "’"; // cp1252 apostrophe (Simpleview)
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

function htmlToText(html) {
  if (!html) return "";
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function squash(s) {
  return s == null ? s : String(s).replace(/\s+/g, " ").trim();
}

function clip(s, max = 400) {
  const t = squash(s);
  if (!t) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "") + "…";
}

const clean = (s) => {
  const t = squash(decodeEntities(s));
  return t || null;
};

const joinAddr = (...parts) => parts.map((p) => squash(p)).filter(Boolean).join(", ") || null;

/** "$20", "Free", "Free - $15", cost_details values -> true/false/null */
function freeFromCost(cost, values) {
  const c = String(cost || "");
  if (/\$\s*[1-9]/.test(c)) return false;
  if (/\bfree\b/i.test(c)) return true;
  if (Array.isArray(values) && values.length) return values.every((v) => !(parseFloat(v) > 0));
  return null;
}

// --- normalization

function makeEvent(source, o) {
  let venue = clean(o.venue) || null;
  // Luma and Eventbrite often put the street in the venue slot; keep it only
  // when there is no separate address holding the location
  if (venue && o.address && /^\d+\s/.test(venue)) venue = null;
  // CitySpark sometimes sends an end at midnight before a timed start
  const end = o.end && o.start && Date.parse(o.end) < Date.parse(o.start) ? null : o.end || null;
  return {
    title: clean(o.title),
    start: o.start || null,
    end,
    allDay: !!o.allDay,
    url: o.url || null,
    venue,
    address: clean(o.address)?.replace(/\s+,/g, ",").replace(/,(\s*,)+/g, ",").replace(/^,\s*|,\s*$/g, "") || null,
    lat: num(o.lat),
    lng: num(o.lng),
    org: clean(o.org) || null,
    source,
    image: o.image || null,
    description: o.description ? clip(o.description, 400) : null,
    free: typeof o.free === "boolean" ? o.free : null,
  };
}

function windowOf(days, now) {
  const from = now.getTime();
  return { from, to: from + days * 86_400_000 };
}

/** Keep events not yet over, starting before the horizon, and not long-running (started >1 day ago). */
function finalize(events, win, keyFn = (e) => `${e.url}|${e.start}`) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (!e || !e.title || !e.start) continue;
    const s = Date.parse(e.start);
    const end = e.end ? Date.parse(e.end) : s;
    if (!Number.isFinite(s)) continue;
    if (s > win.to || s < win.from - 86_400_000) continue;
    if ((Number.isFinite(end) ? end : s) < win.from) continue;
    const k = keyFn(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Run a fetcher body; never throw; attach `stats` to the result. */
async function guarded(name, fn) {
  const stats = { dropped: {} };
  let events;
  try {
    events = await fn(stats);
  } catch (err) {
    console.warn(`[${name}] failed: ${err?.message || err}`);
    stats.error = String(err?.message || err);
    events = [];
  }
  Object.defineProperty(events, "stats", { value: stats, enumerable: false });
  return events;
}

/** Count a discarded row by reason, only if it falls inside the time window. */
function dropper(stats, win) {
  return (reason, start, end) => {
    const s = typeof start === "number" ? start : Date.parse(start || "");
    if (Number.isFinite(s)) {
      const e = end ? (typeof end === "number" ? end : Date.parse(end)) : s;
      if (s > win.to || (Number.isFinite(e) ? e : s) < win.from || s < win.from - 86_400_000) return;
    }
    stats.dropped[reason] = (stats.dropped[reason] || 0) + 1;
  };
}

const opts0 = (o = {}) => ({
  region: o.region || REGION,
  days: o.days ?? 60,
  now: o.now ? new Date(o.now) : new Date(),
  budgetMs: o.budgetMs ?? DEFAULT_BUDGET_MS,
});

/** Grid of points `stepKm` apart covering the region circle, centre first. */
function tileRegion(region, stepKm) {
  const [clat, clng] = region.center;
  const kmLng = KM_PER_DEG_LAT * Math.cos((clat * Math.PI) / 180);
  const n = Math.ceil(region.radiusKm / stepKm);
  const pts = [];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      const dy = i * stepKm;
      const dx = j * stepKm;
      if (Math.hypot(dx, dy) <= region.radiusKm + stepKm / 2) pts.push([clat + dy / KM_PER_DEG_LAT, clng + dx / kmLng, Math.hypot(dx, dy)]);
    }
  }
  return pts.sort((a, b) => a[2] - b[2]).map(([la, ln]) => [la, ln]);
}

// ====================================================================
// 1. Luma (api.lu.ma discover, lat/lng mode)
// ====================================================================

function prosemirrorText(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (node.type === "hard_break") return " ";
  const inner = (node.content || []).map(prosemirrorText).join("");
  return /paragraph|heading|list_item|blockquote/.test(node.type || "") ? inner + " " : inner;
}

export async function fetchLuma(options) {
  return guarded("luma", async (stats) => {
    const { region, days, now, budgetMs } = opts0(options);
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    const deadline = Date.now() + budgetMs;
    // Without discover_place_api_id the endpoint returns every discoverable
    // event within ~70 km of latitude/longitude, sorted by start_at.
    const [lat, lng] = region.center;
    const base = `https://api.lu.ma/discover/get-paginated-events?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&pagination_limit=50`;
    const hits = [];
    let cursor = null;
    for (let page = 0; page < 40 && Date.now() < deadline; page++) {
      let d;
      try {
        d = await getJSON(base + (cursor ? `&pagination_cursor=${encodeURIComponent(cursor)}` : ""));
      } catch (err) {
        if (page === 0) throw err;
        console.warn(`[luma] stopped at page ${page}, keeping ${hits.length}: ${err.message}`);
        break;
      }
      for (const entry of d.entries || []) {
        const ev = entry.event || {};
        const c = ev.coordinate || {};
        if (ev.location_type && ev.location_type !== "offline") { drop("online", ev.start_at, ev.end_at); continue; }
        if (!inRegion(region, num(c.latitude), num(c.longitude))) { drop("outside", ev.start_at, ev.end_at); continue; }
        hits.push(entry);
      }
      const last = d.entries?.at(-1)?.start_at;
      if (!d.has_more || !d.next_cursor || (last && Date.parse(last) > win.to)) break;
      cursor = d.next_cursor;
      await sleep(300);
    }

    const out = [];
    let details = 0;
    for (const entry of hits) {
      const ev = entry.event;
      if (Date.parse(ev.start_at) > win.to) continue;
      const g = ev.geo_address_info || {};
      const shown = g.mode === "shown";
      let description = null;
      if (details < 50 && Date.now() < deadline) {
        try {
          details++;
          const det = await getJSON(`https://api.lu.ma/event/get?event_api_id=${encodeURIComponent(ev.api_id)}`);
          description = squash(prosemirrorText(det.description_mirror)) || null;
        } catch (err) {
          console.warn(`[luma] detail ${ev.api_id}: ${err.message}`);
        }
        await sleep(250);
      }
      const tz = ev.timezone || TZ;
      const cal = entry.calendar || {};
      const hosts = (entry.hosts || []).map((h) => h.name).filter(Boolean);
      const ticket = entry.ticket_info || {};
      out.push(
        makeEvent("luma", {
          title: ev.name,
          start: toZonedISO(ev.start_at, tz),
          end: ev.end_at ? toZonedISO(ev.end_at, tz) : null,
          url: `https://luma.com/${ev.url}`,
          venue: shown ? g.address : null,
          // obfuscated events only expose the town; their coordinate is jittered
          address: shown ? g.full_address : [g.sublocality, g.city_state].filter(Boolean).join(", ") || null,
          lat: ev.coordinate?.latitude,
          lng: ev.coordinate?.longitude,
          org: !cal.is_personal && cal.name ? cal.name : hosts.join(", ") || null,
          image: ev.cover_url,
          description,
          free: typeof ticket.is_free === "boolean" ? ticket.is_free : null,
        }),
      );
    }
    return finalize(out, win);
  });
}

// ====================================================================
// 2. Eventbrite (destination/search with bbox; needs csrftoken cookie)
// ====================================================================

export async function fetchEventbrite(options) {
  return guarded("eventbrite", async (stats) => {
    const { region, days, now, budgetMs } = opts0(options);
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    const deadline = Date.now() + budgetMs;
    const box = region.box;
    // 1) any HTML page sets the csrftoken cookie; /signin/ is the lightest (~40 KB)
    const r0 = await http("https://www.eventbrite.com/signin/", { headers: { accept: "text/html" } });
    const cookies = r0.headers.getSetCookie?.() || [];
    await r0.text();
    const csrf = cookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("csrftoken="))?.slice(10);
    if (!csrf) throw new Error("no csrftoken cookie");
    const referer = "https://www.eventbrite.com/d/ca--sebastopol/events/";
    const bbox = `${box.minLng},${box.minLat},${box.maxLng},${box.maxLat}`;

    const out = [];
    for (let page = 1; page <= 25 && Date.now() < deadline; page++) {
      await sleep(400);
      const body = {
        event_search: { dates: "current_future", dedup: false, bbox, page, page_size: 50, online_events_only: false },
        "expand.destination_event": ["primary_venue", "image", "ticket_availability", "primary_organizer"],
        browse_surface: "search",
      };
      let res;
      try {
        res = await http("https://www.eventbrite.com/api/v3/destination/search/", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-csrftoken": csrf,
            "x-requested-with": "XMLHttpRequest",
            referer,
            cookie: `csrftoken=${csrf}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`search HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      } catch (err) {
        if (page === 1) throw err;
        console.warn(`[eventbrite] stopped at page ${page}, keeping ${out.length}: ${err.message}`);
        break;
      }
      const d = await res.json();
      const results = d.events?.results || [];
      for (const e of results) {
        const tz = e.timezone || TZ;
        const start = wallStringToISO(e.start_date, e.start_time, tz);
        const end = e.end_date ? wallStringToISO(e.end_date, e.end_time, tz) : null;
        if (e.is_cancelled) { drop("cancelled", start, end); continue; }
        if (e.is_online_event) { drop("online", start, end); continue; }
        const v = e.primary_venue || {};
        const a = v.address || {};
        const lat = num(a.latitude), lng = num(a.longitude);
        if (!inRegion(region, lat, lng)) { drop("outside", start, end); continue; }
        out.push(
          makeEvent("eventbrite", {
            title: e.name,
            start,
            end,
            url: e.url,
            venue: v.name,
            address: a.localized_address_display,
            lat,
            lng,
            org: e.primary_organizer?.name,
            image: e.image?.url || e.image?.original?.url,
            description: e.summary,
            free: e.ticket_availability?.is_free,
          }),
        );
      }
      if (!d.events?.pagination?.continuation || results.length === 0) break;
    }
    return finalize(out, win, (e) => e.url);
  });
}

// ====================================================================
// 3. Meetup (gql2, recommendedEvents by lat/lon/radius; no auth)
// ====================================================================

const MEETUP_QUERY = `query($filter: RecommendedEventsFilter!, $first: Int, $after: String, $sort: RecommendedEventsSort) {
  recommendedEvents(filter: $filter, first: $first, after: $after, sort: $sort) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id title description dateTime endTime eventUrl eventType status
      feeSettings { amount currency }
      featuredEventPhoto { highResUrl }
      venue { name address city state postalCode lat lon }
      group { name urlname }
    } }
  }
}`;

export async function fetchMeetup(options) {
  return guarded("meetup", async (stats) => {
    const { region, days, now, budgetMs } = opts0(options);
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    const deadline = Date.now() + budgetMs;
    // recommendedEvents ranks and truncates each query (one 12-mile circle on
    // Sebastopol returns ~34; a tiled union returns ~70). So: one circle the
    // size of the region, then a grid of 12 km-apart circles of 5.6 mi.
    const stepKm = options?.meetupStepKm ?? 12;
    const tileMiles = +((stepKm * 0.75) / 1.609).toFixed(1);
    const circles = [[...region.center, +(region.radiusKm / 1.609).toFixed(1)], ...tileRegion(region, stepKm).map(([a, b]) => [a, b, tileMiles])];
    const startRange = `${toZonedISO(win.from)}[US/Pacific]`;
    const endRange = `${toZonedISO(win.to)}[US/Pacific]`;
    const seen = new Map();
    const dropped = new Set();
    let first = true;
    for (const [lat, lon, radius] of circles) {
      let after = null;
      for (let page = 0; page < 6 && Date.now() < deadline; page++) {
        await sleep(1500);
        const ask = () =>
          http("https://www.meetup.com/gql2", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json", origin: "https://www.meetup.com", referer: "https://www.meetup.com/find/" },
            body: JSON.stringify({
              query: MEETUP_QUERY,
              variables: {
                filter: { lat, lon, radius, eventType: "PHYSICAL", startDateRange: startRange, endDateRange: endRange },
                first: 50,
                after,
                sort: { sortField: "DATETIME" },
              },
            }),
          }).then(async (res) => (res.ok ? res.json() : { errors: [{ message: `HTTP ${res.status}` }] }));
        let d = await ask();
        // gql2 throttles silently: it answers 200 with zero edges. The first
        // (region-sized) circle is never empty for a populated region, so an
        // empty answer there means "throttled": wait and retry once.
        if (first && !d.errors && !(d.data?.recommendedEvents?.edges || []).length) {
          console.warn("[meetup] first circle came back empty; waiting 20 s and retrying");
          await sleep(20_000);
          d = await ask();
          if (!(d.data?.recommendedEvents?.edges || []).length) console.warn("[meetup] still empty: probably throttled");
        }
        first = false;
        if (d.errors?.length) {
          const msg = `gql2: ${d.errors[0].message}`;
          if (seen.size === 0 && lat === circles[0][0] && lon === circles[0][1]) throw new Error(msg);
          console.warn(`[meetup] ${lat.toFixed(3)},${lon.toFixed(3)}: ${msg}`);
          break;
        }
        const rc = d.data?.recommendedEvents;
        for (const { node: e } of rc?.edges || []) {
          if (!e || seen.has(e.id) || dropped.has(e.id)) continue;
          if (e.eventType !== "PHYSICAL" || (e.status && e.status !== "ACTIVE")) { dropped.add(e.id); drop("online", e.dateTime, e.endTime); continue; }
          const v = e.venue || {};
          if (!inRegion(region, num(v.lat), num(v.lon))) { dropped.add(e.id); drop("outside", e.dateTime, e.endTime); continue; }
          seen.set(
            e.id,
            makeEvent("meetup", {
              title: e.title,
              start: toZonedISO(e.dateTime),
              end: e.endTime ? toZonedISO(e.endTime) : null,
              url: e.eventUrl,
              venue: v.name,
              // venue.address is sometimes the full one-line address already
              address:
                v.address && v.city && v.address.toLowerCase().includes(v.city.toLowerCase())
                  ? v.address.replace(/,\s*USA$/i, "")
                  : [v.address, v.city, [v.state, v.postalCode].filter(Boolean).join(" ")].filter((x) => x && x.trim()).join(", "),
              lat: v.lat,
              lng: v.lon,
              org: e.group?.name,
              image: e.featuredEventPhoto?.highResUrl,
              description: e.description,
              free: e.feeSettings ? !(num(e.feeSettings.amount) > 0) : true,
            }),
          );
        }
        if (!rc?.pageInfo?.hasNextPage) break;
        after = rc.pageInfo.endCursor;
      }
    }
    return finalize([...seen.values()], win, (e) => e.url);
  });
}

// ====================================================================
// 4. CitySpark: North Bay Bohemian (= Pacific Sun) + Press Democrat
// ====================================================================

// Pacific Sun ("PacificSun", ppid 9096) returns exactly the Bohemian set, so
// it is not queried. The Press Democrat set is ~95% the same events under
// different ids; rows are merged on CitySpark's PId + UTC start.
export const CITYSPARK_PORTALS = [
  { slug: "Bohemian", ppid: 9093, base: "https://bohemian.com/events-calendar" },
  { slug: "SRPressDemocrat", ppid: 8662, base: "https://www.pressdemocrat.com/events" },
];

const csSlug = (name) => encodeURIComponent(String(name || "-").toLowerCase().replace(/\W+/g, "-"));

export async function fetchCitySpark(options) {
  return guarded("cityspark", async (stats) => {
    const { region, days, now } = opts0(options);
    const budgetMs = options?.budgetMs ?? 160_000; // ~110 requests
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    const deadline = Date.now() + budgetMs;
    // distance is in miles; ask slightly wider and filter by haversine
    const miles = Math.ceil(region.radiusKm / 1.609) + 1;
    const startLocal = `${ymd(win.from)}T00:00`;
    const out = new Map();
    const droppedKeys = new Set();
    for (const portal of options?.portals || CITYSPARK_PORTALS) {
      let skip = 0;
      for (let page = 0; page < 120 && Date.now() < deadline; page++) {
        const body = {
          ppid: portal.ppid, start: startLocal, end: null, labels: [], pick: false, tps: "24", sparks: false,
          sort: "Time", category: [], distance: miles, lat: region.center[0], lng: region.center[1],
          search: "", skip, defFilter: "all",
        };
        let d;
        try {
          d = await getJSON(`https://portal.cityspark.com/api/events/GetEvents/${portal.slug}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (err) {
          if (page === 0 && portal === (options?.portals || CITYSPARK_PORTALS)[0]) throw err;
          console.warn(`[cityspark] ${portal.slug} stopped at skip=${skip}: ${err.message}`);
          break;
        }
        if (!d.Success) {
          console.warn(`[cityspark] ${portal.slug}: ${d.ErrorMessage || "Success=false"}`);
          break;
        }
        const rows = d.Value || [];
        for (const e of rows) {
          const key = `${e.PId}|${e.StartUTC}`;
          if (out.has(key) || droppedKeys.has(key)) continue;
          const start = e.StartUTC ? toZonedISO(e.StartUTC) : null;
          const end = e.EndUTC ? toZonedISO(e.EndUTC) : null;
          if (e.isVirtual || e.Format === 2) { droppedKeys.add(key); drop("online", start, end); continue; }
          const address = joinAddr(e.Address, [e.CityState, e.Zip].filter(Boolean).join(" "));
          const where = placeEvent(num(e.latitude), num(e.longitude), joinAddr(e.Venue, address));
          if (!where) { droppedKeys.add(key); drop("noLocation", start, end); continue; }
          if (!inRegion(region, where.lat, where.lng)) { droppedKeys.add(key); drop("outside", start, end); continue; }
          const allDay = !!e.AllDay || e.HasTime === false;
          out.set(
            key,
            makeEvent("cityspark", {
              title: e.Name,
              start: allDay && e.DateStart ? wallStringToISO(e.DateStart.slice(0, 10)) : start,
              end: allDay ? null : end,
              allDay,
              url: `${portal.base}/#!/details/${csSlug(e.Name)}/${e.PId}/${String(e.DateStart || "").slice(0, 13)}`,
              venue: e.Venue,
              address,
              lat: where.fill ? where.lat : null,
              lng: where.fill ? where.lng : null,
              org: e.ct?.org || null, // contact org only; the contact person stays out
              image: e.LargeImg || e.MediumImg || null,
              description: e.Summary || e.Description,
              free: typeof e.Free === "boolean" ? e.Free : null,
            }),
          );
        }
        skip += rows.length;
        const last = rows.at(-1)?.StartUTC;
        if (!rows.length || (last && Date.parse(last) > win.to)) break;
        await sleep(200);
      }
    }
    return finalize([...out.values()], win, (e) => `${e.title}|${e.start}|${e.venue}`);
  });
}

// ====================================================================
// 5. Sonoma County Library (LibraryMarket LibraryCalendar JSON feed)
// ====================================================================

// Branch ids from the events.sonomalibrary.org filter form; coordinates from
// the US Census geocoder (Forestville and Windsor from OSM).
export const SCL_BRANCHES = {
  102: { name: "Sebastopol Regional Library", address: "7140 Bodega Ave, Sebastopol, CA 95472", lat: 38.40181, lng: -122.82517 },
  100: { name: "Rincon Valley Regional Library", address: "6959 Montecito Blvd, Santa Rosa, CA 95409", lat: 38.47986, lng: -122.65727 },
  84: { name: "Central Santa Rosa Library", address: "211 E St, Santa Rosa, CA 95404", lat: 38.44123, lng: -122.71027 },
  101: { name: "Rohnert Park-Cotati Regional Library", address: "6135 State Farm Dr, Rohnert Park, CA 94928", lat: 38.35114, lng: -122.70617 },
  94: { name: "Forestville Community Library", address: "7050 Covey Rd, Forestville, CA 95436", lat: 38.48184, lng: -122.89024 },
  95: { name: "Guerneville Regional Library", address: "14107 Armstrong Woods Rd, Guerneville, CA 95446", lat: 38.50348, lng: -122.99757 },
  98: { name: "Occidental Community Library", address: "73 Main St, Occidental, CA 95465", lat: 38.4066, lng: -122.94743 },
  97: { name: "Northwest Santa Rosa Library", address: "150 Coddingtown Center, Santa Rosa, CA 95401", lat: 38.45806, lng: -122.72688 },
  189: { name: "Roseland Regional Library", address: "470 Sebastopol Rd, Santa Rosa, CA 95407", lat: 38.4304, lng: -122.7259 },
  104: { name: "Windsor Regional Library", address: "9291 Old Redwood Hwy, Windsor, CA 95492", lat: 38.54945, lng: -122.81404 },
  141: { name: "Sonoma County History & Genealogy Library", address: "725 3rd St, Santa Rosa, CA 95404", lat: 38.44065, lng: -122.71139 },
  99: { name: "Petaluma Regional Library", address: "100 Fairgrounds Dr, Petaluma, CA 94952", lat: 38.24279, lng: -122.63169 },
  96: { name: "Healdsburg Regional Library", address: "139 Piper St, Healdsburg, CA 95448", lat: 38.61426, lng: -122.86974 },
  103: { name: "Sonoma Valley Regional Library", address: "755 W Napa St, Sonoma, CA 95476", lat: 38.29331, lng: -122.47269 },
  93: { name: "Cloverdale Regional Library", address: "401 N Cloverdale Blvd, Cloverdale, CA 95425", lat: 38.80874, lng: -123.01963 },
};
// No fixed site: located by each event's offsite address.
const SCL_ROAMING = { 186: "BiblioBus", 85: "Off Site" };

/** "Venue\nStreet\nCity, CA 95472\nUnited States" -> { venue, address } */
function splitPostal(s) {
  const lines = String(s || "").split(/\n+/).map((x) => squash(decodeEntities(x))).filter((x) => x && !/^united states$/i.test(x));
  if (!lines.length) return { venue: null, address: null };
  const cityIdx = lines.findIndex((l) => /,\s*[A-Z]{2}\s+\d{5}/.test(l));
  const first = lines[0];
  const venue = /^\d/.test(first) ? null : first;
  const rest = venue ? lines.slice(1) : lines;
  // drop room notes between street and city ("On the Stage")
  const street = rest.find((l) => /^\d/.test(l));
  const city = cityIdx >= 0 ? lines[cityIdx] : rest.at(-1);
  return { venue, address: joinAddr(street, city) || joinAddr(...rest) };
}

export async function fetchSonomaLibrary(options) {
  return guarded("sonomalibrary", async (stats) => {
    const { region, days, now, budgetMs } = opts0(options);
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    const deadline = Date.now() + budgetMs;
    // fixed branches inside the radius, plus the roaming ones
    const ids = [
      ...Object.entries(SCL_BRANCHES).filter(([, b]) => inRegion(region, b.lat, b.lng)).map(([id]) => id),
      ...Object.keys(SCL_ROAMING),
    ];
    const qs = ids.map((id) => `branches%5B${id}%5D=${id}`).join("&");
    const rows = [];
    // 31-day chunks; one 60-day request also works (~430 rows, 5 s)
    for (let t = win.from; t < win.to && Date.now() < deadline; t += 31 * 86_400_000) {
      const a = ymd(t);
      const b = ymd(Math.min(t + 31 * 86_400_000, win.to + 86_400_000));
      const d = await getJSON(`https://events.sonomalibrary.org/events/feed/json?_wrapper_format=lc_calendar_feed&start=${a}&end=${b}&${qs}`, { timeout: 45_000 });
      if (Array.isArray(d)) rows.push(...d);
      await sleep(400);
    }
    const out = [];
    for (const e of rows) {
      if (e.public === false || e.published === false || e.moderation_state === "cancelled") continue;
      const branchIds = e.branch && !Array.isArray(e.branch) ? Object.keys(e.branch) : [];
      const tz = e.timezone || TZ;
      const start = wallStringToISO(e.start_date, "", tz);
      const end = e.end_date ? wallStringToISO(e.end_date, "", tz) : null;
      // "All Branches" rows are closure notices ("LIBRARY CLOSED")
      if (!branchIds.length || branchIds.length > 2 || /^library (is )?clos/i.test(e.title || "")) continue;
      const roomNames = e.room && !Array.isArray(e.room) ? Object.values(e.room).join(" ") : "";
      if (e.online_address || /virtual/i.test(roomNames) || branchIds.includes("113")) { drop("online", start, end); continue; }
      const branch = SCL_BRANCHES[branchIds[0]];
      let venue, address, lat = null, lng = null;
      if (e.offsite_address) {
        ({ venue, address } = splitPostal(e.offsite_address));
        const where = placeEvent(null, null, joinAddr(venue, address));
        if (!where) { drop("noLocation", start, end); continue; }
        if (!inRegion(region, where.lat, where.lng)) { drop("outside", start, end); continue; }
        if (where.fill) ({ lat, lng } = where);
        if (branch && !venue) venue = branch.name;
      } else if (branch) {
        ({ name: venue, address, lat, lng } = branch);
        if (!inRegion(region, lat, lng)) { drop("outside", start, end); continue; }
      } else {
        drop("noLocation", start, end);
        continue;
      }
      const allDay = /00:00:00$/.test(e.start_date || "") && /00:00:00$/.test(e.end_date || "");
      out.push(
        makeEvent("sonomalibrary", {
          title: e.title,
          start: allDay ? wallStringToISO(String(e.start_date).slice(0, 10), "", tz) : start,
          end: allDay ? null : end,
          allDay,
          url: e.url,
          venue,
          address,
          lat,
          lng,
          org: "Sonoma County Library",
          image: e.image || null,
          description: htmlToText(e.description),
          free: true,
        }),
      );
    }
    return finalize(out, win);
  });
}

// ====================================================================
// 6-7. The Events Calendar REST (WordPress "tribe"): sebastopolcalendar.com
//      (the City of Sebastopol's community calendar) and Farm Trails
// ====================================================================

async function fetchTribe(source, base, stats, options, { defaultTown = null, org = null, venueHost = false } = {}) {
  const { region, days, now, budgetMs } = opts0(options);
  const win = windowOf(days, now);
  const drop = dropper(stats, win);
  const deadline = Date.now() + budgetMs;
  const out = [];
  for (let page = 1; page <= 15 && Date.now() < deadline; page++) {
    const url = `${base}/wp-json/tribe/events/v1/events?start_date=${ymd(win.from)}&end_date=${ymd(win.to)}&per_page=50&page=${page}`;
    let d;
    try {
      d = await getJSON(url, { timeout: 40_000 });
    } catch (err) {
      if (page === 1) throw err;
      console.warn(`[${source}] stopped at page ${page}: ${err.message}`);
      break;
    }
    for (const e of d.events || []) {
      const allDay = !!e.all_day;
      const tz = e.timezone || TZ;
      const start = allDay ? wallStringToISO(String(e.start_date).slice(0, 10), "", tz) : e.utc_start_date ? toZonedISO(Date.parse(e.utc_start_date.replace(" ", "T") + "Z")) : wallStringToISO(e.start_date, "", tz);
      const end = allDay ? null : e.utc_end_date ? toZonedISO(Date.parse(e.utc_end_date.replace(" ", "T") + "Z")) : null;
      if (e.is_virtual) { drop("online", start, end); continue; }
      // venue is an object, [] when blank, or occasionally [object]
      const v0 = Array.isArray(e.venue) ? e.venue[0] : e.venue;
      const v = v0 && typeof v0 === "object" ? v0 : {};
      const venue = clean(v.venue);
      let address = joinAddr(v.address, v.city, [v.stateprovince || v.state || (v.city ? "CA" : ""), v.zip].filter(Boolean).join(" "));
      let where = placeEvent(num(v.geo_lat), num(v.geo_lng), joinAddr(venue, address));
      if (!where && defaultTown) {
        // single-town calendar: a blank venue means "somewhere in town"
        const t = TOWN_BY_NAME.get(defaultTown.toLowerCase());
        where = { lat: t.lat, lng: t.lng, fill: false, from: "default" };
        address = address || `${defaultTown}, CA`;
      }
      if (!where) { drop("noLocation", start, end); continue; }
      if (!inRegion(region, where.lat, where.lng)) { drop("outside", start, end); continue; }
      const organizer = Array.isArray(e.organizer) ? e.organizer[0]?.organizer : null;
      out.push(
        makeEvent(source, {
          title: e.title,
          start,
          end,
          allDay,
          url: e.url,
          venue,
          address,
          lat: where.fill ? where.lat : null,
          lng: where.fill ? where.lng : null,
          // On Farm Trails the venue is the farm that runs the event.
          org: organizer || (venueHost ? venue : null) || org,
          image: e.image?.url || null,
          description: htmlToText(e.description),
          free: freeFromCost(e.cost, e.cost_details?.values),
        }),
      );
    }
    if (page >= (d.total_pages || 1)) break;
    await sleep(400);
  }
  return finalize(out, win);
}

export async function fetchSebastopolCalendar(options) {
  // custom_fields on this site hold submitters' names and emails; never read them
  return guarded("sebcalendar", (stats) => fetchTribe("sebcalendar", "https://sebastopolcalendar.com", stats, options, { defaultTown: "Sebastopol" }));
}

export async function fetchFarmTrails(options) {
  return guarded("farmtrails", (stats) => fetchTribe("farmtrails", "https://www.farmtrails.org", stats, options, { org: "Sonoma County Farm Trails", venueHost: true }));
}

// ====================================================================
// 8. City of Sebastopol public meetings (WordPress page, AddEvent markup)
// ====================================================================

const SEB_CITY_VENUES = [
  [/youth annex|425 morris/i, "425 Morris St, Sebastopol, CA 95472", 38.40883, -122.82035],
  [/city hall|7120 bodega/i, "7120 Bodega Ave, Sebastopol, CA 95472", 38.40186, -122.82504],
  [/teen center|community center|390 morris/i, "390 Morris St, Sebastopol, CA 95472", null, null],
];

export async function fetchSebastopolCity(options) {
  return guarded("sebcity", async (stats) => {
    const { region, days, now } = opts0(options);
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    const html = await getText("https://www.cityofsebastopol.gov/your-government/city-meeting-calendar/");
    const blocks = html.split(/class="addeventatc/).slice(1);
    const spanOf = (b, cls) => clean(htmlToText((b.match(new RegExp(`<span class="${cls}">([\\s\\S]*?)</span>`)) || [])[1] || ""));
    const out = [];
    let details = 0;
    for (const b of blocks) {
      const title = spanOf(b, "title");
      const startTxt = spanOf(b, "start");
      let loc = spanOf(b, "location");
      let street = null;
      const url = (b.match(/href="(https:\/\/www\.cityofsebastopol\.gov\/events\/[^"]+)"/) || [])[1] || null;
      const dm = startTxt && parseDateRange(startTxt);
      const tm = parseClock(startTxt);
      if (!title || !dm) continue;
      const start = wallToISO(dm.y, dm.m, dm.d, tm ? tm[0] : 0, tm ? tm[1] : 0);
      if (Date.parse(start) > win.to) continue;
      if (/^cancel+ed\b/i.test(title)) { drop("cancelled", start); continue; }
      // the list often leaves the location blank; the meeting page has it
      if (!loc && url && details < 30) {
        details++;
        await sleep(300);
        try {
          const page = await getText(url);
          loc = spanOf(page, "location");
          street = clean(htmlToText((page.match(/<p class="meet-adddress">([\s\S]*?)<\/p>/) || [])[1] || ""));
        } catch (err) {
          console.warn(`[sebcity] ${url}: ${err.message}`);
        }
      }
      const known = SEB_CITY_VENUES.find(([re]) => re.test(`${loc || ""} ${street || ""}`));
      const address = known ? known[1] : street ? street.replace(/,\s*USA$/i, "") : "Sebastopol, CA 95472";
      const lat = known?.[2] ?? null, lng = known?.[3] ?? null;
      const where = placeEvent(lat, lng, joinAddr(loc, address));
      if (!where || !inRegion(region, where.lat, where.lng)) { drop("outside", start); continue; }
      out.push(
        makeEvent("sebcity", {
          title,
          start,
          end: null, // the page's end time is a placeholder (12:00 am)
          allDay: !tm,
          url,
          venue: loc || null,
          address,
          lat,
          lng,
          org: "City of Sebastopol",
          description: null,
          free: true,
        }),
      );
    }
    return finalize(out, win);
  });
}

// ====================================================================
// 9. Sonoma County Regional Parks (activities calendar HTML)
// ====================================================================

export async function fetchRegionalParks(options) {
  return guarded("parks", async (stats) => {
    const { region, days, now } = opts0(options);
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    // Registration links point at secure.sonomacountyparks.org, which sits
    // behind an AWS WAF captcha; this fetcher never requests them.
    const html = await getText("https://parks.sonomacounty.gov/play/calendar");
    const out = [];
    for (const blk of html.split(/<div class="listing">/).slice(1)) {
      const a = blk.match(/<h3[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const rawTitle = htmlToText(a[2].replace(/<strong[^>]*>[\s\S]*?<\/strong>\s*(<span class="pipe">\|<\/span>)?/i, ""));
      const soldOut = /sold out/i.test(a[2]);
      const dateTxt = clean(htmlToText((blk.match(/<span class="date">([\s\S]*?)<\/span>/) || [])[1]));
      const timeTxt = clean(htmlToText((blk.match(/<span class="time">([\s\S]*?)<\/span>/) || [])[1]));
      const loc = clean(htmlToText((blk.match(/<span class="location">([\s\S]*?)<\/span>/) || [])[1]));
      const teaser = clean(htmlToText((blk.match(/<\/p>\s*<p>([\s\S]*?)<\/p>/) || [])[1]));
      const dr = parseDateRange(dateTxt);
      if (!dr) continue;
      const { start: t1, end: t2 } = parseTimeRange(timeTxt);
      const start = wallToISO(dr.y, dr.m, dr.d, t1?.[0] ?? 0, t1?.[1] ?? 0);
      const endDay = dr.d2 ? [dr.y2, dr.m2, dr.d2] : [dr.y, dr.m, dr.d];
      const end = t2 ? wallToISO(...endDay, t2[0], t2[1]) : dr.d2 ? wallToISO(...endDay, 23, 59) : null;
      if (!loc) { drop("noLocation", start, end); continue; }
      const where = placeEvent(null, null, loc);
      if (!where) { console.warn(`[parks] unknown location "${loc}"`); drop("noLocation", start, end); continue; }
      if (!inRegion(region, where.lat, where.lng)) { drop("outside", start, end); continue; }
      out.push(
        makeEvent("parks", {
          title: rawTitle,
          start,
          end,
          allDay: !t1,
          url: decodeEntities(a[1]),
          venue: loc,
          address: null,
          lat: where.lat,
          lng: where.lng,
          org: "Sonoma County Regional Parks",
          description: [soldOut ? "Sold out." : null, teaser].filter(Boolean).join(" ") || null,
        }),
      );
    }
    return finalize(out, win);
  });
}

// ====================================================================
// 10. Sonoma County Tourism (sonomacounty.com, "dataengine" month view)
// ====================================================================

export async function fetchSonomaTourism(options) {
  return guarded("tourism", async (stats) => {
    const { region, days, now, budgetMs } = opts0(options);
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    const deadline = Date.now() + budgetMs;
    const months = [];
    for (let t = win.from; ; ) {
      const ym = ymd(t).slice(0, 7);
      if (!months.includes(ym)) months.push(ym);
      if (t >= win.to) break;
      t = Math.min(t + 27 * 86_400_000, win.to);
    }
    const out = [];
    for (const ym of months) {
      if (Date.now() > deadline) break;
      const d = await getJSON(
        `https://www.sonomacounty.com/wp-admin/admin-ajax.php?action=dataengine-events&_view=month&_supertag=&_city=&_type=&_month=${ym.replace("-", "")}`,
        { timeout: 40_000 },
      );
      const coords = new Map(Object.values(d.map || {}).map((m) => [m.permalink, [num(m.lat), num(m.lng)]]));
      let day = null;
      for (const row of String(d.listing || "").split(/<tr\b/)) {
        const dd = row.match(/data-date="(\d{4}-\d{2}-\d{2})"/);
        if (dd) { day = dd[1]; continue; }
        const link = row.match(/<a href="([^"]+)"><h3 class="event-title">([\s\S]*?)<\/h3>(?:<small class="event-city">([\s\S]*?)<\/small>)?/);
        if (!link || !day) continue;
        const timeTxt = clean(htmlToText((row.match(/<td class="list-event-time">([\s\S]*?)<\/td>/) || [])[1]));
        const { start: t1, end: t2 } = parseTimeRange(timeTxt);
        const [y, mo, da] = day.split("-").map(Number);
        const start = wallToISO(y, mo, da, t1?.[0] ?? 0, t1?.[1] ?? 0);
        const end = t2 ? wallToISO(y, mo, da, t2[0], t2[1]) : null;
        const city = clean(htmlToText(link[3] || ""));
        const [lat, lng] = coords.get(link[1]) || [null, null];
        const where = placeEvent(lat, lng, city && !/^sonoma county/i.test(city) ? city : "");
        if (!where) { drop("noLocation", start, end); continue; }
        if (!inRegion(region, where.lat, where.lng)) { drop("outside", start, end); continue; }
        const img = (row.match(/<img[^>]+(?:data-src|src)=['"](https:[^'"]+)['"]/) || [])[1] || null;
        out.push(
          makeEvent("tourism", {
            title: htmlToText(link[2]),
            start,
            end,
            allDay: !t1,
            url: link[1],
            venue: null, // the month view has no venue name; the event page does
            address: city,
            lat: where.fill ? where.lat : null,
            lng: where.fill ? where.lng : null,
            org: null,
            image: img,
            description: null,
          }),
        );
      }
      await sleep(500);
    }
    return finalize(out, win);
  });
}

// ====================================================================
// 11. Sebastopol Area Chamber of Commerce (GrowthZone calendar + detail pages)
// ====================================================================

export async function fetchChamber(options) {
  return guarded("chamber", async (stats) => {
    const { region, days, now, budgetMs } = opts0(options);
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    const deadline = Date.now() + budgetMs;
    const base = "https://business.sebastopol.org";
    // 1) month grids: each detail link sits under its day's /events/index/<date> link
    const links = new Map(); // url -> first date seen
    const fromDay = ymd(win.from);
    const toDay = ymd(win.to);
    const months = [];
    for (let t = win.from; ; ) {
      const ym = ymd(t).slice(0, 7);
      if (!months.includes(ym)) months.push(ym);
      if (t >= win.to) break;
      t = Math.min(t + 27 * 86_400_000, win.to);
    }
    for (const ym of months) {
      const html = await getText(`${base}/events/calendar/${ym}-15`);
      let day = null;
      for (const m of html.matchAll(/\/events\/index\/(\d{4}-\d{2}-\d{2})|href="(https:\/\/business\.sebastopol\.org\/events\/details\/[^"?#]+)/g)) {
        if (m[1]) { day = m[1]; continue; }
        if (day && day >= fromDay && day <= toDay && !links.has(m[2])) links.set(m[2], day);
      }
      await sleep(400);
    }
    // 2) detail pages hold schema.org microdata (UTC start/end, location)
    const out = [];
    let n = 0;
    for (const url of links.keys()) {
      if (n++ >= 60 || Date.now() > deadline) break;
      let html;
      try {
        html = await getText(url);
      } catch (err) {
        console.warn(`[chamber] ${url}: ${err.message}`);
        continue;
      } finally {
        await sleep(350);
      }
      const prop = (p) => (html.match(new RegExp(`itemprop="${p}"\\s+content="([^"]*)"`)) || [])[1] || null;
      const startUtc = prop("startDate");
      if (!startUtc) continue;
      const start = toZonedISO(startUtc);
      const endUtc = prop("endDate");
      const end = endUtc ? toZonedISO(endUtc) : null;
      const title = prop("name") || (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
      const locBlock = (html.match(/itemprop="location"[\s\S]*?<\/div>/) || [])[0] || "";
      const loc = clean(htmlToText((locBlock.match(/itemprop="name"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || ""));
      const street = clean(htmlToText((locBlock.match(/itemprop="streetAddress"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || ""));
      const city = clean(htmlToText((locBlock.match(/itemprop="addressLocality"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || ""));
      const zip = clean(htmlToText((locBlock.match(/itemprop="postalCode"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || ""));
      let address = joinAddr(street, [city, zip].filter(Boolean).join(" "));
      let where = placeEvent(null, null, joinAddr(loc, address));
      if (!where) {
        // the Chamber's own calendar: a venue with no town is in Sebastopol
        const t = TOWN_BY_NAME.get("sebastopol");
        where = { lat: t.lat, lng: t.lng, fill: false, from: "default" };
        address = address || "Sebastopol, CA";
      }
      if (!inRegion(region, where.lat, where.lng)) { drop("outside", start, end); continue; }
      const desc = htmlToText((html.match(/class="[^"]*gz-event-description[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || "");
      const img = (html.match(/<img[^>]+class="[^"]*gz-event-image[^"]*"[^>]+src="([^"]+)"/) || html.match(/class="[^"]*gz-event-image[^"]*"[\s\S]{0,300}?<img[^>]+src="([^"]+)"/) || [])[1] || null;
      out.push(
        makeEvent("chamber", {
          title,
          start,
          end,
          url,
          venue: loc,
          address,
          lat: where.fill ? where.lat : null,
          lng: where.fill ? where.lng : null,
          org: "Sebastopol Area Chamber of Commerce",
          image: img,
          description: desc,
        }),
      );
    }
    return finalize(out, win);
  });
}

// ====================================================================
// 12. Santa Rosa Junior College (LiveWhale calendar JSON)
// ====================================================================

const SRJC_SITES = [
  [/petaluma/i, null], // SRJC Petaluma campus: outside a 22 km Sebastopol radius
  [/shone farm/i, "Shone Farm, 7450 Steve Olson Ln, Forestville, CA 95436", 38.50254, -122.87231],
  [/public safety training|\bpstc\b|skylane/i, "Public Safety Training Center, 5743 Skylane Blvd, Windsor, CA 95492", 38.52261, -122.80188],
  [
    /santa rosa campus|srjc santa rosa|doyle library|bertolini|burbank (auditorium|conference)|newman auditorium|analy hall|pioneer hall|garcia hall|emeritus hall|maggini hall|bech hall|shuhaw|haehl pavilion|tauzer|lindley center|race building|multicultural museum|frank p\.? doyle|plover hall|barnett hall|quinn swim|bailey field|1501 mendocino/i,
    "Santa Rosa Junior College, 1501 Mendocino Ave, Santa Rosa, CA 95401",
    38.45464,
    -122.72161,
  ],
];

export async function fetchSrjc(options) {
  return guarded("srjc", async (stats) => {
    const { region, days, now, budgetMs } = opts0(options);
    const win = windowOf(days, now);
    const drop = dropper(stats, win);
    const deadline = Date.now() + budgetMs;
    const fields = "location,summary,thumbnail,group_title,cost,location_latitude,location_longitude";
    let url = `https://calendar.santarosa.edu/live/json/events/start_date/${ymd(win.from)}/end_date/${ymd(win.to)}/response_fields/${fields}`;
    const rows = [];
    for (let page = 0; url && page < 20 && Date.now() < deadline; page++) {
      const d = await getJSON(url, { timeout: 40_000 });
      rows.push(...(d.data || []));
      url = d.links?.next || null;
      await sleep(400);
    }
    // LiveWhale lists a repeating all-day exhibit once per day; keep the first
    // day in the window and stretch `end` to the last one.
    const byId = new Map();
    const out = [];
    for (const e of rows) {
      const allDay = !!e.is_all_day;
      const start = allDay ? wallStringToISO(String(e.date_iso).slice(0, 10)) : toZonedISO(e.date_iso);
      const end = allDay ? null : e.date2_iso ? toZonedISO(e.date2_iso) : null;
      if (e.is_canceled) { drop("cancelled", start, end); continue; }
      const loc = clean(htmlToText(e.location || ""));
      if (e.is_online || /^(online|zoom|virtual)\b/i.test(loc || "")) { drop("online", start, end); continue; }
      if (!loc) { drop("noLocation", start, end); continue; }
      const site = SRJC_SITES.find(([re]) => re.test(loc));
      let lat = num(e.location_latitude), lng = num(e.location_longitude), address = null;
      if (site && !site[1]) { drop("outside", start, end); continue; }
      if (site) [, address, lat, lng] = site;
      else {
        const where = placeEvent(lat, lng, loc);
        if (!where) { drop("noLocation", start, end); continue; }
        ({ lat, lng } = where);
      }
      if (!inRegion(region, lat, lng)) { drop("outside", start, end); continue; }
      if (allDay && byId.has(e.id)) {
        byId.get(e.id).end = start;
        continue;
      }
      // `thumbnail` is an 80x80 crop URL; the same path serves any size
      const image = typeof e.thumbnail === "string" ? e.thumbnail.replace(/\/width\/\d+\/height\/\d+\//, "/width/640/height/640/") : null;
      const ev = makeEvent("srjc", {
        title: htmlToText(e.title),
        start,
        end,
        allDay,
        url: e.url,
        venue: loc,
        address,
        lat,
        lng,
        org: e.group_title && e.group_title !== "Main Calendar" ? `SRJC ${e.group_title}` : "Santa Rosa Junior College",
        image,
        description: htmlToText(e.summary || ""),
        free: freeFromCost(e.cost),
      });
      if (allDay) byId.set(e.id, ev);
      out.push(ev);
    }
    return finalize(out, win);
  });
}

// ====================================================================
// Left out on purpose (details in aggregators.md):
//   City of Santa Rosa (srcity.org): Cloudflare "Sorry, you have been blocked"
//     on Calendar.aspx, iCalendar.aspx and robots.txt.
//   Sonoma State University (sonoma.edu): Cloudflare managed challenge.
//   secure.sonomacountyparks.org: AWS WAF captcha.
//   Pacific Sun: identical CitySpark set to the Bohemian.
// ====================================================================

export const FETCHERS = {
  luma: fetchLuma,
  eventbrite: fetchEventbrite,
  meetup: fetchMeetup,
  cityspark: fetchCitySpark,
  sonomalibrary: fetchSonomaLibrary,
  sebcalendar: fetchSebastopolCalendar,
  sebcity: fetchSebastopolCity,
  parks: fetchRegionalParks,
  tourism: fetchSonomaTourism,
  chamber: fetchChamber,
  farmtrails: fetchFarmTrails,
  srjc: fetchSrjc,
};

// Names as they appear on the site, under "Listed by".
export const LABELS = {
  luma: "Luma",
  eventbrite: "Eventbrite",
  meetup: "Meetup",
  cityspark: "North Bay Bohemian and Press Democrat calendars",
  sonomalibrary: "Sonoma County Library",
  sebcalendar: "What's Happening in Sebastopol",
  sebcity: "City of Sebastopol",
  parks: "Sonoma County Regional Parks",
  tourism: "Sonoma County Tourism",
  chamber: "Sebastopol Chamber of Commerce",
  farmtrails: "Sonoma County Farm Trails",
  srjc: "Santa Rosa Junior College",
};

// SRJC is read as a group calendar in data/orgs.json instead, where its
// student-services listings are filtered out; run it here with SOURCES=srjc.
export const DEFAULT_SOURCES = Object.keys(FETCHERS).filter((k) => k !== "srjc");

/** Run fetchers in parallel (each one is sequential inside). Returns { events, bySource, ms }. */
export async function fetchAll(options = {}, only = DEFAULT_SOURCES) {
  const t0 = Date.now();
  const bySource = {};
  await Promise.all(
    only.map(async (name) => {
      const t = Date.now();
      const events = await FETCHERS[name](options);
      bySource[name] = { events, stats: events.stats || { dropped: {} }, ms: Date.now() - t };
    }),
  );
  const events = Object.values(bySource).flatMap((s) => s.events).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { events, bySource, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const days = arg("days") ? +arg("days") : 60;
  const only = arg("only") ? arg("only").split(",") : DEFAULT_SOURCES;
  const nSamples = arg("samples") ? +arg("samples") : 3;
  const region = REGION;
  const { events, bySource, ms } = await fetchAll({ days, region }, only);
  const fmt = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") : "?");
  console.log(`\nRegion ${region.name}: centre ${region.center.join(", ")}, radius ${region.radiusKm} km, box ${JSON.stringify(region.box)}`);
  console.log(`Next ${days} days, run ${(ms / 1000).toFixed(1)} s\n`);
  console.log(`${"source".padEnd(14)} ${"kept".padStart(5)} ${"core".padStart(5)} ${"nearby".padStart(6)} ${"unkn".padStart(5)} ${"dropped".padStart(7)}  coords  time   dropped by reason`);
  const totals = { kept: 0, core: 0, nearby: 0, unknown: 0, dropped: 0 };
  const rows = [];
  for (const name of only) {
    const s = bySource[name];
    const rings = { core: 0, nearby: 0, out: 0, unknown: 0 };
    for (const e of s.events) rings[classify(e, region)]++;
    const dropped = Object.values(s.stats.dropped).reduce((a, b) => a + b, 0);
    const withCoords = s.events.filter((e) => e.lat !== null).length;
    totals.kept += s.events.length; totals.core += rings.core; totals.nearby += rings.nearby; totals.unknown += rings.unknown + rings.out; totals.dropped += dropped;
    console.log(
      `${name.padEnd(14)} ${String(s.events.length).padStart(5)} ${String(rings.core).padStart(5)} ${String(rings.nearby).padStart(6)} ${String(rings.unknown + rings.out).padStart(5)} ${String(dropped).padStart(7)}  ${String(withCoords).padStart(6)} ${(s.ms / 1000).toFixed(1).padStart(5)}s  ${JSON.stringify(s.stats.dropped)}${s.stats.error ? `  ERROR: ${s.stats.error}` : ""}`,
    );
    rows.push([name, s]);
  }
  console.log(`${"TOTAL".padEnd(14)} ${String(totals.kept).padStart(5)} ${String(totals.core).padStart(5)} ${String(totals.nearby).padStart(6)} ${String(totals.unknown).padStart(5)} ${String(totals.dropped).padStart(7)}  (before cross-source dedupe)\n`);
  for (const [name, s] of rows) {
    console.log(`${name}:`);
    const core = s.events.filter((e) => classify(e, region) === "core");
    const near = s.events.filter((e) => classify(e, region) !== "core");
    const half = Math.min(core.length, Math.max(nSamples - near.length, Math.ceil(nSamples / 2)));
    const pick = [...core.slice(0, half), ...near.slice(0, nSamples - half)];
    for (const e of pick.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
      const ring = classify(e, region);
      const g = Number.isFinite(e.lat) ? { lat: e.lat, lng: e.lng } : locateByText([e.venue, e.address].filter(Boolean).join(", "));
      const km = g ? distanceKm(region, g.lat, g.lng) : null;
      console.log(`    [${ring.padEnd(6)}] ${fmt(e.start)}  ${e.title.slice(0, 60)}  @ ${[e.venue, e.address].filter(Boolean).join(", ").slice(0, 70) || "?"}${km !== null ? `  (${km.toFixed(1)} km)` : ""}`);
    }
  }
  const out = arg("out");
  if (out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(out, JSON.stringify(events, null, 2));
    console.log(`\nwrote ${out} (${events.length} events)`);
  }
}
