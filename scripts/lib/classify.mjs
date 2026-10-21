// Keyword classifier for events that arrive without an org of their own
// (Luma, Eventbrite, Meetup, library listings). Title words count double.
// Events from an org's own feed take the org's first domain instead.

const RULES = {
  // Activities only: a yoga class on the dunes is yoga, not dune work.
  // Activities only: a yoga class at a park is yoga, not park work.
  "land-water": [
    "cleanup", "clean-up", "clean up", "creek", "habitat", "restoration", "revegetation", "native plant",
    "tree planting", "plant trees", "stewardship", "birding", "bird walk", "nature walk", "naturalist",
    "docent walk", "wildflower", "laguna", "watershed", "tide pool", "whale", "preserve", "volunteer workday",
    "trail work", "weed pull", "seed collecting", "salmon", "coho",
  ],
  resilience: [
    "nert", "emergency", "disaster", "preparedness", "earthquake", "mutual aid", "pantry", "food bank",
    "climate", "resilience", "first aid", "cpr", "evacuation", "heat", "flood", "sea level", "wildfire",
    "free groceries", "food distribution",
    "defensible space", "fire safe", "evacuation", "red cross", "cert", "map your neighborhood",
  ],
  "food-farms": [
    "farmers market", "farmers' market", "cooking", "compost", "gardening", "garden workday", "harvest",
    "seed", "co-op", "community garden", "foraging", "fermentation", "baking", "food tour", "tasting",
    "farm", "farm tour", "orchard", "apple", "cider", "harvest festival", "u-pick", "farm stand", "grange", "seed swap",
  ],
  "art-culture": [
    "art", "artist", "music", "concert", "live music", "jazz", "band", "dj", "film", "screening",
    "cinema", "theater", "theatre", "comedy", "poetry", "reading", "book launch", "author", "gallery",
    "exhibit", "exhibition", "museum", "festival", "dance performance", "open mic", "craft", "makers",
    "night market", "mercantile", "mural", "nightlife", "orchestra", "choir", "opera",
  ],
  neighbors: [
    "kids", "children", "family", "families", "toddler", "storytime", "story time", "teen", "teens",
    "youth", "senior", "seniors", "older adults", "community", "potluck", "social", "parents", "baby",
    "newcomer", "lunar new year", "moon festival", "heritage", "block party", "trivia", "game night",
    "bingo", "mahjong", "playgroup", "meet your neighbors",
  ],
  civic: [
    "meeting", "town hall", "supervisor", "board of", "association", "merchants", "planning", "hearing",
    "vote", "voter", "election", "candidate", "forum", "transit", "muni", "bike", "bicycle", "street",
    "safety", "police", "sfpd", "neighborhood", "housing", "rezoning", "zoning", "budget", "policy",
    "advocacy", "great highway",
  ],
  learning: [
    "class", "workshop", "lecture", "talk", "course", "lesson", "tutoring", "library", "science",
    "esl", "english conversation", "coding", "computer", "homework", "stem", "seminar", "webinar",
    "author talk", "book club", "panel", "training", "citizenship", "tech help",
  ],
  wellbeing: [
    "yoga", "meditation", "run club", "running", "5k", "10k", "fitness", "workout", "tai chi", "qigong",
    "health", "wellness", "mindfulness", "sound bath", "surf", "swim", "volleyball", "sports",
    "bootcamp", "breathwork", "grief", "support group", "worship", "mass", "prayer", "dharma", "sangha",
    "pilates", "walk", "hike", "cycling", "pickleball", "ecstatic dance",
  ],
};

const ORDER = Object.keys(RULES);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const COMPILED = Object.fromEntries(
  ORDER.map((d) => [d, RULES[d].map((w) => new RegExp(`\\b${escapeRe(w)}\\b`, "i"))])
);

export function classify(title, description = "") {
  const t = String(title || "");
  const desc = String(description || "").slice(0, 600);
  let best = null;
  let bestScore = 0;
  for (const d of ORDER) {
    let score = 0;
    for (const re of COMPILED[d]) {
      if (re.test(t)) score += 2;
      if (re.test(desc)) score += 1;
    }
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best ?? "neighbors";
}
