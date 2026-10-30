/**
 * scrape.js — the scraper, as a scheduled Worker.
 *
 * Replaces run_all.py. The difference that shapes everything: a Worker may
 * make at most 50 outbound requests per invocation, and Tehran alone runs to
 * 210 pages. So instead of one long loop, a cron fires every few minutes,
 * takes the next chunk of pages for whichever city is furthest behind, and
 * writes down where it stopped. Over a day that covers all 57 cities.
 *
 * State lives in the scrape_state table, so an invocation that fails or is
 * cut short costs one chunk, not a city.
 */

const ENDPOINT = "https://api.divar.ir/v8/postlist/w/search";
const CITIES_URL = "https://api.divar.ir/v8/places/cities";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Content-Type": "application/json",
  Accept: "application/json",
  "Accept-Language": "fa,en;q=0.8",
};

// Divar's own limit is around 210 pages per city; there is no point asking
// for more. 40 leaves room under the 50-subrequest ceiling for the writes.
const PAGES_PER_RUN_DEFAULT = 40;
const MAX_PAGES_PER_CITY = 215;
const PAUSE_MS_DEFAULT = 400;

/* Price bands, in toman.
 *
 * Divar stops paging at ~215 pages, so one search reaches about 5,600
 * listings however long it runs — Tehran alone has 177,125 apartments, and
 * the database sat at 12% of the city because of it. Each search gets its
 * own allowance, so asking twelve narrower questions reaches roughly twelve
 * times as far.
 *
 * Narrow where the listings are. Most of the market is under 20bn, so the
 * bands are tight there and widen above it; the top band is open-ended
 * because the handful of 200bn listings do not need their own slice.
 * If one band still hits 215 pages in a city, that band needs splitting —
 * the run log says which. */
/* Titles that name a different town.
 *
 * A بنگاه posts from its own address, so Divar files the listing where the
 * agency is, not where the property is. One agency in عظیمیه had اندیشه and
 * شهرجدیدهشتگرد flats filed under کرج — five of eight rows on one screen —
 * and every one of them was pulling عظیمیه's median toward a different town.
 *
 * The title is the honest source: sellers write the real location there. So
 * when a title names another known town, the listing moves to it and its
 * neighbourhood is cleared, because the neighbourhood was the agency's too.
 *
 * Only names of five characters or more are matched. Persian titles run
 * words together — "فروش64متراندیشه" has no space before اندیشه — so the
 * match cannot require a word boundary, and without one a short name like قم
 * or آمل would fire inside کامل, شامل, بابلسر and a hundred other words.
 * Five characters is long enough that a false match is unlikely. */
/* The cities scraped, in population order — also the list a title is checked
 * against when a listing looks mislocated.
 *
 * The new towns around Tehran and Karaj are here because that is exactly
 * where the agency-address problem showed up: اندیشه and هشتگرد flats filed
 * under کرج. They are real towns with their own markets, so they are worth
 * scraping in their own right as well. */
const CITY_NAMES = ["تهران","مشهد","اصفهان","کرج","شیراز","تبریز","قم","اهواز",
  "کرمانشاه","ارومیه","رشت","زاهدان","همدان","کرمان","یزد","اردبیل",
  "بندرعباس","اراک","اسلامشهر","زنجان","سنندج","قزوین","خرم آباد","گرگان",
  "ساری","شهریار","قدس","کاشان","دزفول","بابل","ملارد","سبزوار","آمل",
  "نیشابور","بجنورد","ورامین","پاکدشت","بوشهر","بیرجند","سیرجان","بروجرد",
  "ایلام","مرودشت","شهرکرد","خوی","مراغه","سقز","رفسنجان","لاهیجان","یاسوج",
  "اندیشه","هشتگرد","فردیس","پردیس","پرند","نظرآباد","محمدشهر","صالحیه",
  "قرچک","بومهن","رودهن","شهرجدیدهشتگرد",
  // Alborz villages that turn up constantly in Karaj and Tehran titles
  "تهراندشت","کردان","سهیلیه","چهارباغ","ماهدشت","کمال‌شهر","مشکین‌دشت",
  "شهرک وحدت","گرمدره","آسارا","طالقان"];

const EXTRA_CITIES = ["نجف‌آباد","قائم‌شهر","خمینی‌شهر","شاهین‌شهر","ملایر","سمنان","شاهرود",
  "گنبد کاووس","ساوه","آبادان","بندر ماهشهر","بهبهان","اندیمشک","جهرم","کازرون","فسا",
  "مهاباد","بوکان","میاندوآب","مرند","میانه","مریوان","بانه","تربت حیدریه","قوچان",
  "کاشمر","زابل","چابهار","بم","جیرفت","نوشهر","چالوس","تنکابن","بهشهر","بندر انزلی",
  "لنگرود","دماوند","رباط کریم","کیش","شهرضا"];

/* What a plot advert says about itself.
 *
 * Divar rejects every name tried for the land category but accepts the
 * parent, which returns apartments, villas and plots together. Sorting them
 * by each post's own category slug failed — the posts carry none — and
 * treating "unrecognised" as land filled the land tab with flats.
 *
 * So the title decides, and it has to say so positively. A plot advert names
 * itself: زمین, کلنگی, باغ, قواره, عرصه. A post that says none of those is
 * not kept, whatever else it is. The second list rejects the obvious
 * not-land even when a land word appears, so "آپارتمان نزدیک باغ" is left
 * alone.
 *
 * Being strict costs coverage — a plot advertised without any of these words
 * is missed — and that is the right trade. A missing plot is a gap; an
 * apartment filed as a plot is a wrong median. */
const LAND_WORDS = ["زمین", "کلنگی", "قواره", "عرصه", "باغ", "باغچه",
                    "زمین مسکونی", "محوطه", "پلاک ثبتی", "مزروعی"];
/* Words that describe a building, so the advert is not a plot. A plot has
   no bedrooms, no parking space and no lift, and nobody calls bare land
   نوساز. These kept arriving under زمین و کلنگی. */
const NOT_LAND_WORDS = ["آپارتمان", "واحد", "طبقه", "ویلا", "دوبلکس",
                        "پنت هاوس", "پنت‌هاوس", "سوئیت", "مغازه", "دفتر",
                        "خواب", "پارکینگ", "نوساز", "آسانسور", "انباری",
                        "تکواحدی", "تک واحدی", "فول", "بازسازی", "مشاعات",
                        "کلیدنخورده", "کلید نخورده", "صفر"];
/* Phrases that mean land whatever else the title says. A plot sold for
   building a garden villa names the villa — "۱۰۰۰متر حصارشده برای ساخت باغ
   ویلا" is land, and the word ویلا would otherwise reject it. */
const LAND_ANYWAY = ["برای ساخت", "قابل ساخت", "جهت ساخت", "حصارشده",
                     "حصار شده", "کلنگی", "قواره", "زمین مسکونی",
                     "مجوز ساخت", "پروانه ساخت"];
function titleSaysLand(title) {
  if (!title) return false;
  const t = normalizeText(title);
  if (LAND_ANYWAY.some((w) => t.includes(normalizeText(w)))) return true;
  if (NOT_LAND_WORDS.some((w) => t.includes(normalizeText(w)))) return false;
  return LAND_WORDS.some((w) => t.includes(normalizeText(w)));
}

/* The neighbourhood named in the title beats the one Divar filed it under.
 *
 * Same problem as the city, one level down. An agency in گوهردشت posts a
 * flat whose title reads "۴۰۰ متر ویلا باغ تهراندشت" and Divar files it in
 * گوهردشت, because that is where the agency is. Both are in Karaj, so the
 * city rule never fires and the neighbourhood stays wrong.
 *
 * Only a name the city is already known to have is accepted, learned from
 * the listings where Divar did supply one. An invented word, a street name
 * or a neighbourhood of some other city all fail that test — names repeat
 * across cities, so a match is only trusted inside the city being scraped.
 *
 * Five characters again: titles run words together, so the match cannot
 * require a boundary, and a short name would fire inside ordinary words. */
const HOOD_MIN_LEN = 5;
function hoodFromTitle(title, knownHoods) {
  if (!title || !knownHoods || !knownHoods.size) return null;
  const t = normalizeText(title);
  let best = null;
  for (const h of knownHoods) {
    if (!h || h.replace(/\s/g, "").length < HOOD_MIN_LEN) continue;
    if (!t.includes(normalizeText(h))) continue;
    // the longest match wins: "شهرک غرب" over "غرب"
    if (!best || h.length > best.length) best = h;
  }
  return best;
}

// a Persian letter, or the zero-width non-joiner that glues one word together
const PERSIAN_LETTER = /[\u0620-\u064A\u066E-\u06D3\u06FA-\u06FF\u200C]/;

/* A city name used as a road name is not a location.
 *
 * Most Iranian cities have a خیابان تهران or a جاده تهران, and an Isfahan
 * plot whose title mentions one was relocated to Tehran — then plotted at its
 * real Isfahan coordinates, a dot on its own hundreds of kilometres from the
 * rest. If one of these words comes immediately before the name, the name is
 * describing a road. */
const ROAD_WORDS = ["خیابان", "خ ", "جاده", "بلوار", "اتوبان", "بزرگراه",
                    "کمربندی", "میدان", "پل ", "ترمینال", "مسیر", "سمت",
                    "نزدیک", "حوالی", "راه "];
const RELOCATE_MIN_LEN = 5;
let RELOCATE = null;
function relocateTarget(title, currentCity, localHoods) {
  if (!title) return null;
  if (!RELOCATE) {
    RELOCATE = CITY_NAMES.filter((n) => n.replace(/\s/g, "").length >= RELOCATE_MIN_LEN);
  }
  const t = normalizeText(title);
  /* The longest match wins, and a match that runs into more letters is not a
     match at all.
     تهراندشت contains تهران, so plots in تهراندشت — an Alborz village — were
     relocated to Tehran and plotted on Tehran's map. تهرانپارس and کرجی would
     do the same. A trailing Persian letter means the word carries on, so it
     is a different place. Letters before the name are fine: Persian titles
     run words together, and "فروش64متراندیشه" is genuinely اندیشه. */
  let best = null;
  for (const name of RELOCATE) {
    if (name === currentCity) continue;
    /* A town that is also a neighbourhood here is the neighbourhood. Tehran
       has its own اندیشه, so "۹۰ متری اندیشه" in a Tehran listing means that
       district, not the town of Andisheh 30 km away — and the town had grown
       from 11 listings to 13,484 by being handed Tehran's. */
    if (localHoods && localHoods.has(name)) continue;
    const n = normalizeText(name);
    let i = t.indexOf(n);
    while (i !== -1) {
      const after = t[i + n.length];
      const before = t.slice(Math.max(0, i - 14), i);
      const isRoad = ROAD_WORDS.some((w) => before.includes(normalizeText(w)));
      if (!isRoad && (after === undefined || !PERSIAN_LETTER.test(after))) {
        if (!best || name.length > best.length) best = name;
        break;
      }
      i = t.indexOf(n, i + 1);
    }
  }
  return best;
}

const BANDS = [
  [0, 1e9], [1e9, 2e9], [2e9, 3e9], [3e9, 4e9],
  [4e9, 6e9], [6e9, 8e9], [8e9, 12e9], [12e9, 18e9],
  [18e9, 30e9], [30e9, 50e9], [50e9, 100e9], [100e9, null],
];
/* Finer bands for the cities that fill the coarse ones.
 *
 * Twelve bands at about 5,600 listings each cap a city near 67,000. Tehran
 * reached 59,000 against Divar's 177,125 — its bands were nearly all full,
 * and everything past page 215 in each was out of reach. Thirty-six narrower
 * bands lift the ceiling to around 200,000.
 *
 * Only the four big markets get them. A town with a few thousand listings
 * never fills a coarse band, and giving it thirty-six would spend thirty-six
 * runs where twelve already reach everything.
 *
 * Tight where the listings are: most of Tehran sells between 5 and 40bn. */
const FINE_BANDS = [
  [0, 1.5e9], [1.5e9, 2.5e9], [2.5e9, 3.5e9], [3.5e9, 4.5e9], [4.5e9, 5.5e9],
  [5.5e9, 6.5e9], [6.5e9, 7.5e9], [7.5e9, 8.5e9], [8.5e9, 9.5e9], [9.5e9, 10.5e9],
  [10.5e9, 11.5e9], [11.5e9, 12.5e9], [12.5e9, 13.5e9], [13.5e9, 14.5e9],
  [14.5e9, 15.5e9], [15.5e9, 16.5e9], [16.5e9, 17.5e9], [17.5e9, 18.5e9],
  [18.5e9, 20e9], [20e9, 22e9], [22e9, 24e9], [24e9, 26e9], [26e9, 28e9],
  [28e9, 30e9], [30e9, 33e9], [33e9, 36e9], [36e9, 40e9], [40e9, 45e9],
  [45e9, 50e9], [50e9, 60e9], [60e9, 75e9], [75e9, 90e9], [90e9, 110e9],
  [110e9, 140e9], [140e9, 200e9], [200e9, null],
];
const BIG_CITIES = new Set(["تهران", "مشهد", "کرج", "اصفهان"]);
const bandsFor = (city) => (BIG_CITIES.has(city) ? FINE_BANDS : BANDS);

/* A band id carries which list it belongs to: b3 is coarse band 3, f3 is
   fine band 3. The old ids stay valid, so nothing already seeded breaks. */
const bandId = (i, fine) => `${fine ? "f" : "b"}${i}`;
const bandOf = (id) => {
  const s = String(id), list = s[0] === "f" ? FINE_BANDS : BANDS;
  return list[Number(s.slice(1))] || [null, null];
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── text helpers, ported from normalize.py ─────────────────────────── */

const AGE_RE = /(?:([\d۰-۹٠-٩]+)\s*)?(لحظاتی|دقایقی|دقیقه|ساعت|روز|هفته|ماه)\s*پیش/;
const AGE_DAYS = { "لحظاتی": 0, "دقایقی": 0, "دقیقه": 0, "ساعت": 0, "روز": 1, "هفته": 7, "ماه": 30 };
const AGE_PRECISE = new Set(["لحظاتی", "دقایقی", "دقیقه", "ساعت", "روز"]);

function divarAge(strings) {
  for (const x of strings) {
    if (!x || x.length > 120) continue;
    const m = normalizeText(x).match(AGE_RE);
    if (!m) continue;
    const n = m[1] ? Number(m[1]) : (AGE_DAYS[m[2]] === 0 ? 0 : 1);
    const days = n * (AGE_DAYS[m[2]] ?? 1);
    const date = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    return { date, precise: AGE_PRECISE.has(m[2]) };
  }
  return null;
}

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

export function normalizeText(s) {
  if (!s) return "";
  let t = String(s);
  for (let i = 0; i < 10; i++) {
    t = t.split(FA_DIGITS[i]).join(String(i));
    t = t.split(AR_DIGITS[i]).join(String(i));
  }
  t = t
    .replace(/ك/g, "ک").replace(/[يئ]/g, "ی").replace(/ة/g, "ه")
    .replace(/[أإآ]/g, "ا").replace(/ؤ/g, "و")
    .replace(/\u0640/g, "")            // tatweel: "متـر" is "متر"
    .replace(/\u200c/g, " ")           // zero-width non-joiner
    .replace(/[\u200e\u200f\ufeff]/g, "")
    .replace(/[،؛]/g, " ")
    .replace(/(?<=\d)\/(?=\d)/g, ".")  // Persian decimal: ۶۴/۵ is 64.5
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

const SCALES = [["میلیارد", 1e9], ["ملیارد", 1e9], ["میلیون", 1e6],
                ["ملیون", 1e6], ["هزار", 1e3]];

export function parsePrice(text) {
  const t0 = normalizeText(text);
  if (!t0) return null;
  if (/توافقی|تماس بگیرید|رایگان/.test(t0)) return null;

  const isRial = /ریال/.test(t0);
  // separators are removed, not replaced with spaces — otherwise
  // "42,500,000,000" parses as 42
  let t = t0.replace(/[,٬]/g, "");
  let scale = 1;
  for (const [w, m] of SCALES) {
    if (t.includes(w)) { scale = m; t = t.split(w).join(" "); break; }
  }
  const m = t.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]) * scale;
  if (isRial || (!/تومان/.test(t0) && v >= 1e14)) v /= 10;
  return Math.round(v);
}

// "متر" spelled out is unambiguous even when jammed against the next word.
// The abbreviations م / مر / m are not, so they need a letter check after.
const AREA_LONG = /(\d+(?:\.\d+)?)\s*(?:متر\s*مربع|مترمربع|متری|متر)/g;
const AREA_SHORT = /(\d+(?:\.\d+)?)\s*(?:m2|mr|m|مر|م)(?![\u0621-\u06CC])/g;
const AREA_SUM = /(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)\s*(?:متری|متر|م)/g;
const NOT_THE_FLAT = ["گذر", "کوچه", "بالکن", "پاسیو", "حیاط", "تراس",
                      "دسترسی", "انباری", "متری بانک"];

// What the number in front of these words measures.
const SAYS_LAND     = ["زمین", "عرصه", "قواره", "ملک کلنگی", "کلنگی"];
const SAYS_BUILDING = ["زیربنا", "زیر بنا", "اعیان", "بنا", "متراژ بنا"];
const STREET_WIDTH  = ["بلوار", "خیابان", "گذر", "کوچه", "معبر", "عرض", "بر ", "دونبش", "اتوبان", "بزرگراه"];

/**
 * Building area and land area, told apart by the word in front of them.
 *
 * parseArea below takes the largest number it finds, on the reasoning that a
 * flat is the biggest thing measured in its own advert. A villa breaks that:
 * it lists زمین and زیربنا, the land is larger, and price per metre then
 * describes the plot rather than the house. Tehran's villa median came out
 * at 27.6 against 234 for flats, and the sanity band — a quarter to four
 * times the median — then discarded every villa whose area had parsed as
 * the building instead. 1,073 villas became 245.
 *
 * Only villa and land consult this. Apartments keep the old behaviour
 * exactly, because for them it is right and they are most of the database.
 */
export function parseAreaByLabel(sources) {
  let building = null, land = null;
  for (const src of sources) {
    const t = normalizeText(src);
    if (!t) continue;
    for (const rx of [AREA_LONG, AREA_SHORT]) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(t))) {
        const v = parseFloat(m[1]);
        if (!(v > 0)) continue;
        const before = t.slice(Math.max(0, m.index - 18), m.index);
        const near = t.slice(Math.max(0, m.index - 10), m.index);
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
        if (STREET_WIDTH.some((w) => near.includes(w))) continue;
        if (SAYS_BUILDING.some((w) => before.includes(w))) {
          if (building === null || v < building) building = v;
        } else if (SAYS_LAND.some((w) => before.includes(w) || after.includes(w))) {
          if (v >= 30 && (land === null || v > land)) land = v;
        }
      }
    }
  }
  return { building, land };
}

export function parseArea(...sources) {
  const cands = [];
  for (const src of sources) {
    const t = normalizeText(src);
    if (!t) continue;
    let m;
    AREA_SUM.lastIndex = 0;
    while ((m = AREA_SUM.exec(t))) cands.push(parseFloat(m[1]) + parseFloat(m[2]));
    for (const rx of [AREA_LONG, AREA_SHORT]) {
      rx.lastIndex = 0;
      while ((m = rx.exec(t))) {
        const before = t.slice(Math.max(0, m.index - 14), m.index);
        if (NOT_THE_FLAT.some((w) => before.includes(w))) continue;
        cands.push(parseFloat(m[1]));
      }
    }
  }
  // the flat is almost always the largest measurement on the line
  const ok = cands.filter((a) => a >= 20 && a <= 1000);
  return ok.length ? Math.max(...ok) : null;
}

/* Three markets, three Divar categories.
 *
 * They are kept apart all the way through — separate scrape state, separate
 * snapshots, separate medians — because land in Tehran runs many times the
 * price per metre of a flat in the same street. You are buying the ground
 * rather than a share of a building, so a combined figure would move with
 * the mix of what was advertised rather than with prices.
 *
 * Each rejects what the others sell, plus the things that are not a sale at
 * all: instalment plans, off-plan, joint ventures, key money, swaps. */
export const KINDS = [
  { id: "apartment", category: "apartment-sell",
    reject: ["اقساط", "قسط", "پیش فروش", "پیش‌فروش", "پیشفروش", "مشارکت",
             "تعاونی", "سرقفلی", "تهاتر", "معاوضه", "کلنگی", "زمین",
             "مستغلات", "یکجا", "اداری", "تجاری", "مغازه"] },

  { id: "villa", category: "house-villa-sell",
    reject: ["اقساط", "قسط", "پیش فروش", "پیش‌فروش", "پیشفروش", "مشارکت",
             "تعاونی", "سرقفلی", "تهاتر", "معاوضه", "زمین", "مستغلات",
             "یکجا", "اداری", "تجاری", "مغازه", "اجاره", "رهن"] },

  /* کلنگی belongs here: it is sold for the plot, not the building on it.
   *
   * plots-old-houses-sell returned an empty list from every city, every run
   * — no error, no pages, nothing rejected, just no posts. Divar answers an
   * unknown category with an empty result rather than a failure, so this
   * looked like "there are no plots for sale in Iran" for as long as it ran.
   *
   * Divar's public URL for the category is buy-old-house, but the API name
   * is not the URL slug: apartment-sell works and its URL is buy-apartment.
   * Rather than guess which spelling the API wants, the candidates are
   * tried in order and whichever returns posts is kept in KV. If Divar
   * renames it later the same probe finds the new one. */
  { id: "land", category: "plots-old-houses-sell",
    parents: ["residential-sell", "real-estate"],
    /* The browse URL is divar.ir/s/tehran/buy-old-house, but the API does not
       take the URL slug: buy-apartment in the address bar is apartment-sell
       here, and buy-old-house is rejected outright. So the name is guessed
       from the pattern of the two that work, and the probe tries them all in
       one go rather than one per day. Hit /probe?kind=land to run it now. */
    /* Divar rejects every leaf name tried with "invalid category", so the
       probe now also tests the parents from the site's own breadcrumb —
       املاک › فروش مسکونی › فروش زمین و ملک کلنگی. If a parent is accepted we
       can read it and sort the listings by their own category afterwards,
       and never need the leaf name at all. apartment-sell is included as a
       control: if that fails too, the problem is the request, not the name. */
    alts: ["residential-sell", "real-estate", "residential",
           "apartment-sell",
           "plot-old-house-sell", "land-old-house", "plot-and-old-house",
           "old-house-plot-sell", "kolangi-sell", "zamin-kolangi",
           "plot-oldhouse-sell", "buy-plot-old-house", "sell-old-house",
           "land-plot-sell", "plots-sell"],
    reject: ["اقساط", "قسط", "مشارکت", "تعاونی", "سرقفلی", "تهاتر", "معاوضه",
             "اجاره", "رهن", "مغازه", "سوله", "انبار"] },
];

/* Categories that contain other categories.
 *
 * residential-sell is accepted by Divar and returns listings — but it is the
 * parent of apartment, villa and land together. Scraping it as if it were the
 * land category would file every flat in Tehran as a plot of land. It is
 * useful for discovery, and unusable as a scrape target until each post can
 * be sorted by its own category. */
const PARENT_CATEGORIES = new Set([
  "residential-sell", "real-estate", "residential", "residential-rent",
]);

/* Reading a kind out of the post itself.
 *
 * Divar rejects every name tried for the land category but accepts the parent
 * residential-sell, which returns apartments, villas and land together. So
 * land is collected from the parent and each post is sorted by its own
 * category — which is found rather than assumed: any string in the post that
 * looks like a Divar category slug is taken, the two known ones are mapped,
 * and whatever is left over is the land slug. The first time an unknown one
 * appears it is logged, so the name we could not guess ends up in the log by
 * itself.
 *
 * A post that cannot be classified is skipped, never filed as a guess. */
const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:sell|rent)$/;
const SLUG_TO_KIND = {
  "apartment-sell": "apartment",
  "house-villa-sell": "villa",
};
function postCategorySlug(post) {
  let found = null;
  const visit = (n, depth) => {
    if (found || depth > 6 || n === null || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const v of n) visit(v, depth + 1); return; }
    for (const k in n) {
      const v = n[k];
      if (typeof v === "string") {
        if (v !== "residential-sell" && SLUG_RE.test(v)) { found = v; return; }
      } else if (v && typeof v === "object") visit(v, depth + 1);
    }
  };
  visit(post, 0);
  return found;
}

const KIND_BY_ID = Object.fromEntries(KINDS.map((k) => [k.id, k]));

export function acceptTitle(title, kindId) {
  const k = KIND_BY_ID[kindId] || KINDS[0];
  const t = normalizeText(title);
  return !k.reject.some((w) => t.includes(w));
}

// kept so existing callers and tests still work
export function looksLikeFlatSale(title) { return acceptTitle(title, "apartment"); }

export function canonicalPlace(name) {
  let t = normalizeText(name)
    .replace(/آ/g, "ا").replace(/ۀ/g, "ه");
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

// The same flat is posted by the owner and by three agents on three sites.
// Rooms is deliberately absent: it is missing too often to match on.
export async function dedupeKey(city, hood, area, amount) {
  const raw = `${canonicalPlace(city)}|${canonicalPlace(hood)}|` +
              `${area ? Math.round(area) : 0}|${amount ? roundSig(amount) : 0}`;
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("").slice(0, 16);
}

/* ── Divar ──────────────────────────────────────────────────────────── */

function extractPosts(payload) {
  const posts = [];
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === "object") {
      if (String(n["@type"] || "").endsWith("widgets.PostRowData")) posts.push(n);
      Object.values(n).forEach(walk);
    }
  };
  walk(payload);
  return posts;
}

function collectStrings(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((v) => collectStrings(v, out));
  else if (node && typeof node === "object") {
    Object.values(node).forEach((v) => collectStrings(v, out));
  }
  return out;
}

function findPriceText(strings) {
  for (const s of strings) {
    if (s.includes("تومان") && !/متری|اجاره|ودیعه/.test(s)) return s;
  }
  return "";
}

function findAreaText(strings, title) {
  for (const s of [title, ...strings]) {
    if (s && s.includes("متر") && !/میلیون|میلیارد/.test(s)) return s;
  }
  return "";
}

/* Divar stops paging at about 215 pages, so one search can never reach more
   than ~5,600 listings — Tehran has 177,125 apartments. The way past it is
   to ask narrower questions, because each search gets its own allowance: all
   apartments under 2bn, then 2–4bn, and so on. This adds that price filter.
   The field name is the part that cannot be checked from outside, so
   /probe-band proves it before anything depends on it. */
async function fetchPage(cityId, category, pagination, band) {
  const data = { category: { str: { value: category } } };
  if (band && (band.min != null || band.max != null)) {
    data.price = { number_range: {
      ...(band.min != null ? { minimum: String(band.min) } : {}),
      ...(band.max != null ? { maximum: String(band.max) } : {}),
    } };
  }
  const body = {
    city_ids: [String(cityId)],
    search_data: { form_data: { data } },
  };
  if (pagination) body.pagination_data = pagination;

  const res = await fetch(ENDPOINT, {
    method: "POST", headers: HEADERS, body: JSON.stringify(body),
  });
  if (!res.ok) {
    /* Divar answers a bad category with 400 and a body explaining what it
       objected to. Six candidate names for the land category were rejected
       with nothing but the status to go on, which is not enough to work out
       the seventh. Carry a slice of the body so the log says why. */
    let detail = "";
    try { detail = (await res.text()).slice(0, 300).replace(/\s+/g, " "); }
    catch (e) { /* body already consumed or empty */ }
    throw new Error(`HTTP ${res.status}${detail ? " — " + detail : ""}`);
  }
  return res.json();
}

/* ── one chunk of work ──────────────────────────────────────────────── */

// The order cities were seeded in is their population order, so it doubles
// as priority. Without this, Tehran waits its turn behind مرودشت.
/**
 * Which city to work on next.
 *
 * Round-robin by seed order gave every city the same turn, so a full pass
 * took about twelve days and Tehran's figures sat unchanged for a week and a
 * half while Lahijan — which barely moves — was refreshed just as often.
 *
 * Cities are now due again after a number of days that depends on their size:
 * the big ones every couple of days, small ones weekly. Anything never
 * scraped still comes first, so the first pass completes before any city
 * starts repeating.
 */
const sqlList = (xs) => xs.map((x) => `'${x}'`).join(",");
const REVISIT_DAYS = `
  CASE
    WHEN city IN (${sqlList(CITY_NAMES.slice(0, 6))}) THEN 2
    WHEN city IN (${sqlList(CITY_NAMES.slice(6, 20))}) THEN 4
    ELSE 7
  END`;

async function pickCity(db) {
  /* Two things were wrong here, and together they starved the apartments.
   *
   * "Never scraped" outranked "is an apartment". Seeding villa and land
   * created about ninety rows with last_run NULL, and every one of them beat
   * every apartment city. Apartments — most of the database and the whole of
   * what the site shows by default — went three days without a refresh while
   * villa worked through the country.
   *
   * And a city already finished today was still eligible to be picked: the
   * chunk would select it, notice done_today, log a line and return, spending
   * the whole hourly run on nothing. Excluding them here means every run does
   * work, and it also means apartments can lead the order without blocking
   * villa and land — once the apartment cities are done for the day they drop
   * out and the rest get the remaining runs.
   */
  /* Apartments first, but not always.
   *
   * Absolute priority starved the other two: 48 apartment cities, several
   * runs each, and villa and land went from 14 to 16 September without a
   * single turn. Absolute priority the other way — "never scraped" first —
   * was what starved the apartments before that. Neither ordering shares.
   *
   * So three hours in four go to apartments and the fourth goes to whatever
   * else is due. Apartments still get 18 runs a day, enough to keep the
   * country fresh; villa and land get 6, which is slow but is not never.
   */
  /* Equal shares, rotating every run.
   *
   * Three hours in four went to apartments, and the fourth alternated
   * between villa and land. That was right when apartments were starved and
   * there were 144 city-and-kind combinations. Price bands multiplied the
   * work twelvefold — 696 combinations per kind — and the split then meant
   * apartments finishing in a day and a half while villa and land needed
   * eight days each.
   *
   * Apartments are caught up, so all three now take turns evenly: 240 runs a
   * day each, every kind swept in about three days. The rotation is by the
   * clock rather than remembered, so nothing needs storing and a missed run
   * costs one turn instead of putting the order out permanently. */
  const slot = Math.floor(Date.now() / 120000) % 3;   // one per 2-minute tick
  const firstChoice = slot === 0 ? "kind = 'apartment'"
    : slot === 1 ? "kind = 'villa'"
    : "kind = 'land'";

  const row = await db.prepare(`
    SELECT city, kind, band, city_id, page, pagination, done_today
    FROM scrape_state
    WHERE source = 'divar'
      AND COALESCE(done_today, '') <> date('now')
    ORDER BY
      (page > 0) DESC,                  -- finish what was started
      (${firstChoice}) DESC,            -- whose hour it is
      (julianday('now') - julianday(COALESCE(last_run, date('now', '-8 days'))))
        / ${REVISIT_DAYS} DESC,
      rowid ASC
    LIMIT 1`).first();
  return row;
}

export async function scrapeChunk(env, log = []) {
  const db = env.DB;
  let loggedEmptyHoodSample = false;   // log the raw shape once per run, not per listing
  let loggedRejectSample = 0;          // land yields nothing; see the note at the reject point
  let loggedAreaSample = 0;            // confirm villa/land pick the right area
  let loggedNewSlug = false, otherKind = 0;
  let relocated = 0, loggedRelocate = false, loggedParentPost = false;
  let hoodFixed = 0, loggedHoodFix = false;
  let skippedNoArea = 0, skippedNoPrice = 0, examined = 0;
  const state = await pickCity(db);
  if (!state) {
    // everything eligible is finished for the day, or nothing is seeded yet
    log.push("nothing due — every city finished today, or run /seed");
    return { log };
  }

  const today = new Date().toISOString().slice(0, 10);
  let { city, kind, band, city_id, page, pagination } = state;
  const [bandMin, bandMax] = bandOf(band);
  kind = kind || "apartment";
  const kindDef = KIND_BY_ID[kind] || KINDS[0];
  let category = kindDef.category;

  // a city finished today starts again from the top tomorrow
  if (state.done_today === today) {
    log.push(`${city}: already finished today`);
    return { log };
  }
  if (page >= MAX_PAGES_PER_CITY) {
    await db.prepare(
      "UPDATE scrape_state SET page=0, pagination=NULL, done_today=?, last_run=? " +
      "WHERE source='divar' AND city=? AND kind=? AND band=?")
      .bind(today, new Date().toISOString(), city, kind, band).run();
    // a band that fills all 215 pages is too wide for this city and is
    // hiding listings beyond the ceiling — it wants splitting
    log.push(`${city} / ${kind} / ${band}: hit the page limit — band too wide`);
    return { log };
  }

  /* A category that has never produced a post gets its alternatives tried
     once, cheaply: one page each, first page only. The winner is cached in
     KV so later runs go straight to it — the probe costs subrequests, and
     they are capped at fifty per invocation. */
  /* No usable leaf name: read the parent and filter. Wasteful — apartments
     and villas come back too and are thrown away — but it is the difference
     between collecting land and not collecting it. */
  /* The neighbourhoods this city is known to have, for checking titles
     against. Read from hood_snapshots — one row per neighbourhood per day
     rather than one per listing — and cached in KV, because this runs every
     two minutes and the list changes slowly. */
  let knownHoods = new Set();
  try {
    const hit = await env.SITE?.get(`hoods:${city}`, { type: "json" });
    if (Array.isArray(hit)) knownHoods = new Set(hit);
    else {
      const { results } = await db.prepare(
        `SELECT DISTINCT hood FROM hood_snapshots
         WHERE city = ? AND hood IS NOT NULL AND hood <> ''`).bind(city).all();
      knownHoods = new Set(results.map((r) => r.hood));
      await env.SITE?.put(`hoods:${city}`, JSON.stringify([...knownHoods]),
                          { expirationTtl: 86400 });
    }
  } catch (e) { /* no list: titles are simply not consulted */ }

  let hasLastSeen = false, hasPriceChanged = false, hasFirstPosted = false, hasPriceHistory = false;
  let hasRemoved = false;
  try {
    const cols = await db.prepare("PRAGMA table_info(listings)").all();
    hasLastSeen = cols.results.some((c) => c.name === "last_seen");
    hasPriceChanged = cols.results.some((c) => c.name === "price_changed_at");
    hasFirstPosted = cols.results.some((c) => c.name === "first_posted_at");
    hasRemoved = cols.results.some((c) => c.name === "removed_at");
    const t = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='price_history'").all();
    hasPriceHistory = t.results.length > 0;
  } catch (e) { /* column check failed: run without the new columns */ }

  let viaParent = false;
  if (kindDef.parents && kindDef.parents.length) {
    const cached = await env.SITE?.get(`cat:${kind}`).catch(() => null);
    if (!cached || PARENT_CATEGORIES.has(cached) ||
        (SLUG_TO_KIND[cached] && SLUG_TO_KIND[cached] !== kind)) {
      // residential-sell answered 520 once and real-estate answered instead,
      // so try them in turn rather than depend on one
      category = kindDef.parents[0];
      viaParent = true;
    }
  }

  if (!viaParent && kindDef.alts && kindDef.alts.length) {
    let known = null;
    try { known = await env.SITE?.get(`cat:${kind}`); } catch (e) { /* probe again */ }
    if (known && SLUG_TO_KIND[known] && SLUG_TO_KIND[known] !== kind) {
      log.push(`cached category ${known} belongs to ${SLUG_TO_KIND[known]} — ignoring`);
      try { await env.SITE?.delete(`cat:${kind}`); } catch (e) { /* best effort */ }
    } else if (known && !PARENT_CATEGORIES.has(known)) {
      category = known;
    } else if (known) {
      // a parent slipped into the cache: ignore it rather than mislabel
      log.push(`cached category ${known} is a parent — ignoring`);
    } else {
      for (const cand of [kindDef.category, ...kindDef.alts]) {
        let probe;
        try { probe = await fetchPage(city_id, cand, null); }
        catch (e) { log.push(`category probe ${cand}: ${e.message}`); continue; }
        const n = extractPosts(probe).length;
        log.push(`category probe ${cand}: ${n} posts`);
        if (n) {
          category = cand;
          try { await env.SITE?.put(`cat:${kind}`, cand); } catch (e) { /* retry next run */ }
          break;
        }
      }
    }
  }

  let pag = pagination ? JSON.parse(pagination) : null;
  let saved = 0, pages = 0, unchanged = 0, ended = false;
  const stmts = [];

  const PAGES_PER_RUN = Number(env.PAGES_PER_RUN) || PAGES_PER_RUN_DEFAULT;
  const PAUSE_MS = Number(env.PAUSE_MS) || PAUSE_MS_DEFAULT;
  for (let i = 0; i < PAGES_PER_RUN; i++) {
    let payload;
    try {
      payload = await fetchPage(city_id, category, pag, { min: bandMin, max: bandMax });
    } catch (e) {
      // the first parent answered 520 once; try the next before giving up
      if (viaParent && pages === 0 && kindDef.parents.indexOf(category) <
          kindDef.parents.length - 1) {
        category = kindDef.parents[kindDef.parents.indexOf(category) + 1];
        log.push(`parent fell back to ${category}`);
        try { payload = await fetchPage(city_id, category, pag, { min: bandMin, max: bandMax }); }
        catch (e2) { log.push(`${city} page 1: ${e2.message}`); break; }
      } else {
      log.push(`${city} page ${page + pages + 1}: ${e.message}`);
      break;
      }
    }

    const posts = extractPosts(payload);

    /* How many listings exist in this category, from Divar's own response.
     *
     * Asked how long villa and land would take to finish, there was no way
     * to answer: the scraper knew how many it had saved and nothing about
     * how many were out there. Divar returns a total alongside the posts —
     * the field name varies across its response shapes, so take the first
     * plausible one rather than hardcode a path that breaks on the next
     * change. Logged on the first page of a city only, so it is one line
     * per city per run and not one per page. */
    if (pages === 0) {
      const totals = [];
      const findTotal = (n, depth) => {
        if (depth > 6 || !n || typeof n !== "object") return;
        for (const k in n) {
          const v = n[k];
          if (typeof v === "number" && v > 0 && v < 5e6 &&
              /^(total|count|total_count|hits|num_results)$/i.test(k)) totals.push([k, v]);
          else if (v && typeof v === "object") findTotal(v, depth + 1);
        }
      };
      findTotal(payload, 0);
      log.push(`${city} / ${kind}: ${posts.length} on page 1` +
        (totals.length ? `, total reported ${totals.map(t => t[0] + "=" + t[1]).join(" ")}`
                       : ", no total in response"));
    }

    if (!posts.length) { ended = true; break; }
    pages++;

    // What do we already have? Reads are cheap on the free tier (5 million a
    // day) and writes are scarce (100,000), so spending a read to avoid a
    // write is a good trade. Most of what a repeat pass sees is unchanged.
    const tokens = posts
      .map((p) => ((p.action || {}).payload || {}).token)
      .filter(Boolean);
    const known = new Map();
    if (tokens.length) {
      const q = tokens.map(() => "?").join(",");
      const rows = await db.prepare(
        `SELECT source_id, price_toman, city, hood, posted_at, area_m2,
                ${hasRemoved ? "removed_at" : "NULL"} AS removed,
                ${hasFirstPosted ? "first_posted_at" : "posted_at"} AS first_posted,
                COALESCE(kind,'apartment') AS kind FROM listings
         WHERE source='divar' AND source_id IN (${q})`).bind(...tokens).all();
      /* Number() on both sides, not ===.
       *
       * price_toman is an INTEGER column, but what a driver hands back for
       * one is not guaranteed to be a JS number — a string or a BigInt both
       * compare false against a number under ===, and the failure is silent.
       * Every listing would then look changed and be rewritten on every
       * pass, which for this scraper is around 250,000 writes a day against
       * an allowance of 100,000.
       *
       * Whether that is what has been happening is not yet confirmed; the
       * counts below will say. Coercing is correct either way. */
      for (const r of rows.results) {
        known.set(r.source_id, { price: Number(r.price_toman),
                                 city: r.city, hood: r.hood || "", kind: r.kind,
                                 posted: r.posted_at || null,
                                 first: r.first_posted || null,
                                 area: Number(r.area_m2) || null, removed: r.removed || null });
      }
    }

    const stillThere = [];
    for (const p of posts) {
      const payloadObj = p;
      const token = ((p.action || {}).payload || {}).token;
      if (!token) continue;
      const info = ((p.action || {}).payload || {}).web_info || {};
      const title = p.title || info.title || "";
      if (viaParent) {
        const had = known.get(token);
        if ((had && had.kind !== kind) || !titleSaysLand(title)) { otherKind++; continue; }
      }

      const strings = collectStrings(payloadObj);
      const priceText = findPriceText(strings);
      const areaText = findAreaText(strings, title);
      const price = parsePrice(priceText);

      /* For a flat there is one area and the old rule holds. For a villa the
         price is asked per metre of house, so the labelled زیربنا wins over
         the larger زمین; for a plot the land is the thing being sold. When
         no label is present the old rule is the fallback, so nothing that
         parsed before stops parsing now. */
      let area = null, landArea = null;
      if (kind === "apartment") {
        area = parseArea(areaText, title);
      } else {
        const lab = parseAreaByLabel([areaText, title, ...strings.slice(0, 40)]);
        landArea = lab.land;
        area = (kind === "land")
          ? (lab.land ?? lab.building ?? parseArea(areaText, title))
          : (lab.building ?? parseArea(areaText, title));
        if (area != null && (area < 15 || area > 100000)) area = null;
      }

      if (loggedAreaSample < 3 && kind !== "apartment") {
        loggedAreaSample++;
        console.log(`${kind} area sample ${loggedAreaSample} in ${city}: ` +
          JSON.stringify({ title, areaText, area, landArea,
                           oldRule: parseArea(areaText, title) }));
      }

      /* Land returns no listings at all, while apartment and villa work.
       *
       * Two things here were written when apartments were the only kind, and
       * either could be the cause: parseArea discards anything over 1000 m2,
       * which an ordinary plot exceeds, and NOT_THE_FLAT skips a number that
       * follows حیاط or گذر, which for a plot may be the plot itself rather
       * than a yard beside a flat. There is also the possibility that Divar
       * describes plots with no متر figure at all, in which case findAreaText
       * returns nothing and neither of the above matters.
       *
       * Guessing between three causes and changing the area rules blind is
       * how apartment areas get quietly corrupted. So: log the first three
       * rejected land listings with the text each step actually saw. Three
       * rather than one because plots vary more than flats, and one sample
       * could be unrepresentative. Remove this once the shape is known. */
      if ((!price || !area) && kind === "land" && loggedRejectSample < 3) {
        loggedRejectSample++;
        console.log(`land reject ${loggedRejectSample} in ${city}: ` + JSON.stringify({
          title,
          areaText,
          priceText,
          parsedArea: area,
          parsedPrice: price,
          areaStrings: strings.filter((x) => x && x.includes("متر")).slice(0, 6),
        }));
      }
      /* How much of this category never gets through the door.
         A Tabriz villa came back with no متر figure anywhere in the listing —
         no area, no land size — and was discarded here, silently. Villas are
         often advertised without a measurement, so "villa count is lower than
         expected" needed a number rather than a theory. */
      examined++;
      if (!price) skippedNoPrice++;
      else if (!area) skippedNoArea++;
      if (!price) continue;

      const cityFa = info.city_persian || city;
      const hood = info.district_persian || "";
      // Temporary: some cities (Tabriz confirmed) have every listing land with
      // hood empty, even though coordinates come through fine — so the field
      // may exist under a different name for those listings, or genuinely not
      // exist. Logging the raw web_info once when this happens shows which,
      // instead of guessing at alternate field names blind.
      if (!hood && !loggedEmptyHoodSample) {
        loggedEmptyHoodSample = true;
        console.log(`empty hood sample for ${cityFa}: ${JSON.stringify(info)}`);
      }
      // already stored at this price — nothing to write
      /* The title wins over the agency's address. A relocated listing loses
         its neighbourhood as well — that came from the same wrong place. */
      const prev = known.get(token);
      let rowCity = cityFa, rowHood = hood;
      const elsewhere = relocateTarget(title, cityFa, knownHoods);
      if (elsewhere) {
        rowCity = elsewhere;
        rowHood = "";
        relocated++;
        if (!loggedRelocate) {
          loggedRelocate = true;
          console.log(`relocated by title: ${cityFa} -> ${elsewhere} | ${title}`);
        }
      } else if (prev && prev.city !== cityFa) {
        rowCity = prev.city;
        rowHood = prev.hood || "";
      } else {
        /* Still in this city, but the title may name a different
           neighbourhood than the agency's. */
        const titleHood = hoodFromTitle(title, knownHoods);
        if (titleHood && titleHood !== rowHood) {
          if (!loggedHoodFix) {
            loggedHoodFix = true;
            console.log(`hood from title: ${rowHood || "—"} -> ${titleHood} | ${title}`);
          }
          rowHood = titleHood;
          hoodFixed++;
        }
      }

      /* Skip only when nothing has changed — price and location.
       *
       * The skip used to compare the price alone, so a listing whose price
       * was steady was never rewritten, and the corrected city and
       * neighbourhood never reached it. Most listings hold their price for
       * weeks, so most corrections went nowhere. */
      const keptHood = rowHood || (prev && prev.city === rowCity ? prev.hood || "" : "");
      const age = divarAge(strings);
      let posted = prev ? prev.posted : null;
      if (age && (!posted || (age.precise && age.date > posted))) posted = age.date;
      if (prev && prev.price === Number(price) && prev.kind === kind &&
          prev.city === rowCity && (prev.hood || "") === keptHood &&
          (prev.posted || null) === posted && !prev.removed &&
          (kind === "apartment" || area == null || prev.area === area)) {
        unchanged++; stillThere.push(token); continue;
      }

      const key = area ? await dedupeKey(rowCity, rowHood, area, price) : null;
      const rawText = [title, priceText, areaText].filter(Boolean).join(" | ").slice(0, 300);

      const seenCol = hasLastSeen ? ", last_seen" : "";
      const seenVal = hasLastSeen ? ",?" : "";
      const seenSet = hasLastSeen ? ", last_seen=excluded.last_seen" : "";
      const priceSet = hasPriceChanged
        ? `, price_changed_at=CASE WHEN listings.price_toman <> excluded.price_toman
                                   AND listings.price_toman * 10 <> excluded.price_toman
                                  THEN excluded.scraped_at ELSE listings.price_changed_at END`
        : "";
      const firstCol = hasFirstPosted ? ", first_posted_at" : "";
      const firstVal = hasFirstPosted ? ",?" : "";
      const firstSet = hasFirstPosted
        ? ", first_posted_at=COALESCE(listings.first_posted_at, excluded.first_posted_at)" : "";
      const binds = [token, rowCity, rowHood, title.slice(0, 120),
                     `https://divar.ir/v/${token}`, price, area,
                     area ? Math.round(price / area) : null, rawText, key, today, kind, posted];
      if (hasLastSeen) binds.push(today);
      if (hasFirstPosted) binds.push(posted);

      if (hasPriceHistory) {
        if (prev && prev.price !== Number(price) && prev.price * 10 !== Number(price)) {
          stmts.push(db.prepare(
            `INSERT OR IGNORE INTO price_history (source, source_id, day, price_toman)
             VALUES ('divar', ?, ?, ?)`).bind(token, prev.first || prev.posted || "0000-00-00", prev.price));
          stmts.push(db.prepare(
            `INSERT OR REPLACE INTO price_history (source, source_id, day, price_toman)
             VALUES ('divar', ?, ?, ?)`).bind(token, today, price));
        }
      }

      stmts.push(db.prepare(`
        INSERT INTO listings (source, source_id, city, hood, title, url,
          price_toman, area_m2, price_m2, raw_text, dedupe_key, scraped_at, kind, posted_at${seenCol}${firstCol})
        VALUES ('divar',?,?,?,?,?,?,?,?,?,?,?,?,?${seenVal}${firstVal})
        ON CONFLICT(source, source_id) DO UPDATE SET
          posted_at=COALESCE(excluded.posted_at, listings.posted_at)${priceSet}${firstSet},
          price_toman=excluded.price_toman,
          area_m2=CASE WHEN listings.enriched_at IS NULL OR listings.area_m2 IS NULL
                         OR (excluded.kind <> 'apartment' AND listings.area_m2 < 30)
                       THEN COALESCE(excluded.area_m2, listings.area_m2) ELSE listings.area_m2 END,
          price_m2=CAST(excluded.price_toman /
                   CASE WHEN listings.enriched_at IS NULL OR listings.area_m2 IS NULL
                          OR (excluded.kind <> 'apartment' AND listings.area_m2 < 30)
                        THEN COALESCE(excluded.area_m2, listings.area_m2) ELSE listings.area_m2 END AS INTEGER),${
            hasRemoved ? "\n          removed_at=NULL," : ""}
          city=excluded.city,
          hood=CASE WHEN excluded.hood <> '' THEN excluded.hood
                    WHEN excluded.city <> listings.city THEN ''
                    ELSE listings.hood END,
          dedupe_key=COALESCE(excluded.dedupe_key, listings.dedupe_key),
          scraped_at=excluded.scraped_at,
          kind=excluded.kind${seenSet}`)
        .bind(...binds));
      saved++;
    }

    if (hasLastSeen && stillThere.length) {
      stmts.push(db.prepare(
        `UPDATE listings SET last_seen = ?
         WHERE source='divar' AND source_id IN (${stillThere.map(() => "?").join(",")})
           AND (last_seen IS NULL OR last_seen < date(?, '-2 days'))`).bind(today, ...stillThere, today));
    }

    pag = (payload.pagination || {}).data || null;
    if (!pag) { ended = true; break; }
    await sleep(PAUSE_MS);
  }

  if (stmts.length) await db.batch(stmts);

  const newPage = page + pages;
  await db.prepare(`
    UPDATE scrape_state SET page=?, pagination=?, last_run=?, done_today=?
    WHERE source='divar' AND city=? AND kind=? AND band=?`)
    .bind(ended ? 0 : newPage, ended ? null : JSON.stringify(pag),
          new Date().toISOString(), ended ? today : state.done_today,
          city, kind, band)
    .run();

  const seen = saved + unchanged;
  if (hoodFixed) {
    log.push(`${city} / ${kind}: ${hoodFixed} listings took the neighbourhood ` +
             `named in their title instead of the agency's`);
  }
  if (relocated) {
    log.push(`${city} / ${kind}: ${relocated} listings moved to the town ` +
             `named in their title (agency address, not the property's)`);
  }
  if (viaParent) {
    log.push(`${city} / ${kind}: read via ${category}, ` +
             `${otherKind} posts belonged to another kind and were skipped`);
  }
  if (examined && (skippedNoArea || skippedNoPrice)) {
    log.push(`${city} / ${kind}: of ${examined} listings, ` +
      `${skippedNoArea} had no area (stored, waiting for the enricher) and ` +
      `${skippedNoPrice} no price (${Math.round(skippedNoPrice / examined * 100)}% never stored)`);
  }
  log.push(`${city} / ${kind} / ${band}: ${pages} pages, ${saved} written, ` +
    `${unchanged} unchanged (${seen ? Math.round(unchanged / seen * 100) : 0}% skipped)` +
           (ended ? " — city finished" : ` — at page ${newPage}`));
  return { log, city, pages, saved, unchanged };
}

/* ── seeding the city list ──────────────────────────────────────────── */

export async function seedCities(env) {
  const res = await fetch(CITIES_URL, { headers: HEADERS });
  const payload = await res.json();

  const found = new Map();
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === "object") {
      const name = n.name || n.title;
      const id = n.id ?? n.city_id;
      if (typeof name === "string" && id != null) found.set(name.trim(), String(id));
      Object.values(n).forEach(walk);
    }
  };
  walk(payload);

  // The biggest markets first, so an interrupted day still covers what
  // matters. Everything else is added behind them.
  const priority = [...CITY_NAMES, ...EXTRA_CITIES];
  const norm = (t) => String(t).replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/[\s\u200c]/g, "");
  const byNorm = new Map([...found].map(([n, id]) => [norm(n), n]));
  const missing = [];

  const stmts = [];
  // one row per city, kind and price band — each band is a separate search
  // with its own 215-page allowance, which is the whole point of them
  for (const wanted of priority) {
    const name = found.has(wanted) ? wanted : byNorm.get(norm(wanted));
    const id = name && found.get(name);
    if (!id) { if (EXTRA_CITIES.includes(wanted)) missing.push(wanted); continue; }
    for (const k of KINDS) {
      const fine = BIG_CITIES.has(name);
      const list = bandsFor(name);
      for (let b = 0; b < list.length; b++) {
        stmts.push(env.DB.prepare(
          "INSERT OR IGNORE INTO scrape_state (source, city, kind, band, city_id, page) " +
          "VALUES ('divar',?,?,?,?,0)").bind(name, k.id, bandId(b, fine), id));
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { known: found.size, seeded: stmts.length, missing };
}

/* ── entry points ───────────────────────────────────────────────────── */


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
  // the cron fires this
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scrapeChunk(env)
      .then((r) => console.log(r.log.join("\n")))
      .catch((e) => {
        if (isLimitError(e)) {
          console.log("daily limit reached; skipping until it resets at midnight UTC");
          return;
        }
        throw e;
      }));
  },

  // and this is for running it by hand while setting up
  async fetch(request, env) {
    const url = new URL(request.url);
    // A bare 1101 page says only that something threw. Reporting the message
    // turns "it is broken" into "this query failed on this line", which is
    // the difference between guessing and fixing.
    try {
      return await route(url, env);
    } catch (err) {
      return json({ error: `${err.name}: ${err.message}`,
                    stack: String(err.stack || "").split("\n").slice(0, 4) }, 500);
    }
  },
};

async function route(url, env) {
    /* Try every candidate category for a kind and report what each returned.
       Waiting for the scheduler to reach land took days per attempt; this
       answers in one request. Read-only — it fetches from Divar and writes
       nothing, except the winning name to KV so the scraper picks it up. */
    /* Does the price filter actually filter?
       A band that is silently ignored returns the whole city, every band
       returns the same listings, and the extra work buys nothing. This asks
       for one narrow band and reports what came back, so the answer is
       measured rather than assumed. */
    if (url.pathname === "/probe-band") {
      const kind = url.searchParams.get("kind") || "apartment";
      const cityName = url.searchParams.get("city") || "تهران";
      const min = Number(url.searchParams.get("min") || 1e9);
      const max = Number(url.searchParams.get("max") || 2e9);
      const def = KIND_BY_ID[kind];
      const st = await env.DB.prepare(
        `SELECT city_id FROM scrape_state WHERE city = ? AND kind = ? LIMIT 1`)
        .bind(cityName, kind).first();
      if (!def || !st?.city_id) return json({ error: "unknown kind or city" }, 404);
      const cat = (await env.SITE?.get(`cat:${kind}`).catch(() => null)) || def.category;
      const prices = (payload) => extractPosts(payload).map((p) => {
        const strings = [];
        const walk = (n, d) => {
          if (!n || typeof n !== "object" || d > 5) return;
          for (const k in n) {
            const v = n[k];
            if (typeof v === "string") strings.push(v);
            else if (v && typeof v === "object") walk(v, d + 1);
          }
        };
        walk(p, 0);
        return parsePrice(strings.find((x) => /تومان/.test(x)) || "");
      }).filter((x) => x);
      try {
        const all = prices(await fetchPage(st.city_id, cat, null));
        const some = prices(await fetchPage(st.city_id, cat, null, { min, max }));
        const inBand = some.filter((p) => p >= min && p <= max).length;
        return json({ kind, city: cityName, band: { min, max },
          unfiltered: { n: all.length, min: Math.min(...all), max: Math.max(...all) },
          filtered: { n: some.length, min: Math.min(...some), max: Math.max(...some),
                      inBand },
          works: some.length > 0 && inBand === some.length &&
                 JSON.stringify(all) !== JSON.stringify(some) });
      } catch (e) { return json({ error: String(e.message).slice(0, 300) }, 500); }
    }

    if (url.pathname === "/probe") {
      const kind = url.searchParams.get("kind") || "land";
      const cityName = url.searchParams.get("city") || "تهران";
      const def = KIND_BY_ID[kind];
      if (!def) return json({ error: `unknown kind ${kind}` }, 400);
      const st = await env.DB.prepare(
        `SELECT city_id FROM scrape_state
         WHERE city = ? AND kind = ? LIMIT 1`).bind(cityName, kind).first();
      if (!st || !st.city_id) {
        return json({ error: `no city_id for ${cityName} / ${kind}` }, 404);
      }
      /* Every candidate is tried, not just up to the first success: a parent
         that works would otherwise hide a leaf further down the list, and the
         leaf is the one worth having. A working leaf always wins. */
      const tried = [];
      let winner = null, parentHit = null;
      for (const cand of [def.category, ...(def.alts || [])]) {
        try {
          const payload = await fetchPage(st.city_id, cand, null);
          const n = extractPosts(payload).length;
          tried.push({ category: cand, posts: n });
          if (!n) continue;
          if (PARENT_CATEGORIES.has(cand)) { parentHit ||= cand; continue; }
          /* apartment-sell was in the list as a control — proof the request
             itself works — and it answered, so it was chosen as the category
             for land and cached. A slug that already belongs to another kind
             is never that kind's answer. */
          if (SLUG_TO_KIND[cand] && SLUG_TO_KIND[cand] !== kind) {
            tried[tried.length - 1].note = "control — belongs to " + SLUG_TO_KIND[cand];
            continue;
          }
          winner = cand; break;
        } catch (e) {
          tried.push({ category: cand, error: String(e.message).slice(0, 200) });
        }
      }
      if (!winner && parentHit) winner = parentHit;
      /* A parent is never cached as a kind's category: the scraper would take
         it literally and tag everything it returned as that kind. Return a
         sample post instead, so the field that identifies a post's own
         category can be found and the parent used properly. */
      let sample = null;
      if (winner && PARENT_CATEGORIES.has(winner)) {
        try {
          const payload = await fetchPage(st.city_id, winner, null);
          const first = extractPosts(payload)[0];
          sample = first ? JSON.parse(JSON.stringify(first)).slice : null;
          if (first) {
            sample = { topLevelKeys: Object.keys(first),
                       web_info: first?.action?.payload?.web_info ?? null,
                       data: first?.data ? Object.keys(first.data) : null,
                       raw: JSON.stringify(first).slice(0, 1200) };
          }
        } catch (e) { sample = { error: String(e.message).slice(0, 200) }; }
        try { await env.SITE?.delete(`cat:${kind}`); } catch (e) { /* best effort */ }
        return json({ kind, city: cityName, winner,
          note: `${winner} is a parent category — not cached. ` +
                `It returns apartments, villas and land together.`,
          sample, tried });
      }
      if (winner) {
        try { await env.SITE?.put(`cat:${kind}`, winner); } catch (e) { /* next run probes again */ }
      }
      return json({ kind, city: cityName, winner, tried });
    }

    if (url.pathname === "/seed") {
      const r = await seedCities(env);
      return json(r);
    }
    if (url.pathname === "/run") {
      const r = await scrapeChunk(env);
      return json(r);
    }
    if (url.pathname === "/status") {
      const cities = await env.DB.prepare(`
        SELECT city, kind, page, done_today, last_run FROM scrape_state
        WHERE source='divar' ORDER BY last_run DESC NULLS LAST LIMIT 90`).all();
      // scrape_state is 50-ish rows, so that part is free; the counts over
      // the listings table are not, and are cached.
      const fresh = url.searchParams.get("fresh") === "1";
      let counts;
      try {
        counts = await cachedStatus(env, "status:scrape", async () => {
        const c = await env.DB.prepare(
          "SELECT COUNT(*) listings, COUNT(DISTINCT city) cities, " +
          "SUM(lat IS NOT NULL) with_coords FROM listings").first();
        const byKind = await env.DB.prepare(
          "SELECT COALESCE(kind,'apartment') kind, COUNT(*) n, " +
          "SUM(lat IS NOT NULL) coords FROM listings GROUP BY 1").all();
        return { ...c, byKind: byKind.results };
        }, 600000, fresh);
      } catch (e) {
        // most likely the daily read limit; the rotation below is the part
        // worth seeing anyway, and it costs almost nothing
        counts = { unavailable: e.message };
      }
      return json({ counts, cities: cities.results });
    }
    return json({
      routes: ["/seed — load the city list, run once",
               "/run  — scrape one chunk now",
               "/status — what is in the database",
               "/probe?kind=land — find the category name Divar accepts",
               "/probe-band?kind=apartment&min=1000000000&max=2000000000 — " +
               "does the price filter work"],
    });
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
