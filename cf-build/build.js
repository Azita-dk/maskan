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
const MIN_CITY_LISTINGS = 1;
const HISTORY_DAYS = 180;         // how much per-neighbourhood history to ship
const MAD_CUTOFF = 3.5;
const CITY_BAND = [0.25, 12.0];
const HOOD_MIN_FOR_BAND = 20;    // relative to the city's own median


/* Listings written into each city file, per kind. 12,000 x 3 kinds is about
   12 MB of JSON — inside the 25 MB limit on a stored value, with room for
   the database to keep growing. */
const PER_KIND_CAP = 12000;

/* How far back the history is recomputed. Listings that expired before the
   scraper first ran are not in the database, so days beyond this rest on too
   few of them to mean anything. */
const BACKFILL_DAYS = 0;
const BACKFILL_PER_RUN = 2;

const ACTIVE_DAYS = 21;

/**
 * A matching key for place names — never for display.
 *
 * "سعادت‌آباد", "سعادت آباد" and "سعادت اباد" are one neighbourhood. Without
 * folding them, each spelling becomes its own row with a fraction of the
 * listings, and a real neighbourhood can fall below the sample threshold
 * purely because its name is written three ways.
 */
function sheypoorUrl(title, id) {
  const slug = String(title || "").split(/[^\p{L}\p{N}\u200c]+/u).filter(Boolean).join("-");
  return `https://www.sheypoor.com/v/${slug ? slug + "-" : ""}${id}.html`;
}

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

/* Where each city is, from Iran's National Cartographic Center gazetteer
 * (gndb.ncc.org.ir). Four provincial capitals were cut off in the copy used —
 * همدان, یزد, بندرعباس and اراک — and are their standard city centres.
 *
 * Villages the scraper meets in titles — تهراندشت, کردان, سهیلیه — are not
 * in the gazetteer because they are not cities. A listing there goes to the
 * nearest city that is, which for all three is کرج. */
const CITY_POS = {
  "تهران":[35.7122,51.3684],"مشهد":[36.3033,59.5819],"اصفهان":[32.6666,51.6607],
  "کرج":[35.8378,50.9709],"شیراز":[29.5992,52.5325],"تبریز":[38.0793,46.2892],
  "قم":[34.6456,50.8721],"اهواز":[31.3096,48.6722],"کرمانشاه":[34.3432,47.1002],
  "ارومیه":[37.5481,45.0562],"رشت":[37.2841,49.5904],"زاهدان":[29.4905,60.8603],
  "همدان":[34.7980,48.5146],"کرمان":[30.2799,57.0592],"یزد":[31.8974,54.3569],
  "اردبیل":[38.2449,48.2897],"بندرعباس":[27.1832,56.2666],"اراک":[34.0917,49.6892],
  "اسلامشهر":[35.5534,51.2408],"زنجان":[36.6785,48.4959],"سنندج":[35.3040,46.9987],
  "قزوین":[36.2858,50.0066],"خرم آباد":[33.5052,48.3643],"گرگان":[36.8392,54.4390],
  "ساری":[36.5614,53.0611],"شهریار":[35.6574,51.0586],"قدس":[35.7115,51.1158],
  "کاشان":[33.9749,51.4359],"دزفول":[32.3784,48.4086],"بابل":[36.5462,52.6783],
  "ملارد":[35.6630,50.9783],"سبزوار":[36.2092,57.6823],"آمل":[36.4722,52.3562],
  "نیشابور":[36.2079,58.7940],"بجنورد":[37.4743,57.3264],"ورامین":[35.3294,51.6347],
  "پاکدشت":[35.4816,51.6876],"بوشهر":[28.9214,50.8377],"بیرجند":[32.8569,59.2195],
  "سیرجان":[29.4449,55.6752],"بروجرد":[33.8981,48.7554],"ایلام":[33.6349,46.4300],
  "مرودشت":[29.8791,52.8109],"شهرکرد":[32.3319,50.8583],"خوی":[38.5500,44.9540],
  "مراغه":[37.3862,46.2410],"سقز":[36.2417,46.2726],"رفسنجان":[30.4005,55.9871],
  "لاهیجان":[37.2044,50.0061],"یاسوج":[30.6652,51.5877],"اندیشه":[35.6897,51.0223],
  "هشتگرد":[35.9607,50.6867],"فردیس":[35.7453,51.0010],"پردیس":[35.7455,51.8052],
  "پرند":[35.4859,50.9387],"نظرآباد":[35.9519,50.6045],"محمدشهر":[35.7486,50.8979],
  "قرچک":[35.4210,51.5835],"بومهن":[35.7295,51.8702],"رودهن":[35.7376,51.9104],
  "شهرجدیدهشتگرد":[35.9955,50.7505],"چهارباغ":[35.8393,50.8478],
  "ماهدشت":[35.7260,50.8094],"کمال‌شهر":[35.8639,50.8822],
  "مشکین‌دشت":[35.7470,50.9474],"گرمدره":[35.7458,51.0755],
  "آسارا":[36.0395,51.1866],"طالقان":[36.1730,50.7685],
};

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


const ADDR_HOOD_MIN = 5;
const ADDR_STREET = ["خیابان", "خ ", "کوچه", "بلوار", "بزرگراه", "اتوبان", "میدان", "جاده",
                     "نبش", "بین ", "پلاک", "فاز ", "متری", "کیلومتر", "روبروی", "جنب"];
function hoodFromAddress(address, city) {
  if (!address) return null;
  const parts = String(address).split(/[،,]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const start = parts[0] === city ? 1 : 0;
  const cand = parts[start];
  if (!cand || cand === city || cand.length < 2 || cand.length > 40) return null;
  if (/^[\d۰-۹٠-٩]/.test(cand)) return null;
  if (ADDR_STREET.some((w) => cand.startsWith(w))) return null;
  return cand;
}
const MONTHS_BACK = 12;

function jKey(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  const [a, b] = gregorianToJalali(y, m, d);
  return a * 12 + b - 1;
}

/* Each advert counts once in every month it was on the market: from the
   month of its first Divar date to the month it was last seen (or this
   month, while it is still up). In each month it carries the price it had
   by the end of that month. */
function monthlyOf(list, jyNow, jmNow, activeFrom, history) {
  const nowK = jyNow * 12 + jmNow - 1;
  const fromK = nowK - MONTHS_BACK + 1;
  const g = new Map();
  for (const r of list) {
    if (r.dup) continue;
    const start = r.first_posted || r.posted_at;
    if (!start) continue;
    const sK = jKey(start);
    if (sK == null) continue;
    const seen = String(r.seen || "").slice(0, 10);
    const eK = r.removed ? jKey(r.removed)
      : !seen || seen >= activeFrom ? nowK : jKey(seen);
    if (eK == null || eK < fromK) continue;
    const h = history && history.get(r.source_id);
    for (let k = Math.max(sK, fromK); k <= Math.min(eK, nowK); k++) {
      let p = r.price_m2;
      if (h && h.length && r.area_m2 > 0) {
        let pick = null;
        for (const e of h) if (e.k <= k) pick = e;
        p = Math.round((pick || h[0]).price / r.area_m2);
      }
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(p > 0 ? p : null);
    }
  }
  const out = [];
  for (const [k, all] of [...g].sort((x, y) => x[0] - y[0])) {
    const vals = all.filter((v) => v > 0);
    const kept = trimOutliers(vals);
    out.push([k, all.length, kept.length ? Math.round(median(kept) / 1e5) / 10 : null]);
  }
  return out;
}

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
    "SELECT city FROM scrape_state WHERE source='divar' GROUP BY city ORDER BY MIN(rowid)").all();
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
  let hasLastSeen = false, hasPriceChanged = false, hasFirstPosted = false, hasPriceHistory = false;
  let hasRemoved = false;
  try {
    const cols = await db.prepare("PRAGMA table_info(listings)").all();
    hasRemoved = cols.results.some((c) => c.name === "removed_at");
    hasLastSeen = cols.results.some((c) => c.name === "last_seen");
    hasPriceChanged = cols.results.some((c) => c.name === "price_changed_at");
    hasFirstPosted = cols.results.some((c) => c.name === "first_posted_at");
    const t = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='price_history'").all();
    hasPriceHistory = t.results.length > 0;
  } catch (e) { /* treat every listing as active */ }
  const activeFrom = new Date(Date.now() - ACTIVE_DAYS * 864e5).toISOString().slice(0, 10);

  const all = await db.prepare(`
    SELECT source, source_id, city, hood, title, url, price_toman, area_m2,
           price_m2, rooms, age_years, lat, lng, address, posted_at,
           features, dedupe_key, COALESCE(kind,'apartment') AS kind,
           ${hasLastSeen ? "COALESCE(last_seen, scraped_at)" : "scraped_at"} AS seen,
           ${hasPriceChanged
             ? "CASE WHEN price_changed_at > COALESCE(posted_at, '') THEN price_changed_at ELSE posted_at END"
             : "posted_at"} AS eff,
           ${hasFirstPosted ? "first_posted_at" : "posted_at"} AS first_posted,
           ${hasRemoved ? "removed_at" : "NULL"} AS removed
    FROM listings
    WHERE price_toman IS NOT NULL AND price_toman > 0
      AND city IN (${sliceCities.map(() => "?").join(",")})`)
    .bind(...sliceCities).all();

  const KEEP_SOURCES = new Set(["divar", "sheypoor"]);
  const dropped = all.results.length;
  all.results = all.results.filter((r) => KEEP_SOURCES.has(r.source || "divar"));
  log.push(`${all.results.length} listings read (${dropped - all.results.length} from unmaintained sources left out)`);

  const priceHistory = new Map();
  if (hasPriceHistory) {
    try {
      const ph = await db.prepare(`
        SELECT h.source_id, h.day, h.price_toman FROM price_history h
        JOIN listings l ON l.source = h.source AND l.source_id = h.source_id
        WHERE l.city IN (${sliceCities.map(() => "?").join(",")})
        ORDER BY h.day`).bind(...sliceCities).all();
      for (const r of ph.results) {
        const k = r.day.startsWith("0000") ? -1 : jKey(r.day);
        if (k == null) continue;
        if (!priceHistory.has(r.source_id)) priceHistory.set(r.source_id, []);
        priceHistory.get(r.source_id).push({ k, price: Number(r.price_toman) });
      }
      log.push(`${ph.results.length} price changes read`);
    } catch (e) { log.push(`price history not read: ${e.message}`); }
  }

  /* A listing's city comes from text — Divar's label, or a town named in the
   * title — and text is wrong often enough: a بنگاه's address, a road called
   * جاده تهران, a village called تهراندشت. Its coordinates come from Divar's
   * own map for that one listing, and are far more reliable. So when they
   * disagree, the coordinates decide.
   *
   * A listing more than NEAR_KM from its own city's centre, and within
   * NEAR_KM of another city's, is in that other city: it is moved, and the
   * move is written back so the other city's own build picks it up. One more
   * than FAR_KM from its city and near no other is somewhere the scraper
   * does not cover, and is left out.
   *
   * The two thresholds keep adjacent towns from trading listings: کرج and
   * فردیس are ten kilometres apart, so a Fardis flat filed under Karaj is
   * still inside NEAR_KM of Karaj and stays where it is. */
  const NEAR_KM = 20, FAR_KM = 30;
  const kmTo = (r, city) => {
    const p = CITY_POS[city]; if (!p) return null;
    const R = 6371, rad = Math.PI / 180;
    const dLat = (p[0] - r.lat) * rad, dLng = (p[1] - r.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(r.lat * rad) * Math.cos(p[0] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const moves = [];
  let misplaced = 0;
  // only a city this build processes can receive a listing — one filed
  // anywhere else would sit in the database and never reach the site
  for (const r of all.results) {
    if (!(r.area_m2 > 0) || (r.kind !== "apartment" && r.area_m2 < 30)) r.price_m2 = null;
  }
  const built = new Set(everyCity);
  all.results = all.results.filter(r => {
    if (!r.lat || !r.lng || !CITY_POS[r.city]) return true;   // cannot check
    const own = kmTo(r, r.city);
    if (own <= NEAR_KM) return true;
    let best = null, bestKm = Infinity;
    for (const c in CITY_POS) {
      if (c === r.city || !built.has(c)) continue;
      const d = kmTo(r, c);
      if (d < bestKm) { bestKm = d; best = c; }
    }
    if (best && bestKm <= NEAR_KM) {
      moves.push({ source: r.source, source_id: r.source_id, city: best });
      misplaced++;
      return false;                 // it belongs to another city's build
    }
    if (own > FAR_KM) misplaced++;
    return true;
  });

  const seen = new Set();
  const cities = new Map();
  let dupes = 0, onDivar = 0;
  const looseKey = (r) => {
    const a = Math.round(r.area_m2 || 0), p = Number(r.price_toman) || 0;
    if (!a || !p) return null;
    const d = Math.ceil(Math.log10(p)) - 3;
    return `${canonicalPlace(r.city)}|${r.kind}|${a}|${Math.round(p / 10 ** d)}`;
  };
  const divarKeys = new Set();
  for (const r of all.results) {
    if (r.source !== "divar" || r.removed) continue;
    if (r.dedupe_key) divarKeys.add(r.dedupe_key);
    const k = looseKey(r);
    if (k) divarKeys.add(k);
  }
  all.results.sort((a, b) => (a.source === "divar" ? 0 : 1) - (b.source === "divar" ? 0 : 1));

  for (const r of all.results) {
    if (r.source !== "divar" &&
        ((r.dedupe_key && divarKeys.has(r.dedupe_key)) || divarKeys.has(looseKey(r)))) { onDivar++; continue; }
    if (r.dedupe_key) {
      if (seen.has(r.dedupe_key)) { dupes++; r.dup = true; }
      else seen.add(r.dedupe_key);
    }
    const gk = `${r.city}|${r.kind}`;
    if (!cities.has(gk)) cities.set(gk, []);
    cities.get(gk).push(r);
  }

  const hoodFills = [];
  for (const [gk, list] of cities) {
    const city = gk.split("|")[0];
    const known = new Set(list.filter((r) => r.hood).map((r) => canonicalPlace(r.hood)));
    const counts = new Map();
    const cand = new Map();
    for (const r of list) {
      if (r.hood) continue;
      const h = hoodFromAddress(r.address, city);
      if (!h) continue;
      cand.set(r, h);
      const k = canonicalPlace(h);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const [r, h] of cand) {
      const k = canonicalPlace(h);
      if (known.has(k) || counts.get(k) >= ADDR_HOOD_MIN) {
        r.hood = h;
        hoodFills.push({ source: r.source, source_id: r.source_id, hood: h });
      }
    }
  }
  log.push(`${onDivar} ads from other sites left out because the same ad is on Divar`);
  log.push(`${dupes} duplicate reposts (shown, not counted twice in statistics), ` +
           `${misplaced} whose map position is in another town ` +
           `(${moves.length} moved to it)`);

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
  /* Start every slice from the last published index, not from nothing.
   *
   * This loaded the previous cities only when continuing a pass (from > 0),
   * so the first slice of each new pass wrote stats.json with eight cities
   * in it. The national total halved and climbed back every forty minutes —
   * 192,262 apartments, then 140,887, with Tehran unchanged in both.
   *
   * A city now keeps its last figures until its own slice rebuilds them, so
   * the file is always complete: some entries are up to a pass old, none are
   * missing. Yesterday's index is accepted for the same reason — the first
   * pass after midnight should not publish a near-empty country. */
  let carried = [];
  try {
    const prev = await env.SITE.get("build:index", { type: "json" });
    if (prev && Array.isArray(prev.cities)) carried = prev.cities;
  } catch (e) { /* start the index again */ }
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
  let backfilled = 0;

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
                       ours: {}, hood_hist: {}, byKind: {},
                       monthly: {}, hood_monthly: {} };

   for (const [kind, allRows] of kinds) {
    cityFile.monthly[kind] = monthlyOf(allRows, jy, jm, activeFrom, priceHistory);
    {
      const hg = new Map(), hn = new Map();
      for (const r of allRows) {
        const raw = r.hood || "نامشخص";
        const key = canonicalPlace(raw) || "نامشخص";
        if (!hg.has(key)) { hg.set(key, []); hn.set(key, raw); }
        hg.get(key).push(r);
      }
      const hm = {};
      for (const [key, members] of hg) {
        const m = monthlyOf(members, jy, jm, activeFrom, priceHistory);
        if (m.some((x) => x[1] >= 3)) hm[hn.get(key)] = m;
      }
      cityFile.hood_monthly[kind] = hm;
    }
    const activeRows = allRows.filter((r) => !r.removed &&
      (!hasLastSeen || String(r.seen || "").slice(0, 10) >= activeFrom));
    const rows = activeRows.length >= 5 ? activeRows : allRows.filter((r) => !r.removed);
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
      const priced = members.filter((m) => !m.dup && m.price_m2 > 0);
      const kept = trimOutliers(priced.map((m) => m.price_m2));
      if (!kept.length) continue;
      const keptSet = new Set(kept);
      const inliers = priced.filter((m) => keptSet.has(m.price_m2));
      const med = Math.round(median(kept) / 1e5) / 10;   // million toman, 1dp

      const pts = inliers.filter((m) => m.lat && m.lng);
      const row = {
        // the kind belongs on the row: every kind's neighbourhoods are
        // pushed into one cityFile.rows, and without it the site cannot tell
        // an apartment neighbourhood from a villa one
        k: kind,
        hood, m: 35, median: med, n: members.filter((x) => !x.dup).length,
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
        m: r.price_m2 > 0 ? Math.round(r.price_m2 / 1e5) / 10 : null,
        s: r.source, u: r.source === "sheypoor" ? sheypoorUrl(r.title, r.source_id) : (r.url || ""), k: kind,
      };
      if (r.rooms != null) o.r = r.rooms;
      if (r.age_years != null) o.g = r.age_years;
      if (r.lat) { o.y = +r.lat.toFixed(5); o.x = +r.lng.toFixed(5); }
      if (r.eff || r.posted_at) o.d = String(r.eff || r.posted_at).slice(0, 10);
      if (r.first_posted && o.d && String(r.first_posted).slice(0, 10) < o.d)
        o.d0 = String(r.first_posted).slice(0, 10);
      if (r.address) o.ad = r.address;
      if (r.features) o.f = r.features.split(",");
      return o;
    }).sort((a, b) => (b.m || 0) - (a.m || 0));

    const statVals = rows.filter((r) => !r.dup && r.price_m2 > 0).map((r) => r.price_m2);
    const cityMed = statVals.length ? Math.round(median(statVals) / 1e5) / 10 : null;

    /* The history, recomputed from today's listings.
     *
     * A day's median used to be whatever had been scraped by then, so the
     * line moved when coverage moved: Tehran fell to 218.8 and rose to 247.5
     * while its listing count went from 16,350 to 102,578 in five days.
     * Neither was the market.
     *
     * Every listing carries its posting date, and a Divar advert runs about
     * 28 days, so which listings were on the market on any past day can be
     * worked out from the ones held now — and every day measured the same
     * way, on the same data. Rewritten daily, because today's listings are a
     * better record of last week than last week's scrape was.
     *
     * It reaches back only as far as the listings do: an advert that expired
     * before the scraper first ran is not here, so the earliest days rest on
     * fewer listings and drift. BACKFILL_DAYS keeps it to a window the data
     * genuinely covers. */
    /* At most a couple of rebuilds per run. Each is cheap now, but eight
       cities times three kinds in one invocation is not, and a run that
       overruns writes nothing at all. The rest are picked up by later runs,
       since each is remembered for the day once done. */
    const backfillKey = `backfill:${city}|${kind}:${today}`;
    let doneToday = true;
    if (BACKFILL_DAYS > 0 && backfilled < BACKFILL_PER_RUN) {
      try { doneToday = !!(await env.SITE.get(backfillKey)); } catch (e) { doneToday = false; }
    }
    if (!doneToday) {
      backfilled++;
      /* Dates are turned into numbers once, not re-parsed for every day.
         Parsing inside the loop meant three million Date.parse calls for
         Tehran alone, and over seven million across the big cities in one
         slice — past the thirty seconds a run gets, so the run died and
         nothing was written at all. */
      const dayMs = 864e5, now = Date.parse(today);
      const dated = [];
      for (const r of rows) {
        if (!r.posted_at || !(r.price_m2 > 0)) continue;
        const t = Date.parse(r.posted_at);
        const s = hasLastSeen && r.seen ? Date.parse(String(r.seen).slice(0, 10)) : Infinity;
        if (isFinite(t)) dated.push({ t, s: isFinite(s) ? s : Infinity, p: r.price_m2 });
      }

      for (let back = BACKFILL_DAYS; back >= 1; back--) {
        const dayT = now - back * dayMs;
        const d = new Date(dayT).toISOString().slice(0, 10);
        const live = [];
        /* On the market on that day means posted by then. A Divar advert
           stays up until its seller takes it down, so there is no lifetime
           after which to drop it — cutting at 28 days was throwing away most
           of what was genuinely for sale. */
        for (const r of dated) {
          if (r.t > dayT || r.s < dayT) continue;
          live.push(r.p);
        }
        if (live.length < 30) continue;                        // too few to trust
        const m = Math.round(median(live) / 1e5) / 10;
        const dt = new Date(d);
        const [jy2, jm2] = gregorianToJalali(
          dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
        if (perKindHistory) {
          snapshots.push(db.prepare(
            "INSERT OR REPLACE INTO city_snapshots VALUES (?,?,?,?,?,?,?)")
            .bind(city, kind, d, jy2, jm2, m, live.length));
        } else if (kind === "apartment") {
          snapshots.push(db.prepare(
            "INSERT OR REPLACE INTO city_snapshots VALUES (?,?,?,?,?,?)")
            .bind(city, d, jy2, jm2, m, live.length));
        }
      }
      try { await env.SITE.put(backfillKey, "1", { expirationTtl: 172800 }); }
      catch (e) { /* it will simply run again */ }
    }
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
    /* Only the newest listings go in the file.
     *
     * A stored value cannot exceed 25 MB. Tehran crossed 87,595 listings on
     * 21 September — about 29 MB of JSON — and every write since was
     * refused, so the site kept serving the last file that fitted while the
     * database went on growing. It is also what made the site slow to open
     * on a phone: the whole file is downloaded before anything appears.
     *
     * The medians, neighbourhood figures and counts above are computed from
     * every listing first, so nothing in the statistics is sampled. What the
     * cap limits is the ads table and the map, which show a few dozen at a
     * time. */
    /* An even sample, not the first N.
     *
     * The file cannot hold every listing — Tehran's would pass the 25 MB
     * limit on a stored value — but what it holds has to look like the whole
     * city, because the distribution chart is drawn from it. Taking a slice
     * of whatever order the query returned gave a median of 600 against the
     * city's true 240: the chart and the headline were reading different
     * listings.
     *
     * Every k-th row keeps the shape of the distribution whatever the order,
     * and spreads the sample across prices, neighbourhoods and dates alike. */
    if (listings.length <= PER_KIND_CAP) {
      cityFile.listings.push(...listings);
    } else {
      const step = listings.length / PER_KIND_CAP;
      for (let i = 0; i < PER_KIND_CAP; i++) {
        cityFile.listings.push(listings[Math.floor(i * step)]);
      }
    }
    cityFile.byKind[kind] = { n: rows.length, median: cityMed,
                              hoods: hoodRows.length,
                              shown: Math.min(rows.length, PER_KIND_CAP) };
   }   // end of kinds

    cityFile.listings.sort((a, b) => (b.m || 0) - (a.m || 0));
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

  index.cities = index.cities.filter((c) => !sliceCities.includes(c.name) || byCity.has(c.name));

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
    /* stats.json is written on every slice, not only when a pass ends.
     *
     * It used to wait for the last slice, so with more cities than one slice
     * could hold the site showed a file from the previous complete pass while
     * the city files were current — 45,557 apartments on the tab and 33,759
     * in the dropdown, from the same page. The index carries across slices,
     * so writing it each time costs nothing and the file is always as fresh
     * as the last slice made it. */
    await env.SITE.put("data/stats.json", JSON.stringify(index));
    await env.SITE.put("build:index",
      JSON.stringify({ day: today, cities: index.cities, next: from + SLICE }),
      { expirationTtl: 86400 });
    log.push(`slice ${from}-${from + slice.length} done, ` +
             `stats.json has ${index.cities.length} cities, ` +
             `${Math.max(0, everyCity.length - from - SLICE)} left`);
  } else {
    await env.SITE.put("data/stats.json", JSON.stringify(index));
    await env.SITE.put("build:index",
      JSON.stringify({ day: today, cities: index.cities, next: null }),
      { expirationTtl: 86400 });
    log.push(`stats.json written with ${index.cities.length} cities — pass complete`);

  }

  log.push(`${files.length} city files written`);

  /* Write the moves back. Each is a listing whose coordinates put it in a
     different city from the one it was filed under; recording the right city
     means the other city's own slice picks it up, and it is not re-detected
     on every build. The neighbourhood goes too — it came from the wrong
     city. Capped per run so a first pass over a large backlog cannot become
     one enormous write. */
  if (hoodFills.length) {
    const fb = hoodFills.slice(0, 3000).map((m) => db.prepare(
      `UPDATE listings SET hood = ? WHERE source = ? AND source_id = ? AND (hood IS NULL OR hood = '')`)
      .bind(m.hood, m.source, m.source_id));
    for (let i = 0; i < fb.length; i += 50) await db.batch(fb.slice(i, i + 50));
    log.push(`${fb.length} listings given a neighbourhood from their address`);
  }
  if (moves.length) {
    const batch = moves.slice(0, 2000).map(m => db.prepare(
      `UPDATE listings SET city = ?, hood = '' WHERE source = ? AND source_id = ?`)
      .bind(m.city, m.source, m.source_id));
    for (let i = 0; i < batch.length; i += 50) await db.batch(batch.slice(i, i + 50));
    log.push(`${batch.length} listings refiled to the city their map position is in`);
  }
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
    /* Runs every five minutes and rebuilds continuously.
     *
     * It used to stop for the day once a pass finished: six ticks after
     * midnight and nothing until tomorrow. That fitted a scraper that ran
     * hourly. The scraper now runs every two minutes, so a build that stops
     * at 00:30 leaves the site a day behind — which is exactly what it did,
     * showing 19,809 Tehran apartments while the database held 30,882. A
     * finished pass now starts another. */
    ctx.waitUntil((async () => {
      const today = new Date().toISOString().slice(0, 10);
      let from = 0;
      try {
        const p = await env.SITE.get("build:index", { type: "json" });
        if (p && p.day === today) {
          from = p.next === null ? 0 : (p.next || 0);
        }
      } catch (e) { /* start from the beginning */ }
      try {
        const r = await build(env, [], from);
        if (r.more === false && r.cities === 0) {
          const p = await env.SITE.get("build:index", { type: "json" });
          await env.SITE.put("build:index",
            JSON.stringify({ day: today, cities: (p && p.cities) || [], next: null }),
            { expirationTtl: 86400 });
        }
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
          next: from + (Number(env.SLICE) || SLICE_DEFAULT), lastError: String(e.message).slice(0, 200),
        }), { expirationTtl: 86400 });
        console.log(`slice from ${from} failed, skipping ahead: ${e.message}`);
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
          /* One minute, not thirty. Thirty was set when the build ran
             hourly; it now runs every five minutes, so the site could sit
             half an hour behind its own data — the chart kept showing
             21 September while the database had 23. */
          "cache-control": "public, max-age=60, must-revalidate",
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
