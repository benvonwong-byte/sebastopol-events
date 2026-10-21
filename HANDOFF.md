# Handoff

The state of Sebastopol Events, for whoever picks it up next. Read this and the recent commits before changing anything.

## Who has it

Ben (benvonwong-byte) built it with Claude on 2026-10-20 and asked for Jeff Mendelsohn (@jeffmendelsohn) to pick it up from here. Jeff is a collaborator on the repo with write access, which covers pushing, merging pull requests and running the workflows. Pages settings and a custom domain need admin access on the repo; ask Ben for it if you need those.

## What it is

A version of the Sunset events site (`benvonwong-byte/sunset-buildathon`, sunset.dearcrisis.com) for Sebastopol, California. Ben asked for it on 2026-10-20: events around ZIP 95472, the option to zoom out to the wider area in a different color, the look of https://gvfam.com/home, and an easy way for anyone to add an event, an RSS feed or a Luma calendar so the scraper keeps tracking it.

## Where it is

- Repo: https://github.com/benvonwong-byte/sebastopol-events (public)
- Site: https://benvonwong-byte.github.io/sebastopol-events/ (GitHub Pages from the deploy workflow; `noindex` until `INDEX: "1"` is set in `.github/workflows/deploy.yml`)
- Local copy: `~/Dropbox/ClaudeCode/sebastopol-events`
- Local preview: the `sebastopol` entry in `DearCrisis/.claude/launch.json` serves `dist/` on port 4322 (that file is gitignored there)

## What is built

- **Three views and one area switch.** Groups, Map and Events, with "Sebastopol" (ZIP 95472) or "Sebastopol + nearby" (22 km). Outside the ZIP is amber: an amber edge and "Nearby · Town" label on rows, hollow pins on the map, a dashed ring around the shaded ZIP.
- **The Add dialog.** Three paths: paste a calendar link (with a hint saying what kind it is), one event, and "No calendar yet" setup steps for Luma and Google Calendar. Both forms open a prefilled GitHub issue (`.github/ISSUE_TEMPLATE/`).
- **Intake.** `.github/workflows/intake.yml` runs `scripts/intake.mjs` on those issues: it detects the link (`scripts/lib/detect.mjs`), reads it once, counts events in Sebastopol and nearby, replies on the issue, and opens a pull request adding it to `data/feeds.json` or `data/manual-events.json`.
- **Feeds out.** ICS (everything, Sebastopol only, one per category), RSS (`events.rss`) and JSON Feed (`feed.json`).
- **Data.** 155 groups in `data/orgs.json` (101 in Sebastopol, 54 nearby), 52 of them with a calendar the fetcher reads, from four research passes on 2026-10-20. The fetcher also runs the aggregators in `scripts/lib/aggregators.mjs`: Luma, Eventbrite, Meetup, the Bohemian and Press Democrat calendars (CitySpark), the county library, What's Happening in Sebastopol, the city, the chamber, regional parks, Farm Trails and Sonoma County Tourism. Endpoints, headers and what failed are in `docs/aggregators.md`. The first full read found 2,197 events in the next 60 days: 788 in Sebastopol and 1,409 nearby.
- **Cleanup rules in the fetcher.** Titles that announce a closure, a cancellation, a private rental or "no meeting" are dropped, and a repeating series (one group, one title) shows only its next six dates. Calendars that mix public events with internal meetings (the UCC church, St. Stephen's, the senior center, SRJC, the cultural center) have `skip` patterns on their feeds in `data/orgs.json`.
- **Repo settings done.** Labels `add-source` and `add-event`; Actions may create pull requests (`default_workflow_permissions=write`); Pages enabled with `build_type=workflow`.

## What is left

- Watch the first few morning runs (Actions tab, "Refresh listings and deploy"). The footer of the site lists each source and how many events it gave that morning. The first run from GitHub's servers (2026-10-21) read 60 of 68 sources and published 2,175 events. Eventbrite refused it ("no csrftoken cookie"), and six WordPress sites answered their REST endpoint with a block page: the Community Cultural Center, Farm Trails, Luther Burbank Center, Gold Ridge RCD, CNPS Milo Baker and OAEC (403). Their events stayed on the site through the 14-day last-good fallback. `scripts/lib/read-feed.mjs` now falls back to each site's `?ical=1` export when the REST endpoint fails; check the next run's log to see whether that got through. The Farm Trails aggregator has its own reader without that fallback. Meetup and CitySpark worked from GitHub.
- The Parks and Tourism readers parse page HTML, so a redesign of either site makes them return nothing without an error. A source that returns nothing keeps its last good read for 14 days.
- srcity.org (City of Santa Rosa) and sonoma.edu answer every server request with a Cloudflare block, so those calendars are not read.
- Eventbrite turns away GitHub's servers, so Eventbrite listings appear only on mornings when `scripts/home-refresh.sh` runs from a home connection. `scripts/install-home-refresh.sh` installs it as a launch agent; it is not installed for this repo yet.
- Some groups have no readable calendar: `docs/needs-a-feed.md` lists them, refreshed every morning.

## Decisions for Ben (and Jeff)

1. **An email address for "Email it instead".** Set `CONTACT` at the top of `site/app.js`. While it is empty, those links are hidden and the only way to add something is a GitHub account.
2. **A community Luma calendar.** A "Sebastopol community" calendar on Luma that accepts submissions would let people add one-off events with no GitHub account. Once it exists, add it to `data/feeds.json` and mention it in the "One event" pane.
3. **A custom domain**, if this should live at something like sebastopol.dearcrisis.com. The order matters (it went wrong once on Sunset): create the DNS CNAME to `benvonwong-byte.github.io` first, then set the domain on Pages, then set `SITE_URL` in the deploy workflow.
4. **Indexing.** Set `INDEX: "1"` in the deploy workflow when it should appear in search results.

## Links to review

- The site: https://benvonwong-byte.github.io/sebastopol-events/
- Wider area: https://benvonwong-byte.github.io/sebastopol-events/#view=map&area=nearby
- The Add forms: https://github.com/benvonwong-byte/sebastopol-events/issues/new/choose
