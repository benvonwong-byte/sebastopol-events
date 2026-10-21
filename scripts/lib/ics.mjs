// ICS (iCalendar) parsing with recurrence expansion.
//
// Neighborhood calendars are mostly recurring things: a weekly market, a
// monthly association meeting, a Saturday cleanup. A parser that only reads
// DTSTART drops every series whose first date is in the past, so this one
// expands RRULE (DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL,
// BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS), honours EXDATE, and lets
// RECURRENCE-ID overrides replace the instance they modify.

import { normalizeZone, zonedToUtc, partsIn, TZ } from "./time.mjs";

const MAX_INSTANCES = 400;
const DAY_MS = 86400000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function unescapeText(v) {
  return String(v ?? "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

// Split "NAME;P1=a;P2="b:c":value" at the first colon outside quotes.
function parseLine(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ":" && !inQuote) {
      const head = line.slice(0, i);
      const value = line.slice(i + 1);
      const [name, ...rawParams] = head.split(";");
      const params = {};
      for (const p of rawParams) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
      }
      return { name: name.toUpperCase(), params, value };
    }
  }
  return null;
}

// Parse a DATE or DATE-TIME value into { utc, allDay, local, tz }.
function parseDateValue(value, params, calTz) {
  const m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const local = { y: +y, mo: +mo, d: +d, h: +(h ?? 0), mi: +(mi ?? 0), s: +(s ?? 0) };
  if (!h || params.VALUE === "DATE") {
    // All-day: anchor at noon Pacific so the calendar date never shifts.
    return { utc: zonedToUtc(local.y, local.mo, local.d, 12, 0, 0, TZ), allDay: true, local, tz: TZ };
  }
  if (z) {
    return { utc: Date.UTC(local.y, local.mo - 1, local.d, local.h, local.mi, local.s), allDay: false, local: null, tz: "UTC" };
  }
  const tz = normalizeZone(params.TZID || calTz);
  return { utc: zonedToUtc(local.y, local.mo, local.d, local.h, local.mi, local.s, tz), allDay: false, local, tz };
}

function parseRrule(v) {
  const r = {};
  for (const part of v.split(";")) {
    const [k, val] = part.split("=");
    if (k && val != null) r[k.toUpperCase()] = val;
  }
  return r;
}

// Calendar arithmetic on plain {y, mo, d} dates (UTC-noon math keeps it DST-free).
const toDayNum = (y, mo, d) => Math.floor(Date.UTC(y, mo - 1, d, 12) / DAY_MS);
function fromDayNum(n) {
  const dt = new Date(n * DAY_MS + DAY_MS / 2);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
const weekday = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0, 12)).getUTCDate();

function parseByDay(list) {
  return (list || "")
    .split(",")
    .filter(Boolean)
    .map((s) => {
      const m = s.trim().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i);
      return m ? { n: m[1] ? +m[1] : 0, wd: WEEKDAYS.indexOf(m[2].toUpperCase()) } : null;
    })
    .filter(Boolean);
}

// Candidate days of one month for MONTHLY/YEARLY rules.
function monthCandidates(y, mo, rule, start) {
  const dim = daysInMonth(y, mo);
  let days = [];
  if (rule.BYMONTHDAY) {
    for (const s of rule.BYMONTHDAY.split(",")) {
      const n = +s;
      const d = n > 0 ? n : dim + n + 1;
      if (d >= 1 && d <= dim) days.push(d);
    }
  } else if (rule.BYDAY) {
    for (const { n, wd } of parseByDay(rule.BYDAY)) {
      const all = [];
      for (let d = 1; d <= dim; d++) if (weekday(y, mo, d) === wd) all.push(d);
      if (n === 0) days.push(...all);
      else {
        const pick = n > 0 ? all[n - 1] : all[all.length + n];
        if (pick) days.push(pick);
      }
    }
  } else {
    if (start.d <= dim) days.push(start.d);
  }
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.BYSETPOS && days.length) {
    const picked = [];
    for (const s of rule.BYSETPOS.split(",")) {
      const p = +s;
      const d = p > 0 ? days[p - 1] : days[days.length + p];
      if (d) picked.push(d);
    }
    days = [...new Set(picked)].sort((a, b) => a - b);
  }
  return days;
}

// Expand one recurring VEVENT into UTC start instants inside [from, to].
function expand(start, rule, exdates, from, to) {
  const freq = (rule.FREQ || "").toUpperCase();
  const interval = Math.max(1, +(rule.INTERVAL || 1));
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  let until = Infinity;
  if (rule.UNTIL) {
    const u = parseDateValue(rule.UNTIL, {}, start.tz);
    if (u) until = u.allDay ? u.utc + DAY_MS : u.utc;
  }
  const L = start.local;
  const tz = start.tz;
  const startDay = toDayNum(L.y, L.mo, L.d);
  const toUtc = (dn) => {
    const c = fromDayNum(dn);
    return start.allDay
      ? zonedToUtc(c.y, c.mo, c.d, 12, 0, 0, TZ)
      : zonedToUtc(c.y, c.mo, c.d, L.h, L.mi, L.s, tz);
  };

  const out = [];
  let emitted = 0;
  let guard = 0;
  const push = (dn) => {
    if (dn < startDay) return true;
    const t = toUtc(dn);
    if (t > until || emitted >= count) return false;
    emitted++;
    if (t >= from && t <= to && !exdates.has(t) && !exdates.has("d" + dn)) out.push(t);
    return t <= to && out.length < MAX_INSTANCES;
  };

  if (freq === "DAILY") {
    for (let dn = startDay; guard++ < 40000; dn += interval) {
      if (rule.BYDAY) {
        const c = fromDayNum(dn);
        const wds = parseByDay(rule.BYDAY).map((b) => b.wd);
        if (!wds.includes(weekday(c.y, c.mo, c.d))) continue;
      }
      if (!push(dn)) break;
    }
  } else if (freq === "WEEKLY") {
    const wkst = WEEKDAYS.indexOf((rule.WKST || "MO").toUpperCase());
    const wds = rule.BYDAY ? parseByDay(rule.BYDAY).map((b) => b.wd) : [weekday(L.y, L.mo, L.d)];
    const startWd = weekday(L.y, L.mo, L.d);
    const weekStart = startDay - ((startWd - wkst + 7) % 7);
    outer: for (let ws = weekStart; guard++ < 6000; ws += 7 * interval) {
      const days = wds.map((wd) => ws + ((wd - wkst + 7) % 7)).sort((a, b) => a - b);
      for (const dn of days) if (!push(dn)) break outer;
    }
  } else if (freq === "MONTHLY") {
    let y = L.y;
    let mo = L.mo;
    outer: for (; guard++ < 1500; ) {
      for (const d of monthCandidates(y, mo, rule, L)) if (!push(toDayNum(y, mo, d))) break outer;
      mo += interval;
      while (mo > 12) {
        mo -= 12;
        y++;
      }
    }
  } else if (freq === "YEARLY") {
    const months = rule.BYMONTH ? rule.BYMONTH.split(",").map(Number).sort((a, b) => a - b) : [L.mo];
    outer: for (let y = L.y; guard++ < 200; y += interval) {
      for (const mo of months) {
        const r = rule.BYDAY || rule.BYMONTHDAY ? rule : { ...rule };
        const days = rule.BYDAY || rule.BYMONTHDAY ? monthCandidates(y, mo, r, L) : L.d <= daysInMonth(y, mo) ? [L.d] : [];
        for (const d of days) if (!push(toDayNum(y, mo, d))) break outer;
      }
    }
  } else {
    // Unknown frequency: fall back to the single DTSTART.
    if (start.utc >= from && start.utc <= to) out.push(start.utc);
  }
  return out;
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: ", ", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", eacute: "\u00e9", copy: "\u00a9" };

export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}

function stripHtml(s) {
  return decodeEntities(
    String(s ?? "")
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/#block-[\w-]+(\s*\{[^}]*\})?/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parse an ICS document into event instances between `from` and `to` (UTC ms).
 * Returns [{ uid, title, startMs, endMs, allDay, url, location, description, lat, lng }]
 */
export function parseIcs(text, { from, to }) {
  const unfolded = String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const calTzLine = unfolded.match(/^X-WR-TIMEZONE:(.+)$/m);
  const calTz = normalizeZone(calTzLine ? calTzLine[1].trim() : TZ);

  const vevents = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const props = {};
    const multi = { EXDATE: [] };
    for (const raw of body.split("\n")) {
      const p = parseLine(raw);
      if (!p) continue;
      if (p.name === "EXDATE") multi.EXDATE.push(p);
      else if (!(p.name in props)) props[p.name] = p;
    }
    vevents.push({ props, multi });
  }

  // RECURRENCE-ID overrides, keyed by UID
  const overrides = new Map();
  for (const { props } of vevents) {
    if (!props["RECURRENCE-ID"] || !props.UID) continue;
    const rid = parseDateValue(props["RECURRENCE-ID"].value, props["RECURRENCE-ID"].params, calTz);
    if (!rid) continue;
    if (!overrides.has(props.UID.value)) overrides.set(props.UID.value, new Set());
    overrides.get(props.UID.value).add(rid.utc);
  }

  const out = [];
  for (const { props, multi } of vevents) {
    if (!props.DTSTART || !props.SUMMARY) continue;
    if (props.STATUS && /CANCELLED/i.test(props.STATUS.value)) continue;
    const start = parseDateValue(props.DTSTART.value, props.DTSTART.params, calTz);
    if (!start) continue;

    let durationMs = null;
    if (props.DTEND) {
      const end = parseDateValue(props.DTEND.value, props.DTEND.params, calTz);
      if (end) durationMs = Math.max(0, end.utc - start.utc);
    } else if (props.DURATION) {
      const m = props.DURATION.value.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
      if (m) durationMs = ((+m[1] || 0) * 7 * 24 * 60 + (+m[2] || 0) * 24 * 60 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 60000;
    }

    const uid = props.UID?.value ?? null;
    let starts;
    if (props.RRULE && !props["RECURRENCE-ID"] && start.local) {
      const exdates = new Set();
      for (const ex of multi.EXDATE) {
        for (const v of ex.value.split(",")) {
          const e = parseDateValue(v, ex.params, start.tz === "UTC" ? calTz : start.tz);
          if (!e) continue;
          exdates.add(e.utc);
          if (e.allDay) exdates.add("d" + toDayNum(e.local.y, e.local.mo, e.local.d));
        }
      }
      for (const t of overrides.get(uid) ?? []) exdates.add(t);
      starts = expand(start, parseRrule(props.RRULE.value), exdates, from, to);
    } else if (props.RRULE && !start.local) {
      // UTC-anchored series: expand in Pacific wall-clock terms.
      const p = partsIn(start.utc, TZ);
      const local = { y: p.y, mo: p.mo, d: p.d, h: p.h, mi: p.mi, s: p.s };
      starts = expand({ ...start, local, tz: TZ }, parseRrule(props.RRULE.value), new Set(overrides.get(uid) ?? []), from, to);
    } else {
      starts = start.utc >= from && start.utc <= to ? [start.utc] : [];
    }
    if (!starts.length) continue;

    const description = props.DESCRIPTION ? stripHtml(unescapeText(props.DESCRIPTION.value)) : null;
    let url = props.URL?.value?.trim() || null;
    if (!url && description) {
      const m = description.match(/https?:\/\/[^\s<>"')]+/);
      if (m) url = m[0];
    }
    let lat = null;
    let lng = null;
    if (props.GEO) {
      const [a, b] = props.GEO.value.split(/[;,]/).map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        lat = a;
        lng = b;
      }
    }
    for (const s of starts) {
      out.push({
        uid,
        title: unescapeText(props.SUMMARY.value),
        startMs: s,
        endMs: durationMs != null && durationMs > 0 ? s + durationMs : null,
        allDay: start.allDay,
        url,
        location: props.LOCATION ? stripHtml(unescapeText(props.LOCATION.value)).replace(/\n+/g, ", ").replace(/^-\s*|\s+-\s*$/g, "").trim() || null : null,
        description,
        lat,
        lng,
        organizer: props.ORGANIZER?.params?.CN ? unescapeText(props.ORGANIZER.params.CN) : null,
      });
    }
  }
  return out;
}

export { stripHtml };
