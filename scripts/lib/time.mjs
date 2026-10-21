// Time zone helpers. Every event on the site is shown in Pacific time, and
// feeds hand us wall-clock times in assorted zones, so all conversion runs
// through Intl rather than a fixed offset (DST changes twice a year).

export const TZ = "America/Los_Angeles";

// Windows zone names that show up in Outlook-made ICS files.
const WINDOWS_ZONES = {
  "pacific standard time": "America/Los_Angeles",
  "mountain standard time": "America/Denver",
  "central standard time": "America/Chicago",
  "eastern standard time": "America/New_York",
  "gmt standard time": "Europe/London",
  utc: "UTC",
};

export function normalizeZone(tzid) {
  if (!tzid) return TZ;
  let z = String(tzid).replace(/^"|"$/g, "").trim();
  // "/mozilla.org/20070129_1/America/Los_Angeles" and similar prefixes
  const m = z.match(/([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/);
  if (WINDOWS_ZONES[z.toLowerCase()]) return WINDOWS_ZONES[z.toLowerCase()];
  if (m) z = m[1];
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return TZ;
  }
}

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );
  }
  return dtfCache.get(tz);
}

// Wall-clock parts of a UTC instant in a zone.
export function partsIn(utcMs, tz = TZ) {
  const v = {};
  for (const p of dtf(tz).formatToParts(new Date(utcMs))) v[p.type] = p.value;
  return {
    y: +v.year,
    mo: +v.month,
    d: +v.day,
    h: +v.hour,
    mi: +v.minute,
    s: +v.second,
  };
}

function offsetMs(utcMs, tz) {
  const p = partsIn(utcMs, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// Wall-clock time in a zone to a UTC instant.
export function zonedToUtc(y, mo, d, h = 0, mi = 0, s = 0, tz = TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = offsetMs(guess, tz);
  let utc = guess - off1;
  const off2 = offsetMs(utc, tz);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

const pad = (n) => String(n).padStart(2, "0");

// ISO 8601 with the Pacific offset, e.g. 2026-10-11T09:00:00-07:00
export function toPacificIso(utcMs) {
  const p = partsIn(utcMs, TZ);
  const off = offsetMs(utcMs, TZ) / 60000;
  const sign = off <= 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// YYYY-MM-DD of an instant in Pacific time.
export function pacificDayKey(utcMs) {
  const p = partsIn(utcMs, TZ);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

// Parse loose date strings from JSON feeds. Strings without an offset are
// read as Pacific wall-clock time.
export function parseLooseDate(value, tz = TZ) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const s = String(value).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    return zonedToUtc(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), tz);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
