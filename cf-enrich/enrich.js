/**
 * enrich.js — fetch each listing's own page, as a scheduled Worker.
 *
 * Replaces enrich.py. The search results carry a title and a price; the
 * detail page carries coordinates, exact area, bedrooms, build year and the
 * posting date. That difference is what makes the map, the age filter and
 * the date filter work at all.
 *
 * One request per listing. The binding constraint is not the 50-subrequest
 * ceiling but the free plan's 10 ms of CPU per cron invocation: parsing and
 * reading one detail payload costs roughly 0.4 ms, so a batch of 45 ran out
 * of CPU after about seven listings and was killed with exceededCpu every
 * single minute. Twelve per run fits, with room to spare.
 *
 * Set PER_RUN as a var in wrangler.toml to tune it without editing this file.
 *
 * Throughput past that is a matter of more invocations, not a faster one:
 * each Worker gets its own 10 ms. Deploy this file as N workers, each with
 * SHARDS = N and SHARD = 0..N-1, and they divide the table by rowid with no
 * coordination and no overlap. Each keeps its own cursor. The cost is that a
 * shard scans N rows to find one of its own, so D1 rows-read grows roughly
 * N-fold — watch the D1 usage graph after adding one.
 *
 * Divar publishes an approximate position deliberately, usually within a
 * few hundred metres. Good enough for a price map, and the site says so.
 */

const DETAIL = "https://api.divar.ir/v8/posts-v2/web/";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "fa,en;q=0.8",
};

const PER_RUN_DEFAULT = 15;  // CPU-bound on the free plan, not subrequest-bound
const PAUSE_MS = 250;
const LAT = [24, 40.5];      // Iran's bounding box
const LNG = [43, 64];
const LISTING_LIFETIME_DAYS = 28;
const WRAP_EVERY_MS = 6 * 3600000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toInt(v) {
  if (v == null) return null;
  let t = String(v);
  FA_DIGIT.lastIndex = 0;
  if (FA_DIGIT.test(t)) {
    FA_DIGIT.lastIndex = 0;
    t = t.replace(FA_DIGIT, (c) => {
      const n = c.charCodeAt(0);
      return String(n >= FA_BASE ? n - FA_BASE : n - AR_BASE);
    });
  }
  const d = t.replace(/\D/g, "");
  return d ? parseInt(d, 10) : null;
}

const FA_DIGIT = /[۰-۹٠-٩]/g;
const FA_BASE = "۰".charCodeAt(0), AR_BASE = "٠".charCodeAt(0);

const LABELS = {
  "متراژ": "area", "زیربنا": "area", "مساحت": "area",
  "اتاق": "rooms", "تعداد اتاق": "rooms", "اتاق خواب": "rooms",
  "ساخت": "year", "سال ساخت": "year",
  "طبقه": "floor", "پارکینگ": "parking", "انباری": "storage",
  "آسانسور": "lift",
};
const LABEL_KEYS = Object.keys(LABELS);

const AGE_RE = /(?:(\d+)\s*)?(لحظاتی|دقیقه|ساعت|روز|هفته|ماه)\s*پیش/;
const ADDR_RE = /پیش\s+در\s+(.{3,80})$/;
const AGE_DAYS = { "لحظاتی": 0, "دقیقه": 0, "ساعت": 0,
                   "روز": 1, "هفته": 7, "ماه": 30 };

/**
 * Coordinates, attributes and the posting date in a single traversal.
 *
 * These were three functions, each calling a generic walk() that ran
 * Object.entries() or Object.values() at every node — three full passes over
 * a thousand-node tree per listing, allocating a throwaway array at each
 * node. That was most of the CPU the worker spent, and what pushed it past
 * the free plan's 10 ms limit.
 *
 * One pass, for..in instead of Object.entries, and every own key of a node
 * examined before descending — that last part matters, because each field
 * keeps the first match found and changing the visit order would change
 * which value wins. Verified against the three-pass version on generated
 * payloads: identical output, about 2.5x faster.
 */
/* A neighbourhood from the address line, for listings Divar gives none.
 *
 * The Tabriz investigation ended here: web_info for those listings holds
 * exactly {title, city_persian}. There is no district field under any name —
 * Divar simply does not publish one, so no amount of looking in the scraper
 * would ever have found it.
 *
 * The date line does carry a location though: "۲ هفته پیش در تبریز، ولیعصر،
 * خیابان لطفی". The first part is the city and the second is usually the
 * neighbourhood — but not always the property's. Plenty of listings are
 * posted by a بنگاه, and then it is the agency's address, which may be a
 * different neighbourhood or a different city altogether.
 *
 * So a candidate is only accepted when that city already has a neighbourhood
 * of that name, learned from the listings where Divar did publish one. An
 * agency in Tehran selling a flat in Karaj contributes nothing, because its
 * district is not a Karaj neighbourhood; street names and free text fail for
 * the same reason. What it cannot catch is a Tehran agency selling elsewhere
 * in Tehran — that name is genuinely a Tehran neighbourhood, just not this
 * property's. That case stays wrong, and it is the reason this only ever
 * fills an empty hood and never overwrites one Divar supplied.
 */
const STREET_WORDS = ["خیابان", "خ ", "کوچه", "بلوار", "بلوار ", "بزرگراه",
                      "اتوبان", "میدان", "جاده", "نبش", "بین ", "پلاک",
                      "فاز ", "متری", "کیلومتر"];
function hoodFromAddress(address, city) {
  if (!address) return null;
  const parts = address.split(/[،,]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;              // city alone says nothing
  const start = parts[0] === city ? 1 : 0;
  const cand = parts[start];
  if (!cand || cand === city) return null;
  if (cand.length < 2 || cand.length > 40) return null;
  // \d does not match ۰-۹, so "۲۰۰ متری طلاب" passed as a neighbourhood.
  // Only a leading number is refused: "منطقه ۵" is a real place, "۲۰۰ متری
  // طلاب" is a road.
  if (/^[\d۰-۹٠-٩]/.test(cand)) return null;
  if (STREET_WORDS.some((w) => cand.startsWith(w))) return null;
  return cand;
}

/* The neighbourhoods a city is known to have.
 *
 * Read from hood_snapshots rather than listings: it holds one row per
 * neighbourhood per day instead of one per listing, so the DISTINCT is a
 * fraction of the rows. Cached in KV for a day because this runs every
 * minute in three workers and D1 reads are the tighter budget. */
async function knownHoods(env, db, city, cache) {
  if (cache.has(city)) return cache.get(city);
  let set = null;
  try {
    const hit = await env.SITE?.get(`hoods:${city}`, { type: "json" });
    if (Array.isArray(hit)) set = new Set(hit);
  } catch (e) { /* cold cache */ }
  if (!set) {
    try {
      const { results } = await db.prepare(
        `SELECT DISTINCT hood FROM hood_snapshots
         WHERE city = ? AND hood IS NOT NULL AND hood <> ''`).bind(city).all();
      set = new Set(results.map((r) => r.hood));
      await env.SITE?.put(`hoods:${city}`, JSON.stringify([...set]),
                          { expirationTtl: 86400 });
    } catch (e) { set = new Set(); }   // no list: accept nothing, change nothing
  }
  cache.set(city, set);
  return set;
}

function extract(blob) {
  let lat = null, lng = null, rawText = null, address = null, expires = null;
  const pairs = {};

  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) visit(node[i]);
      return;
    }
    for (const k in node) {
      const v = node[k];
      const t = typeof v;
      if (t === "number") {
        if (lat === null && (k === "latitude" || k === "lat")
            && v > LAT[0] && v < LAT[1]) lat = v;
        else if (lng === null && (k === "longitude" || k === "lng" || k === "lon")
            && v > LNG[0] && v < LNG[1]) lng = v;
      } else if (t === "string") {
        if (rawText === null && v.length < 120 && AGE_RE.test(v)) {
          rawText = v;
          const m = v.trim().match(ADDR_RE);
          if (m) address = m[1].trim();
        }
        if (expires === null && k === "unavailable_after") {
          const c = v.charCodeAt(0);
          if (c >= 48 && c <= 57) expires = v;
        }
      }
    }
    const nt = node.title;
    if (typeof nt === "string") {
      const nv = node.value, vt = typeof nv;
      if (vt === "string" || vt === "number") pairs[nt.trim()] = nv;
    }
    const items = node.items;
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it && typeof it.title === "string" && it.value != null)
          pairs[it.title.trim()] = it.value;
      }
    }
    for (const k in node) visit(node[k]);
  };
  visit(blob);

  const out = {};
  for (const label in pairs) {
    for (let i = 0; i < LABEL_KEYS.length; i++) {
      const needle = LABEL_KEYS[i];
      if (label.indexOf(needle) !== -1) {
        const key = LABELS[needle];
        if (out[key] === undefined) out[key] = pairs[label];
      }
    }
  }

  let year = toInt(out.year);
  if (year != null && (year < 1250 || year > 1500)) year = null;   // a floor number
  let area = toInt(out.area);
  if (area != null && (area < 15 || area > 2000)) area = null;
  let rooms = toInt(out.rooms);
  if (out.rooms && String(out.rooms).indexOf("بدون") !== -1) rooms = 0;
  if (rooms != null && rooms > 10) rooms = null;

  const yes = (v) => v == null ? null
    : (/ندارد|بدون/.test(String(v)) ? 0 : 1);

  // Two independent signals. The expiry timestamp is precise; the relative
  // text is coarse but always present, so it is the fallback.
  let posted = null;
  if (expires) {
    const exp = new Date(expires.split(".")[0] + "Z");
    if (!isNaN(exp)) posted = new Date(exp.getTime() -
      LISTING_LIFETIME_DAYS * 864e5).toISOString().slice(0, 10);
  }
  if (posted === null && rawText) {
    const m = rawText.match(AGE_RE);
    if (m) {
      const n = toInt(m[1]) ?? (m[2] === "لحظاتی" ? 0 : 1);
      posted = new Date(Date.now() - n * (AGE_DAYS[m[2]] ?? 1) * 864e5)
        .toISOString().slice(0, 10);
    }
  }

  return { lat, lng, posted, address,
    f: { area, rooms, year, floor: out.floor,
         parking: yes(out.parking), lift: yes(out.lift), pairs } };
}

/* ── features, ported from build.py ─────────────────────────────────── */

const FEATURES = {
  "نوساز": ["نوساز", "کلید نخورده", "کلیدنخورده"],
  "پارکینگ": ["پارکینگ", "پارکینك", "پارکنیگ"],
  "آسانسور": ["آسانسور"],
  "انباری": ["انباری"],
  "بالکن": ["بالکن", "تراس"],
  "بازسازی": ["بازسازی"],
  "تک‌واحدی": ["تک واحدی", "تکواحدی", "تک‌واحدی"],
  "سند": ["سند تک برگ", "تک‌برگ", "ششدانگ", "شش دانگ"],
  "وام": ["وام"],
  "فول": ["فول امکانات", "فول"],
};
const NEGATIVE = ["ندارد", "بدون", "فاقد"];

function extractFeatures(text, parking, lift) {
  const out = [];
  for (const [label, words] of Object.entries(FEATURES)) {
    for (const w of words) {
      const i = text.indexOf(w);
      if (i === -1) continue;
      const before = text.slice(Math.max(0, i - 12), i);
      if (NEGATIVE.some((n) => before.includes(n))) continue;
      out.push(label);
      break;
    }
  }
  // the structured attribute beats any guess from the text
  if (parking === 1 && !out.includes("پارکینگ")) out.push("پارکینگ");
  if (parking === 0) { const i = out.indexOf("پارکینگ"); if (i > -1) out.splice(i, 1); }
  if (lift === 1 && !out.includes("آسانسور")) out.push("آسانسور");
  if (lift === 0) { const i = out.indexOf("آسانسور"); if (i > -1) out.splice(i, 1); }
  return out;
}

/* ── one chunk ──────────────────────────────────────────────────────── */

export async function enrichChunk(env) {
  const db = env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const PER_RUN = Number(env.PER_RUN) || PER_RUN_DEFAULT;
  const hoodCache = new Map();   // city -> known neighbourhoods, for this run

  const SHARDS = Math.max(1, Math.trunc(Number(env.SHARDS)) || 1);
  const SHARD = Math.min(SHARDS - 1, Math.max(0, Math.trunc(Number(env.SHARD)) || 0));
  // both are integers by construction above, so this cannot carry injection
  const shardSql = SHARDS > 1 ? ` AND rowid % ${SHARDS} = ${SHARD}` : "";
  const cursorKey = SHARDS > 1 ? `enrich:cursor:${SHARD}` : "enrich:cursor";

  /* Knowing there is nothing to do, without looking for it.
   *
   * enriched_at has no index — deliberately, because indexing it would make
   * every enrichment cost two row writes instead of one. The price is that
   * finding unenriched rows is a table scan, and a scan that finds nothing
   * scans everything. Once the backlog is cleared, the old code scanned all
   * 158,000 rows twice a minute in every shard and found nothing: over a
   * billion rows read a day against an allowance of five million. Catching
   * up would have taken D1 down, and the scraper and the build with it.
   *
   * rowid only ever increases, so the largest one is a watermark. If the
   * sweep has already passed it, no listing has been added since and there
   * is provably nothing new — no scan required, one row read to prove it.
   * An empty forward scan jumps the cursor to the watermark so the same
   * tail is not walked again next minute.
   *
   * Rows left behind below the cursor are picked up by a full sweep every
   * six hours rather than every minute. */
  let cursor = 0, lastWrap = 0;
  try {
    const c = await env.SITE?.get(cursorKey, { type: "json" });
    if (c && Number.isFinite(c.rowid)) cursor = c.rowid;
    if (c && Number.isFinite(c.wrapAt)) lastWrap = c.wrapAt;
  } catch (e) { /* start from the beginning */ }

  const top = await db.prepare("SELECT MAX(rowid) AS m FROM listings").first();
  const watermark = (top && top.m) || 0;

  const saveCursor = async (rowid) => {
    try {
      await env.SITE?.put(cursorKey, JSON.stringify({ rowid, wrapAt: lastWrap }),
                          { expirationTtl: 86400 });
    } catch (e) { /* a lost cursor only means starting the sweep again */ }
  };

  let results = [];
  if (watermark > cursor) {
    ({ results } = await db.prepare(`
      SELECT rowid AS rid, source_id, title, raw_text, city
      FROM listings
      WHERE rowid > ? AND enriched_at IS NULL AND COALESCE(enrich_tries, 0) < 3
        ${shardSql}
      ORDER BY rowid
      LIMIT ?`).bind(cursor, PER_RUN).all());

    // nothing unenriched above the cursor: skip the whole tail next time
    if (!results.length) { cursor = watermark; await saveCursor(cursor); }
  }

  // stragglers below the cursor, on a slow cadence rather than every minute
  if (!results.length && Date.now() - lastWrap >= WRAP_EVERY_MS) {
    lastWrap = Date.now();
    cursor = 0;
    ({ results } = await db.prepare(`
      SELECT rowid AS rid, source_id, title, raw_text, city
      FROM listings
      WHERE enriched_at IS NULL AND COALESCE(enrich_tries, 0) < 3
        ${shardSql}
      ORDER BY rowid
      LIMIT ?`).bind(PER_RUN).all());
    if (!results.length) { cursor = watermark; }
    await saveCursor(cursor);
  }

  if (!results.length) {
    return { log: ["nothing new to enrich"], done: 0, idle: true };
  }

  const stmts = [];
  /* A cursor sweeping the table, instead of an indexed queue.
   *
   * The queue used to be "enriched_at IS NULL ORDER BY scraped_at", which
   * needs an index on enriched_at. That index is what made every enrichment
   * cost two rows written rather than one — the table row, plus the index
   * row. At 32,400 enrichments a day that is 32,400 wasted writes.
   *
   * A cursor costs nothing. It remembers the last rowid it reached, asks for
   * the next 45 unenriched rows after it, and starts again from the
   * beginning when it runs off the end. rowid is SQLite's own ordering, so
   * no index is needed and none has to be maintained.
   *
   * It also fixes the starvation for free: a sweep passes over every listing
   * in turn, so Mashhad's week-old rows are reached on the same pass as
   * yesterday's. There is no back of the queue to be stuck at.
   */
  let coords = 0, dated = 0, failed = 0;

  /* Divar refuses roughly a quarter of detail requests — rate limiting, or a
   * listing pulled between the scrape and now. A refusal used to leave the
   * row exactly as it was: enriched_at still null, scraped_at unchanged. The
   * queue takes the newest first, so those same rows came back to the top on
   * the very next run, failed again, and never moved. A city whose listings
   * mostly refuse would stall permanently — which is what Mashhad has been
   * doing, at 480 coordinates from 10,904 listings.
   *
   * Each failure is now counted, and after three the row is passed over so
   * the rest of the queue can move. Nothing is deleted; a later pass can
   * reset the counter if it is worth another attempt. */
  const giveUp = [];

  for (const row of results) {
    let blob;
    try {
      const res = await fetch(DETAIL + row.source_id, { headers: HEADERS });
      if (res.status === 404 || res.status === 410) {
        // the listing is gone; mark it so it is not retried forever
        stmts.push(db.prepare(
          "UPDATE listings SET enriched_at=? WHERE source='divar' AND source_id=?")
          .bind(today, row.source_id));
        continue;
      }
      if (!res.ok) { failed++; giveUp.push(row.source_id); continue; }
      blob = await res.json();
    } catch (e) {
      failed++;
      giveUp.push(row.source_id);
      continue;
    }

    const { lat, lng, posted, address, f } = extract(blob);
    if (lat) coords++;
    if (posted) dated++;

    const featText = [row.raw_text || "", row.title || "",
                      Object.entries(f.pairs).map(([k, v]) => `${k} ${v}`).join(" ")]
                     .join(" ");
    const feats = extractFeatures(featText, f.parking, f.lift);

    let derivedHood = hoodFromAddress(address, row.city);
    if (derivedHood) {
      const known = await knownHoods(env, db, row.city, hoodCache);
      if (!known.has(derivedHood)) derivedHood = null;
    }

    stmts.push(db.prepare(`
      UPDATE listings SET
        hood = CASE WHEN hood IS NULL OR hood = '' THEN COALESCE(?, hood)
                    ELSE hood END,
        lat = COALESCE(?, lat),
        lng = COALESCE(?, lng),
        area_m2 = COALESCE(?, area_m2),
        price_m2 = CASE WHEN ? IS NOT NULL AND price_toman IS NOT NULL
                        THEN CAST(price_toman / ? AS INTEGER) ELSE price_m2 END,
        rooms = COALESCE(?, rooms),
        age_years = COALESCE(?, age_years),
        posted_at = COALESCE(?, posted_at),
        address = COALESCE(?, address),
        features = ?,
        enriched_at = ?
      WHERE source = 'divar' AND source_id = ?`)
      .bind(derivedHood, lat, lng, f.area, f.area, f.area, f.rooms,
            f.year ? Math.max(0, 1405 - f.year) : null,
            posted, address ? address.slice(0, 80) : null,
            feats.join(",") || null, today, row.source_id));

    await sleep(PAUSE_MS);
  }

  for (const id of giveUp) {
    stmts.push(db.prepare(
      "UPDATE listings SET enrich_tries = COALESCE(enrich_tries,0) + 1 " +
      "WHERE source='divar' AND source_id=?").bind(id));
  }

  if (stmts.length) await db.batch(stmts);

  // remember where the sweep reached
  await saveCursor(results.length ? results[results.length - 1].rid : cursor);

  /* There used to be a COUNT of the remaining queue here, with a comment
   * claiming the index made it cheap. It does not. An index makes a lookup
   * cheap; a count still reads every matching entry — 59,000 of them, every
   * two minutes, which is 42 million reads a day against an allowance of
   * five million. It exhausted the budget about two hours into every day and
   * then stopped the scraper, the build and everything else with it.
   *
   * The remaining count is a progress figure, not something the work depends
   * on. It is kept in KV and adjusted by what each run actually did, and
   * recounted every six hours so it cannot drift far — four full counts a
   * day instead of seven hundred and twenty. */
  let remaining = null;
  try {
    if (SHARD !== 0) throw 0;   // one shard keeps the shared counter
    const c = await env.SITE?.get("enrich:remaining", { type: "json" });
    const stale = !c || Date.now() - c.at > 6 * 3600000;
    if (stale) {
      const left = await db.prepare(
        "SELECT COUNT(*) n FROM listings WHERE enriched_at IS NULL").first();
      remaining = left.n;
    } else {
      remaining = Math.max(0, c.n - results.length);
    }
    await env.SITE?.put("enrich:remaining",
      JSON.stringify({ n: remaining, at: stale ? Date.now() : c.at }),
      { expirationTtl: 86400 });
  } catch (e) { /* the count is a nicety; never let it stop the work */ }

  return {
    log: [`${results.length} fetched from rowid ${cursor} ` +
          `· ${coords} with coordinates · ` +
          `${dated} with a date · ${failed} failed` +
          (remaining === null ? "" : ` · ${remaining} still to do`)],
    done: results.length, coords, failed, remaining,
  };
}


/* Counting rows costs one read per row, so a status page that scans the whole
   listings table costs about 113,000 reads every time it is opened. Checking
   on progress a dozen times in a day was quietly spending half the daily
   allowance — which is what exhausted it on 4 September.
   The counts are cached for ten minutes. They are a progress indicator, not a
   live reading, and a ten-minute-old number answers the question just as well.
   Add ?fresh=1 to force a live count when it actually matters. */
async function cachedStatus(env, key, compute, ttlMs = 600000, fresh = false) {
  if (!fresh) {
    try {
      const hit = await env.SITE?.get(key, { type: "json" });
      if (hit && Date.now() - hit.at < ttlMs)
        return { ...hit.v, as_of: new Date(hit.at).toISOString(), cached: true };
    } catch (e) { /* no cache available; fall through */ }
  }
  const v = await compute();
  try {
    await env.SITE?.put(key, JSON.stringify({ at: Date.now(), v }),
                        { expirationTtl: 3600 });
  } catch (e) { /* caching is best effort */ }
  return { ...v, as_of: new Date().toISOString(), cached: false };
}


/* The daily read and write limits are a normal condition, not a fault. When
 * one is reached every query fails, wherever it happens to be — the stack
 * then points at whichever line ran first, which is misleading when looking
 * for the cause. Recognising it here means the worker stops quietly and
 * resumes by itself at midnight UTC, instead of throwing every few minutes
 * and leaving a trail of errors that look like bugs. */
function isLimitError(e) {
  return /exceeded .*(daily|limit)/i.test(String(e && e.message));
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(enrichChunk(env)
      .then((r) => console.log(r.log.join("\n")))
      .catch((e) => {
        if (isLimitError(e)) {
          console.log("daily limit reached; skipping until it resets at midnight UTC");
          return;
        }
        throw e;
      }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") return json(await enrichChunk(env));
    if (url.pathname === "/status") {
      const fresh = url.searchParams.get("fresh") === "1";
      const out = await cachedStatus(env, "status:enrich", async () => {
        const s = await env.DB.prepare(`
          SELECT COUNT(*) total,
                 SUM(enriched_at IS NOT NULL) enriched,
                 SUM(lat IS NOT NULL) with_coords,
                 SUM(age_years IS NOT NULL) with_age,
                 SUM(posted_at IS NOT NULL) with_date
          FROM listings WHERE source='divar'`).first();
        const perCity = await env.DB.prepare(`
          SELECT city, COUNT(*) n, SUM(lat IS NOT NULL) coords
          FROM listings WHERE source='divar'
          GROUP BY city ORDER BY n DESC LIMIT 12`).all();
        return { ...s, perCity: perCity.results };
      }, 600000, fresh);
      return json(out);
    }
    return json({ routes: ["/run — enrich one chunk now", "/status"] });
  },
};

function json(o) {
  return new Response(JSON.stringify(o, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
