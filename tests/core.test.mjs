// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIcs } from "../scripts/lib/ics.mjs";
import { toPacificIso, zonedToUtc } from "../scripts/lib/time.mjs";
import { inCore, inRegion, areaFor, areaByText, townFor, km, CENTER, RADIUS_KM } from "../scripts/lib/geo.mjs";
import { classify } from "../scripts/lib/classify.mjs";
import { parseSquarespace, parseJsonLd, parseEventbriteOrganizer } from "../scripts/lib/parsers.mjs";
import { detectSource } from "../scripts/lib/detect.mjs";

const window = { from: Date.parse("2026-10-09T00:00:00Z"), to: Date.parse("2026-11-23T00:00:00Z") };
const starts = (ics) => parseIcs(ics, window).map((e) => `${toPacificIso(e.startMs).slice(0, 16)} ${e.title}`);

test("weekly series expands across DST and honours EXDATE", () => {
  const out = starts(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:m
DTSTART;TZID=America/Los_Angeles:20240107T090000
RRULE:FREQ=WEEKLY;BYDAY=SU
EXDATE;TZID=America/Los_Angeles:20261018T090000
SUMMARY:Farmers Market
END:VEVENT
END:VCALENDAR`);
  assert.deepEqual(out.slice(0, 4), [
    "2026-10-11T09:00 Farmers Market",
    "2026-10-25T09:00 Farmers Market",
    "2026-11-01T09:00 Farmers Market",
    "2026-11-08T09:00 Farmers Market",
  ]);
});

test("RECURRENCE-ID moves one instance of a monthly series", () => {
  const out = starts(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a
DTSTART;TZID=America/Los_Angeles:20250113T190000
RRULE:FREQ=MONTHLY;BYDAY=2MO
SUMMARY:Meeting
END:VEVENT
BEGIN:VEVENT
UID:a
RECURRENCE-ID;TZID=America/Los_Angeles:20261012T190000
DTSTART;TZID=America/Los_Angeles:20261013T190000
SUMMARY:Meeting (moved)
END:VEVENT
END:VCALENDAR`);
  assert.deepEqual(out.sort(), ["2026-10-13T19:00 Meeting (moved)", "2026-11-09T19:00 Meeting"]);
});

test("cancelled events are dropped", () => {
  assert.equal(
    starts(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:c
DTSTART:20261020T170000Z
STATUS:CANCELLED
SUMMARY:Gone
END:VEVENT
END:VCALENDAR`).length,
    0
  );
});

test("Pacific conversion picks the right offset either side of DST", () => {
  assert.equal(toPacificIso(zonedToUtc(2026, 10, 31, 10, 0, 0)), "2026-10-31T10:00:00-07:00");
  assert.equal(toPacificIso(zonedToUtc(2026, 11, 1, 10, 0, 0)), "2026-11-01T10:00:00-08:00");
});

test("the core is ZIP 95472, with Graton cut out of it", () => {
  assert.equal(areaFor(38.4031, -122.8237), "sebastopol"); // the plaza
  assert.equal(areaFor(38.4042, -122.8208), "sebastopol"); // The Barlow
  assert.equal(areaFor(38.4051, -122.8458), "sebastopol"); // Ragle Ranch Park
  assert.equal(inCore(38.4363, -122.869), false); // downtown Graton, ZIP 95444
  assert.equal(areaFor(38.4363, -122.869), "nearby");
});

test("the nearby ring reaches the coast and Santa Rosa but not Petaluma or Healdsburg", () => {
  assert.equal(areaFor(38.3217, -123.0288), "nearby"); // Bodega Bay
  assert.equal(areaFor(38.4074, -122.9486), "nearby"); // Occidental
  assert.equal(areaFor(38.5179, -122.9782), "nearby"); // Guerneville
  assert.equal(areaFor(38.4405, -122.7141), "nearby"); // Santa Rosa
  assert.equal(inRegion(38.2324, -122.6367), false); // Petaluma
  assert.equal(inRegion(38.6105, -122.8692), false); // Healdsburg
  assert.ok(km(...CENTER, 38.3217, -123.0288) < RADIUS_KM);
});

test("towns name the nearest place", () => {
  assert.equal(townFor(38.4363, -122.869), "Graton");
  assert.equal(townFor(38.4838, -122.8857), "Forestville");
});

test("text test reads ZIP codes and town names", () => {
  assert.equal(areaByText("7400 Willow St, Sebastopol, CA 95472"), "sebastopol");
  assert.equal(areaByText("15290 Coleman Valley Rd, Occidental, CA 95465"), "nearby");
  assert.equal(areaByText("Petaluma Veterans Building, Petaluma, CA 94952"), false);
  assert.equal(areaByText("Zoom"), null);
  assert.equal(areaByText("Roseland Library, 779 Sebastopol Rd, Santa Rosa, CA 95407"), "nearby");
});

test("classifier", () => {
  assert.equal(classify("Apple Blossom Festival cider tasting"), "food-farms");
  assert.equal(classify("Laguna de Santa Rosa creek restoration walk"), "land-water");
  assert.equal(classify("Defensible space workshop"), "resilience");
  assert.equal(classify("Toddler Storytime"), "neighbors");
  assert.equal(classify("Sunrise Yoga"), "wellbeing");
});

test("Squarespace and JSON-LD parsers decode what they read", () => {
  const sq = parseSquarespace(
    JSON.stringify({ upcoming: [{ title: "Harvest Supper", startDate: 1791900000000, fullUrl: "/e/1", location: { addressTitle: "Farm &#64; Green Valley" } }] }),
    { url: "https://example.org/events?format=json" }
  );
  assert.equal(sq[0].url, "https://example.org/e/1");
  const ld = parseJsonLd(
    `<script type="application/ld+json">{"@type":"Event","name":"Reading &amp; Talk","startDate":"2026-10-20T19:00:00-07:00","location":{"@type":"Place","name":"Bookstore","geo":{"latitude":38.40,"longitude":-122.82}}}</script>`,
    { url: "https://example.org" }
  );
  assert.equal(ld[0].title, "Reading & Talk");
  assert.equal(ld[0].lat, 38.4);
});

test("Eventbrite organizer pages are read from the page's own data", () => {
  const data = {
    props: {
      pageProps: {
        upcomingEvents: [
          {
            id: "1",
            name: "Creek Walk &amp; Talk",
            url: "https://www.eventbrite.com/e/1",
            start_date: "2026-11-07",
            start_time: "10:00:00",
            end_date: "2026-11-07",
            end_time: "12:00:00",
            timezone: "America/Los_Angeles",
            is_online_event: false,
            is_cancelled: false,
            primary_venue: { name: "Ragle Ranch", address: { localized_address_display: "500 Ragle Rd, Sebastopol, CA 95472", latitude: "38.405", longitude: "-122.845" } },
          },
          { id: "2", name: "Called off", start_date: "2026-11-08", start_time: "10:00:00", is_cancelled: true },
        ],
      },
    },
  };
  const out = parseEventbriteOrganizer(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`, { url: "https://www.eventbrite.com/o/x-1" });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Creek Walk & Talk");
  assert.equal(toPacificIso(out[0].startMs), "2026-11-07T10:00:00-08:00");
  assert.equal(out[0].location, "Ragle Ranch, 500 Ragle Rd, Sebastopol, CA 95472");
  assert.equal(out[0].lat, 38.405);
});

// These shapes are recognized from the link alone, with no network.
test("detect turns pasted links into feeds", async () => {
  const g = await detectSource("https://calendar.google.com/calendar/embed?src=abc123%40group.calendar.google.com&ctz=America%2FLos_Angeles");
  assert.equal(g.format, "ics");
  assert.equal(g.url, "https://calendar.google.com/calendar/ical/abc123%40group.calendar.google.com/public/basic.ics");
  assert.equal((await detectSource("meetup.com/sebastopol-hikers/events/")).url, "https://www.meetup.com/sebastopol-hikers/events/ical/");
  assert.equal((await detectSource("webcal://example.org/cal.ics")).url, "https://example.org/cal.ics");
  assert.equal((await detectSource("https://www.eventbrite.com/o/some-group-123/")).format, "eventbrite");
  await assert.rejects(detectSource("https://www.eventbrite.com/e/one-event-tickets-9"), /organizer/);
  await assert.rejects(detectSource(""), /Paste a link/);
});
