# Sebastopol event aggregators: research notes

For a daily events feed centred on Sebastopol, California (ZIP 95472, Sonoma
County). Researched and tested 2026-10-20 with plain `fetch`/`curl` from a
residential IP: no keys, no browser, no login. Code: `aggregators.mjs` (same
folder), generalized from the tested San Francisco module
(`sunset-buildathon/scripts/lib/aggregators.mjs`). Raw output of the final run:
`raw/all_events.json` (2,651 rows) and `raw/run.txt`.

## Region

```js
REGION = {
  name: "Sebastopol",
  center: [38.4021, -122.8239],          // downtown
  radiusKm: 22,
  box: { minLat: 38.2045, maxLat: 38.5997, minLng: -123.0761, maxLng: -122.5717 },
  core: {                                 // used only by classify()
    zips: ["95472", "95473"],             // 95473 = Sebastopol PO boxes
    towns: ["sebastopol", "freestone"],   // Freestone is inside 95472
    box: { minLat: 38.33, maxLat: 38.47, minLng: -122.93, maxLng: -122.76 },
  },
}
```

`regionAround([lat, lng], radiusKm, extra)` builds the box from the radius.
22 km (changed from 19 km during the work) reaches Bodega Bay (20.0 km),
Duncans Mills (20.8), Guerneville (18.6), Monte Rio (18.1), Windsor (16.1) and
Penngrove (17.4). Healdsburg (23.5), Petaluma (25.0), Jenner (26.3) and
Cazadero (28.1) fall outside. Every fetcher reads the radius from the region
argument; nothing is hard-coded, because the site filters again with its own
rule.

## Summary (next 60 days, run of 2026-10-20 ~17:50 PDT)

"Dropped" counts rows inside the 60-day window that the fetcher threw away
(outside the radius, no usable location, online, cancelled).

| Source | Works | Method | Coordinates | Core | Nearby | Dropped |
|--------|-------|--------|-------------|-----:|-------:|--------:|
| Luma | yes | `api.lu.ma/discover/get-paginated-events?latitude&longitude` | yes (some jittered) | 5 | 2 | 7 |
| Eventbrite | yes | `POST /api/v3/destination/search/` with region `bbox`, csrftoken cookie | yes | 50 | 306 | 67 |
| Meetup | yes | `POST /gql2` `recommendedEvents`, 22 tiled circles | yes | 4 | 69 | 11 |
| CitySpark: North Bay Bohemian (= Pacific Sun) + Press Democrat | yes | `POST portal.cityspark.com/api/events/GetEvents/<slug>` | yes | 167 | 1,177 | 378 |
| Sonoma County Library | yes | LibraryCalendar JSON feed `/events/feed/json` | branch coords; offsite by text | 47 | 456 | 9 |
| sebastopolcalendar.com (City of Sebastopol community calendar) | yes | The Events Calendar REST `tribe/events/v1` | partial (venue geo) | 66 | 5 | 0 |
| City of Sebastopol meetings | yes | meeting-calendar page, AddEvent markup (+ meeting page when blank) | known halls | 14 | 0 | 0 |
| Sonoma County Regional Parks | yes | `parks.sonomacounty.gov/play/calendar` HTML | park gazetteer | 0 | 33 | 2 |
| Sonoma County Tourism | yes | `admin-ajax.php?action=dataengine-events&_view=month` | yes (map data) | 5 | 68 | 46 |
| Sebastopol Area Chamber | yes | GrowthZone month grid + detail-page microdata | text | 19 | 8 | 0 |
| Sonoma County Farm Trails | yes | The Events Calendar REST `tribe/events/v1` | text (ZIP/town) | 32 | 39 | 58 |
| Santa Rosa Junior College | yes | LiveWhale `/live/json/events/...` | campus gazetteer | 0 | 79 | 122 |
| City of Santa Rosa | no | Cloudflare block ("Sorry, you have been blocked") | | | | |
| Sonoma State University | no | Cloudflare managed challenge | | | | |
| Pacific Sun | not queried | same CitySpark set as the Bohemian | | | | |

Total 2,651 rows (409 core, 2,242 nearby, 700 dropped) before cross-source
dedupe; 2,218 distinct title + date pairs. The whole run takes about 45 s with
sources in parallel (Meetup and CitySpark are the long poles at ~45 s and
~41 s).

## Shared conventions in the module

- Every fetcher: `fetchX({ region = REGION, days = 60, now, budgetMs = 100000 })`.
  Requests inside one source are sequential with 200 to 1,500 ms gaps;
  `fetchAll()` runs sources in parallel. Each fetcher has page caps and a time
  budget, catches everything, `console.warn`s, and returns `[]`. Verified
  with `fetch` stubbed to throw and to return 403: all 12 return `[]` with
  `stats.error` set, no exception escapes.
- Result arrays have a non-enumerable `stats`:
  `{ dropped: { outside, noLocation, online, cancelled }, error? }`. Only rows
  inside the time window are counted. `fetchAll()` returns
  `bySource[name] = { events, stats, ms }`.
- Event shape is unchanged from the SF module:
  `{ title, start, end, allDay, url, venue, address, lat, lng, org, source, image, description (<=400 chars), free }`.
  `start`/`end` are America/Los_Angeles wall time with the right DST offset
  (`2026-11-10T09:00:00-08:00`). `end` is null when the source gives none or
  gives one before the start.
- Location filter: haversine distance from `region.center` <= `region.radiusKm`.
  Source coordinates win. Without them, `locateByText()` places the
  venue/address string: (1) a gazetteer of ~55 named places (Regional Parks,
  library branches, SRJC sites, Green Music Center, Sebastopol City Hall,
  Youth Annex, Ives Park, The Barlow); (2) a town name, ~45 towns from
  Freestone to Gualala; (3) a ZIP centroid, ~55 ZIPs. Town matching reads
  "Town, CA" / "Town 9xxxx" first, then a looser "Forestville Methodist
  Church" style match that skips street names ("470 Sebastopol Rd, Santa
  Rosa" is Santa Rosa, "Petaluma Hill Rd" is not Petaluma). `lat`/`lng` are
  filled only from the source or from a named-place match; town and ZIP
  centroids are used for the radius test but not written into the event.
- Gazetteer coordinates were looked up once with the US Census geocoder
  (addresses) and OpenStreetMap Nominatim (towns, ZIPs, parks) and are
  hard-coded, so the daily run calls no geocoder. Four parks are marked
  approximate in the code (EDC at Spring Lake, Mark West Creek, Hood
  Mountain, Two Rock).
- `classify(event, region)` returns `core | nearby | out | unknown`:
  1. address ZIP in `core.zips` -> core;
  2. no ZIP, address names a core town (Sebastopol, Freestone) -> core;
  3. coordinates (source or gazetteer) outside the radius -> out;
  4. no ZIP and no town named, coordinates inside `core.box` -> core;
  5. otherwise nearby.
  A named non-core town wins over the core box, which also covers Graton
  (95444) and the edge of Forestville. Consequence worth knowing: Balletto
  winery (5700 Occidental Rd, 2 km from downtown) has a Santa Rosa 95401
  address, so it is "nearby"; Camp DoomsDaddy on Green Valley Rd (10.9 km
  out) has a Sebastopol 95472 address, so it is "core". That is the ZIP rule
  doing what it says.
- Single-town calendars (sebastopolcalendar.com, the Chamber) fall back to
  "Sebastopol, CA" when a row has no venue at all. On the final run that
  fallback was not needed for any row.

---

## 1. Luma

**Works, small.** Same method as SF.

- `GET https://api.lu.ma/discover/get-paginated-events?latitude=38.4021&longitude=-122.8239&pagination_limit=50[&pagination_cursor=...]`
  returns every discoverable event within about 70 km, sorted by `start_at`.
  14 rows in total for Sebastopol (one page): Sonoma, Petaluma, Napa,
  Benicia, Novato and 7 inside 22 km (Sebastopol, Santa Rosa, Graton). It
  does return Sonoma County events.
- Fields and caveats as in the SF notes: `event.coordinate` is jittered when
  `geo_address_info.mode` is `obfuscated` (then only `city_state` is shown,
  for example "Sebastopol, CA"; "Game Day" plots 6.2 km out). Description from
  `GET https://api.lu.ma/event/get?event_api_id=evt-...` (`description_mirror`).
- No rate limiting seen.

## 2. Eventbrite

**Works. 356 in radius from one bbox search.**

- Same flow as SF: `GET https://www.eventbrite.com/signin/` for the
  `csrftoken` cookie, then `POST https://www.eventbrite.com/api/v3/destination/search/`
  with `x-csrftoken`, `cookie: csrftoken=...`,
  `referer: https://www.eventbrite.com/d/ca--sebastopol/events/`.
- Body uses the region box: `"bbox": "-123.0761,38.2045,-122.5717,38.5997"`
  (`west,south,east,north`), `dates: "current_future"`, `page_size: 50`.
  On 2026-10-20: `object_count` 402 over 9 pages; 67 rows dropped by the
  haversine filter (mostly Petaluma in the box corners).
- Results are not date-sorted, so the fetcher reads every page (cap 25,
  stop when `pagination.continuation` is null).
- No rate limiting seen (10 requests).

## 3. Meetup

**Works without auth, but `recommendedEvents` truncates and throttles silently.**

- `POST https://www.meetup.com/gql2`, raw GraphQL, same query as SF
  (`recommendedEvents(filter: {lat, lon, radius (miles), eventType: PHYSICAL,
  startDateRange, endDateRange})`).
- One 12-mile circle on downtown returns 34 events (Santa Rosa 29, Sebastopol
  4). Circles of 4 miles on Santa Rosa and on Rohnert Park/Cotati return 29
  each, mostly different ones; the union reaches ~70. The fetcher asks one
  region-sized circle, then a grid of circles 12 km apart (radius 5.6 mi)
  covering the 22 km disc: 22 requests, ~44 s at 1.5 s spacing. Final run:
  73 kept, 11 outside.
- **Throttling:** after ~8 requests within a minute (1 s apart) gql2 kept
  answering `200` with `totalCount: 0` and no edges for a couple of minutes,
  then recovered. Nothing in the response says it is throttled. At 1.5 to
  2.5 s spacing, 22 requests went through cleanly three times. The fetcher
  treats an empty first (region-sized) circle as a throttle: it waits 20 s,
  retries once, and warns if still empty.
- Online events still come with a fake venue (filtered by `eventType`).

## 4. CitySpark: North Bay Bohemian, Pacific Sun, Press Democrat

**Works, and it is the biggest single source.** All three papers embed the
same CitySpark calendar widget.

- Widget script: `https://portal.cityspark.com/PortalScripts/<slug>` sets
  `cSparkLocals` with `slug`, `ppid`, `baseUrl`. Bohemian `ppid` 9093
  (`baseUrl` `https://Bohemian.com/events-calendar`), Pacific Sun `PacificSun`
  9096, Press Democrat `SRPressDemocrat` 8662
  (`https://www.pressdemocrat.com/events`).
- **Endpoint:** `POST https://portal.cityspark.com/api/events/GetEvents/<slug>`,
  `content-type: application/json`, no cookie or token:
  ```json
  {"ppid":9093,"start":"2026-10-20T00:00","end":null,"labels":[],"pick":false,
   "tps":"24","sparks":false,"sort":"Time","category":[],"distance":15,
   "lat":38.4021,"lng":-122.8239,"search":"","skip":0,"defFilter":"all"}
  ```
  `distance` is in miles (the fetcher sends `ceil(radiusKm / 1.609) + 1` and
  filters by haversine). 25 rows per call; page with `skip += 25`; stop when
  a page is empty or its last `StartUTC` is past the window. Sort options in
  the widget: `Popularity` (default), `Time`, `A to Z`, `Z to A`,
  `Spotlight`. `"sort":"Date"` is not one of them and returns rows from 2028
  first.
- Response `{ Success, Value: [...] }`. Fields: `PId` (listing id), `Id`
  (occurrence id, differs per portal), `Name`, `Summary`, `Description`,
  `Venue`, `Address`, `CityState`, `Zip`, `latitude`/`longitude`,
  `Distance` (miles), `StartUTC`/`EndUTC` (true UTC), `DateStart`/`DateEnd`
  (**local wall time wrongly suffixed `Z`**; use only for the date of all-day
  rows), `AllDay`, `HasTime`, `Free`, `Price`, `LargeImg`, `PrimaryUrl`,
  `isVirtual`, `Format` (2 = virtual), `Tags`. `ct` holds the submitter's
  name, phone and email; the fetcher reads only `ct.org`.
- Event page URL (from the widget's router):
  `<baseUrl>/#!/details/<name lowercased, \W+ -> ->/<PId>/<DateStart first 13 chars>`.
- Overlap: Pacific Sun returned exactly the Bohemian set (200/200 same ids),
  so it is not queried. Press Democrat uses different `Id`s but 191 of its
  first 200 match Bohemian rows on `PId + StartUTC`; over 60 days it adds 37
  rows. The fetcher reads Bohemian then Press Democrat and merges on
  `PId|StartUTC`.
- Volume: ~110 requests in ~41 s, no throttling. 1,344 kept, 375 outside.
- CitySpark aggregates other calendars: 269 of its rows match a Sonoma
  County Library row by title and date (library programs are syndicated in).

## 5. Sonoma County Library

**Works. Platform: LibraryMarket LibraryCalendar (Drupal) at
`events.sonomalibrary.org`.** BiblioCommons has no events
(`sonomalibrary.bibliocommons.com/events` 404) and there is no LibCal
(`sonomalibrary.libcal.com` does not resolve).

- **JSON feed:**
  `GET https://events.sonomalibrary.org/events/feed/json?_wrapper_format=lc_calendar_feed&start=2026-10-20&end=2026-11-20&branches%5B102%5D=102&branches%5B94%5D=94...`
  Returns a plain array, all rows for the range, no paging (60 days for 13
  branches is ~430 rows in 5 s; the fetcher asks in 31-day chunks).
  `current_month=2026-10` instead of start/end returns the whole month for
  every branch (2.8 MB).
- **ICS** also works: `https://events.sonomalibrary.org/events/feed/ical`
  (Sabre VObject, 1.6 MB, all branches). Not used; the JSON has branch ids
  and structured offsite addresses.
- Branch ids (from the `branches[...]` checkboxes on `/events/month`):

  | id | Branch | Address |
  |---:|--------|---------|
  | 102 | Sebastopol Regional Library | 7140 Bodega Ave, Sebastopol 95472 |
  | 100 | Rincon Valley Regional Library | 6959 Montecito Blvd, Santa Rosa 95409 |
  | 84 | Central Santa Rosa Library | 211 E St, Santa Rosa 95404 |
  | 101 | Rohnert Park-Cotati Regional Library | 6135 State Farm Dr, Rohnert Park 94928 |
  | 94 | Forestville Community Library | 7050 Covey Rd, Forestville 95436 |
  | 95 | Guerneville Regional Library | 14107 Armstrong Woods Rd, Guerneville 95446 |
  | 98 | Occidental Community Library | 73 Main St, Occidental 95465 |
  | 97 | Northwest Santa Rosa Library | 150 Coddingtown Center, Santa Rosa 95401 |
  | 189 | Roseland Regional Library | 470 Sebastopol Rd, Santa Rosa 95407 |
  | 104 | Windsor Regional Library | 9291 Old Redwood Hwy, Windsor 95492 |
  | 141 | Sonoma County History & Genealogy Library | 725 3rd St, Santa Rosa 95404 |
  | 99 / 96 / 103 / 93 | Petaluma / Healdsburg / Sonoma Valley / Cloverdale | outside 22 km |
  | 186 | BiblioBus (mobile; location per stop) | |
  | 85 | Off Site | |
  | 113 / 241 | Virtual Events / Adult Literacy Program | |

  The fetcher queries every branch whose coordinates are inside the radius,
  plus BiblioBus and Off Site.
- Fields: `title`, `url`, `start_date`/`end_date` ("2026-10-21 10:30:00",
  local), `timezone`, `branch` (`{id: name}`; a list of every branch for
  "LIBRARY CLOSED" notices, which are skipped), `room`, `offsite_address`
  (multi-line string) and `offsite_address_raw` (structured), `online_address`,
  `program_type`, `age_group`, `description` (HTML), `image`,
  `registration_enabled`, `contact_*` (staff; not read).
- 110 of 430 rows are offsite (Ives Park, Youth Annex, Burton Ave Rec Center,
  BiblioBus stops in Bodega Bay, Monte Rio, Cazadero). Those are placed by
  their own address; a BiblioBus stop in Petaluma or Cazadero is dropped as
  outside.
- No rate limiting seen.

## 6. sebastopolcalendar.com ("What's Happening in Sebastopol?")

**Works. This is the City of Sebastopol's community calendar:**
`https://www.cityofsebastopol.gov/our-community/community-calendar/` is an
iframe of `https://sebastopolcalendar.com/events/?embed_id=all`, a WordPress
site running The Events Calendar Pro.

- `GET https://sebastopolcalendar.com/wp-json/tribe/events/v1/events?start_date=2026-10-20&end_date=2026-12-19&per_page=50&page=N`
  -> `{ events, total, total_pages, next_rest_url }`. 73 events in 60 days
  (2 pages).
- Fields: `title`, `url`, `start_date`/`end_date` (local),
  `utc_start_date`/`utc_end_date`, `all_day`, `timezone`, `cost`,
  `cost_details.values`, `image.url`, `description` (HTML), `categories`,
  `venue` (object, `[]` when blank, or `[object]`) with `venue`, `address`,
  `city`, `zip`, `geo_lat`/`geo_lng` (22 of 50 had geo), `organizer[]`,
  `is_virtual`. **`custom_fields` holds the submitter's name and email; the
  fetcher never reads it.**
- 66 core, 5 nearby (Forestville, Santa Rosa).

## 7. City of Sebastopol public meetings

**Works.** The city site (`www.cityofsebastopol.gov`, WordPress, not
CivicPlus) has no iCal. Meetings are a custom post type, but
`/wp-json/wp/v2/events` gives no event date (only publish date; the meeting
date is in the title).

- `GET https://www.cityofsebastopol.gov/your-government/city-meeting-calendar/`
  lists upcoming meetings (17 through 2026-12-22). Each has an AddEvent
  widget: `<div class="addeventatc"> <span class="start">December 01, 2026
  6:00 pm</span> <span class="timezone">America/Los_Angeles</span> <span
  class="title">...</span> <span class="location">...</span>` and a "MORE
  DETAILS" link to `/events/<slug>/`. The `end` span is a placeholder
  (12:00 am) and is ignored.
- `location` is often blank on the list; the meeting page has it in the same
  span plus `<p class="meet-adddress">`. The fetcher reads the meeting page
  only when the list is blank (14 extra requests, ~6 s). City Hall (7120
  Bodega Ave) and the Youth Annex (425 Morris St) get coordinates.
- `CANCELLED ...` titles are dropped.

## 8. Sonoma County Regional Parks

**Works via HTML.** Site moved to `parks.sonomacounty.gov` (the `.ca.gov`
host redirects).

- `GET https://parks.sonomacounty.gov/play/calendar` returns every listed
  activity (35 on 2026-10-20, through 2026-11-25; registration opens about a
  month ahead). `?page=`, `&month=` and the `?view=ajax&type=&year=` URL in
  `data-defaultsource` all return the same list. Category pages
  (`/play/activities-calendar/<slug>`) are subsets.
- Each `<div class="listing">`: `<h3><a href title>` (registration link, may
  start with `<strong>sold out</strong> |`), `<span class="date">` ("October
  21, 2026" or "November 23 - 24, 2026"), `<span class="time">` ("9:30 am -
  11:30 am", absent for some), `<span class="location">` (park name), then a
  one-line teaser `<p>`. No coordinates, price or image.
- Park names are placed by the gazetteer (Doran, Spud Point Marina, Spring
  Lake, Environmental Discovery Center, Taylor Mountain, Foothill, Shiloh
  Ranch, Mark West Creek, Crane Creek, Colgan Creek Trail, Pinnacle Gulch,
  Helen Putnam and ~20 more). Unknown names are logged with `console.warn`.
- **Registration links go to `secure.sonomacountyparks.org`, which answers
  `405` with an AWS WAF captcha (`x-amzn-waf-action: captcha`) to scripts.**
  The fetcher never requests it; the URL is only stored for people to click.
- 0 core on this run (nothing at Ragle Ranch or the West County Trail in the
  window), 33 nearby, 1 outside (Helen Putnam, Petaluma), 1 without location.

## 9. Sonoma County Tourism (sonomacounty.com)

**Works via the site's own month-view AJAX.** WordPress with the "Miles
DataEngine Events" plugin (Simpleview CRM data).

- `GET https://www.sonomacounty.com/wp-admin/admin-ajax.php?action=dataengine-events&_view=month&_supertag=&_city=&_type=&_month=202611`
  -> JSON `{ listing, pagination, map }`. `listing` is an HTML table:
  `<tr data-date="2026-11-01">` day headers, then rows with
  `<td class="list-event-time">10:00am - 3:00pm</td>` ("See Details" when no
  time), `<a href="https://www.sonomacounty.com/events/<slug>/"><h3
  class="event-title">`, `<small class="event-city">Sebastopol, CA</small>`
  and the image. `map` is `{ id: { title, permalink, lat, lng } }`; the
  fetcher joins rows to coordinates by permalink. 3 requests for 60 days
  (53 + 32 + 47 rows for Oct/Nov/Dec). Recurring events appear on each date.
- `_view=paged&_page=N` returns a different, card-style markup (6 pages); not
  needed.
- Dead ends: `/wp-json/ns/api/query/events` lists only ids, names and tags;
  `/wp-json/wp/v2/listings` (2,980 rows) has no dates (`acf` empty); event
  pages are ~700 KB each and their JSON-LD `startDate` is midnight UTC with
  no time ("2026-10-24T00:00:00+0000").
- No venue name in the month view (address is the city), no description or
  price. 73 kept, 46 outside (Sonoma Valley, Healdsburg, Petaluma).

## 10. Sebastopol Area Chamber of Commerce

**Works.** `sebastopol.org/events/` redirects to
`https://business.sebastopol.org/events/` (GrowthZone).

- No feed: `/events/rss` 404, no iCal link. `/events/` and
  `/events/search?from=&to=` show only ~10 upcoming items.
- **Month grid:** `GET https://business.sebastopol.org/events/calendar/2026-11-15`
  renders the month; each day cell has `/events/index/2026-11-07` followed by
  that day's `/events/details/<slug>-<id>` links. The fetcher reads 3 month
  grids, keeps links whose day is inside the window (27), then each detail
  page (~350 ms apart, ~21 s).
- Detail page microdata: `itemprop="name" content`, `itemprop="startDate"
  content="2026-10-23T00:30:00Z"` (UTC), `itemprop="endDate"`, and
  `itemprop="location"` with a free-text `itemprop="name"` ("Bliss 186 N Main
  St"; no town). Description in `.gz-event-description`. `og:image` is the
  Chamber logo, so no image.
- 19 core, 8 nearby (Rohnert Park, Santa Rosa fairgrounds).

## 11. Sonoma County Farm Trails

**Works.** `farmtrails.org/events/` is The Events Calendar Pro.

- `GET https://www.farmtrails.org/wp-json/tribe/events/v1/events?start_date=...&end_date=...&per_page=50&page=N`
  -> 131 events in 60 days, countywide (3 pages).
- Venues have `city`/`zip` but no `geo_lat`; placed by ZIP/town. 28 rows have
  no venue at all (one cheese class series in the town of Sonoma); 30 are
  outside (Petaluma, Sonoma, Windsor farm markets beyond 22 km). 32 core, 39
  nearby.

## 12. Santa Rosa Junior College

**Works.** `calendar.santarosa.edu` is LiveWhale Calendar (not Localist);
`events.santarosa.edu` is a facilities-booking site (25Live) with no public
feed.

- `GET https://calendar.santarosa.edu/live/json/events/start_date/2026-10-20/end_date/2026-12-19/response_fields/location,summary,thumbnail,group_title,cost,location_latitude,location_longitude?page=N`
  -> `{ meta: { total_results, total_pages }, links: { next }, data }`, 100
  per page. `?page=N` pages; `/page/N` in the path is ignored. 353 rows in
  60 days.
- Without `response_fields` only core fields come back (no location).
  `location_latitude`/`location_longitude` were null for every row.
  `image` is null; `thumbnail` is an 80x80 crop URL and the same path serves
  640x640 (`/width/640/height/640/`), checked 200.
- Fields: `id`, `title`, `url`, `date_iso`/`date2_iso` (ISO with offset),
  `is_all_day`, `repeats*`, `is_canceled`, `is_online`, `location` (free
  text), `summary` (HTML), `group_title`, `cost`.
- Location is mapped to sites: Santa Rosa campus (Doyle Library, Bertolini,
  Burbank, Newman, Pioneer Hall, the Multicultural Museum and so on), Shone
  Farm (Forestville), Public Safety Training Center (Windsor); Petaluma
  campus is outside 22 km. 34 rows have no location and 20 are "Online";
  both are dropped.
- LiveWhale lists repeating all-day exhibits once per day; the fetcher keeps
  the first day in the window and moves `end` to the last.

## Failed / skipped

| Source | Result |
|--------|--------|
| City of Santa Rosa (`srcity.org`) | Cloudflare WAF block page "Sorry, you have been blocked" (403) on `Calendar.aspx`, `iCalendar.aspx` and even `robots.txt`. Only `RSSFeed.aspx?ModID=58&CID=All-calendar.xml` answered (5 items, mostly board meetings). Left out per the brief: the site is blocking this client. |
| Sonoma State University (`sonoma.edu/events`) | Cloudflare managed challenge (`cf-mitigated: challenge`, "Just a moment..."). `events.sonoma.edu` and `calendar.sonoma.edu` do not resolve (no Localist). The Green Music Center (`gmc.sonoma.edu`) has no feed and its `wp-json` is disabled; its concerts already arrive through CitySpark. |
| `secure.sonomacountyparks.org` (parks registration) | AWS WAF captcha (405). Not needed: the parks calendar page has every field. |
| Pacific Sun | Identical CitySpark result set to the Bohemian. |
| Sonoma County Library on BiblioCommons / LibCal | BiblioCommons events page 404; no LibCal tenant. |
| sonomacounty.com `wp-json` | No event dates (see section 9). |
| cityofsebastopol.gov `wp/v2/events` | No event date field (see section 7). |
| Local venue sites probed for `tribe/events/v1` (Sebastopol Center for the Arts, Occidental Center for the Arts, HopMonk, The Barlow, Sebastopol Grange, Rialto Cinemas, Gravenstein Apple Fair, West County Museum, LandPaths, Pepperwood, Laguna Foundation, Sonoma Land Trust) | None expose The Events Calendar REST. Their events reach the feed through sebastopolcalendar.com, CitySpark and Eventbrite. |

## Cross-source overlap and dedupe advice

On the final run, 371 title + date groups appear in more than one source:
CitySpark + Library 269, CitySpark + Eventbrite 40 (+3 with Tourism),
CitySpark + Tourism 36, Farm Trails + sebastopolcalendar 9, Chamber + Farm
Trails 3, smaller pairs below that. CitySpark syndicates the library and many
Eventbrite and tourism listings. Suggested dedupe key: normalized title +
local date + venue coordinates rounded to 3 decimals (or town when there are
no coordinates), preferring the first-party source: Library > sebcity >
sebcalendar > Chamber > Farm Trails > Parks > SRJC > Eventbrite > Luma >
Meetup > Tourism > CitySpark. CitySpark's own `PrimaryUrl` often points at
the Eventbrite or venue page and can be used to match.

## Risks to check before relying on this in CI

- All testing was from a residential IP. GitHub Actions egress is datacenter
  IP space; Eventbrite and Meetup are the most likely to challenge it, and
  Cloudflare-fronted county sites could start doing so. Every fetcher fails
  soft, so check `stats.error` and the per-source counts on the first
  workflow runs.
- Meetup's silent throttle (section 3) can make a run look like "0 events".
  The first-circle retry catches the common case; a dashboard alert on a
  source dropping to zero is still worth having.
- The parks and tourism fetchers parse HTML; a theme change breaks them
  quietly (they return `[]` or fewer rows, not an error).
- CitySpark's `DateStart` is local time with a `Z`; the module uses
  `StartUTC`. Do not "fix" that.
- Personal data: sebastopolcalendar `custom_fields` (submitter name and email),
  CitySpark `ct` (contact name, phone, email) and library `contact_*` are in
  the raw responses. The module copies none of them.
- Event descriptions are third-party text with em dashes and promotional copy.
  If the DearCrisis voice gate is ever pointed at the generated file, register
  it as quoted data or keep it out of `check-voice`.

## Real run output

Command: `node aggregators.mjs --out=raw/all_events.json` (all 12 sources,
Node 25.9 on macOS, 2026-10-20 ~17:50 PDT). "unkn" counts classify() results
of `unknown` or `out` (0 here). Samples are 3 per source, sorted by start.
Pasted verbatim:

```
Region Sebastopol: centre 38.4021, -122.8239, radius 22 km, box {"minLat":38.2045,"maxLat":38.5997,"minLng":-123.0761,"maxLng":-122.5717}
Next 60 days, run 45.2 s

source          kept  core nearby  unkn dropped  coords  time   dropped by reason
luma               7     5      2     0       7       7   2.7s  {"outside":7}
eventbrite       356    50    306     0      67     356  24.5s  {"outside":67}
meetup            73     4     69     0      11      73  45.1s  {"outside":11}
cityspark       1344   167   1177     0     378    1344  40.8s  {"outside":375,"online":3}
sonomalibrary    503    47    456     0       9     451   6.7s  {"outside":8,"online":1}
sebcalendar       71    66      5     0       0      32   3.7s  {}
sebcity           14    14      0     0       0      14   5.3s  {}
parks             33     0     33     0       2      33   0.5s  {"outside":1,"noLocation":1}
tourism           73     5     68     0      46      72   3.4s  {"outside":46}
chamber           27    19      8     0       0       3  19.5s  {}
farmtrails        71    32     39     0      58       9   1.5s  {"noLocation":28,"outside":30}
srjc              79     0     79     0     122      79   3.6s  {"online":18,"outside":72,"noLocation":32}
TOTAL           2651   409   2242     0     700  (before cross-source dedupe)

luma:
    [core  ] 2026-10-24 08:00  Camp DoomsDaddy | Sebastopol, CA  @ 13024 Green Valley Rd, Sebastopol, CA 95472, USA  (10.9 km)
    [core  ] 2026-10-25 12:00  Game Day  @ Sebastopol, CA  (6.2 km)
    [nearby] 2026-10-28 16:00  Bonsai Tech Happy Hour  @ Belly Left Coast Kitchen & Taproom, Belly Left Coast Kitchen & Taproom  (10.4 km)
eventbrite:
    [nearby] 2026-10-20 18:00  Game Night  @ The Main Bar at R3 Hotel, 16390 4th Street, Guerneville, CA 95446  (19.0 km)
    [core  ] 2026-10-21 07:00  Daily Morning Meditation | 7:00 am to 7:25 am  @ 618 South Main Street, Sebastopol, CA 95472  (0.6 km)
    [core  ] 2026-10-21 19:00  Wednesday Night Meditation and Dharma Talk  @ 618 South Main Street, Sebastopol, CA 95472  (0.6 km)
meetup:
    [core  ] 2026-10-20 19:00  Wisdom Within Women's Circle  @ Sebastopol, Sebastopol, CA 95472  (0.0 km)
    [nearby] 2026-10-20 19:00  Hands of Gold Healing Hangout  @ Songbird Community Healing Center, 8299 Old Redwood Hwy, Cotati, CA 94  (13.5 km)
    [core  ] 2026-10-23 09:00  Guided Meditation: Transforming Negative Experiences into Po  @ Persimmon Yoga, 105 Morris St Ste 192, Sebastopol, CA 95472  (0.6 km)
cityspark:
    [nearby] 2026-10-20 16:30  How to Draw K-pop Demon Hunters  @ Roseland Regional Library, 470 Sebastopol Rd, Santa Rosa, CA 95407  (9.1 km)
    [core  ] 2026-10-21 09:30  Garden Tours Guided by Osmosis Founder + Lead Gardener (10/2  @ 209 Bohemian Hwy, Freestone, CA  (8.5 km)
    [core  ] 2026-10-21 10:30  Family Storytime at Ives Park  @ Ives Park, 7400 Willow St., Sebastopol, CA 95472  (0.3 km)
sonomalibrary:
    [nearby] 2026-10-20 16:30  How to Draw K-pop Demon Hunters  @ Roseland Regional Library, 470 Sebastopol Rd, Santa Rosa, CA 95407  (9.1 km)
    [core  ] 2026-10-21 10:30  Family Storytime at Ives Park  @ Ives Park, 7400 Willow St, Sebastopol, CA 95472  (0.3 km)
    [core  ] 2026-10-22 10:30  Toddler Storytime @ Sebastopol Community Center Youth Annex  @ Sebastopol Community Center Youth Annex, 425 Morris St, Sebastopol, CA  (0.8 km)
sebcalendar:
    [core  ] 2026-10-20 18:00  Voter Information Night  @ Analy High School Cafeteria, 6950 Analy Ave., Sebastopol, CA 95472  (0.0 km)
    [core  ] 2026-10-21 09:00  Luther Burbank Experiment Farm Work Day  @ Luther Burbank Experiment Farm, 7777 Bodega Ave, Sebastopol, CA 95472  (1.1 km)
    [nearby] 2026-10-21 12:00  Forestville Prime Timer’s Lunch  @ Forestville Methodist Church ommunity Room  (10.6 km)
sebcity:
    [core  ] 2026-10-21 13:00  Agenda Review Committee October 21, 2026  @ City Hall, 7120 Bodega Ave, Sebastopol, CA 95472  (0.1 km)
    [core  ] 2026-10-27 15:30  Design Review/ Tree Board Meeting October 27, 2026  @ Sebastopol Youth Annex, 425 Morris St, Sebastopol, CA 95472  (0.8 km)
    [core  ] 2026-10-27 18:00  Planning Commission Meeting October 27, 2026  @ Sebastopol Youth Annex, 425 Morris St, Sebastopol, CA 95472  (0.8 km)
parks:
    [nearby] 2026-10-21 09:30  Volunteer: Ice Plant Removal  @ Doran Regional Park  (21.3 km)
    [nearby] 2026-10-21 10:00  Volunteer Grab Bag: Litter Pick-up….and More  @ Spring Lake Regional Park  (15.7 km)
    [nearby] 2026-10-22 10:00  Kayak: Senior Paddle  @ Spring Lake Regional Park  (15.7 km)
tourism:
    [nearby] 2026-10-22 16:30  Harvest Happy Hour at Balletto  @ Santa Rosa, CA  (2.1 km)
    [core  ] 2026-10-29 00:00  Flynn Creek Circus Presents The Cricket and the Wren  @ Sebastopol, CA  (1.6 km)
    [core  ] 2026-10-30 00:00  Flynn Creek Circus Presents The Cricket and the Wren  @ Sebastopol, CA  (1.6 km)
chamber:
    [core  ] 2026-10-22 17:30  Mixer @ Bliss!  @ Bliss 186 N Main St, Sebastopol, CA  (0.0 km)
    [nearby] 2026-10-24 09:00  CPR First Aid Class (American Heart Association)  @ 5350 Commerce Blvd, Suite B, Rohnert Park, CA 94928  (12.8 km)
    [core  ] 2026-10-29 19:00  Flynn Creek Circus - Sebastopol  @ Sebastopol Grange  (0.0 km)
farmtrails:
    [nearby] 2026-10-21 08:30  Santa Rosa Farmers’ Market at the Vet’s Building  @ Santa Rosa Veteran’s Memeorial Building, 1351 Maple Ave, Santa Rosa, C  (11.4 km)
    [core  ] 2026-10-23 16:30  Live Music Fridays  @ Pax Wines, 6780 MCKINLEY AVE., SEBASTOPOL, CA 95472  (0.0 km)
    [core  ] 2026-10-24 16:00  Fresh Cheesemaking with Botanical Flavors  @ Gather Sebastopol, 122 N Main St, Sebastopol, CA 95472  (0.0 km)
srjc:
    [nearby] 2026-10-20 00:00  From Sheep to Loom: Diné Weaving Traditions  @ SRJC Multicultural Museum - Santa Rosa Campus, Santa Rosa Junior Colle  (10.7 km)
    [nearby] 2026-10-20 00:00  In the Spotlight: Lawrence’s George “Nash” Walker  @ Doyle Library, 1st Floor Lobby - Santa Rosa Campus, Santa Rosa Junior   (10.7 km)
    [nearby] 2026-10-20 00:00  Jerrold Ballaine: Land and Sea  @ Doyle Library - Santa Rosa Campus, Santa Rosa Junior College, 1501 Men  (10.7 km)

wrote raw/all_events.json (2651 events)
```
