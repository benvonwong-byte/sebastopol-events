# Sebastopol Events

Every public event in Sebastopol, California (ZIP 95472) and the towns within about 22 km, the groups behind them, and a map. The site rebuilds itself every morning from public calendars, and anyone can add theirs.

Live at https://benvonwong-byte.github.io/sebastopol-events/ (unlisted from search engines until `INDEX=1` is set in the deploy workflow).

## What it shows

Three views share one switch at the top: **Sebastopol** (the ZIP) or **Sebastopol + nearby** (Graton, Forestville, Occidental, Freestone, Bodega, Bodega Bay, the river towns, Cotati, Rohnert Park, Santa Rosa and Windsor).

- **Groups** is the directory: nonprofits, farms, venues, neighborhood groups, the city and the library, each with a line on how to take part.
- **Map** shows today, the next seven days, or the groups. ZIP 95472 is shaded amber with Graton cut out of it, and a dashed circle marks the nearby ring. Pins in Sebastopol are filled; pins outside it are hollow.
- **Events** is one list by day, with a strip of dates on top. Rows outside Sebastopol have an amber edge and an amber "Nearby · Town" label.

The look follows [Green Valley Farm + Mill](https://gvfam.com/home): a black band with spaced capitals, Raleway, a white page and one amber.

## Adding a calendar or an event

The Add button on the site has three paths:

1. **A calendar.** Paste a link (Luma, Google Calendar, Meetup, Eventbrite organizer, Mobilize, Tockify, any .ics or webcal, RSS, a Squarespace or WordPress events page). It opens a short GitHub form with the link filled in.
2. **One event.** A form for a one-off.
3. **No calendar yet.** Five-minute setup steps for a free Luma or Google calendar.

Either form opens an issue. The `Check a submission` workflow reads the link (or checks the date and the address), replies on the issue with what it found, and opens a pull request. A maintainer merges it, and the deploy picks it up. The full guide is in [docs/adding-a-source.md](docs/adding-a-source.md).

By hand:

```bash
node scripts/intake.mjs --url https://luma.com/some-calendar --name "Some Group"
node scripts/intake.mjs --url https://luma.com/some-calendar --name "Some Group" --write
```

The first only reports; `--write` also adds it to `data/feeds.json`.

## Feeds out

Every morning's build publishes the listings for anyone to use:

| File | What |
| --- | --- |
| `events.ics` | Everything, Sebastopol and nearby |
| `events-sebastopol.ics` | Sebastopol only |
| `events-<category>.ics` | One per category (`food-farms`, `land-water` and the rest) |
| `events.rss` | RSS 2.0 |
| `feed.json` | JSON Feed 1.1, with the start, place, ring and town of each event under `_event` |
| `data/events.json` | The raw file the page reads |

## How the morning run works

`.github/workflows/deploy.yml` runs at about 6 AM Pacific and on every push to `main`:

1. `npm run gate`: the language gate, the data check and the tests.
2. `scripts/geocode-orgs.mjs` places new groups on the map.
3. `scripts/fetch-events.mjs` reads every group's feeds, the calendars in `data/feeds.json`, the events added by hand in `data/manual-events.json`, and the aggregators (Luma, Eventbrite, Meetup, the Bohemian and Press Democrat calendars, the Sonoma County Library, What's Happening in Sebastopol and others in `scripts/lib/aggregators.mjs`, notes in `docs/aggregators.md`). It keeps what falls inside the ring, marks each event `sebastopol` or `nearby`, merges duplicates, drops closure notices, and shows a repeating series only for its next six dates.
4. `scripts/needs-feed.mjs` lists the groups we cannot read yet in `docs/needs-a-feed.md`.
5. `scripts/build.mjs` writes `dist/` and Pages publishes it.

A source that fails one morning keeps its last good read for 14 days, so one bad night does not empty the calendar.

Eventbrite turns away GitHub's servers. `scripts/home-refresh.sh` runs the same fetch from a home connection and pushes the result; `scripts/install-home-refresh.sh` sets it up as a launch agent on a Mac.

## Where things are

| Path | What |
| --- | --- |
| `site/` | The page: `index.html`, `style.css`, `app.js` |
| `data/orgs.json` | The groups, their feeds and how to take part |
| `data/feeds.json` | Regional and community-added calendars, always filtered to the ring |
| `data/manual-events.json` | Single events added through the site |
| `data/domains.json` | The eight categories and their colors |
| `data/core-95472.json` | The ZIP outline from the Census Bureau, with Graton as a hole |
| `scripts/lib/geo.mjs` | The two rings, the town list and the text tests |
| `scripts/lib/detect.mjs` | Turns a pasted link into a feed |
| `scripts/intake.mjs` | Checks a submission and opens the pull request |
| `.github/ISSUE_TEMPLATE/` | The two Add forms |

## Running it locally

```bash
npm run fetch
npm run dev
```

`npm run dev` builds and serves `dist/` on http://localhost:4322. Node 20 or newer; no dependencies to install.
