#!/usr/bin/env node
// The language gate for everything this repo publishes. Same rules as
// dearcrisis.com: TELLS and STRUCTURE below are copied verbatim from
// DearCrisis/scripts/check-voice.mjs (October 2026); update them from there
// rather than editing them here.
//
// Prose (group blurbs, category blurbs, the page copy, the README and docs)
// gets every rule. Code and comments get the two that apply everywhere: no
// em dashes, and no forms of the banned verb. A word in quotation marks is
// a mention, not a use, so the rule docs can name it.
//
// Adding a new prose field to data/orgs.json? Add its name to ORG_FIELDS in
// the same commit, or the gate will never read it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORG_FIELDS = ["what", "plugIn"];
const DOMAIN_FIELDS = ["label", "blurb"];

const TELLS = [
  "delve", "unpack", "deep dive", "dive into", "tapestry", "landscape of",
  "game-changer", "game changer", "at the end of the day", "buckle up",
  "testament to", "navigate the complexities", "in an era of", "in a world where",
  "underscore", "underscores", "moreover", "furthermore", "myriad", "plethora",
  "pivotal", "paradigm shift", "seamless", "robust", "leverage the",
  "isn't just", "is not just", "more than just", "stands as", "serves as a reminder",
  "profound implications", "stark reminder", "sobering reminder", "cannot be overstated",
  "ever-evolving", "rapidly evolving", "the realm of", "a journey", "unprecedented times",
  // Claude-specific tells, added 2026-09-23 from the public banlists
  // (claudisms.ai, Wikipedia:Signs of AI writing, kdgbalmer/ai-tells) and
  // Anthropic's own "mannered prose" note for Fable 5.1: metaphors that
  // stand in for a plain statement, fake candor, and phrases that hand the
  // reader a verdict. Von asked for these by name: "carries" (already a
  // STRUCTURE rule), em dashes, past-tense narration.
  "load-bearing", "heavy lifting", "full stop", "stating plainly", "stated plainly",
  "the whole game", "the whole ballgame", "hand-waving", "hand-wave", "at its core",
  "when it comes to", "the real question", "here's the thing", "here is the thing",
  "genuinely", "the honest version", "and the trap is", "double down", "lean into",
  "unlock", "the engine of", "the physics of",
  // The verb "carry" moved to STRUCTURE (a whole-word regex over every form)
  // on 2026-09-11, after "carries both lists" got past this list.
  // Metaphor shorthand used as page vocabulary. Von rejected each of these
  // by name: say campaigns, legal barriers, the funding gap, the five
  // questions. A metaphor is fine once, where the sentence defines it.
  "legal walls", "the same walls", "hit the same walls", "money surges",
  "the surges", "surge of collective", "ledger problem", "runs the frame",
  "the frame every", "standing invitation",
];

const STRUCTURE = [
  {
    // Von, 2026-08-16: "carries them" and its relatives are a tell. 2026-08-28:
    // "carried" too. 2026-09-11: "The Blind Spot carries both lists at length"
    // shipped because only the phrases were listed, so the rule is now the
    // verb itself, every form, whole word. Say what the thing has, holds,
    // states, brings, or does. (Salon 13's "carries an insect across the
    // line" and the rest were rewritten the same day.)
    re: /\bcarr(?:y|ies|ying|ied)\b/i,
    why: 'the verb "carry" is banned in every form: say what the thing has, holds, states or brings',
    key: "carry",
  },
  {
    // Announce-openers. "Say it plainly" told the reader nothing the next
    // sentence did not; the statement was already the point.
    re: /(^|[.!?]\s+)(say it plainly|here'?s where |here is where |this is where |which brings (?:me|us) (?:back )?to |put simply|simply put|the short version|the bottom line|honestly,|frankly,|here is (?:what|why|how) |now let'?s|let'?s (?:look|talk|start)|what it says|so what breaks|it started with|the point is|to be clear|worth noting)\b/i,
    why: "framing: announces what is coming instead of saying it",
  },
  {
    // Verdict closers: the writer's judgement handed to the reader.
    re: /(^|[.!?]\s+)(and that is (?:what makes|why it matters|the point)|and that matters|this matters|that'?s the tell|that is the tell|which is the (?:trouble|beauty|problem) with|that is the whole (?:point|argument)|and that changes everything)\b/i,
    why: "verdict: tells the reader what to conclude",
  },
  {
    // Von, 2026-08-24: rooms and things that "sit", "nestle" or "perch".
    // "Behind it sits a private back room" is a machine-writing tell, not
    // description. Use a plain verb or none: "behind it, the private back
    // room has a screen". Deliberately narrow: only the inverted locative
    // ("sits a/an/the") and nestle/perch. "X sits between Y and Z" on a
    // scale, and "the evidence that sits behind the declaration", are
    // ordinary English and Von writes both; a rule that flagged those
    // would be the rule-of-three mistake again.
    re: /\b(?:sits|sat)\s+(?:a|an|the)\b|\b(?:nestled|nestles|perched|perches)\b/i,
    why: "machine-writing tell: an inanimate thing sitting, nestling or perching. Use a plain verb, or none",
  },
  // The three shapes below were added 2026-09-23. Von wants the gate to catch
  // what makes prose read as Claude's, not only the word list: the stacked
  // "No X. No Y." fragments, the metaphor that stands in for a plain verb,
  // and the past-tense report of an idea that is still true ("the salon
  // explored", "he unpacked"). Tense follows the fact: past for dated
  // events, present for what is true now.
  //
  // Deliberately NOT here: the "X isn't A. It's B." cleft, even though it is
  // the most-cited AI tell on every public list. It was written and pulled
  // the same day, like the rule of three: it fired 39 times on approved
  // copy, and those are the house voice, not padding ("The danger isn't
  // collapse. It's lock-in." is Salon 9's through-line; "The system isn't
  // broken. It's doing what it was built to do" is Lent's own line). The
  // tell is the intensified form, "isn't JUST X, it's Y" and "more than
  // just", which stays in TELLS. Everything else is an editorial call.
  {
    re: /\bNo [\w'-]+(?: [\w'-]+){0,3}\. No [\w'-]+(?: [\w'-]+){0,3}\./,
    why: 'stacked "No X. No Y." fragments: write a sentence',
    key: "staccato",
  },
  {
    // "worth sitting with", "the shape of the argument", "reaching for a
    // metaphor". Kept to the figurative forms: "sit with it" is the thesis
    // of Hospicing Modernity and "hands you a name tag" is a greeter, and
    // the first draft flagged both.
    re: /\b(?:worth )?sitting with\b|\bthe shape of (?:the|a|this|that|his|her|their) (?:argument|problem|question|answer|idea|conversation|crisis)\b|\breach(?:es|ing)? for (?:a |the )?(?:metaphor|word|phrase|language|gravitas|depth|weight)\b/i,
    why: "metaphor standing in for a plain statement: say the literal thing",
    key: "metaphor",
  },
  {
    re: /\b(?:explored|unpacked|walked (?:us |the room |them )?through|touched on|dove into|dug into|delved)\b/i,
    why: "past-tense report of an idea (explored, unpacked, walked through): state the idea in the present",
    key: "pastreport",
  },
];

const EM_DASH = /\u2014|\s--\s/;
const CARRY = /(?<!")\bcarr(?:y|ies|ying|ied)\b(?!")/i;

const problems = [];
const show = (t, i, n = 40) => t.slice(Math.max(0, i - n), i + n + 20).replace(/\s+/g, " ");

function checkProse(where, text) {
  if (typeof text !== "string" || !text) return;
  checkCode(where, text);
  for (const { re, why, key } of STRUCTURE) {
    if (key === "carry") continue;
    const m = text.match(re);
    if (m) problems.push(`${where}: ${why}: "...${show(text, m.index)}..."`);
  }
  const lower = text.toLowerCase();
  for (const t of TELLS) {
    const at = lower.indexOf(t);
    if (at !== -1) problems.push(`${where}: "${t}": "...${show(text, at)}..."`);
  }
}
function checkCode(where, text) {
  const d = text.match(EM_DASH);
  if (d) problems.push(`${where}: em dash (use a comma, colon or full stop): "...${show(text, d.index)}..."`);
  const c = text.match(CARRY);
  if (c) problems.push(`${where}: the banned verb (say has, holds, states or brings): "...${show(text, c.index)}..."`);
}

// 1. Data prose
const orgs = JSON.parse(readFileSync(join(ROOT, "data/orgs.json"), "utf8"));
for (const o of orgs) for (const f of ORG_FIELDS) checkProse(`data/orgs.json ${o.id}.${f}`, o[f]);
const domains = JSON.parse(readFileSync(join(ROOT, "data/domains.json"), "utf8"));
for (const d of domains) for (const f of DOMAIN_FIELDS) checkProse(`data/domains.json ${d.id}.${f}`, d[f]);

// 2. Page copy: the visible text of the page
for (const page of ["site/index.html"]) {
  readFileSync(join(ROOT, page), "utf8")
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, "\n")
    .split(/\n+/)
    .forEach((line) => line.trim() && checkProse(page, line.trim()));
}

// 3. Docs: paragraph by paragraph, code blocks and inline code left out
for (const f of ["README.md", "AGENTS.md", "HANDOFF.md", ...readdirSync(join(ROOT, "docs")).map((n) => "docs/" + n)]) {
  if (!f.endsWith(".md")) continue;
  readFileSync(join(ROOT, f), "utf8")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\n+/)
    .forEach((p) => checkProse(f, p.replace(/`[^`]*`/g, "x")));
}

// 4. Everything else that people read: scripts, styles, workflow, page code
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "data", "docs"]);
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p);
    } else if (/\.(js|mjs|css|yml|yaml|html|sh)$/.test(name) && !p.endsWith("check-voice.mjs")) {
      readFileSync(p, "utf8").split("\n").forEach((line, i) => checkCode(`${relative(ROOT, p)}:${i + 1}`, line));
    }
  }
}
walk(ROOT);

if (problems.length) {
  console.error(`check-voice: ${problems.length} problem(s)\n` + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log(`check-voice: clean (${orgs.length} groups, ${domains.length} categories, page copy, docs, scripts)`);
