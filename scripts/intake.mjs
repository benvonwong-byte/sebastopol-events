#!/usr/bin/env node
// Checks a submitted calendar or event and proposes it.
//
// Runs in GitHub Actions on an issue opened from the site's "Add" forms
// (.github/ISSUE_TEMPLATE/add-source.yml and add-event.yml), and by hand:
//   node scripts/intake.mjs --url <link> [--name "Group name"]   (report only)
//
// For a calendar: detect what the link is (scripts/lib/detect.mjs), read it
// once, count upcoming events in Sebastopol and nearby, and add it to
// data/feeds.json. For one event: check the date and place the address,
// and add it to data/manual-events.json. In Actions it then opens a pull
// request and answers on the issue; a maintainer merges.
//
// The issue text is untrusted. It is read from the event payload in Node,
// never interpolated into a shell command.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { detectSource } from "./lib/detect.mjs";
import { readFeed } from "./lib/read-feed.mjs";
import { areaFor, areaByText, townFor } from "./lib/geo.mjs";
import { openGeocoder } from "./lib/geocode.mjs";
import { zonedToUtc, toPacificIso } from "./lib/time.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEEDS = join(ROOT, "data/feeds.json");
const MANUAL = join(ROOT, "data/manual-events.json");
const geo = openGeocoder(join(ROOT, "data/geocache.json"));
const HORIZON_DAYS = 60;

// ---- Inputs ---------------------------------------------------------------
// GitHub issue forms render as "### Label\n\nvalue" blocks.
function formFields(body) {
  const out = {};
  const parts = String(body ?? "").split(/^###\s+/m).slice(1);
  for (const p of parts) {
    const [label, ...rest] = p.split("\n");
    const value = rest.join("\n").trim();
    out[label.trim().toLowerCase()] = value === "_No response_" ? "" : value;
  }
  return out;
}
const field = (f, ...names) => names.map((n) => f[n.toLowerCase()]).find((v) => v) ?? "";
const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

// ---- Calendars ------------------------------------------------------------
async function checkSource(url, name) {
  const src = await detectSource(url);
  const now = Date.now();
  const window = { from: now - 6 * 3600000, to: now + HORIZON_DAYS * 86400000 };
  let read;
  try {
    read = await readFeed(src, window);
  } catch (err) {
    if (src.format !== "eventbrite") throw err;
    return { src, name: name || null, upcoming: null, core: 0, nearby: 0, unplaced: 0, samples: [] };
  }
  const instances = read.filter((i) => i.title && i.startMs >= window.from && i.startMs <= window.to);
  let core = 0;
  let nearby = 0;
  let unplaced = 0;
  const samples = [];
  for (const i of instances.slice(0, 80)) {
    let area = Number.isFinite(i.lat) ? areaFor(i.lat, i.lng) : null;
    if (!area && i.location) {
      area = areaByText(i.location) || null;
      if (!area) {
        const g = await geo.geocode(i.location, { budget: 25 });
        if (g) area = areaFor(g.lat, g.lng);
      }
    }
    if (area === "sebastopol") core++;
    else if (area === "nearby") nearby++;
    else if (!i.location) unplaced++;
    if (samples.length < 5) samples.push(`${toPacificIso(i.startMs).slice(0, 16).replace("T", " ")}  ${i.title}${i.location ? ` (${i.location.slice(0, 60)})` : ""}`);
  }
  return { src, name: name || null, upcoming: instances.length, core, nearby, unplaced, samples };
}

function addFeed({ src, name }, issue) {
  const feeds = existsSync(FEEDS) ? JSON.parse(readFileSync(FEEDS, "utf8")) : [];
  if (feeds.some((f) => f.url === src.url)) return { added: false, why: "This calendar is already on the list." };
  const id = slug(name || new URL(src.url).hostname) || "feed";
  feeds.push({
    id: feeds.some((f) => f.id === id) ? `${id}-${feeds.length + 1}` : id,
    name: name || new URL(src.url).hostname.replace(/^www\./, ""),
    format: src.format,
    url: src.url,
    kind: src.kind,
    ...(issue ? { addedIn: `issue #${issue}` } : {}),
  });
  writeFileSync(FEEDS, JSON.stringify(feeds, null, 2) + "\n");
  return { added: true };
}

function sourceReport(r) {
  if (r.upcoming == null)
    return `**${r.src.kind}** found: \`${r.src.url}\`\n\nEventbrite does not let GitHub's servers read its pages, so this one could not be counted here. It is read on mornings when the refresh runs from a home connection.`;
  const lines = [
    `**${r.src.kind}** found: \`${r.src.url}\``,
    "",
    `- ${r.upcoming} events in the next ${HORIZON_DAYS} days`,
    `- ${r.core} in Sebastopol, ${r.nearby} nearby${r.unplaced ? `, ${r.unplaced} with no place listed` : ""}`,
  ];
  if (r.samples.length) lines.push("", "First few:", "", ...r.samples.map((s) => `- ${s}`));
  if (!r.upcoming) lines.push("", "The calendar has nothing upcoming right now. It still gets added and is read every morning, so new events will appear as they are posted.");
  return lines.join("\n");
}

// ---- One event ------------------------------------------------------------
function parseWhen(date, time) {
  const d = String(date).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!d) return null;
  const t = String(time ?? "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!t) return { allDay: true, ms: zonedToUtc(+d[1], +d[2], +d[3], 12, 0, 0) };
  const n = +t[1];
  if (n > 23 || +(t[2] ?? 0) > 59) return { allDay: true, ms: zonedToUtc(+d[1], +d[2], +d[3], 12, 0, 0) };
  let h = n;
  if (t[3]) h = (n % 12) + (t[3] === "pm" ? 12 : 0);
  // With no am or pm: a time picker sends 24-hour "07:30" or "18:30" and
  // those read as written. A typed "7" or "6:30" with no leading zero reads
  // as evening for 1 to 7, and as morning for 8 to 11.
  else if (n >= 1 && n <= 7 && !/^0/.test(t[1])) h = n + 12;
  return { allDay: false, ms: zonedToUtc(+d[1], +d[2], +d[3], h, +(t[2] ?? 0), 0) };
}

async function checkEvent(f, issue) {
  const title = field(f, "event name", "title");
  const date = field(f, "date (yyyy-mm-dd)", "date");
  const start = parseWhen(date, field(f, "start time", "time"));
  const end = parseWhen(date, field(f, "end time"));
  const place = field(f, "place and street address", "address", "place");
  const link = field(f, "link for details or tickets", "link");
  const host = field(f, "who is hosting it", "host");
  const about = field(f, "one or two sentences about it", "description");
  const problems = [];
  if (!title) problems.push("The event needs a name.");
  if (!start) problems.push("The date needs to be written like 2026-11-14.");
  else if (start.ms < Date.now() - 86400000) problems.push("That date has already passed.");
  else if (start.ms > Date.now() + 366 * 86400000) problems.push("That date is more than a year away.");
  if (link && !/^https?:\/\//i.test(link)) problems.push("The link needs to start with https://.");
  let lat = null;
  let lng = null;
  let area = areaByText(place) || null;
  if (place) {
    const g = await geo.geocode(place, { budget: 5 });
    if (g) {
      ({ lat, lng } = g);
      area = areaFor(lat, lng);
    }
  } else problems.push("The event needs a place and street address.");
  if (place && !area) problems.push("That place is outside Sebastopol and the towns around it, or we could not find it on the map. Add the street address and town.");
  if (problems.length) return { ok: false, problems };
  const event = {
    id: createHash("sha1").update(`${title}|${start.ms}|${place}`).digest("hex").slice(0, 12),
    title,
    start: toPacificIso(start.ms),
    end: end && !end.allDay && end.ms > start.ms ? toPacificIso(end.ms) : null,
    allDay: start.allDay,
    venue: place.split(",")[0].trim(),
    address: place,
    lat,
    lng,
    url: link || null,
    org: host || null,
    description: about ? about.slice(0, 400) : null,
    ...(issue ? { addedIn: `issue #${issue}` } : {}),
  };
  return { ok: true, event, area, town: townFor(lat, lng) };
}

function addEvent(event) {
  const list = existsSync(MANUAL) ? JSON.parse(readFileSync(MANUAL, "utf8")) : [];
  if (list.some((e) => e.id === event.id)) return false;
  // Past events drop out here, so the file stays short.
  const keep = list.filter((e) => Date.parse(e.end ?? e.start) > Date.now() - 86400000);
  keep.push(event);
  keep.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  writeFileSync(MANUAL, JSON.stringify(keep, null, 2) + "\n");
  return true;
}

// ---- GitHub plumbing --------------------------------------------------------
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts }).trim();
function comment(issue, body) {
  sh("gh", ["issue", "comment", String(issue), "--body", body]);
}
function proposeChange(issue, files, title, body) {
  const branch = `intake/issue-${issue}`;
  sh("git", ["config", "user.name", "sebastopol-events-bot"]);
  sh("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  sh("git", ["checkout", "-B", branch]);
  sh("git", ["add", ...files]);
  sh("git", ["commit", "-m", `${title}\n\nFrom issue #${issue}.`]);
  sh("git", ["push", "-f", "origin", branch]);
  const existing = sh("gh", ["pr", "list", "--head", branch, "--json", "url", "--jq", ".[0].url"]);
  return existing || sh("gh", ["pr", "create", "--head", branch, "--title", title, "--body", `${body}\n\nCloses #${issue}.`]);
}

export { formFields, field, parseWhen, checkEvent, checkSource, sourceReport };

// ---- Main -------------------------------------------------------------------
const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const args = main ? process.argv.slice(2) : [];
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : null;
};

if (!main) {
  // Imported by the tests: nothing to run.
} else if (flag("url")) {
  // By hand: report only, unless --write
  try {
    const r = await checkSource(flag("url"), flag("name"));
    console.log(sourceReport(r));
    if (args.includes("--write")) console.log(addFeed(r).added ? "\nAdded to data/feeds.json." : "\nAlready listed.");
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
  geo.save();
} else if (process.env.GITHUB_EVENT_PATH) {
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const issue = payload.issue;
  const labels = (issue?.labels ?? []).map((l) => l.name);
  const f = formFields(issue?.body);
  try {
    if (labels.includes("add-source")) {
      const r = await checkSource(field(f, "calendar or feed link", "link", "url"), field(f, "group or calendar name", "name"));
      const { added, why } = addFeed(r, issue.number);
      if (!added) comment(issue.number, `${why}\n\n${sourceReport(r)}`);
      else {
        geo.save();
        const pr = proposeChange(issue.number, ["data/feeds.json", "data/geocache.json"], `Add calendar: ${r.name ?? r.src.kind}`, sourceReport(r));
        comment(issue.number, `Thanks. This calendar works, and it is ready to add.\n\n${sourceReport(r)}\n\nOnce a maintainer approves ${pr}, its events show up on the site the next morning, and it is read every morning after that.`);
      }
    } else if (labels.includes("add-event")) {
      const r = await checkEvent(f, issue.number);
      if (!r.ok) comment(issue.number, `Almost. Please edit the request to fix this:\n\n${r.problems.map((p) => `- ${p}`).join("\n")}\n\nEditing the request runs this check again.`);
      else if (!addEvent(r.event)) comment(issue.number, "This event is already on the list.");
      else {
        geo.save();
        const summary = `**${r.event.title}**, ${r.event.start.slice(0, 16).replace("T", " ")}, ${r.event.address} (${r.area === "sebastopol" ? "Sebastopol" : `nearby, ${r.town}`})`;
        const pr = proposeChange(issue.number, ["data/manual-events.json", "data/geocache.json"], `Add event: ${r.event.title}`, summary);
        comment(issue.number, `Thanks. ${summary}\n\nIt shows up on the site once a maintainer approves ${pr}. For a group with more than one event, a calendar link saves you posting each one: see the "Add your calendar" option.`);
      }
    }
  } catch (err) {
    comment(issue.number, `We could not use that yet: ${err.message}\n\nEdit the request to try another link, or reply here and a person will help.`);
  }
} else {
  console.log('Usage: node scripts/intake.mjs --url <calendar link> [--name "Group"] [--write]');
}
