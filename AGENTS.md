# Working on Sebastopol Events

Read `HANDOFF.md` and the recent commits before changing anything.

## Everything published passes the gate

```bash
npm run gate
```

The gate is the voice check (`scripts/check-voice.mjs`), the data check (`scripts/check-data.mjs`) and the tests. It runs first in the deploy, so a failing gate cannot publish.

The voice rules are the Dear Crisis house voice. Plain words. No em dashes. The verb "carry" is banned in every form: say what the thing has, holds, states or brings. No framing sentence at the front of a paragraph and no verdict at the back. Plain nouns instead of metaphors. Present tense for what is true now. The gate reads group blurbs, category blurbs, the visible page copy and every doc; code and comments get the em dash and "carry" rules.

Adding a prose field to `data/orgs.json`? Add its name to `ORG_FIELDS` in `scripts/check-voice.mjs` in the same commit, or the gate never reads it.

## Geography

Two rings, both in `scripts/lib/geo.mjs`:

- **Sebastopol** is ZIP 95472, from the Census Bureau's ZCTA outline in `data/core-95472.json`. Graton (95444) is a hole inside it and counts as nearby.
- **Nearby** is everything within 22 km of downtown Sebastopol that is not the ZIP. It reaches Bodega Bay (20 km), Guerneville and Windsor, and leaves out Petaluma (25 km), Healdsburg (23.5 km), Jenner and Kenwood.

Every keep-or-drop decision goes through `inRegion()`, and `areaFor()` says which ring. The text tests (`areaByText`) read ZIP codes and town names for listings without coordinates, and `namesElsewhere()` vetoes a listing that names a town outside the ring.

Town points for Graton and Occidental are their downtown crossroads. OpenStreetMap's points for both are census-area centroids that land inside 95472.

## Groups

Each group in `data/orgs.json` has `id`, `name`, `url`, `what` (one line, under 260 characters), `plugIn` (how to take part), `kind`, `domains`, `area`, `town`, `address`, `eventsPage`, `instagram`, `feeds` and `evidence`. `scripts/geocode-orgs.mjs` fills `lat`, `lng`, `area` and `town` from the address.

Public contact channels only. Never record a calendar id that is someone's personal Gmail address; a group calendar's id ends in `@group.calendar.google.com`. Do not use AllEvents.in as a source.

Feed formats the fetcher reads: `ics`, `luma`, `meetup`, `tockify`, `civicplus`, `squarespace`, `tribe`, `mobilize`, `rss`, `rss-future`, `jsonld`, `eventbrite`, `mahina`, `fullcalendar`. A feed's `scope` is `local` (keep events with no place, they are the group's own) or `filter` (keep only events placed inside the ring).

## Submissions

Issues from the Add forms are untrusted input. `scripts/intake.mjs` reads them from the event payload and passes values to `git` and `gh` as arguments. Never interpolate issue text into a shell command or a workflow expression.

## Deploys

A push to `main` deploys. Merges to `main` and anything that changes what the public sees need Ben's go-ahead; pushing a working branch does not.
