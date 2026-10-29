const API = "https://www.sheypoor.com/api/v10.0.0";
const SITE = "https://www.sheypoor.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
  Referer: SITE + "/",
  Origin: SITE,
};

const CATS = [
  { id: 43604, kind: null },
  { id: 44586, kind: "villa" },
  { id: 44099, kind: "land" },
];

const CITY_NAMES = ["تهران","مشهد","اصفهان","کرج","شیراز","تبریز","قم","اهواز",
  "کرمانشاه","ارومیه","رشت","زاهدان","همدان","کرمان","یزد","اردبیل",
  "بندرعباس","اراک","اسلامشهر","زنجان","سنندج","قزوین","خرم آباد","گرگان",
  "ساری","شهریار","قدس","کاشان","دزفول","بابل","ملارد","سبزوار","آمل",
  "نیشابور","بجنورد","ورامین","پاکدشت","بوشهر","بیرجند","سیرجان","بروجرد",
  "ایلام","مرودشت","شهرکرد","خوی","مراغه","سقز","رفسنجان","لاهیجان","یاسوج",
  "اندیشه","هشتگرد","فردیس","پردیس","پرند","نظرآباد","محمدشهر","صالحیه",
  "قرچک","بومهن","رودهن","تهراندشت","کردان","سهیلیه","چهارباغ","ماهدشت",
  "کمال‌شهر","مشکین‌دشت","گرمدره","آسارا","طالقان"];

const A_AREA = "68085", A_LAND = "69317", A_TYPE = ["68094", "68096"], A_ROOMS = "68133", A_YEAR = "92368";
const PAGES_PER_RUN_DEFAULT = 25, MAX_PAGES_DEFAULT = 80, PAUSE_MS_DEFAULT = 1000, RECHECK_DEFAULT = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹", AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function normalizeText(s) {
  if (!s) return "";
  let t = String(s);
  for (let i = 0; i < 10; i++) {
    t = t.split(FA_DIGITS[i]).join(String(i));
    t = t.split(AR_DIGITS[i]).join(String(i));
  }
  return t.replace(/ك/g, "ک").replace(/[يئ]/g, "ی").replace(/ة/g, "ه")
    .replace(/[أإآ]/g, "ا").replace(/ؤ/g, "و").replace(/ـ/g, "")
    .replace(/‌/g, " ").replace(/[‎‏﻿]/g, "")
    .replace(/[،؛]/g, " ").replace(/\s+/g, " ").trim();
}

function canonicalPlace(name) {
  let t = normalizeText(name).replace(/آ/g, "ا").replace(/ۀ/g, "ه");
  for (const f of ["محله ", "منطقه ", "شهرک ", "بلوار ", "خیابان ", "میدان "]) {
    if (t.startsWith(f)) t = t.slice(f.length);
  }
  return t.replace(/[\s\-_.]/g, "");
}

function roundSig(x, sig = 3) {
  if (!x) return 0;
  const d = Math.ceil(Math.log10(Math.abs(x)));
  const p = sig - d;
  return Math.round(x * 10 ** p) / 10 ** p;
}

async function dedupeKey(city, hood, area, amount) {
  const raw = `${canonicalPlace(city)}|${canonicalPlace(hood)}|` +
              `${area ? Math.round(area) : 0}|${amount ? roundSig(amount) : 0}`;
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

const num = (v) => {
  const m = normalizeText(String(v ?? "").replace(/٫/g, ".")).replace(/(?<=\d)\/(?=\d)/g, ".")
    .replace(/[,٬\s]/g, "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

function pickPrice(prices) {
  const list = Array.isArray(prices) ? prices : [];
  const sale = list.filter((p) => !/رهن|اجاره|ودیعه|متری|هر متر/.test(p.label || ""));
  for (const p of sale.length ? sale : []) {
    const t = normalizeText(`${p.amount || ""} ${p.currency || ""}`);
    if (!t || /توافقی|تماس/.test(t)) continue;
    let v = num(p.amount);
    if (!v) continue;
    if (/میلیارد/.test(t)) v *= 1e9; else if (/میلیون/.test(t)) v *= 1e6;
    if (/ریال/.test(t)) v /= 10;
    if (v >= 1e7) return Math.round(v);
  }
  return null;
}

function attrMap(full) {
  const m = new Map();
  for (const a of Array.isArray(full) ? full : []) {
    const id = String(a.id ?? "");
    if (!id) continue;
    if (!m.has(id)) m.set(id, []);
    m.get(id).push(a.value);
  }
  return m;
}

function jalaliYearNow() {
  const d = new Date();
  const afterNowruz = d.getUTCMonth() > 2 || (d.getUTCMonth() === 2 && d.getUTCDate() >= 21);
  return d.getUTCFullYear() - (afterNowruz ? 621 : 622);
}

function kindOf(item, cat, attrs) {
  const chain = ((item.attributes || {}).categories || []).map((c) => normalizeText(c.name)).join(" ");
  if (/رهن|اجاره|اداری|تجاری|صنعتی|پیش فروش|مشارکت/.test(chain)) return null;
  if (cat.kind) return cat.kind;
  const type = normalizeText(A_TYPE.flatMap((k) => attrs.get(k) || []).join(" "));
  const title = normalizeText((item.attributes || {}).title);
  if (/اپارتمان|آپارتمان/.test(type)) return "apartment";
  if (/ویلا|خانه|منزل|سوئیت/.test(type)) return "villa";
  if (/زمین|کلنگی/.test(type)) return "land";
  if (/ویلا|ویلایی|حیاط ?دار/.test(title)) return "villa";
  return "apartment";
}

function hoodOf(location, city) {
  const parts = String(location || "").split(/[،,]/).map((s) => s.trim()).filter(Boolean);
  const c = canonicalPlace(city);
  let i = -1;
  parts.forEach((p, k) => { if (canonicalPlace(p) === c) i = k; });
  const rest = i >= 0 ? parts.slice(i + 1) : parts.length > 2 ? parts.slice(2) : [];
  const h = rest[0] || "";
  return /مرکز شهر|سایر|همه/.test(h) ? "" : h;
}

function adUrl(title, id) {
  const slug = String(title || "").split(/[^\p{L}\p{N}\u200c]+/u).filter(Boolean).join("-");
  return `${SITE}/v/${slug ? slug + "-" : ""}${id}.html`;
}

function parseItem(item, city, cat, today) {
  if (!item || !["normal", "paidEngagement"].includes(item.type)) return null;
  const a = item.attributes || {};
  const attrs = attrMap(item.fullAttributes || a.attributes);
  const kind = kindOf(item, cat, attrs);
  if (!kind) return null;
  const locParts = String(a.location || "").split(/[،,]/).map((x) => canonicalPlace(x));
  if (!locParts.includes(canonicalPlace(city))) return null;
  const price = pickPrice(a.price);
  if (!price) return null;
  let area = num((kind === "land" && attrs.get(A_LAND)?.[0]) || attrs.get(A_AREA)?.[0]);
  if (area && (area < 15 || area > (kind === "land" ? 100000 : 20000))) area = null;
  const rooms = num(attrs.get(A_ROOMS)?.[0]);
  const year = num(attrs.get(A_YEAR)?.[0]);
  const jy = jalaliYearNow();
  const age = year == null ? null : year < 100 ? Math.round(year) : year > 1300 && year <= jy ? jy - year : null;
  const ts = Array.isArray(item.sort) && Number(item.sort[1]) > 1e12 ? Number(item.sort[1]) : null;
  const posted = ts ? new Date(ts).toISOString().slice(0, 10) : today;
  const geo = item.geo || {};
  const url = adUrl(a.title, item.id);
  return {
    id: String(item.id), kind, city, hood: hoodOf(a.location, city),
    title: String(a.title || "").slice(0, 300), url, price, area,
    price_m2: area ? Math.round(price / area) : null,
    rooms: rooms != null && rooms < 20 ? Math.round(rooms) : null,
    age: age != null && age < 100 ? age : null,
    lat: Number(geo.lat) || null, lng: Number(geo.lon ?? geo.lng) || null,
    address: a.location || null,
    raw: normalizeText(`${a.title || ""} ${item.description || ""}`).slice(0, 2000),
    posted: posted > today ? today : posted,
  };
}

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

async function loadCities(env) {
  const cached = await env.SITE.get("sh:cities", "json").catch(() => null);
  if (cached && cached.length) return cached;
  const j = await getJson(`${API}/general/locations`);
  const want = new Map(CITY_NAMES.map((n) => [canonicalPlace(n), n]));
  const out = [], seen = new Set();
  for (const p of j?.data?.list || []) {
    for (const c of p.cities || []) {
      const name = want.get(canonicalPlace(c.name));
      if (name && !seen.has(name)) { seen.add(name); out.push({ name, slug: c.slug, id: c.cityID }); }
    }
  }
  out.sort((x, y) => CITY_NAMES.indexOf(x.name) - CITY_NAMES.indexOf(y.name));
  if (out.length) await env.SITE.put("sh:cities", JSON.stringify(out), { expirationTtl: 7 * 86400 });
  return out;
}

function searchUrl(slug, cat, page, cursor) {
  const u = new URL(`${API}/search/${slug}`);
  u.searchParams.set("c", cat.id);
  u.searchParams.set("o", "n");
  u.searchParams.set("p", page);
  if (cursor) u.searchParams.set("f", cursor);
  return u.toString();
}

function itemsOf(res) {
  const out = [];
  for (const g of res?.data || []) {
    if (g.type === "listingGroup" || g.type === "vip") out.push(...(g.items || []));
    else out.push(g);
  }
  return out;
}

async function save(db, rows, today) {
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const known = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const { results } = await db.prepare(
      `SELECT source_id, price_toman FROM listings WHERE source='sheypoor' AND source_id IN (${part.map(() => "?").join(",")})`)
      .bind(...part).all();
    for (const r of results) known.set(r.source_id, Number(r.price_toman));
  }
  const stmts = [];
  for (const r of rows) {
    const key = r.area ? await dedupeKey(r.city, r.hood, r.area, r.price) : null;
    const old = known.get(r.id);
    const changed = old != null && old !== r.price;
    if (old == null || changed) {
      stmts.push(db.prepare(
        "INSERT OR REPLACE INTO price_history (source, source_id, day, price_toman) VALUES ('sheypoor',?,?,?)")
        .bind(r.id, today, r.price));
    }
    stmts.push(db.prepare(`
      INSERT INTO listings (source, source_id, city, hood, title, url, price_toman, area_m2, price_m2,
        raw_text, dedupe_key, scraped_at, kind, posted_at, first_posted_at, last_seen, enriched_at,
        rooms, age_years, lat, lng, address)
      VALUES ('sheypoor',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source, source_id) DO UPDATE SET
        city=excluded.city,
        hood=CASE WHEN excluded.hood <> '' THEN excluded.hood ELSE listings.hood END,
        title=excluded.title, url=excluded.url,
        price_toman=excluded.price_toman,
        area_m2=COALESCE(excluded.area_m2, listings.area_m2),
        price_m2=COALESCE(excluded.price_m2, listings.price_m2),
        dedupe_key=COALESCE(excluded.dedupe_key, listings.dedupe_key),
        kind=excluded.kind,
        posted_at=COALESCE(excluded.posted_at, listings.posted_at),
        first_posted_at=COALESCE(listings.first_posted_at, excluded.first_posted_at),
        last_seen=excluded.last_seen, scraped_at=excluded.scraped_at, removed_at=NULL,
        rooms=COALESCE(excluded.rooms, listings.rooms),
        age_years=COALESCE(excluded.age_years, listings.age_years),
        lat=COALESCE(excluded.lat, listings.lat), lng=COALESCE(excluded.lng, listings.lng),
        address=COALESCE(excluded.address, listings.address)${changed ? ",\n        price_changed_at=excluded.last_seen" : ""}`)
      .bind(r.id, r.city, r.hood, r.title, r.url, r.price, r.area, r.price_m2, r.raw, key,
            new Date().toISOString(), r.kind, r.posted, r.posted, today, today,
            r.rooms, r.age, r.lat, r.lng, r.address));
  }
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  return rows.length;
}

async function scrapeChunk(env) {
  const db = env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const perRun = Number(env.PAGES_PER_RUN || PAGES_PER_RUN_DEFAULT);
  const maxPages = Number(env.MAX_PAGES || MAX_PAGES_DEFAULT);
  const pause = Number(env.PAUSE_MS || PAUSE_MS_DEFAULT);
  const cities = await loadCities(env);
  if (!cities.length) return { log: ["no Sheypoor cities matched"] };

  const st = (await env.SITE.get("sh:state", "json").catch(() => null)) || { i: 0, p: 1, f: null };
  const log = [];
  let pages = 0, saved = 0, skipped = 0;

  while (pages < perRun) {
    const pair = st.i % (cities.length * CATS.length);
    const city = cities[Math.floor(pair / CATS.length)], cat = CATS[pair % CATS.length];
    let res;
    try {
      res = await getJson(searchUrl(city.slug, cat, st.p, st.f));
    } catch (e) {
      log.push(`${city.name}/${cat.id} p${st.p}: ${e.message}`);
      if (e.status === 429 || e.status === 403) break;
      st.i++; st.p = 1; st.f = null; pages++;
      continue;
    }
    pages++;
    const items = itemsOf(res);
    const rows = [];
    for (const it of items) {
      const r = parseItem(it, city.name, cat, today);
      if (r) rows.push(r); else if (it.type === "normal" || it.type === "paidEngagement") skipped++;
    }
    saved += await save(db, rows, today);
    const next = res?.meta?.f;
    const normal = items.filter((x) => x.type === "normal").length;
    if (!normal || !next || st.p >= maxPages) {
      log.push(`${city.name}/${cat.id}: done at page ${st.p}`);
      st.i++; st.p = 1; st.f = null;
    } else {
      st.p++; st.f = next;
    }
    await sleep(pause);
  }
  await env.SITE.put("sh:state", JSON.stringify(st));
  const rc = await recheck(env, today);
  log.unshift(`${pages} pages, ${saved} ads saved, ${skipped} skipped (rent/commercial/no price/other city)`, rc);
  return { log };
}

async function recheck(env, today) {
  const db = env.DB;
  const n = Number(env.RECHECK || RECHECK_DEFAULT);
  if (!n) return "recheck off";
  const { results } = await db.prepare(`
    SELECT source_id FROM listings
    WHERE source='sheypoor' AND removed_at IS NULL AND last_seen < ?
    ORDER BY last_seen LIMIT ?`).bind(today, n).all();
  const codes = {}, gone = [], live = [], added = [];
  for (const r of results) {
    let code;
    try {
      const page = await fetch(`${SITE}/v/x-${r.source_id}.html`, { headers: HEADERS, redirect: "manual" });
      code = page.status;
      if (code === 200) {
        live.push(r.source_id);
        const res = await fetch(`${API}/listings/${r.source_id}`, { headers: HEADERS });
        if (res.ok) {
          const j = await res.json().catch(() => null);
          const at = String(j?.data?.attributes?.addedAt || "").slice(0, 10);
          if (/^\d{4}-\d\d-\d\d$/.test(at)) added.push([r.source_id, at]);
        }
      } else if ([301, 302, 303, 307, 308, 404, 410].includes(code)) {
        const loc = page.headers.get("location") || "";
        if (code >= 400 || !loc.includes(r.source_id)) gone.push(r.source_id);
      }
    } catch (e) { code = "err"; }
    codes[code] = (codes[code] || 0) + 1;
    if (code === 429 || code === 403) break;
    await sleep(500);
  }
  const checked = gone.length + live.length;
  if (checked >= 10 && gone.length / checked > 0.8) {
    return `recheck: ${Object.entries(codes).map(([k, v]) => `${k}×${v}`).join(" ")}, ${gone.length} looked removed — too many, not applied`;
  }
  const stmts = [
    ...gone.map((id) => db.prepare("UPDATE listings SET removed_at=? WHERE source='sheypoor' AND source_id=?").bind(today, id)),
    ...live.map((id) => db.prepare("UPDATE listings SET last_seen=? WHERE source='sheypoor' AND source_id=?").bind(today, id)),
    ...added.map(([id, at]) => db.prepare(
      "UPDATE listings SET first_posted_at=CASE WHEN first_posted_at IS NULL OR first_posted_at > ? THEN ? ELSE first_posted_at END WHERE source='sheypoor' AND source_id=?")
      .bind(at, at, id)),
  ];
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  return `recheck: ${Object.entries(codes).map(([k, v]) => `${k}×${v}`).join(" ") || "nothing due"}, removed ${gone.length}`;
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function route(url, env) {
  const today = new Date().toISOString().slice(0, 10);
  if (url.pathname === "/test") {
    const cities = await loadCities(env);
    const city = cities.find((c) => c.name === (url.searchParams.get("city") || "تهران")) || cities[0];
    const cat = CATS.find((c) => String(c.id) === url.searchParams.get("cat")) || CATS[0];
    const u = searchUrl(city.slug, cat, 1, null);
    const res = await getJson(u);
    const items = itemsOf(res);
    return json({
      url: u, cities: cities.length, meta: res.meta,
      types: items.reduce((o, x) => ((o[x.type] = (o[x.type] || 0) + 1), o), {}),
      parsed: items.map((x) => parseItem(x, city.name, cat, today)).filter(Boolean).slice(0, 8)
        .map(({ raw, ...r }) => r),
      first_raw: items.find((x) => x.type === "normal") || null,
    });
  }
  if (url.pathname === "/raw") {
    const id = url.searchParams.get("id") || "";
    const res = await fetch(`${API}/listings/${id}`, { headers: HEADERS, redirect: "manual" });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 1500); }
    const page = await fetch(`${SITE}/v/x-${id}.html`, { headers: HEADERS, redirect: "manual" });
    return json({ api_status: res.status, page_status: page.status, page_redirect: page.headers.get("location"), body });
  }
  if (url.pathname === "/run") return json(await scrapeChunk(env));
  if (url.pathname === "/start") { await env.SITE.put("sh:enabled", "1"); return json({ running: true }); }
  if (url.pathname === "/stop") { await env.SITE.put("sh:enabled", "0"); return json({ running: false }); }
  if (url.pathname === "/recheck") return json({ log: await recheck(env, today) });
  if (url.pathname === "/status") {
    const r = await env.DB.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN removed_at IS NULL THEN 1 ELSE 0 END) AS live,
             SUM(CASE WHEN area_m2 IS NOT NULL THEN 1 ELSE 0 END) AS with_area,
             SUM(CASE WHEN hood <> '' THEN 1 ELSE 0 END) AS with_hood,
             COUNT(DISTINCT city) AS cities
      FROM listings WHERE source='sheypoor'`).first();
    return json({ ...r, running: (await env.SITE.get("sh:enabled")) === "1", state: await env.SITE.get("sh:state", "json") });
  }
  return json({ endpoints: ["/test", "/test?city=مشهد&cat=44099", "/start", "/stop", "/run", "/recheck", "/status"] });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if ((await env.SITE.get("sh:enabled")) !== "1") return console.log("paused — open /start to begin");
      const r = await scrapeChunk(env);
      console.log(r.log.join("\n"));
    })());
  },
  async fetch(request, env) {
    try {
      return await route(new URL(request.url), env);
    } catch (err) {
      return json({ error: `${err.name}: ${err.message}` }, 500);
    }
  },
};
