/* Shared across every page.
 *
 * The filter state lives in the address bar rather than in a variable, which
 * is what makes the pages agree with each other: navigating from the map to
 * the statistics carries the city, the neighbourhood and every filter along
 * with it, and a link someone sends to a friend opens on the same view.
 */

const DATA_BASE = 'https://maskan-build.azita-maskan.workers.dev';
const APP_VERSION = '2026-09-03 18:20';

/* ------------------------------------------------------------- numbers */
const FA_DIGITS = t => String(t).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
const FA  = n => Number(n).toLocaleString('fa-IR').replace(/,/g, '\u066C');
const FA1 = n => Number(n).toLocaleString('fa-IR',
  { minimumFractionDigits: 1, maximumFractionDigits: 1 }).replace(/,/g, '\u066C');
// A year is not a quantity. FA(1405) gives ۱٬۴۰۵, which is not a year.
const FA_YEAR = y => FA_DIGITS(y);

const esc = t => String(t ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const median = a => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = v => Math.round(v * 10) / 10;
const CSSVAR = n => getComputedStyle(document.documentElement)
  .getPropertyValue(n).trim();

/* -------------------------------------------------------------- jalali */
const J_MONTHS = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور',
                  'مهر','آبان','آذر','دی','بهمن','اسفند'];
function toJalali(gy, gm, gd){
  const gdm = [0,31,59,90,120,151,181,212,243,273,304,334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365*gy + Math.floor((gy2+3)/4) - Math.floor((gy2+99)/100)
           + Math.floor((gy2+399)/400) - 80 + gd + gdm[gm-1];
  jy += 33 * Math.floor(days/12053); days %= 12053;
  jy += 4 * Math.floor(days/1461); days %= 1461;
  if (days > 365){ jy += Math.floor((days-1)/365); days = (days-1)%365; }
  const jm = days < 186 ? 1 + Math.floor(days/31) : 7 + Math.floor((days-186)/30);
  const jd = 1 + (days < 186 ? days%31 : (days-186)%30);
  return [jy, jm, jd];
}
function faDate(iso){
  const [y,m,d] = iso.split('-').map(Number);
  const [jy,jm,jd] = toJalali(y,m,d);
  return `${FA_DIGITS(jd)} ${J_MONTHS[jm-1]} ${FA_YEAR(jy)}`;
}
function faShortDate(iso){
  const [y,m,d] = iso.split('-').map(Number);
  const [,jm,jd] = toJalali(y,m,d);
  return `${FA_DIGITS(jd)} ${J_MONTHS[jm-1]}`;
}
function faMonth(iso){
  const [y,m,d] = iso.split('-').map(Number);
  const [jy,jm] = toJalali(y,m,d);
  return `${J_MONTHS[jm-1]} ${FA_YEAR(jy)}`;
}

const PROVINCE = {
 "کرج": "البرز",
 "فردیس": "البرز",
 "نظرآباد": "البرز",
 "هشتگرد": "البرز",
 "کمال‌شهر": "البرز",
 "محمدشهر": "البرز",
 "ماهدشت": "البرز",
 "مشکین‌دشت": "البرز",
 "گرمدره": "البرز",
 "اشتهارد": "البرز",
 "طالقان": "البرز",
 "تهران": "تهران",
 "شهریار": "تهران",
 "اسلامشهر": "تهران",
 "ملارد": "تهران",
 "قدس": "تهران",
 "ورامین": "تهران",
 "پاکدشت": "تهران",
 "رباط کریم": "تهران",
 "پردیس": "تهران",
 "اندیشه": "تهران",
 "پرند": "تهران",
 "ری": "تهران",
 "شهر ری": "تهران",
 "بومهن": "تهران",
 "نسیم شهر": "تهران",
 "صالحیه": "تهران",
 "فیروزکوه": "تهران",
 "دماوند": "تهران",
 "مشهد": "خراسان رضوی",
 "نیشابور": "خراسان رضوی",
 "سبزوار": "خراسان رضوی",
 "تربت حیدریه": "خراسان رضوی",
 "کاشمر": "خراسان رضوی",
 "قوچان": "خراسان رضوی",
 "تربت جام": "خراسان رضوی",
 "گناباد": "خراسان رضوی",
 "طرقبه": "خراسان رضوی",
 "چناران": "خراسان رضوی",
 "سرخس": "خراسان رضوی",
 "اصفهان": "اصفهان",
 "کاشان": "اصفهان",
 "نجف‌آباد": "اصفهان",
 "نجف آباد": "اصفهان",
 "خمینی‌شهر": "اصفهان",
 "خمینی شهر": "اصفهان",
 "شاهین‌شهر": "اصفهان",
 "شاهین شهر": "اصفهان",
 "فولادشهر": "اصفهان",
 "گلپایگان": "اصفهان",
 "شهرضا": "اصفهان",
 "مبارکه": "اصفهان",
 "اردستان": "اصفهان",
 "نطنز": "اصفهان",
 "شیراز": "فارس",
 "مرودشت": "فارس",
 "جهرم": "فارس",
 "کازرون": "فارس",
 "فسا": "فارس",
 "لار": "فارس",
 "داراب": "فارس",
 "صدرا": "فارس",
 "نی‌ریز": "فارس",
 "اقلید": "فارس",
 "تبریز": "آذربایجان شرقی",
 "مراغه": "آذربایجان شرقی",
 "مرند": "آذربایجان شرقی",
 "اهر": "آذربایجان شرقی",
 "میانه": "آذربایجان شرقی",
 "بناب": "آذربایجان شرقی",
 "سراب": "آذربایجان شرقی",
 "شبستر": "آذربایجان شرقی",
 "آذرشهر": "آذربایجان شرقی",
 "ارومیه": "آذربایجان غربی",
 "خوی": "آذربایجان غربی",
 "مهاباد": "آذربایجان غربی",
 "بوکان": "آذربایجان غربی",
 "میاندوآب": "آذربایجان غربی",
 "سلماس": "آذربایجان غربی",
 "پیرانشهر": "آذربایجان غربی",
 "نقده": "آذربایجان غربی",
 "ماکو": "آذربایجان غربی",
 "اهواز": "خوزستان",
 "دزفول": "خوزستان",
 "آبادان": "خوزستان",
 "خرمشهر": "خوزستان",
 "اندیمشک": "خوزستان",
 "شوشتر": "خوزستان",
 "بهبهان": "خوزستان",
 "ماهشهر": "خوزستان",
 "بندر ماهشهر": "خوزستان",
 "شوش": "خوزستان",
 "ایذه": "خوزستان",
 "مسجدسلیمان": "خوزستان",
 "مسجد سلیمان": "خوزستان",
 "رامهرمز": "خوزستان",
 "ساری": "مازندران",
 "بابل": "مازندران",
 "آمل": "مازندران",
 "قائم‌شهر": "مازندران",
 "قائم شهر": "مازندران",
 "بابلسر": "مازندران",
 "چالوس": "مازندران",
 "نوشهر": "مازندران",
 "تنکابن": "مازندران",
 "رامسر": "مازندران",
 "محمودآباد": "مازندران",
 "بهشهر": "مازندران",
 "نکا": "مازندران",
 "نور": "مازندران",
 "فریدونکنار": "مازندران",
 "سرخرود": "مازندران",
 "ایزدشهر": "مازندران",
 "رشت": "گیلان",
 "بندر انزلی": "گیلان",
 "انزلی": "گیلان",
 "لاهیجان": "گیلان",
 "لنگرود": "گیلان",
 "رودسر": "گیلان",
 "آستارا": "گیلان",
 "تالش": "گیلان",
 "فومن": "گیلان",
 "صومعه‌سرا": "گیلان",
 "صومعه سرا": "گیلان",
 "آستانه اشرفیه": "گیلان",
 "ماسال": "گیلان",
 "رودبار": "گیلان",
 "همدان": "همدان",
 "ملایر": "همدان",
 "نهاوند": "همدان",
 "تویسرکان": "همدان",
 "اسدآباد": "همدان",
 "بهار": "همدان",
 "کبودرآهنگ": "همدان",
 "رزن": "همدان",
 "کرمان": "کرمان",
 "سیرجان": "کرمان",
 "رفسنجان": "کرمان",
 "بم": "کرمان",
 "جیرفت": "کرمان",
 "زرند": "کرمان",
 "بردسیر": "کرمان",
 "کهنوج": "کرمان",
 "کرمانشاه": "کرمانشاه",
 "اسلام‌آباد غرب": "کرمانشاه",
 "کنگاور": "کرمانشاه",
 "سنقر": "کرمانشاه",
 "هرسین": "کرمانشاه",
 "جوانرود": "کرمانشاه",
 "پاوه": "کرمانشاه",
 "سنندج": "کردستان",
 "سقز": "کردستان",
 "مریوان": "کردستان",
 "بانه": "کردستان",
 "قروه": "کردستان",
 "بیجار": "کردستان",
 "کامیاران": "کردستان",
 "خرم‌آباد": "لرستان",
 "خرم آباد": "لرستان",
 "بروجرد": "لرستان",
 "دورود": "لرستان",
 "الیگودرز": "لرستان",
 "کوهدشت": "لرستان",
 "الشتر": "لرستان",
 "نورآباد": "لرستان",
 "گرگان": "گلستان",
 "گنبد کاووس": "گلستان",
 "علی‌آباد": "گلستان",
 "علی آباد": "گلستان",
 "بندر ترکمن": "گلستان",
 "آق‌قلا": "گلستان",
 "کردکوی": "گلستان",
 "مینودشت": "گلستان",
 "اراک": "مرکزی",
 "ساوه": "مرکزی",
 "خمین": "مرکزی",
 "محلات": "مرکزی",
 "دلیجان": "مرکزی",
 "شازند": "مرکزی",
 "تفرش": "مرکزی",
 "قزوین": "قزوین",
 "تاکستان": "قزوین",
 "الوند": "قزوین",
 "آبیک": "قزوین",
 "بوئین‌زهرا": "قزوین",
 "محمدیه": "قزوین",
 "زنجان": "زنجان",
 "ابهر": "زنجان",
 "خرمدره": "زنجان",
 "قیدار": "زنجان",
 "سمنان": "سمنان",
 "شاهرود": "سمنان",
 "دامغان": "سمنان",
 "گرمسار": "سمنان",
 "مهدی‌شهر": "سمنان",
 "یزد": "یزد",
 "میبد": "یزد",
 "اردکان": "یزد",
 "بافق": "یزد",
 "مهریز": "یزد",
 "تفت": "یزد",
 "اشکذر": "یزد",
 "بندرعباس": "هرمزگان",
 "قشم": "هرمزگان",
 "میناب": "هرمزگان",
 "کیش": "هرمزگان",
 "بندر لنگه": "هرمزگان",
 "رودان": "هرمزگان",
 "بوشهر": "بوشهر",
 "برازجان": "بوشهر",
 "گناوه": "بوشهر",
 "بندر گناوه": "بوشهر",
 "دیلم": "بوشهر",
 "عسلویه": "بوشهر",
 "خورموج": "بوشهر",
 "کنگان": "بوشهر",
 "زاهدان": "سیستان و بلوچستان",
 "زابل": "سیستان و بلوچستان",
 "ایرانشهر": "سیستان و بلوچستان",
 "چابهار": "سیستان و بلوچستان",
 "سراوان": "سیستان و بلوچستان",
 "خاش": "سیستان و بلوچستان",
 "اردبیل": "اردبیل",
 "پارس‌آباد": "اردبیل",
 "پارس آباد": "اردبیل",
 "مشگین‌شهر": "اردبیل",
 "مشگین شهر": "اردبیل",
 "خلخال": "اردبیل",
 "گرمی": "اردبیل",
 "بجنورد": "خراسان شمالی",
 "شیروان": "خراسان شمالی",
 "اسفراین": "خراسان شمالی",
 "آشخانه": "خراسان شمالی",
 "بیرجند": "خراسان جنوبی",
 "قائن": "خراسان جنوبی",
 "فردوس": "خراسان جنوبی",
 "طبس": "خراسان جنوبی",
 "نهبندان": "خراسان جنوبی",
 "قم": "قم",
 "ایلام": "ایلام",
 "دهلران": "ایلام",
 "ایوان": "ایلام",
 "آبدانان": "ایلام",
 "شهرکرد": "چهارمحال و بختیاری",
 "بروجن": "چهارمحال و بختیاری",
 "فارسان": "چهارمحال و بختیاری",
 "لردگان": "چهارمحال و بختیاری",
 "یاسوج": "کهگیلویه و بویراحمد",
 "گچساران": "کهگیلویه و بویراحمد",
 "دوگنبدان": "کهگیلویه و بویراحمد",
 "دهدشت": "کهگیلویه و بویراحمد"
};

// A city not in the table is shown under its own name rather than dropped,
// so a new city appearing in the data never vanishes from the list.
function provinceOf(city){ return PROVINCE[city] || city; }

// localeCompare with 'fa' orders the Persian alphabet properly; a plain
// sort would use code points and put ی before ک.
const byFa = (a, b) => String(a).localeCompare(String(b), 'fa');

/* ------------------------------------------------------- shared state */
const PAGES = [
  { file:'index.html',  label:'صفحه اصلی' },
  { file:'cities.html', label:'شهرها و محله‌ها' },
  { file:'stats.html',  label:'آمار و نمودارها' },
  { file:'ads.html',    label:'آگهی‌ها و نقشه' },
  { file:'value.html',  label:'قیمت خانه من' },
  { file:'about.html',  label:'روش کار' },
];

const DEFAULTS = { city:'', hood:'', min:'0', max:'9999', rooms:'all',
                   age:'999', date:'0', sample:'20', q:'', feat:'' };

const S = { ...DEFAULTS };          // current filter state
let DB = null, CITY = null;

function readState(){
  const p = new URLSearchParams(location.search);
  for (const k of Object.keys(DEFAULTS))
    S[k] = p.get(k) ?? DEFAULTS[k];
}

function writeState(replace){
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(S))
    if (v && v !== DEFAULTS[k]) p.set(k, v);
  const url = location.pathname + (p.toString() ? '?' + p : '');
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
}

function linkTo(file){
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(S))
    if (v && v !== DEFAULTS[k]) p.set(k, v);
  return file + (p.toString() ? '?' + p : '');
}

const featureSet = () => new Set(S.feat ? S.feat.split(',').filter(Boolean) : []);

/* ------------------------------------------------------------ filtering */
function ageOk(l, age){
  if (age === 999) return true;
  if (l.g == null) return false;
  if (age === 0) return l.g <= 1;
  if (age === 21) return l.g > 20;
  return l.g <= age;
}

/**
 * The one filter every page uses.
 *
 * `except` leaves a single control out, so a chart can show the choice the
 * reader made in the context of what they narrowed away from.
 */
function passes(l, except){
  const minA = +S.min, maxA = +S.max, age = +S.age, days = +S.date;
  const feats = featureSet();
  const cutoff = days
    ? new Date(Date.now() - days*864e5).toISOString().slice(0,10) : null;
  return (except === 'area' || (l.a >= minA && l.a <= maxA))
    && (except === 'rooms' || S.rooms === 'all' || String(l.r) === S.rooms)
    && (except === 'age'   || ageOk(l, age))
    && (!cutoff || (l.d && l.d >= cutoff))
    && (!feats.size || [...feats].every(f => (l.f || []).includes(f)))
    && (!S.q || matches(hay(l), S.q));
}

const hay = l => [l.n, l.h, l.ad, ...(l.f || [])].filter(Boolean).join(' ');
const norm = t => String(t).replace(/[يﻯﻰ]/g,'ی').replace(/[ك]/g,'ک')
  .replace(/آ/g,'ا').replace(/[\u064B-\u0652\u200c\u0640]/g,'').toLowerCase();
const matches = (text, q) => norm(text).includes(norm(q));

function activeListings(except){
  const all = (CITY && CITY.listings) || [];
  const inHood = l => !S.hood || l.h === S.hood;
  return all.filter(l => passes(l, except) && inHood(l));
}
function cityWideListings(){
  return ((CITY && CITY.listings) || []).filter(l => passes(l));
}

function activeFilterCount(){
  let n = 0;
  if (S.min !== DEFAULTS.min) n++;
  if (S.max !== DEFAULTS.max) n++;
  if (S.rooms !== DEFAULTS.rooms) n++;
  if (S.age !== DEFAULTS.age) n++;
  if (S.date !== DEFAULTS.date) n++;
  return n + featureSet().size;
}

/* ------------------------------------------------------------ confidence */
function confLevel(n){
  if (n >= 100) return { cls:'hi',  label:'اعتبار بالا',   short:'بالا' };
  if (n >= 20)  return { cls:'mid', label:'اعتبار متوسط', short:'متوسط' };
  return          { cls:'lo',  label:'اعتبار کم',     short:'کم' };
}
function confBadge(n, short){
  const c = confLevel(n);
  return `<span class="conf ${c.cls}"><i></i><b>${short ? c.short : c.label}</b></span>`;
}

/* ------------------------------------------------------------ price heat */
function heat(v, lo, hi){
  if (!isFinite(v) || hi <= lo) return '#12A06B';
  const stops = [[12,122,79],[242,199,68],[217,119,6],[179,38,30]];
  const x = Math.max(0, Math.min(1, (v-lo)/(hi-lo))) * (stops.length-1);
  const i = Math.min(stops.length-2, Math.floor(x)), f = x - i;
  const c = k => Math.round(stops[i][k] + (stops[i+1][k]-stops[i][k])*f);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

/* ------------------------------------------------------------ the icons */
const ico = b => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true">${b}</svg>`;
const ICONS = {
  search:  ico('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  theme:   ico('<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5A6.5 6.5 0 0 1 12 3.5z"/>'),
  burger:  ico('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  trend:   ico('<path d="M3 17l5.5-5.5 3.5 3.5L21 6"/><path d="M15 6h6v6"/>'),
  house:   ico('<path d="M3 10.5L12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>'),
  chart:   ico('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v8.5h8.5"/>'),
  clock:   ico('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h3M8 17.5h6"/>'),
  lock:    ico('<rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v2.5"/>'),
  refresh: ico('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 3.5V9h-5.5"/>'),
  data:    ico('<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>'),
  shield:  ico('<path d="M12 3l7.5 3v6c0 4.4-3.1 8.1-7.5 9-4.4-.9-7.5-4.6-7.5-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>'),
};

const LOGO = `<rect width="64" height="64" rx="14" fill="#0C7A4F"/>
  <path d="M14 30L32 16l18 14" stroke="#fff" stroke-width="5" fill="none"
        stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="18" y="36" width="7" height="12" rx="2" fill="#fff" opacity=".55"/>
  <rect x="28.5" y="31" width="7" height="17" rx="2" fill="#fff" opacity=".78"/>
  <rect x="39" y="26" width="7" height="22" rx="2" fill="#fff"/>`;

/* ------------------------------------------------------------- the nav */
function renderNav(current){
  const links = PAGES.map(p =>
    `<a href="${linkTo(p.file)}"${p.file === current ? ' class="on"' : ''}
       data-page="${p.file}">${p.label}</a>`).join('');
  document.body.insertAdjacentHTML('afterbegin', `
    <nav class="nav"><div class="wrap">
      <a class="brand" href="${linkTo('index.html')}">
        <svg class="mark" viewBox="0 0 64 64" aria-hidden="true">${LOGO}</svg>
        <span><b>تحلیل بازار مسکن</b><small>قیمت‌ها و روند بازار در یک نگاه</small></span>
      </a>
      <div class="menu" id="menu">${links}</div>
      <button class="iconbtn burger" id="burger" aria-label="فهرست">${ICONS.burger}</button>
      <button class="iconbtn" id="theme" title="روشن / تیره" aria-label="روشن یا تیره">${ICONS.theme}</button>
    </div></nav>`);

  document.getElementById('burger').addEventListener('click', () =>
    document.getElementById('menu').classList.toggle('open'));

  const saved = (() => { try { return localStorage.getItem('mk_theme'); } catch(e){ return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
  document.getElementById('theme').addEventListener('click', () => {
    const now = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = now;
    try { localStorage.setItem('mk_theme', now); } catch(e){}
    window.dispatchEvent(new Event('mk:theme'));
  });
}

/* Links are rebuilt whenever the filters change, so every page in the menu
   opens on the view the reader is currently looking at. */
function refreshNavLinks(){
  document.querySelectorAll('[data-page]').forEach(a =>
    a.href = linkTo(a.dataset.page));
  const brand = document.querySelector('.brand');
  if (brand) brand.href = linkTo('index.html');
}

/* ------------------------------------------------------- the search bar */
function renderSearchBar(host){
  host.innerHTML = `
    <div class="searchbar">
      <div class="search">
        <span class="go">${ICONS.search}</span>
        <input id="q" type="search" autocomplete="off"
               placeholder="جست‌وجوی شهر، محله، امکانات یا متن آگهی…">
        <button class="clear hide" id="qClear" aria-label="پاک کردن">×</button>
        <div class="sugg hide" id="sugg"></div>
      </div>

      <button class="filterbtn" id="filterBtn">فیلترها</button>

      <div class="filters" id="filters">
        <label><span>شهر</span><select id="fCity"></select></label>
        <label><span>محله</span><select id="fHood"></select></label>
        <label><span>حداقل متراژ</span><select id="fMin">
          <option value="0">بدون حد</option><option value="50">۵۰ متر</option>
          <option value="70">۷۰ متر</option><option value="90">۹۰ متر</option>
          <option value="120">۱۲۰ متر</option></select></label>
        <label><span>حداکثر متراژ</span><select id="fMax">
          <option value="70">۷۰ متر</option><option value="90">۹۰ متر</option>
          <option value="120">۱۲۰ متر</option><option value="150">۱۵۰ متر</option>
          <option value="9999">بدون حد</option></select></label>
        <label><span>اتاق خواب</span><select id="fRooms">
          <option value="all">همه</option><option value="1">۱ خوابه</option>
          <option value="2">۲ خوابه</option><option value="3">۳ خوابه</option>
          <option value="4">۴ خوابه و بیشتر</option></select></label>
        <label><span>سن بنا</span><select id="fAge">
          <option value="999">همه</option><option value="0">نوساز</option>
          <option value="5">تا ۵ سال</option><option value="10">تا ۱۰ سال</option>
          <option value="20">تا ۲۰ سال</option><option value="21">بالای ۲۰ سال</option>
          </select></label>
      </div>

      <div class="chips" id="chips"></div>
      <div class="summary" id="summary"></div>
    </div>`;

  const q = document.getElementById('q');
  q.value = S.q;
  document.getElementById('qClear').classList.toggle('hide', !S.q);

  fillCitySelect();
  fillHoodSelect();
  for (const [id, key] of [['fMin','min'],['fMax','max'],['fRooms','rooms'],['fAge','age']])
    document.getElementById(id).value = S[key];

  document.getElementById('fCity').addEventListener('change', async e => {
    S.city = e.target.value; S.hood = ''; S.q = '';
    await loadCity(S.city);
    fillHoodSelect();
    commit();
  });
  document.getElementById('fHood').addEventListener('change', e => {
    S.hood = e.target.value; commit();
  });
  for (const [id, key] of [['fMin','min'],['fMax','max'],['fRooms','rooms'],['fAge','age']])
    document.getElementById(id).addEventListener('change', e => {
      S[key] = e.target.value; commit();
    });

  document.getElementById('filterBtn').addEventListener('click', () =>
    document.getElementById('filters').classList.toggle('open'));

  document.getElementById('qClear').addEventListener('click', () => {
    S.q = ''; q.value = ''; closeSugg(); commit();
  });

  let timer = null;
  q.addEventListener('input', () => {
    document.getElementById('qClear').classList.toggle('hide', !q.value);
    drawSuggestions(q.value.trim());
    clearTimeout(timer);
    timer = setTimeout(() => { S.q = q.value.trim(); commit(); }, 260);
  });
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSugg(); q.blur(); }
    if (e.key === 'Enter')  { clearTimeout(timer); S.q = q.value.trim(); closeSugg(); commit(); }
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.search')) closeSugg();
  });
}

function fillCitySelect(){
  const sel = document.getElementById('fCity');
  if (!sel || !DB) return;
  const groups = {};
  for (const c of DB.cities) (groups[provinceOf(c.name)] ||= []).push(c);
  sel.innerHTML = Object.keys(groups).sort(byFa).map(prov => {
    const rows = groups[prov].sort((a, b) => byFa(a.name, b.name));
    return `<optgroup label="استان ${esc(prov)}">` + rows.map(c =>
      `<option value="${c.id}">${esc(c.name)} (${FA(c.n)} آگهی)</option>`).join('')
      + '</optgroup>';
  }).join('');
  sel.value = S.city;
}

function fillHoodSelect(){
  const sel = document.getElementById('fHood');
  if (!sel) return;
  const rows = ((CITY && CITY.rows) || [])
    .filter(r => r.n >= 10)
    .sort((a, b) => byFa(a.hood, b.hood));
  sel.innerHTML = '<option value="">همه محله‌ها</option>' +
    rows.map(r => `<option value="${esc(r.hood)}">${esc(r.hood)}</option>`).join('');
  // a neighbourhood from a different city cannot survive here
  if (S.hood && !rows.some(r => r.hood === S.hood)) S.hood = '';
  sel.value = S.hood;
}

function closeSugg(){
  const s = document.getElementById('sugg');
  if (s) s.classList.add('hide');
}

function drawSuggestions(term){
  const box = document.getElementById('sugg');
  if (!term || !DB) return closeSugg();
  const cities = DB.cities.filter(c => matches(c.name, term)).slice(0, 5);
  const hoods = ((CITY && CITY.rows) || [])
    .filter(r => matches(r.hood, term) && r.n >= 10).slice(0, 6);
  if (!cities.length && !hoods.length) {
    box.innerHTML = '<div class="head">چیزی پیدا نشد — همین متن در آگهی‌ها جست‌وجو می‌شود</div>';
    box.classList.remove('hide');
    return;
  }
  box.innerHTML =
    (cities.length ? '<div class="head">شهرها</div>' + cities.map(c =>
      `<div class="row" data-city="${c.id}"><span>${esc(c.name)}</span>
       <span class="meta">${FA(c.n)} آگهی</span></div>`).join('') : '') +
    (hoods.length ? `<div class="head">محله‌ها در ${esc(CITY.name)}</div>` +
      hoods.map(h => `<div class="row" data-hood="${esc(h.hood)}">
       <span>${esc(h.hood)}</span>
       <span class="meta">${FA1(h.median)} میلیون</span></div>`).join('') : '');
  box.classList.remove('hide');

  box.querySelectorAll('[data-city]').forEach(el =>
    el.addEventListener('click', async () => {
      S.city = el.dataset.city; S.hood = ''; S.q = '';
      document.getElementById('q').value = '';
      await loadCity(S.city);
      fillCitySelect(); fillHoodSelect(); closeSugg(); commit();
    }));
  box.querySelectorAll('[data-hood]').forEach(el =>
    el.addEventListener('click', () => {
      S.hood = el.dataset.hood; S.q = '';
      document.getElementById('q').value = '';
      fillHoodSelect(); closeSugg(); commit();
    }));
}

function drawChips(){
  const box = document.getElementById('chips');
  if (!box) return;
  const base = cityWideListings();
  const counts = {};
  for (const l of base) for (const f of (l.f || [])) counts[f] = (counts[f] || 0) + 1;
  const feats = featureSet();
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  box.innerHTML = top.map(([f, n]) =>
    `<button data-f="${esc(f)}"${feats.has(f) ? ' class="on"' : ''}>${esc(f)}
      <span class="c">${FA(n)}</span></button>`).join('');
  box.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      const f = b.dataset.f, cur = featureSet();
      cur.has(f) ? cur.delete(f) : cur.add(f);
      S.feat = [...cur].join(',');
      commit();
    }));
}

function drawSummary(){
  const box = document.getElementById('summary');
  if (!box) return;
  const n = activeListings().length;
  const where = S.hood ? `${esc(S.hood)}، ${esc(CITY.name)}` : esc(CITY ? CITY.name : '');
  const fc = activeFilterCount();
  box.innerHTML =
    `<span><b>${FA(n)}</b> آگهی در ${where}</span>` +
    (fc ? `<span>${FA(fc)} فیلتر فعال</span>` : '') +
    (S.q ? `<span>شامل «${esc(S.q)}»</span>` : '') +
    ((fc || S.q || S.hood) ? '<button class="reset" id="resetAll">پاک کردن فیلترها</button>' : '');
  const r = document.getElementById('resetAll');
  if (r) r.addEventListener('click', () => {
    const city = S.city;
    Object.assign(S, DEFAULTS, { city });
    const q = document.getElementById('q'); if (q) q.value = '';
    for (const [id, key] of [['fMin','min'],['fMax','max'],['fRooms','rooms'],['fAge','age']])
      document.getElementById(id).value = S[key];
    fillHoodSelect();
    commit();
  });

  const btn = document.getElementById('filterBtn');
  if (btn) btn.innerHTML = fc ? `فیلترها <span class="n">${FA(fc)}</span>` : 'فیلترها';
}

/* Every page registers what to redraw; the search bar calls it. */
let PAGE_RENDER = () => {};
function commit(){
  writeState(true);
  refreshNavLinks();
  drawChips();
  drawSummary();
  PAGE_RENDER();
}

/* ---------------------------------------------------------- data access */
async function loadStats(){
  DB = await (await fetch(DATA_BASE + '/data/stats.json')).json();
  return DB;
}
async function loadCity(id){
  CITY = await (await fetch(`${DATA_BASE}/data/${id}.json`)).json();
  CITY.id = id;
  return CITY;
}

/**
 * Everything a page needs before it can draw, in the right order.
 * A page calls this and then its own render; nothing else.
 */
async function bootPage(currentFile, render){
  readState();
  renderNav(currentFile);
  try {
    await loadStats();
  } catch (e) {
    document.getElementById('main').innerHTML =
      '<div class="loading">داده‌ها بارگذاری نشد. اتصال را بررسی کنید و صفحه را دوباره باز کنید.</div>';
    return;
  }
  if (!S.city || !DB.cities.some(c => c.id === S.city)) S.city = DB.cities[0].id;
  try { await loadCity(S.city); } catch (e) {}

  const host = document.getElementById('searchHost');
  if (host) renderSearchBar(host);

  PAGE_RENDER = render;
  writeState(true);
  refreshNavLinks();
  drawChips();
  drawSummary();
  render();

  const ver = document.getElementById('ver');
  if (ver) ver.textContent = `نسخه ${faDate(APP_VERSION.split(' ')[0])}`;

  window.addEventListener('mk:theme', () => render());
  window.addEventListener('popstate', async () => {
    readState();
    if (CITY && CITY.id !== S.city) await loadCity(S.city);
    fillCitySelect(); fillHoodSelect(); drawChips(); drawSummary(); render();
  });
}
