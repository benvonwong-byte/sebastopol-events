// Sebastopol Events: three simple views over data files rebuilt every morning.
//   Groups  the directory, by kind of group
//   Map     one map with a three-way switch: today, next 7 days, groups
//   Events  one threaded list with a strip of dates on top
// One switch above all three picks the area: Sebastopol (ZIP 95472) or
// Sebastopol plus the towns within about 22 km. Anything outside the ZIP is
// marked in amber: an amber edge on its row, an amber "Nearby · Graton"
// label, and a hollow pin on the map.
//
// Everything in the data comes from outside websites, so every string that
// reaches innerHTML goes through esc(), and every link through safeUrl().

const REPO = "benvonwong-byte/sebastopol-events";
// An address for "Email it instead" in the Add dialog. Empty hides those links.
const CONTACT = "";

const TZ = "America/Los_Angeles";
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function safeUrl(u) {
  try {
    const url = new URL(u, location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

// ---------- Dates (always Pacific) ----------
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const longDayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
const shortDayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const wdFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
const stampFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
const shortStamp = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" });

const todayKey = () => dayKeyFmt.format(new Date());
const noon = (k) => new Date(k + "T12:00:00Z");
const keyPlus = (k, n) => new Date(noon(k).getTime() + n * 86400000).toISOString().slice(0, 10);
const longDay = (k) => longDayFmt.format(noon(k));
const shortDay = (k) => shortDayFmt.format(noon(k));
const timeLabel = (iso) => timeFmt.format(new Date(iso)).replace(":00", "");
function timeRange(e) {
  if (e.allDay) return "All day";
  if (!e.end || dayKeyFmt.format(new Date(e.end)) !== e.day) return timeLabel(e.start);
  return `${timeLabel(e.start)} to ${timeLabel(e.end)}`;
}

// ---------- Data ----------
let DATA = { events: [], sources: [], fetchedAt: null };
let ORGS = [];
let DOMAINS = [];
let GEO = null;
let EVENTS = [];
const domainById = new Map();
const orgById = new Map();
const eventById = new Map();
const upcomingByOrg = new Map();
const colorOf = (d) => domainById.get(d)?.color ?? "#111111";
const firstDomain = (o) => (o.domains ?? [])[0];

// Where a thing is, as a label: nothing for Sebastopol itself. An online
// event outside Sebastopol says where its host is.
function placeTag(x) {
  if (x.area === "sebastopol") return "";
  if (x.online) return x.town && x.town !== "Sebastopol" ? `Host in ${x.town}` : "Host nearby";
  if (x.area === "nearby") return x.town && x.town !== "Sebastopol" ? `Nearby · ${x.town}` : "Nearby";
  return "West County";
}
const isNear = (x) => x.area !== "sebastopol";

// Directory sections, in the order a neighbor looks for them.
const SECTIONS = [
  { id: "nonprofits", label: "Nonprofits", kinds: ["nonprofit"] },
  { id: "farms", label: "Farms and gardens", kinds: ["farm"] },
  { id: "groups", label: "Neighborhood and volunteer groups", kinds: ["civic", "informal"] },
  { id: "places", label: "Venues and places", kinds: ["venue"] },
  { id: "markets", label: "Markets and local businesses", kinds: ["market", "business"] },
  { id: "faith", label: "Faith communities", kinds: ["faith"] },
  { id: "public", label: "City, county and library", kinds: ["government"] },
  { id: "schools", label: "Schools", kinds: ["school"] },
  { id: "news", label: "Local news", kinds: ["media"] },
];
const sectionOf = (o) => SECTIONS.find((s) => s.kinds.includes(o.kind)) ?? SECTIONS[0];

// ---------- State (mirrored in the URL hash) ----------
const VIEWS = ["groups", "map", "events"];
const AREAS = ["sebastopol", "nearby"];
const DEFAULTS = { map: "week", area: "sebastopol" };
const state = { view: "groups", gq: "", kind: "", eq: "", cat: "", org: "", event: "", group: "", map: "week", area: "sebastopol" };
const KEYS = ["gq", "kind", "eq", "cat", "org", "event", "group", "map", "area"];

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.view = VIEWS.includes(p.get("view")) ? p.get("view") : "groups";
  for (const k of KEYS) state[k] = p.get(k) ?? DEFAULTS[k] ?? "";
  if (!AREAS.includes(state.area)) state.area = DEFAULTS.area;
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.view !== "groups") p.set("view", state.view);
  for (const k of KEYS) if (state[k] && state[k] !== DEFAULTS[k]) p.set(k, state[k]);
  const h = p.toString();
  history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
}
const words = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const inArea = (x) => state.area === "nearby" || x.area === "sebastopol";

// Opening something outside Sebastopol widens the area so it can be seen.
function reveal(x) {
  if (x && isNear(x) && state.area === "sebastopol") state.area = "nearby";
}

// ---------- Hero and the area switch ----------
function mapWindow() {
  const t = todayKey();
  return state.map === "today" ? t : keyPlus(t, 6);
}
function areaPool() {
  if (state.view === "groups" || (state.view === "map" && state.map === "groups")) return ORGS;
  if (state.view === "map") {
    const last = mapWindow();
    return EVENTS.filter((e) => e.day <= last);
  }
  return EVENTS;
}
function renderHero() {
  const v = state.view;
  const near = state.area === "nearby";
  const pool = areaPool();
  const core = pool.filter((x) => x.area === "sebastopol").length;
  $("#headline").textContent = v === "groups" ? "Groups" : v === "map" ? "Map" : "Events";
  const n = near ? pool.length : core;
  $("#subline").textContent =
    v === "groups"
      ? near
        ? `${n} nonprofits, farms, venues and groups in Sebastopol and the towns within about 22 km. The ones outside Sebastopol have an amber edge.`
        : `${n} nonprofits, farms, venues and neighborhood groups in Sebastopol, and how to take part.`
      : v === "map"
        ? near
          ? "ZIP 95472 is shaded. Filled pins are in Sebastopol; hollow pins are in Graton, Forestville, Occidental, the coast, the river towns and Santa Rosa."
          : "Sebastopol, ZIP 95472, is shaded. Switch to Sebastopol + nearby to zoom out to the towns around it."
        : near
          ? "Public events in Sebastopol and the towns within about 22 km, gathered every morning. The ones outside Sebastopol are marked in amber."
          : "Public events in Sebastopol, ZIP 95472, gathered every morning from local calendars, the library, Luma, Eventbrite and Meetup.";
  for (const b of $$(".area-switch button")) {
    const on = b.dataset.area === state.area;
    b.setAttribute("aria-pressed", String(on));
    const count = b.dataset.area === "nearby" ? pool.length : core;
    b.innerHTML =
      b.dataset.area === "nearby"
        ? `<span class="key-near" aria-hidden="true"></span>Sebastopol + nearby <span class="n">${count}</span>`
        : `<span class="key-core" aria-hidden="true"></span>Sebastopol <span class="n">${count}</span>`;
  }
}

// ---------- Groups ----------
function groupPasses(o, { ignoreKind = false } = {}) {
  if (!inArea(o)) return false;
  if (!ignoreKind && state.kind && sectionOf(o).id !== state.kind) return false;
  const w = words(state.gq);
  return !w.length || w.every((t) => o._text.includes(t));
}

function renderGroups() {
  const searched = ORGS.filter((o) => groupPasses(o, { ignoreKind: true }));
  const counts = new Map();
  for (const o of searched) counts.set(sectionOf(o).id, (counts.get(sectionOf(o).id) ?? 0) + 1);
  $("#kind-chips").innerHTML =
    `<button class="chip" data-kind="" aria-pressed="${!state.kind}">All <span class="n">${searched.length}</span></button>` +
    SECTIONS.filter((s) => counts.get(s.id))
      .map((s) => `<button class="chip" data-kind="${s.id}" aria-pressed="${state.kind === s.id}">${esc(s.label)} <span class="n">${counts.get(s.id)}</span></button>`)
      .join("");

  const list = searched.filter((o) => groupPasses(o));
  let html = "";
  if (!list.length) {
    html = ORGS.length
      ? `<p class="empty">No groups match.${state.area === "sebastopol" && ORGS.some((o) => isNear(o) && groupPasses({ ...o, area: "sebastopol" })) ? ` <button class="inline-link" data-widen>Look in the nearby towns too</button>` : " Try a shorter search."}</p>`
      : `<p class="empty">The directory is being put together.</p>`;
  }
  for (const s of SECTIONS) {
    const rows = list.filter((o) => sectionOf(o).id === s.id);
    if (!rows.length) continue;
    html += `<section class="g-section"><h2 class="sec-head"><span>${esc(s.label)}</span><span class="n">${rows.length}</span></h2>`;
    for (const o of rows) {
      const n = upcomingByOrg.get(o.id)?.length ?? 0;
      const tag = placeTag(o);
      html += `<article class="item${isNear(o) ? " near" : ""}${state.group === o.id ? " open" : ""}" id="g-${esc(o.id)}" data-id="${esc(o.id)}">
        <button class="item-row" aria-expanded="${state.group === o.id}">
          <span class="dot" style="--c:${colorOf(firstDomain(o))}"></span>
          <span><span class="item-name">${esc(o.name)}</span><span class="item-sub">${esc(o.what)}</span>${tag ? `<span class="item-meta"><span class="where-tag">${esc(tag)}</span></span>` : ""}</span>
          <span class="badge">${n ? `${n} event${n === 1 ? "" : "s"}` : ""}</span>
        </button>
        <div class="item-more"${state.group === o.id ? "" : " hidden"}>${state.group === o.id ? groupDetail(o) : ""}</div>
      </article>`;
    }
    html += `</section>`;
  }
  const noFeed = ORGS.filter((o) => inArea(o) && !(o.feeds ?? []).length).length;
  if (!state.gq && !state.kind) {
    html += `<div class="callout"><h2>Run one of these groups?</h2><p>${noFeed ? `${noFeed} of the groups here post events only on a web page, Instagram or a flyer, so their events cannot appear yet. ` : ""}A free Luma or Google calendar takes five minutes, and after that every event you post shows up here on its own.</p><button class="btn" data-open-add="feed">Add your calendar</button></div>`;
  }
  $("#group-list").innerHTML = html;
}

function groupDetail(o) {
  const n = upcomingByOrg.get(o.id)?.length ?? 0;
  const site = safeUrl(o.url);
  const evPage = safeUrl(o.eventsPage);
  const ig = safeUrl(o.instagram);
  const maps = o.address ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(o.address + (/\bCA\b|california/i.test(o.address) ? "" : ", CA")) : null;
  return `
    ${o.plugIn ? `<p class="plug">${esc(o.plugIn)}</p>` : ""}
    ${o.address ? `<p class="item-meta">${maps ? `<a href="${esc(maps)}" target="_blank" rel="noopener">${esc(o.address)}</a>` : esc(o.address)}</p>` : ""}
    <div class="links">
      ${site ? `<a class="go" href="${esc(site)}" target="_blank" rel="noopener">Website ↗</a>` : ""}
      ${n ? `<button class="go" data-org-events="${esc(o.id)}">${n} upcoming event${n === 1 ? "" : "s"}</button>` : ""}
      ${Number.isFinite(o.lat) ? `<button class="go" data-map-group="${esc(o.id)}">On the map</button>` : ""}
      ${evPage && evPage !== site ? `<a class="go" href="${esc(evPage)}" target="_blank" rel="noopener">Events page ↗</a>` : ""}
      ${ig ? `<a class="go" href="${esc(ig)}" target="_blank" rel="noopener">Instagram ↗</a>` : ""}
    </div>`;
}

function toggleGroup(id, { scroll = false } = {}) {
  state.group = state.group === id && !scroll ? "" : id;
  writeHash();
  for (const art of $$("#group-list .item")) {
    const on = art.dataset.id === state.group;
    art.classList.toggle("open", on);
    $(".item-row", art).setAttribute("aria-expanded", String(on));
    const more = $(".item-more", art);
    more.hidden = !on;
    more.innerHTML = on ? groupDetail(orgById.get(art.dataset.id)) : "";
  }
  if (scroll && state.group) {
    const el = document.getElementById("g-" + id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }
}

// ---------- Events ----------
function eventPasses(e, { ignoreCat = false } = {}) {
  if (!inArea(e)) return false;
  if (!ignoreCat && state.cat && e.domain !== state.cat) return false;
  if (state.org && e.orgId !== state.org) return false;
  const w = words(state.eq);
  return !w.length || w.every((t) => e._text.includes(t));
}

function renderEvents() {
  const searched = EVENTS.filter((e) => eventPasses(e, { ignoreCat: true }));
  const counts = new Map();
  for (const e of searched) counts.set(e.domain, (counts.get(e.domain) ?? 0) + 1);
  $("#cat-chips").innerHTML =
    `<button class="chip" data-cat="" aria-pressed="${!state.cat}">All <span class="n">${searched.length}</span></button>` +
    DOMAINS.filter((d) => counts.get(d.id))
      .map((d) => `<button class="chip" data-cat="${d.id}" aria-pressed="${state.cat === d.id}" style="--c:${d.color}"><span class="sw"></span>${esc(d.label)} <span class="n">${counts.get(d.id)}</span></button>`)
      .join("");

  const org = state.org && orgById.get(state.org);
  $("#filter-note").hidden = !org;
  $("#filter-note").innerHTML = org ? `Only events from ${esc(org.name)}. <button class="inline-link" data-clear-org>Show everyone's</button>` : "";

  const list = searched.filter((e) => eventPasses(e));
  const byDay = new Map();
  for (const e of list) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }
  const t = todayKey();
  $("#date-strip").innerHTML = [...byDay]
    .map(([k, evs]) => `<button class="ds-day${k === t ? " today" : ""}" data-day="${k}"><span class="w">${esc(wdFmt.format(noon(k)))}</span><span class="d">${Number(k.slice(8))}</span><span class="c">${evs.length}</span></button>`)
    .join("");
  if (!list.length) {
    const widen = state.area === "sebastopol" && EVENTS.some((e) => isNear(e) && eventPasses({ ...e, area: "sebastopol" }));
    $("#thread").innerHTML = `<p class="empty">${
      !EVENTS.length
        ? "No listings yet. The calendar rebuilds every morning."
        : widen
          ? `Nothing in Sebastopol matches. <button class="inline-link" data-widen>Look in the nearby towns too</button>`
          : "Nothing matches. Try another kind of event or a shorter search."
    }</p>`;
    return;
  }
  let html = "";
  for (const [k, evs] of byDay) {
    const label = k === t ? `<span class="today">Today</span> · ${esc(longDay(k))}` : k === keyPlus(t, 1) ? `Tomorrow · ${esc(longDay(k))}` : esc(longDay(k));
    html += `<section class="day" id="d-${k}" data-day="${k}"><h2 class="sec-head"><span>${label}</span><span class="n">${evs.length}</span></h2>${evs.map(eventRow).join("")}</section>`;
  }
  $("#thread").innerHTML = html;
  trackScroll(true);
}

function eventRow(e) {
  const venue = (e.venue ?? "").toLowerCase();
  const host = (e.org ?? "").toLowerCase();
  const same = venue && host && (host.includes(venue) || venue.includes(host));
  const tag = placeTag(e);
  const meta = [same ? null : esc(e.venue), tag ? `<span class="where-tag">${esc(tag)}</span>` : null].filter(Boolean).join(" · ");
  const open = state.event === e.id;
  return `<article class="item ev${isNear(e) ? " near" : ""}${open ? " open" : ""}" id="e-${esc(e.id)}" data-id="${esc(e.id)}">
    <button class="item-row" aria-expanded="${open}">
      <span class="t"><span class="sw" style="--c:${colorOf(e.domain)}"></span>${esc(e.allDay ? "All day" : timeLabel(e.start))}</span>
      <span><span class="item-name">${esc(e.title)}${e.org ? `<span class="host"> · ${esc(e.org)}</span>` : ""}</span>${meta ? `<span class="item-meta">${meta}</span>` : ""}</span>
    </button>
    <div class="item-more"${open ? "" : " hidden"}>${open ? eventDetail(e) : ""}</div>
  </article>`;
}

function whereText(e) {
  if (e.online) return "Online";
  const same = e.venue && e.address && e.address.toLowerCase().startsWith(e.venue.toLowerCase());
  return same ? e.address : [e.venue, e.address].filter(Boolean).join(", ");
}
function gcalDate(iso, allDay, plus = 0) {
  if (allDay) return keyPlus(dayKeyFmt.format(new Date(iso)), plus).replace(/-/g, "");
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
const endOf = (e) => e.end ?? new Date(Date.parse(e.start) + 3600000).toISOString();
function googleLink(e) {
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: e.allDay ? `${gcalDate(e.start, true)}/${gcalDate(e.start, true, 1)}` : `${gcalDate(e.start)}/${gcalDate(endOf(e))}`,
    details: `${e.url ?? ""}\n\nFrom ${location.origin}${location.pathname}#view=events&event=${e.id}`,
    location: whereText(e),
    ctz: TZ,
  });
  return "https://calendar.google.com/calendar/render?" + p;
}
function icsFor(e) {
  const f = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sebastopol Events//EN", "BEGIN:VEVENT",
    `UID:${e.id}@${location.host || "sebastopol-events"}`, `DTSTAMP:${gcalDate(new Date().toISOString())}`,
    e.allDay ? `DTSTART;VALUE=DATE:${gcalDate(e.start, true)}` : `DTSTART:${gcalDate(e.start)}`,
    e.allDay ? `DTEND;VALUE=DATE:${gcalDate(e.start, true, 1)}` : `DTEND:${gcalDate(endOf(e))}`,
    `SUMMARY:${f(e.title)}`, `LOCATION:${f(whereText(e))}`, e.url ? `URL:${e.url}` : "",
    `DESCRIPTION:${f((e.url ?? "") + "\n\n" + (e.description ?? ""))}`, "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => {
    const safe = safeUrl(u.replace(/&amp;/g, "&"));
    return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + "…" : u}</a>` : u;
  });
}

function eventDetail(e) {
  const url = safeUrl(e.url);
  const img = safeUrl(e.image);
  const where = whereText(e);
  const tag = placeTag(e);
  const org = e.orgId && orgById.get(e.orgId);
  const desc = e.description && e.description.length > 320 ? e.description.slice(0, 317).trimEnd() + "…" : e.description;
  return `
    ${img ? `<img class="ev-img" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
    <div class="facts">
      <span><b>When</b> ${esc(longDay(e.day))}, ${esc(timeRange(e))}</span>
      ${where ? `<span><b>Where</b> ${esc(where)}${tag ? ` <span class="where-tag">${esc(tag)}</span>` : ""}${e.approxLocation ? " (the group's home base; check the listing)" : ""}</span>` : ""}
      ${e.org ? `<span><b>Who</b> ${org ? `<button class="inline-link" data-show-group="${esc(org.id)}">${esc(e.org)}</button>` : esc(e.org)}</span>` : ""}
    </div>
    ${desc ? `<p class="desc">${linkify(desc)}</p>` : ""}
    <div class="links">
      ${url ? `<a class="go" href="${esc(url)}" target="_blank" rel="noopener">Event page ↗</a>` : ""}
      <a class="go" href="${esc(googleLink(e))}" target="_blank" rel="noopener">Add to Google Calendar</a>
      <button class="go" data-ics="${esc(e.id)}">.ics</button>
      ${Number.isFinite(e.lat) ? `<button class="go" data-map-event="${esc(e.id)}">On the map</button>` : ""}
      <button class="go" data-share="${esc(e.id)}">Copy link</button>
    </div>
    <p class="item-meta">Listed by ${esc(e.sourceLabel ?? e.source)}</p>`;
}

function toggleEvent(id, { scroll = false } = {}) {
  state.event = state.event === id && !scroll ? "" : id;
  writeHash();
  for (const art of $$("#thread .ev.open, #e-" + CSS.escape(id))) {
    const on = art.dataset.id === state.event;
    art.classList.toggle("open", on);
    $(".item-row", art).setAttribute("aria-expanded", String(on));
    const more = $(".item-more", art);
    more.hidden = !on;
    more.innerHTML = on ? eventDetail(eventById.get(art.dataset.id)) : "";
  }
  if (scroll && state.event) document.getElementById("e-" + id)?.scrollIntoView({ block: "center" });
}

// The date strip marks the day at the top of the list.
let focusDay = null;
function trackScroll(force = false) {
  if (state.view !== "events") return;
  const line = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 100) + 4;
  let current = null;
  for (const sec of $$("#thread .day")) {
    if (sec.getBoundingClientRect().bottom > line) {
      current = sec.dataset.day;
      break;
    }
  }
  if (!current || (current === focusDay && !force)) return;
  focusDay = current;
  for (const b of $$(".ds-day")) {
    const on = b.dataset.day === current;
    b.classList.toggle("focus", on);
    if (on) {
      const strip = b.parentElement;
      strip.scrollTo({ left: b.offsetLeft - strip.clientWidth / 2 + b.clientWidth / 2, behavior: force ? "auto" : "smooth" });
    }
  }
}

// ---------- Map ----------
// ZIP 95472 is shaded amber with Graton cut out of it; a dashed amber circle
// marks the nearby ring. Pins in Sebastopol are filled, pins outside it are
// hollow, both in the color of their kind of event.
let map = null;
let layer = null;
let coreBounds = null;
let ringBounds = null;
const markers = new Map();

function initMap() {
  if (map || !window.L) return;
  map = L.map("map", { zoomSnap: 0.5, scrollWheelZoom: false });
  map.setView(GEO?.center ?? [38.4021, -122.8242], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  if (GEO) {
    const [lat, lng] = GEO.center;
    const r = GEO.radiusKm;
    const dLat = r / 111.32;
    const dLng = r / (111.32 * Math.cos((lat * Math.PI) / 180));
    ringBounds = L.latLngBounds([lat - dLat, lng - dLng], [lat + dLat, lng + dLng]);
    L.circle(GEO.center, { radius: r * 1000, color: "#8a5a10", weight: 1.5, dashArray: "6 6", fillColor: "#f9b864", fillOpacity: 0.05, interactive: false }).addTo(map);
    const core = L.polygon([GEO.core.outer, ...(GEO.core.holes ?? [])], { color: "#111111", weight: 1.5, fillColor: "#f9b864", fillOpacity: 0.3, interactive: false }).addTo(map);
    coreBounds = core.getBounds();
  }
  layer = L.layerGroup().addTo(map);
  map.on("popupopen", (ev) => {
    const el = ev.popup.getElement();
    el?.querySelector("[data-open-event]")?.addEventListener("click", (b) => openFromMap("events", b.currentTarget.dataset.openEvent));
    el?.querySelector("[data-open-group]")?.addEventListener("click", (b) => openFromMap("groups", b.currentTarget.dataset.openGroup));
  });
}

function renderLegend() {
  const groups = state.map === "groups";
  $("#legend").innerHTML =
    DOMAINS.map((d) => `<span><span class="sw" style="--c:${d.color}"></span>${esc(d.label)}</span>`).join("") +
    `<span class="break"></span>` +
    `<span><span class="zone"></span>Sebastopol, ZIP 95472</span>` +
    `<span><span class="solid"${groups ? ' style="border-radius:0"' : ""}></span>${groups ? "Group" : "Event"} in Sebastopol</span>` +
    (state.area === "nearby"
      ? `<span><span class="ring"></span>About 22 km out</span><span><span class="hollow"${groups ? ' style="border-radius:0"' : ""}></span>${groups ? "Group" : "Event"} nearby</span>`
      : "");
}

function spread(items) {
  const groups = new Map();
  for (const it of items) {
    const k = it.lat.toFixed(4) + "," + it.lng.toFixed(4);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const g of groups.values())
    if (g.length > 1)
      g.forEach((it, i) => {
        const r = 0.00016 * Math.sqrt(i + 1);
        it.lat += r * Math.sin(i * 2.4);
        it.lng += r * Math.cos(i * 2.4) * 1.27;
      });
  return items;
}

let mapFocus = null; // { kind: "event" | "group", id }
function renderMap() {
  initMap();
  if (!map) return;
  for (const b of $$("#map-mode button")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.map));
  renderLegend();
  layer.clearLayers();
  markers.clear();
  if (state.map === "groups") {
    const list = ORGS.filter(inArea);
    const pins = spread(list.filter((o) => Number.isFinite(o.lat)).map((o) => ({ o, lat: o.lat, lng: o.lng })));
    for (const { o, lat, lng } of pins) {
      const icon = L.divIcon({ className: "", html: `<div class="pin-org${isNear(o) ? " near" : ""}" style="--c:${colorOf(firstDomain(o))}"></div>`, iconSize: [13, 13] });
      const n = upcomingByOrg.get(o.id)?.length ?? 0;
      const tag = placeTag(o);
      const m = L.marker([lat, lng], { icon, zIndexOffset: isNear(o) ? 0 : 500 })
        .bindPopup(`${tag ? `<span class="where-tag">${esc(tag)}</span>` : ""}<span class="pt">${esc(o.name)}</span><span class="pm">${esc(sectionOf(o).label)}${n ? ` · ${n} upcoming` : ""}</span><button class="go" data-open-group="${esc(o.id)}">See the group</button>`)
        .addTo(layer);
      markers.set(o.id, m);
    }
    $("#map-count").textContent = `${pins.length} of ${list.length} groups have a fixed address`;
  } else {
    const last = mapWindow();
    const list = EVENTS.filter((e) => inArea(e) && (e.day <= last || (mapFocus?.kind === "event" && mapFocus.id === e.id)));
    const pins = spread(list.filter((e) => Number.isFinite(e.lat)).map((e) => ({ e, lat: e.lat, lng: e.lng })));
    // Nearby pins go down first, so Sebastopol's sit on top where they overlap.
    pins.sort((a, b) => Number(!isNear(a.e)) - Number(!isNear(b.e)));
    for (const { e, lat, lng } of pins) {
      const c = colorOf(e.domain);
      const style = isNear(e)
        ? { radius: 6.5, color: c, weight: 2.5, fillColor: "#ffffff", fillOpacity: 1 }
        : { radius: 7.5, color: "#111111", weight: 1.5, fillColor: c, fillOpacity: 0.95 };
      const tag = placeTag(e);
      const m = L.circleMarker([lat, lng], style)
        .bindPopup(`${tag ? `<span class="where-tag">${esc(tag)}</span>` : ""}<span class="pt">${esc(e.title)}</span><span class="pm">${esc(state.map === "today" ? "" : shortDay(e.day) + ", ")}${esc(e.allDay ? "All day" : timeLabel(e.start))}${e.venue ? " · " + esc(e.venue) : ""}</span><button class="go" data-open-event="${esc(e.id)}">Details</button>`)
        .addTo(layer);
      markers.set(e.id, m);
    }
    $("#map-count").textContent = `${list.length} event${list.length === 1 ? "" : "s"}, ${pins.length} with an address`;
  }
  setTimeout(() => {
    map.invalidateSize();
    const m = mapFocus && markers.get(mapFocus.id);
    if (m) {
      map.setView(m.getLatLng(), 15);
      m.openPopup();
      if (m.setStyle) m.setStyle({ radius: 11, weight: 3 });
    } else {
      const b = state.area === "nearby" ? ringBounds : coreBounds;
      if (b) map.fitBounds(b, { padding: [8, 8] });
    }
    mapFocus = null;
  }, 0);
}

function openFromMap(view, id) {
  if (view === "events") {
    Object.assign(state, { eq: "", cat: "", org: "", event: id });
    setView("events");
    toggleEvent(id, { scroll: true });
  } else {
    Object.assign(state, { gq: "", kind: "", group: id });
    reveal(orgById.get(id));
    setView("groups");
    toggleGroup(id, { scroll: true });
  }
}
function showOnMap(kind, id) {
  mapFocus = { kind, id };
  reveal(kind === "group" ? orgById.get(id) : eventById.get(id));
  state.map = kind === "group" ? "groups" : state.map === "groups" ? "week" : state.map;
  setView("map");
  window.scrollTo({ top: 0 });
}

// ---------- Views ----------
function setView(v) {
  state.view = v;
  for (const t of $$(".nav-tab[data-view]")) t.setAttribute("aria-selected", String(t.dataset.view === v));
  for (const name of VIEWS) $("#view-" + name).hidden = name !== v;
  writeHash();
  renderHero();
  if (v === "groups") renderGroups();
  else if (v === "events") renderEvents();
  else renderMap();
}
function setArea(a) {
  if (!AREAS.includes(a) || a === state.area) return;
  state.area = a;
  // A filter for a kind or a group that the new area does not have would
  // leave the list empty with no visible reason.
  if (state.kind && !ORGS.some((o) => inArea(o) && sectionOf(o).id === state.kind)) state.kind = "";
  setView(state.view);
}

// ---------- Footer ----------
function renderSources() {
  const shown = DATA.sources.filter((s) => s.kind === "aggregator" || s.kind === "feed");
  const groups = DATA.sources.filter((s) => s.kind === "org");
  const items = [
    ...(groups.length ? [`<li>Group calendars: ${groups.filter((s) => s.ok).length} of ${groups.length} read</li>`] : []),
    ...shown.map((s) => {
      const name = esc(s.label.replace(/ \((\w|-)+\)$/, ""));
      if (s.ok) return `<li>${name}: ${s.count} events</li>`;
      if (s.count && s.lastGood) return `<li class="bad">${name}: ${s.count} events from the ${esc(shortStamp.format(new Date(s.lastGood)))} read</li>`;
      return `<li class="bad">${name}: did not load this morning</li>`;
    }),
  ];
  if (DATA.fetchedAt) items.push(`<li>Updated ${esc(stampFmt.format(new Date(DATA.fetchedAt)))}</li>`);
  $("#sources").innerHTML = items.join("") || "<li>The first read has not run yet.</li>";
}

// ---------- Add: a calendar, one event, or how to start a calendar ----------
// The two forms open a GitHub issue with the answers filled in
// (.github/ISSUE_TEMPLATE/add-source.yml and add-event.yml, whose field ids
// match the parameters here). A bot checks it and opens a pull request.
const HINTS = [
  [/^(https?:\/\/)?(www\.)?(lu\.ma|luma\.com)\/(embed\/)?[\w-]+/i, true, "A Luma calendar. We read its public feed."],
  [/calendar\.google\.com/i, true, "A Google Calendar. It has to be public; the check says if it is not."],
  [/meetup\.com\/[\w-]+/i, true, "A Meetup group."],
  [/eventbrite\.[a-z.]+\/o\//i, true, "An Eventbrite organizer page."],
  [/eventbrite\./i, false, "That looks like one Eventbrite event. Paste the organizer's page instead (eventbrite.com/o/...)."],
  [/mobilize\.us\/[\w-]+/i, true, "A Mobilize organization."],
  [/tockify\.com/i, true, "A Tockify calendar."],
  [/^webcals?:|\.ics(\?|$)|[?&]ical=1/i, true, "A calendar file (.ics)."],
  [/\/(feed|rss)(\/|\.xml)?$|\.rss$|\/atom/i, true, "An RSS feed."],
  [/facebook\.com|instagram\.com|fb\.me/i, false, "Facebook and Instagram cannot be read automatically. See \"No calendar yet\" for a five-minute fix."],
];
function hint(raw) {
  const v = raw.trim();
  if (!v) return null;
  for (const [re, ok, text] of HINTS) if (re.test(v)) return { ok, text };
  if (!/^(https?:\/\/|webcals?:\/\/)?[\w-]+(\.[\w-]+)+/i.test(v)) return { ok: false, text: "That does not look like a web address yet." };
  return { ok: null, text: "A web page. The check looks on it for a calendar, an RSS feed or event listings." };
}
function issueUrl(template, title, fields) {
  const p = new URLSearchParams({ template, title });
  for (const [k, v] of Object.entries(fields)) if (v) p.set(k, v);
  return `https://github.com/${REPO}/issues/new?${p}`;
}
function mailto(subject, lines) {
  return `mailto:${CONTACT}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.filter(Boolean).join("\n"))}`;
}

function setupAdd() {
  const dlg = $("#add-dialog");
  const showPane = (name) => {
    for (const b of $$(".add-tabs [data-add]", dlg)) b.setAttribute("aria-selected", String(b.dataset.add === name));
    for (const p of $$(".add-pane", dlg)) p.hidden = p.dataset.pane !== name;
  };
  $(".add-tabs", dlg).addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]");
    if (b) showPane(b.dataset.add);
  });
  const open = (pane = "feed") => {
    showPane(pane);
    if (!dlg.open) dlg.showModal();
  };
  $("#open-add").addEventListener("click", () => open());
  $("#foot-add").addEventListener("click", () => open());
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open-add]");
    if (b) open(b.dataset.openAdd);
  });
  dlg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (b) {
      e.preventDefault();
      showPane(b.dataset.goto);
    }
  });

  // A calendar
  const url = $("#feed-url");
  const name = $("#feed-name");
  const detect = $("#feed-detect");
  const update = () => {
    const h = hint(url.value);
    detect.textContent = h?.text ?? "";
    detect.className = "detect" + (h?.ok ? " ok" : "");
    $("#feed-mail").href = mailto(`Calendar for Sebastopol Events: ${name.value.trim() || "a group"}`, [
      `Group: ${name.value.trim()}`,
      `Calendar link: ${url.value.trim()}`,
    ]);
  };
  url.addEventListener("input", update);
  name.addEventListener("input", update);
  $("#feed-send").addEventListener("click", () => {
    const v = url.value.trim();
    if (!v) {
      detect.textContent = "Paste the link first.";
      detect.className = "detect";
      return url.focus();
    }
    const n = name.value.trim();
    window.open(issueUrl("add-source.yml", `Add calendar: ${n || v}`, { url: v, name: n }), "_blank", "noopener");
  });

  // One event
  const ev = Object.fromEntries(["name", "date", "start", "end", "place", "link", "host", "about"].map((k) => [k, $("#ev-" + k)]));
  const vals = () => Object.fromEntries(Object.entries(ev).map(([k, el]) => [k, el.value.trim()]));
  const updateMail = () => {
    const v = vals();
    $("#ev-mail").href = mailto(`Event for Sebastopol Events: ${v.name || "new event"}`, [
      `Event: ${v.name}`,
      `Date: ${v.date}`,
      `Time: ${[v.start, v.end].filter(Boolean).join(" to ")}`,
      `Place: ${v.place}`,
      `Link: ${v.link}`,
      `Host: ${v.host}`,
      v.about,
    ]);
  };
  for (const el of Object.values(ev)) el.addEventListener("input", updateMail);
  $("#ev-date").min = todayKey();
  $("#ev-send").addEventListener("click", () => {
    const v = vals();
    const missing = [!v.name && ev.name, !v.date && ev.date, !v.place && ev.place].filter(Boolean);
    if (missing.length) {
      for (const el of missing) el.setAttribute("aria-invalid", "true");
      toast("Add the name, date and place first");
      return missing[0].focus();
    }
    for (const el of Object.values(ev)) el.removeAttribute("aria-invalid");
    window.open(
      issueUrl("add-event.yml", `Add event: ${v.name}`, { event: v.name, date: v.date, start: v.start, end: v.end, place: v.place, link: v.link, host: v.host, about: v.about }),
      "_blank",
      "noopener"
    );
  });

  if (!CONTACT) for (const a of $$("#feed-mail, #ev-mail")) a.hidden = true;
  update();
  updateMail();
}

// ---------- Subscribe, dialogs, copy ----------
function setupDialogs() {
  const sel = $("#sub-cat");
  sel.innerHTML =
    `<option value="">Sebastopol and nearby, everything</option><option value="sebastopol">Sebastopol only</option>` +
    DOMAINS.map((d) => `<option value="${d.id}">${esc(d.label)}, Sebastopol and nearby</option>`).join("");
  const update = () => {
    const https = new URL(sel.value ? `events-${sel.value}.ics` : "events.ics", location.href).href;
    const webcal = https.replace(/^https?:/, "webcal:");
    $("#sub-url").value = https;
    $("#sub-webcal").href = webcal;
    $("#sub-google").href = "https://calendar.google.com/calendar/r?cid=" + encodeURIComponent(webcal);
  };
  sel.addEventListener("change", update);
  $("#sub-copy").addEventListener("click", () => copy($("#sub-url").value, "Feed address copied"));
  $("#open-subscribe").addEventListener("click", () => {
    sel.value = state.cat || (state.area === "sebastopol" ? "sebastopol" : "");
    update();
    $("#subscribe-dialog").showModal();
  });
  for (const dlg of $$("dialog")) {
    dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());
    $$("[data-close]", dlg).forEach((b) => b.addEventListener("click", () => dlg.close()));
  }
}
async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    prompt("Copy this", text);
  }
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2000);
}

// ---------- Wiring ----------
function debounce(fn, ms = 160) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function wire() {
  for (const t of $$(".nav-tab[data-view]"))
    t.addEventListener("click", () => {
      setView(t.dataset.view);
      window.scrollTo({ top: 0 });
    });
  $(".area-switch").addEventListener("click", (e) => {
    const b = e.target.closest("[data-area]");
    if (b) setArea(b.dataset.area);
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-widen]")) setArea("nearby");
  });

  // Groups
  $("#g-search").addEventListener("input", debounce((e) => {
    state.gq = e.target.value.trim();
    writeHash();
    renderGroups();
  }));
  $("#kind-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (!b) return;
    state.kind = b.dataset.kind;
    writeHash();
    renderGroups();
  });
  $("#group-list").addEventListener("click", (e) => {
    const row = e.target.closest(".item-row");
    if (row) return toggleGroup(row.closest(".item").dataset.id);
    const ev = e.target.closest("[data-org-events]");
    if (ev) {
      Object.assign(state, { org: ev.dataset.orgEvents, eq: "", cat: "", event: "" });
      reveal(orgById.get(ev.dataset.orgEvents));
      if ((upcomingByOrg.get(ev.dataset.orgEvents) ?? []).some(isNear)) state.area = "nearby";
      setView("events");
      return window.scrollTo({ top: 0 });
    }
    const m = e.target.closest("[data-map-group]");
    if (m) showOnMap("group", m.dataset.mapGroup);
  });

  // Map
  $("#map-mode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    state.map = b.dataset.mode;
    writeHash();
    renderHero();
    renderMap();
  });

  // Events
  $("#e-search").addEventListener("input", debounce((e) => {
    state.eq = e.target.value.trim();
    writeHash();
    renderEvents();
  }));
  $("#cat-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    state.cat = b.dataset.cat;
    writeHash();
    renderEvents();
  });
  $("#filter-note").addEventListener("click", (e) => {
    if (!e.target.closest("[data-clear-org]")) return;
    state.org = "";
    writeHash();
    renderEvents();
  });
  $("#date-strip").addEventListener("click", (e) => {
    const b = e.target.closest("[data-day]");
    if (b) document.getElementById("d-" + b.dataset.day)?.scrollIntoView({ block: "start" });
  });
  $("#thread").addEventListener("click", (e) => {
    const row = e.target.closest(".item-row");
    if (row) return toggleEvent(row.closest(".item").dataset.id);
    const ics = e.target.closest("[data-ics]");
    if (ics) {
      const ev = eventById.get(ics.dataset.ics);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([icsFor(ev)], { type: "text/calendar" }));
      a.download = ev.title.replace(/[^\w]+/g, "-").slice(0, 50) + ".ics";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    const share = e.target.closest("[data-share]");
    if (share) return copy(`${location.origin}${location.pathname}#view=events&event=${share.dataset.share}`, "Link copied");
    const m = e.target.closest("[data-map-event]");
    if (m) return showOnMap("event", m.dataset.mapEvent);
    const g = e.target.closest("[data-show-group]");
    if (g) openFromMap("groups", g.dataset.showGroup);
  });

  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      trackScroll();
    });
  }, { passive: true });

  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
    if (typing) {
      if (e.key === "Escape") document.activeElement.blur();
      return;
    }
    if (e.key === "/") {
      const box = state.view === "groups" ? $("#g-search") : state.view === "events" ? $("#e-search") : null;
      if (box) {
        e.preventDefault();
        box.focus();
      }
    }
  });

  window.addEventListener("hashchange", () => {
    const before = JSON.stringify(state);
    readHash();
    if (JSON.stringify(state) !== before) boot2();
  });
}

function boot2() {
  $("#g-search").value = state.gq;
  $("#e-search").value = state.eq;
  if (state.event) reveal(eventById.get(state.event));
  if (state.group) reveal(orgById.get(state.group));
  setView(state.view);
  if (state.view === "events" && state.event) toggleEvent(state.event, { scroll: true });
  if (state.view === "groups" && state.group) toggleGroup(state.group, { scroll: true });
}

// ---------- Boot ----------
async function boot() {
  const [ev, orgs, domains, geo] = await Promise.all(
    ["data/events.json", "data/orgs.json", "data/domains.json", "data/geo.json"].map((u) =>
      fetch(u, { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    )
  );
  DATA = ev ?? DATA;
  DATA.sources ??= [];
  ORGS = (orgs ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  DOMAINS = domains ?? [];
  GEO = geo;
  for (const d of DOMAINS) domainById.set(d.id, d);
  const now = Date.now();
  EVENTS = (DATA.events ?? [])
    .filter((e) => (e.end ? Date.parse(e.end) : Date.parse(e.start) + (e.allDay ? 24 : 2) * 3600000) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const e of EVENTS) {
    e._text = [e.title, e.venue, e.address, e.org, e.description, e.town, placeTag(e), domainById.get(e.domain)?.label].join(" ").toLowerCase();
    eventById.set(e.id, e);
    if (e.orgId) {
      if (!upcomingByOrg.has(e.orgId)) upcomingByOrg.set(e.orgId, []);
      upcomingByOrg.get(e.orgId).push(e);
    }
  }
  for (const o of ORGS) {
    orgById.set(o.id, o);
    o._text = [o.name, o.what, o.plugIn, o.address, o.town, sectionOf(o).label, ...(o.domains ?? []).map((d) => domainById.get(d)?.label)]
      .join(" ")
      .toLowerCase();
  }
  readHash();
  wire();
  setupDialogs();
  setupAdd();
  renderSources();
  boot2();
}

boot();
