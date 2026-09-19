/**
 * build.js — turn the listings into the files the site reads.
 *
 * Replaces build.py. Runs once a day, after the scraper and enricher have
 * had their turn.
 *
 * Three jobs:
 *   1. record today's median for every city and neighbourhood — this is the
 *      price history, and it cannot be backfilled, so it matters that it
 *      runs even on a day when nothing else does
 *   2. compute the aggregates the site displays
 *   3. write one JSON file per city into KV, plus a small index
 *
 * The site fetches those files. Splitting per city means a visitor
 * downloads the 5 KB index and one city, not eleven megabytes.
 */

const MIN_SAMPLE = 20;            // below this a neighbourhood median is noise
const MIN_CITY_LISTINGS = 30;     // below this a "city" is a rounding error
const HISTORY_DAYS = 180;         // how much per-neighbourhood history to ship
const MAD_CUTOFF = 3.5;
const CITY_BAND = [0.25, 4.0];    // relative to the city's own median

/* Gone from Divar, or simply posted a while ago?
 *
 * This filtered on posted_at older than 28 days, which was wrong: posted_at
 * is when the advert went up, not when it comes down. A flat posted forty
 * days ago and renewed by its seller is still for sale, and the filter threw
 * it out. It only showed once price-band scraping started reaching listings
 * beyond Divar's 215-page ceiling — 30,882 Tehran apartments in the database
 * and 19,809 surviving to the site.
 *
 * scraped_at answers the right question. The scraper sees whatever is on
 * Divar now, so a listing it has not seen recently is one that is no longer
 * there. The window is generous because a city is only swept every few days;
 * tighten it if sweeps become more frequent.
 *
 * The old note, kept because the lifetime is still what posted_at is derived
 * from: a Divar listing runs about 28 days, and the database keeps it after.
 *
 * An expired listing is an asking price from a market that has moved on, and
 * leaving it in pulled every median toward the past — 11.4% of apartments
 * were already expired, and that share grows as the database ages. The site
 * says its figures come from current listings, so now they do.
 *
 * posted_at NULL is kept rather than dropped: it means enrichment has not
 * reached that listing yet, not that it is old, and discarding those would
 * quietly remove everything scraped in the last few hours.
 *
 * Note this changes what the daily snapshots measure from today onward, so
 * the trend line has a small step in it where the basis changed. */
const LISTING_LIFETIME_DAYS = 28;
const STALE_DAYS = 10;

/**
 * A matching key for place names — never for display.
 *
 * "سعادت‌آباد", "سعادت آباد" and "سعادت اباد" are one neighbourhood. Without
 * folding them, each spelling becomes its own row with a fraction of the
 * listings, and a real neighbourhood can fall below the sample threshold
 * purely because its name is written three ways.
 */
function canonicalPlace(name) {
  if (!name) return "";
  let t = String(name);
  for (let i = 0; i < 10; i++) {
    t = t.split("۰۱۲۳۴۵۶۷۸۹"[i]).join(String(i));
  }
  t = t
    .replace(/ك/g, "ک").replace(/[يئ]/g, "ی").replace(/ة/g, "ه")
    .replace(/[أإآ]/g, "ا").replace(/ؤ/g, "و")
    .replace(/\u0640/g, "")
    .replace(/[\u200c\u200e\u200f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const f of ["محله ", "منطقه ", "شهرک ", "بلوار ", "خیابان ", "میدان "]) {
    if (t.startsWith(f)) t = t.slice(f.length);
  }
  return t.replace(/[\s\-_.]/g, "");
}

const MONTHS = ["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور",
                "مهر","آبان","آذر","دی","بهمن","اسفند"];

/* ── small statistics ───────────────────────────────────────────────── */

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Median absolute deviation, not standard deviation.
 *
 * One 5,000-billion-toman villa in an ordinary neighbourhood drags a mean
 * anywhere. MAD ignores it. Fixed price bands would need rewriting every
 * year under Iranian inflation; this calibrates itself to the data.
 */
function trimOutliers(values) {
  if (values.length < 5) return values;
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  if (!mad) return values;
  return values.filter((v) => Math.abs(0.6745 * (v - med) / mad) <= MAD_CUTOFF);
}

/* ── Jalali dates ───────────────────────────────────────────────────── */

function gregorianToJalali(gy, gm, gd) {
  const g_d_m = [0,31,59,90,120,151,181,212,243,273,304,334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
           + Math.floor((gy2 + 399) / 400) - 80 + gd + g_d_m[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  return [jy, jm];
}

function faDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[+d]);
}

function monthLabels(n, jy, jm) {
  const out = [];
  for (let back = n - 1; back >= 0; back--) {
    let m = jm - back, y = jy;
    while (m <= 0) { m += 12; y -= 1; }
    out.push(`${MONTHS[m - 1]} ${faDigits(y)}`);
  }
  return out;
}

/* ── the build ──────────────────────────────────────────────────────── */

/**
 * One night's build, in slices.
 *
 * This used to do everything in a single invocation: read every listing,
 * fold every neighbourhood name, compute every median, and stringify fifty
 * JSON files — Tehran's alone is over two megabytes. That worked until the
 * data reached about 150,000 listings, at which point Cloudflare stopped it
 * for exceeding its CPU allowance (error 1102). It would only have got
 * worse as the data grew.
 *
 * It now handles SLICE cities per invocation and hands on to the next slice
 * itself, so each one starts with a fresh allowance. The city files are
 * written as each slice finishes; stats.json is written by the last one, so
 * the site never sees a half-built index.
 */
const SLICE_DEFAULT = 8;

export async function build(env, log = [], from = 0, self = null) {
  const SLICE = Number(env.SLICE) || SLICE_DEFAULT;
  /* Which cities this slice covers, decided before a single listing is read.
   *
   * Each slice used to read the whole listings table and then throw away the
   * cities it was not handling — a hundred and fifty thousand rows, seven
   * times over, for one build. Worse, a slice that failed was retried by the
   * cron every ten minutes, each attempt reading the whole table again: a
   * hundred and forty-four attempts a day, twenty-one million reads, against
   * an allowance of five million. That is what has been exhausting the reads
   * before breakfast.
   *
   * The city list comes from scrape_state instead, which has one row per city
   * — forty-eight rows rather than a hundred and fifty thousand — and the
   * listings query then asks only for those cities. */
  const cityRows = await env.DB.prepare(
    "SELECT DISTINCT city FROM scrape_state WHERE source='divar' ORDER BY rowid").all();
  const everyCity = cityRows.results.map((r) => r.city);
  const sliceCities = everyCity.slice(from, from + SLICE);
  if (!sliceCities.length) {
    return { log: ["nothing to build: no cities in this slice"], cities: 0, more: false };
  }
  const db = env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const [jy, jm] = gregorianToJalali(
    now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());

  // Only rows that can produce a price per square metre. The scraper already
  // rejects instalment and cooperative ads by title; this catches the ones
  // whose titles gave nothing away, by comparing against their own city.
  // One pass. The previous version read every listing twice — once to work
  // out each city's median and again for the aggregation — which is 172,000
  // row reads for no reason. The medians come from the same rows.
  const all = await db.prepare(`
    SELECT source, source_id, city, hood, title, url, price_toman, area_m2,
           price_m2, rooms, age_years, lat, lng, address, posted_at,
           features, dedupe_key, COALESCE(kind,'apartment') AS kind
    FROM listings
    WHERE price_m2 IS NOT NULL AND price_m2 > 0
      AND (scraped_at IS NULL
           OR scraped_at >= date('now', '-${STALE_DAYS} day'))
      AND city IN (${sliceCities.map(() => "?").join(",")})`)
    .bind(...sliceCities).all();

  log.push(`${all.results.length} listings read`);

  // The sanity band is computed per city AND per kind. A single city median
  // across all three would treat every plot of land as an outlier, since land
  // runs many times the price per metre of a flat in the same street.
  const cityMedians = new Map();
  {
    const byCityAll = new Map();
    for (const r of all.results) {
      const k = `${r.city}|${r.kind}`;
      if (!byCityAll.has(k)) byCityAll.set(k, []);
      byCityAll.get(k).push(r.price_m2);
    }
    for (const [k, vals] of byCityAll) cityMedians.set(k, median(vals));
  }

  const seen = new Set();
  const cities = new Map();
  let outOfBand = 0, dupes = 0;

  for (const r of all.results) {
    const cm = cityMedians.get(`${r.city}|${r.kind}`);
    if (cm && (r.price_m2 < CITY_BAND[0] * cm || r.price_m2 > CITY_BAND[1] * cm)) {
      outOfBand++;
      continue;
    }
    if (r.dedupe_key) {
      if (seen.has(r.dedupe_key)) { dupes++; continue; }
      seen.add(r.dedupe_key);
    }
    const gk = `${r.city}|${r.kind}`;
    if (!cities.has(gk)) cities.set(gk, []);
    cities.get(gk).push(r);
  }

  log.push(`${outOfBand} dropped outside their city's range, ${dupes} duplicate reposts`);

  // looked-up neighbourhood positions, so a neighbourhood without a single
  // enriched listing can still appear on the map
  const geo = new Map();
  try {
    const g = await db.prepare(
      "SELECT city, hood, lat, lng FROM hood_geo WHERE lat IS NOT NULL").all();
    for (const r of g.results) geo.set(`${r.city}|${r.hood}`, [r.lat, r.lng]);
  } catch (e) { /* table may not exist yet */ }

  const labels = monthLabels(36, jy, jm);
  // the index is accumulated across slices and written by the last one
  let carried = [];
  if (from > 0) {
    try {
      const prev = await env.SITE.get("build:index", { type: "json" });
      if (prev && prev.day === today) carried = prev.cities;
    } catch (e) { /* start the index again */ }
  }
  const index = { generated: today, is_sample: false,
                  month_labels: labels, cities: carried };
  /* Does the snapshot table know about property kinds yet?
   *
   * Collecting villas and land needs nothing but the listings table, which
   * already has the column. Only the daily history needs `kind` in the
   * snapshot key. So the worker asks, rather than requiring the tables to be
   * migrated first: with the key in place it records history for all three
   * markets; without it, it records apartments as before and simply does not
   * write history for the other two — which is better than overwriting the
   * apartment series with villa numbers under the same key.
   *
   * Villas and land therefore appear on the site immediately. Their price
   * history begins whenever the two small SQL files are run, and nothing is
   * lost by running them later. */
  let perKindHistory = false;
  try {
    const cols = await db.prepare("PRAGMA table_info(city_snapshots)").all();
    perKindHistory = cols.results.some((c) => c.name === "kind");
  } catch (e) { /* assume not */ }

  const snapshots = [];
  const files = [];

  // One file per city, holding all three kinds. Splitting the file per kind
  // would mean a fresh download every time the reader switches tab; keeping
  // them together costs a little size and makes switching instant.
  const ordered = [...cities.entries()]
    .filter(([, rows]) => rows.length >= MIN_CITY_LISTINGS)
    .sort((a, b) => b[1].length - a[1].length);

  const byCity = new Map();   // city -> { kind -> rows }
  for (const [gk, rows] of ordered) {
    const [city, kind] = gk.split("|");
    if (!byCity.has(city)) byCity.set(city, new Map());
    byCity.get(city).set(kind, rows);
  }

  const slice = [...byCity.entries()];
  const more = from + SLICE < everyCity.length;

  for (const [city, kinds] of slice) {
    const cityFile = { name: city, rows: [], listings: [],
                       ours: {}, hood_hist: {}, byKind: {} };

   for (const [kind, rows] of kinds) {
    // per neighbourhood
    // group by the folded name, display the first spelling seen
    const groups = new Map();
    const display = new Map();
    for (const r of rows) {
      const raw = r.hood || "نامشخص";
      const key = canonicalPlace(raw) || "نامشخص";
      if (!groups.has(key)) { groups.set(key, []); display.set(key, raw); }
      groups.get(key).push(r);
    }

    const hoodRows = [];
    for (const [key, members] of groups) {
      const hood = display.get(key);
      const kept = trimOutliers(members.map((m) => m.price_m2));
      if (!kept.length) continue;
      const keptSet = new Set(kept);
      const inliers = members.filter((m) => keptSet.has(m.price_m2));
      const med = Math.round(median(kept) / 1e5) / 10;   // million toman, 1dp

      const pts = inliers.filter((m) => m.lat && m.lng);
      const row = {
        // the kind belongs on the row: every kind's neighbourhoods are
        // pushed into one cityFile.rows, and without it the site cannot tell
        // an apartment neighbourhood from a villa one
        k: kind,
        hood, m: 35, median: med, n: kept.length,
        area: Math.round(median(inliers.map((m) => m.area_m2).filter(Boolean)) || 0),
        rooms: Math.round(median(inliers.map((m) => m.rooms).filter((v) => v != null)) || 2),
        age: Math.round(median(inliers.map((m) => m.age_years).filter((v) => v != null)) || 10),
      };
      if (pts.length) {
        row.lat = +(pts.reduce((s, p) => s + p.lat, 0) / pts.length).toFixed(5);
        row.lng = +(pts.reduce((s, p) => s + p.lng, 0) / pts.length).toFixed(5);
      } else {
        // the geocoder stored raw names, so try each spelling in this group
        for (const m of members) {
          if (m.hood && geo.has(`${city}|${m.hood}`)) {
            [row.lat, row.lng] = geo.get(`${city}|${m.hood}`);
            row.geo = "lookup";
            break;
          }
        }
      }
      hoodRows.push(row);

      row.k = kind;
      if (perKindHistory) {
        snapshots.push(db.prepare(
          "INSERT OR REPLACE INTO hood_snapshots VALUES (?,?,?,?,?,?)")
          .bind(city, hood, kind, today, med, kept.length));
      } else if (kind === "apartment") {
        snapshots.push(db.prepare(
          "INSERT OR REPLACE INTO hood_snapshots VALUES (?,?,?,?,?)")
          .bind(city, hood, today, med, kept.length));
      }
    }
    hoodRows.sort((a, b) => b.median - a.median);

    // the listings the site shows, sorted dearest first
    const hoodDisplay = new Map();
    for (const [key, name] of display) hoodDisplay.set(key, name);

    const listings = rows.map((r) => {
      const o = {
        h: hoodDisplay.get(canonicalPlace(r.hood || "نامشخص")) ||
           r.hood || "نامشخص",
        t: r.source_id,
        n: (r.title || "").slice(0, 70),
        a: Math.round(r.area_m2 || 0),
        p: Math.round((r.price_toman || 0) / 1e6),
        m: Math.round(r.price_m2 / 1e5) / 10,
        s: r.source, u: r.url || "", k: kind,
      };
      if (r.rooms != null) o.r = r.rooms;
      if (r.age_years != null) o.g = r.age_years;
      if (r.lat) { o.y = +r.lat.toFixed(5); o.x = +r.lng.toFixed(5); }
      if (r.posted_at) o.d = r.posted_at;
      if (r.address) o.ad = r.address;
      if (r.features) o.f = r.features.split(",");
      return o;
    }).sort((a, b) => b.m - a.m);

    const cityMed = Math.round(median(rows.map((r) => r.price_m2)) / 1e5) / 10;
    if (perKindHistory) {
      snapshots.push(db.prepare(
        "INSERT OR REPLACE INTO city_snapshots VALUES (?,?,?,?,?,?,?)")
        .bind(city, kind, today, jy, jm, cityMed, rows.length));
    } else if (kind === "apartment") {
      snapshots.push(db.prepare(
        "INSERT OR REPLACE INTO city_snapshots VALUES (?,?,?,?,?,?)")
        .bind(city, today, jy, jm, cityMed, rows.length));
    }

    cityFile.rows.push(...hoodRows);
    cityFile.listings.push(...listings);
    cityFile.byKind[kind] = { n: rows.length, median: cityMed,
                              hoods: hoodRows.length };
   }   // end of kinds

    cityFile.listings.sort((a, b) => b.m - a.m);
    const apt = cityFile.byKind.apartment || Object.values(cityFile.byKind)[0] || {};

    /* The id is the city's fixed place in the full city list, not how many
     * entries happen to have been written so far.
     *
     * With `c${index.cities.length}` an id depended on the order and number
     * of previous slices. Run a slice twice — a manual /run overlapping the
     * cron does it — and the same city is appended a second time under a new
     * id, while its own data file keeps the old one. The index and the file
     * it points at then disagree, which is what left Tehran's villa count
     * reading 245 in stats.json and something quite different in c0.json.
     * A fixed id plus replace-by-name makes a repeat pass idempotent. */
    const id = `c${everyCity.indexOf(city)}`;
    cityFile.our_year = { y: jy, v: apt.median };
    files.push([id, cityFile]);
    // n and median stay the apartment figures, which is what the site opens
    // on; byKind carries the other two for the market cards
    const entry = { id, name: city, n: apt.n || 0,
                    hoods: apt.hoods || 0, median: apt.median,
                    byKind: cityFile.byKind };
    const at = index.cities.findIndex((c) => c.name === city);
    if (at >= 0) index.cities[at] = entry; else index.cities.push(entry);
  }

  // record the day's measurements before writing any files — the history is
  // the part that cannot be recreated
  for (let i = 0; i < snapshots.length; i += 100) {
    await db.batch(snapshots.slice(i, i + 100));
  }
  log.push(`${snapshots.length} snapshots recorded for ${today}`);

  // attach each city's own recorded history
  // Each kind keeps its own history. They are never concatenated: a villa
  // series and a flat series measure different markets, and joining them
  // would produce a step change on the day the second one started.
  for (const [id, payload] of files) {
    const kindCol = perKindHistory ? "kind" : "'apartment' AS kind";
    const h = await db.prepare(`
      SELECT ${kindCol}, day, median_m2, n_listings FROM city_snapshots
      WHERE city = ? ORDER BY day`).bind(payload.name).all();
    payload.ours = {};
    for (const r of h.results) {
      (payload.ours[r.kind] ||= []).push({
        d: r.day, v: Math.round(r.median_m2 * 10) / 10, n: r.n_listings });
    }

    const hh = await db.prepare(`
      SELECT hood, ${kindCol}, day, median_m2, n_listings FROM hood_snapshots
      WHERE city = ? AND day >= date('now', ?) ORDER BY day`)
      .bind(payload.name, `-${HISTORY_DAYS} days`).all();
    payload.hood_hist = {};
    for (const r of hh.results) {
      ((payload.hood_hist[r.kind] ||= {})[r.hood] ||= []).push({
        d: r.day, v: Math.round(r.median_m2 * 10) / 10, n: r.n_listings });
    }

    await env.SITE.put(`data/${id}.json`, JSON.stringify(payload));
  }

  if (more) {
    /* Record where to resume.
     *
     * A Worker cannot fetch its own address — Cloudflare blocks it to
     * prevent loops — so the slices cannot hand on directly. Instead the
     * next position is written here and the cron picks it up on its next
     * tick, a few minutes later. The build finishes itself over the course
     * of an hour without anyone driving it. */
    await env.SITE.put("build:index",
      JSON.stringify({ day: today, cities: index.cities, next: from + SLICE }),
      { expirationTtl: 86400 });
    log.push(`slice ${from}-${from + slice.length} done, ` +
             `${Math.max(0, everyCity.length - from - SLICE)} cities left ` +
             `— the next tick continues from ${from + SLICE}`);
  } else {
    await env.SITE.put("data/stats.json", JSON.stringify(index));
    await env.SITE.put("build:index",
      JSON.stringify({ day: today, cities: index.cities, next: null }),
      { expirationTtl: 86400 });
    log.push(`stats.json written with ${index.cities.length} cities — build complete`);
  }

  log.push(`${files.length} city files written`);
  return { log, cities: index.cities.length, slice: `${from}-${from + slice.length}`, more,
           listings: all.results.length, day: today };
}

/**
 * Recompute the city snapshots recorded before the method changed.
 *
 * The old figure was the median of the neighbourhood medians, which counts a
 * neighbourhood with three listings the same as one with three hundred. The
 * current figure is the median across listings.
 *
 * Those early days can be rebuilt rather than discarded, because
 * hood_snapshots stored each neighbourhood's median together with how many
 * listings it came from. Treating each neighbourhood as n listings sitting
 * at its median and taking the weighted median gives the listing-weighted
 * figure back. It ignores the spread inside each neighbourhood, so it is an
 * estimate — but an estimate from real counts, not an invention, and far
 * closer to the current method than the number it replaces.
 */
/**
 * Rebuild the pre-Cloudflare snapshots using the live method.
 *
 * The four days before 1 September were measured by the laptop pipeline,
 * which took the median of each neighbourhood's median. The worker takes the
 * median across all of a city's listings. Those are different numbers, and
 * where the two methods met the chart showed a 31% jump that no house price
 * actually made.
 *
 * The listings themselves are still in the table with the date they were
 * scraped, so those days can be recomputed rather than estimated: take the
 * listings known by that date and run exactly the same steps build() runs —
 * same city band, same deduplication, same minimum, same median. The result
 * is not an approximation of the live method, it is the live method.
 *
 * ?apply=1 writes. Without it this only reports what it would change, since
 * the alternative is discovering a mistake after the history is overwritten.
 * ?method=interp falls back to estimating from neighbourhood medians, for
 * days where too few listings survive to recompute honestly.
 */
export async function backfill(env, before = "2026-09-01", opts = {}) {
  const db = env.DB;
  const apply = !!opts.apply;

  const dayRows = await db.prepare(
    "SELECT DISTINCT day FROM city_snapshots WHERE day < ? AND kind='apartment' ORDER BY day")
    .bind(before).all();
  const days = dayRows.results.map((r) => r.day);
  if (!days.length) return { log: ["no earlier snapshots to rebuild"], changed: 0 };

  const existing = new Map();
  const prev = await db.prepare(
    "SELECT city, day, median_m2, n_listings FROM city_snapshots WHERE day < ? AND kind='apartment'")
    .bind(before).all();
  for (const r of prev.results) existing.set(`${r.city}|${r.day}`, r);

  if (opts.method === "interp") {
    return backfillInterpolated(db, before, days, existing, apply);
  }

  // One scan, bucketed in memory afterwards. A query per day would multiply
  // the row reads by the number of days for no extra information.
  const maxDay = days[days.length - 1];
  const rows = await db.prepare(`
    SELECT city, price_m2, dedupe_key, substr(scraped_at, 1, 10) AS d
    FROM listings
    WHERE COALESCE(kind,'apartment')='apartment'
      AND price_m2 IS NOT NULL AND price_m2 > 0
      AND city IS NOT NULL AND scraped_at IS NOT NULL
      AND substr(scraped_at, 1, 10) <= ?`).bind(maxDay).all();

  const log = [`${rows.results.length} listings scraped on or before ${maxDay}`];

  // If the migration stamped every row with its own date rather than the
  // original scrape date, there is nothing here to rebuild from and the
  // estimate is the honest option. Say so rather than writing a flat line.
  if (rows.results.length < 500) {
    log.push("too few listings carry an early scrape date — " +
             "cannot recompute; retry with ?method=interp to estimate instead");
    return { log, changed: 0, applied: false };
  }

  const stmts = [];
  const report = [];

  for (const day of days) {
    const upto = rows.results.filter((r) => r.d <= day);
    const byCity = new Map();
    for (const r of upto) {
      if (!byCity.has(r.city)) byCity.set(r.city, []);
      byCity.get(r.city).push(r);
    }

    const [jy, jm] = gregorianToJalali(
      +day.slice(0, 4), +day.slice(5, 7), +day.slice(8, 10));

    let cities = 0;
    for (const [city, all] of byCity) {
      // the same three steps build() applies, in the same order
      const cm = median(all.map((r) => r.price_m2));
      const inBand = all.filter((r) =>
        r.price_m2 >= CITY_BAND[0] * cm && r.price_m2 <= CITY_BAND[1] * cm);

      const seen = new Set();
      const kept = [];
      for (const r of inBand) {
        if (r.dedupe_key) {
          if (seen.has(r.dedupe_key)) continue;
          seen.add(r.dedupe_key);
        }
        kept.push(r);
      }
      if (kept.length < MIN_CITY_LISTINGS) continue;

      const med = Math.round(median(kept.map((r) => r.price_m2)) / 1e5) / 10;
      cities++;

      stmts.push(db.prepare(
        "INSERT OR REPLACE INTO city_snapshots VALUES (?,?,?,?,?,?)")
        .bind(city, day, jy, jm, med, kept.length));

      const was = existing.get(`${city}|${day}`);
      if (report.length < 12 && was) {
        const delta = was.median_m2
          ? Math.round((med - was.median_m2) / was.median_m2 * 1000) / 10 : null;
        report.push(`${day} ${city}: ${was.median_m2} -> ${med}` +
                    (delta === null ? "" : ` (${delta > 0 ? "+" : ""}${delta}%)`) +
                    `  n ${was.n_listings} -> ${kept.length}`);
      }
    }
    log.push(`${day}: ${upto.length} listings known, ${cities} cities rebuilt`);
  }

  if (apply) {
    for (let i = 0; i < stmts.length; i += 200) {
      await db.batch(stmts.slice(i, i + 200));
    }
  }

  return {
    method: "recomputed from listings, same steps as the daily build",
    applied: apply,
    changed: stmts.length,
    log: apply
      ? [`${stmts.length} snapshots rewritten`, ...log, ...report]
      : [`${stmts.length} snapshots WOULD be rewritten — add ?apply=1 to write`,
         ...log, ...report],
  };
}

/**
 * Fallback: estimate the listing-weighted median from the neighbourhood
 * medians and counts that were recorded at the time. Each neighbourhood's
 * median is treated as sitting at the midpoint of its share of the
 * distribution, and the halfway point is interpolated between neighbours —
 * about 2% off in testing, against 9% for simply taking whichever
 * neighbourhood contains the midpoint.
 */
async function backfillInterpolated(db, before, days, existing, apply) {
  const rows = await db.prepare(`
    SELECT city, day, median_m2, n_listings
    FROM hood_snapshots
    WHERE day < ? AND kind='apartment' AND median_m2 IS NOT NULL AND n_listings > 0
    ORDER BY city, day, median_m2`).bind(before).all();

  const buckets = new Map();
  for (const r of rows.results) {
    const k = `${r.city}|${r.day}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }

  const stmts = [];
  const report = [];

  for (const [k, hoods] of buckets) {
    const [city, day] = k.split("|");
    hoods.sort((a, b) => a.median_m2 - b.median_m2);
    const total = hoods.reduce((s, h) => s + h.n_listings, 0);
    if (!total) continue;

    const half = total / 2;
    let running = 0;
    const points = hoods.map((h) => {
      const mid = running + h.n_listings / 2;
      running += h.n_listings;
      return [mid, h.median_m2];
    });

    let v = points[points.length - 1][1];
    for (let i = 0; i < points.length; i++) {
      if (points[i][0] < half) continue;
      if (i === 0) { v = points[0][1]; break; }
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      v = y0 + (y1 - y0) * (half - x0) / (x1 - x0);
      break;
    }
    v = Math.round(v * 10) / 10;

    const [jy, jm] = gregorianToJalali(
      +day.slice(0, 4), +day.slice(5, 7), +day.slice(8, 10));

    stmts.push(db.prepare(
      "INSERT OR REPLACE INTO city_snapshots VALUES (?,?,?,?,?,?,?)")
      .bind(city, 'apartment', day, jy, jm, v, total));

    const was = existing.get(k);
    if (report.length < 12 && was) {
      report.push(`${day} ${city}: ${was.median_m2} -> ${v} (${total} listings)`);
    }
  }

  if (apply) {
    for (let i = 0; i < stmts.length; i += 200) {
      await db.batch(stmts.slice(i, i + 200));
    }
  }

  return {
    method: "estimated from neighbourhood medians (approximate)",
    applied: apply,
    changed: stmts.length,
    log: [`${stmts.length} snapshots ${apply ? "rewritten" : "WOULD be rewritten"}`,
          ...report],
  };
}

/* The daily read and write limits are a normal condition, not a fault; the
 * build simply resumes tomorrow rather than throwing every ten minutes. */
function isLimitError(e) {
  return /exceeded .*(daily|limit)/i.test(String(e && e.message));
}

export default {
  async scheduled(event, env, ctx) {
    /* Runs every ten minutes and does one slice if there is work to do.
     * Six ticks finish a fifty-city build, an hour after midnight, and the
     * rest of the day it finds nothing pending and stops immediately. */
    ctx.waitUntil((async () => {
      const today = new Date().toISOString().slice(0, 10);
      let from = 0;
      try {
        const p = await env.SITE.get("build:index", { type: "json" });
        if (p && p.day === today) {
          if (p.next === null) return;        // already finished today
          from = p.next || 0;
        }
      } catch (e) { /* start from the beginning */ }
      try {
        const r = await build(env, [], from);
        console.log(r.log.join("\n"));
      } catch (e) {
        /* A slice that throws must not be retried on the next tick. Before
         * this, a failing slice was reattempted every ten minutes and each
         * attempt read the whole listings table, which emptied the daily read
         * allowance within the hour. The position is advanced past it: one
         * bad slice costs eight cities their update for a day, which is far
         * better than costing every city its update. */
        await env.SITE.put("build:index", JSON.stringify({
          day: today, cities: (await env.SITE.get("build:index", { type: "json" }))?.cities || [],
          next: from + 8, lastError: String(e.message).slice(0, 200),
        }), { expirationTtl: 86400 });
        console.log(`slice from ${from} failed, skipping to ${from + 8}: ${e.message}`);
        if (isLimitError(e)) throw e;
      }
    })().catch((e) => {
      if (isLimitError(e)) {
        console.log("daily limit reached; the build resumes tomorrow");
        return;
      }
      throw e;
    }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // report the failure rather than letting Cloudflare show a bare 1101
    try {
      if (url.pathname === "/run") {
        const from = +(url.searchParams.get("from") || 0);
        // its own address, so a slice can hand on to the next
        const self = `${url.origin}/run`;
        return json(await build(env, [], from, self));
      }
      if (url.pathname === "/backfill") {
        const before = url.searchParams.get("before") || "2026-09-01";
        return json(await backfill(env, before, {
          apply: url.searchParams.get("apply") === "1",
          method: url.searchParams.get("method") || "recompute",
        }));
      }
    } catch (err) {
      return json({ error: `${err.name}: ${err.message}`,
                    stack: String(err.stack || "").split("\n").slice(0, 4) }, 500);
    }

    // the site fetches its data through here
    if (url.pathname.startsWith("/data/")) {
      const key = url.pathname.slice(1);
      const body = await env.SITE.get(key);
      if (!body) return new Response("not found", { status: 404 });
      return new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=1800",
          "access-control-allow-origin": "*",
        },
      });
    }
    return json({ routes: ["/run — rebuild now", "/data/stats.json"] });
  },
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
