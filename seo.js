const SITE = "https://maskanhub.com";
const KIND_LABEL = { apartment: "آپارتمان", villa: "خانه و ویلا", land: "زمین و کلنگی" };
const MONTHS = ["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];

const faDigits = (s) => String(s).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[+d]);
const FA = (n) => faDigits(Math.round(n).toLocaleString("en-US")).replace(/,/g, "٬");
const FA1 = (n) => faDigits((Math.round(n * 10) / 10).toFixed(1)).replace(".", "٫");
const esc = (t) => String(t ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function jalali(d) {
  let gy = d.getUTCFullYear(); const gm = d.getUTCMonth() + 1, gd = d.getUTCDate();
  const g = [0,31,59,90,120,151,181,212,243,273,304,334];
  let jy = gy <= 1600 ? 0 : 979; gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
           + Math.floor((gy2 + 399) / 400) - 80 + gd + g[gm - 1];
  jy += 33 * Math.floor(days / 12053); days %= 12053;
  jy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return `${faDigits(jd)} ${MONTHS[jm - 1]} ${faDigits(jy)}`;
}
const monthLabel = (k) => `${MONTHS[k % 12]} ${faDigits(Math.floor(k / 12))}`;

async function stats(env) {
  return (await env.SITE.get("data/stats.json", { type: "json" })) || { cities: [] };
}

function page({ title, desc, canonical, body, jsonld }) {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:locale" content="fa_IR">
<link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet">
<link rel="stylesheet" href="/app.css">
<style>
.seo{max-width:900px;margin:0 auto;padding:0 20px 40px}
.seo h1{font-size:26px;font-weight:800;margin:28px 0 8px}
.seo p.lead{color:var(--muted);font-size:15px;line-height:1.9;margin:0 0 18px}
.seo .facts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 20px}
.seo .facts div{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:14px}
.seo .facts small{display:block;color:var(--muted);font-size:12px}
.seo .facts b{display:block;font-size:22px;margin-top:4px}
.seo table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--rule);border-radius:12px;overflow:hidden}
.seo th,.seo td{padding:10px 14px;border-bottom:1px solid var(--rule);text-align:start;font-size:14px}
.seo th{color:var(--muted);font-weight:600;font-size:12.5px}
.seo h2{font-size:19px;margin:28px 0 10px}
.seo .cta{display:inline-block;margin:6px 0 18px;background:var(--green);color:#fff;border-radius:10px;padding:11px 18px;font-weight:700;text-decoration:none}
.seo .cities{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}
.seo .cities a{display:inline-block;border:1px solid var(--rule);background:var(--card);border-radius:999px;padding:6px 12px;color:var(--ink);text-decoration:none;font-size:13.5px}
.seo nav.top{display:flex;justify-content:space-between;align-items:center;padding:16px 0}
.seo nav.top a{color:var(--green);font-weight:700;text-decoration:none}
@media (max-width:600px){.seo .facts{grid-template-columns:1fr 1fr}.seo h1{font-size:21px}}
</style>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ""}
</head>
<body>
<main class="seo">
<nav class="top"><a href="/">تحلیل بازار مسکن</a><a href="/shahr">همه شهرها</a></nav>
${body}
<p style="color:var(--muted);font-size:12.5px;margin-top:30px">ارقام از آگهی‌های عمومی فروش در دیوار و شیپور گردآوری می‌شود و قیمت درخواستی فروشنده است، نه قیمت معامله‌شده.</p>
</main>
</body>
</html>`;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=3600",
  } });
}

async function cityPage(env, name) {
  const s = await stats(env);
  const c = s.cities.find((x) => x.name === name);
  if (!c) return null;
  const file = (await env.SITE.get(`data/${c.id}.json`, { type: "json" })) || {};
  const kinds = c.byKind || { apartment: { n: c.n, median: c.median } };
  const apt = kinds.apartment || Object.values(kinds)[0] || {};

  const hoods = (file.rows || [])
    .filter((r) => (r.k || "apartment") === "apartment" && r.n >= 10 && r.median > 0 && r.hood !== "نامشخص")
    .sort((a, b) => b.median - a.median);
  const dear = hoods.length >= 6 ? hoods.slice(0, 3).map((h) => h.hood) : [];
  const cheap = hoods.length >= 6 ? hoods.slice(-3).reverse().map((h) => h.hood) : [];

  const monthly = ((file.monthly || {}).apartment || []).filter((m) => m[2] > 0);
  let change = "";
  if (monthly.length >= 2) {
    const a = monthly[monthly.length - 2], b = monthly[monthly.length - 1];
    const pct = (b[2] - a[2]) / a[2] * 100;
    change = `میانه قیمت هر متر از ${monthLabel(a[0])} تا ${monthLabel(b[0])} ` +
      `${pct >= 0 ? "حدود " + FA1(pct) + "٪ بالا رفته" : "حدود " + FA1(-pct) + "٪ پایین آمده"} است.`;
  }

  const updated = s.generated ? new Date(s.generated) : new Date();
  const title = `قیمت آپارتمان در ${name} — قیمت هر متر و روند بازار مسکن | تحلیل بازار مسکن`;
  const desc = `میانه قیمت هر متر آپارتمان در ${name} ${apt.median ? FA1(apt.median) + " میلیون تومان" : ""} ` +
    `بر پایه ${FA(apt.n || 0)} آگهی فروش. قیمت محله‌ها، روند ماهانه و آگهی‌های ${name}.`;

  const kindLines = Object.entries(kinds).filter(([, v]) => v && v.n).map(([k, v]) =>
    `<tr><td>${KIND_LABEL[k] || k}</td><td>${v.median ? FA1(v.median) + " میلیون" : "—"}</td><td>${FA(v.n)}</td></tr>`).join("");

  const hoodRows = hoods.slice(0, 40).map((h) =>
    `<tr><td>${esc(h.hood)}</td><td>${FA1(h.median)} میلیون</td><td>${FA(h.n)}</td></tr>`).join("");

  const others = s.cities.filter((x) => x.name !== name).sort((a, b) => (b.n || 0) - (a.n || 0)).slice(0, 24);

  const body = `
<h1>قیمت آپارتمان در ${esc(name)}</h1>
<p class="lead">میانه قیمت هر متر مربع آپارتمان در ${esc(name)} ${apt.median ? `<b>${FA1(apt.median)} میلیون تومان</b>` : "هنوز محاسبه نشده"} است،
بر پایه ${FA(apt.n || 0)} آگهی فروش فعال.
${dear.length ? `گران‌ترین محله‌ها ${dear.map(esc).join("، ")} و ارزان‌ترین‌ها ${cheap.map(esc).join("، ")} هستند.` : ""}
${change}
آخرین به‌روزرسانی: ${jalali(updated)}.</p>
<a class="cta" href="/?city=${encodeURIComponent(c.id)}">نمودارها، نقشه و آگهی‌های ${esc(name)} ←</a>
<div class="facts">
  <div><small>میانه هر متر آپارتمان</small><b>${apt.median ? FA1(apt.median) : "—"}</b><small>میلیون تومان</small></div>
  <div><small>آگهی فروش آپارتمان</small><b>${FA(apt.n || 0)}</b><small>فعال</small></div>
  <div><small>محله‌های دارای داده</small><b>${FA(hoods.length)}</b><small>محله</small></div>
  <div><small>تغییر ماهانه</small><b>${monthly.length >= 2 ? (() => { const a = monthly[monthly.length - 2][2], b = monthly[monthly.length - 1][2]; const p = (b - a) / a * 100; return (p >= 0 ? "+" : "−") + FA1(Math.abs(p)) + "٪"; })() : "—"}</b><small>قیمت هر متر</small></div>
</div>
<h2>قیمت بر پایه نوع ملک در ${esc(name)}</h2>
<table><thead><tr><th>نوع ملک</th><th>میانه هر متر</th><th>تعداد آگهی</th></tr></thead><tbody>${kindLines}</tbody></table>
${hoodRows ? `<h2>قیمت آپارتمان در محله‌های ${esc(name)}</h2>
<table><thead><tr><th>محله</th><th>میانه هر متر</th><th>تعداد آگهی</th></tr></thead><tbody>${hoodRows}</tbody></table>` : ""}
<h2>شهرهای دیگر</h2>
<ul class="cities">${others.map((o) => `<li><a href="/shahr/${encodeURIComponent(o.name)}">قیمت مسکن ${esc(o.name)}</a></li>`).join("")}</ul>`;

  return page({
    title, desc, canonical: `${SITE}/shahr/${encodeURIComponent(name)}`, body,
    jsonld: { "@context": "https://schema.org", "@type": "Dataset",
      name: `قیمت آپارتمان در ${name}`, description: desc,
      url: `${SITE}/shahr/${encodeURIComponent(name)}`,
      dateModified: updated.toISOString().slice(0, 10),
      spatialCoverage: { "@type": "Place", name: `${name}، ایران` },
      creator: { "@type": "Organization", name: "تحلیل بازار مسکن", url: SITE } },
  });
}

async function cityIndex(env) {
  const s = await stats(env);
  const list = [...s.cities].sort((a, b) => (b.n || 0) - (a.n || 0));
  const rows = list.map((c) => `<tr><td><a href="/shahr/${encodeURIComponent(c.name)}" style="color:var(--green);font-weight:700;text-decoration:none">${esc(c.name)}</a></td>
    <td>${c.median ? FA1(c.median) + " میلیون" : "—"}</td><td>${FA(c.n || 0)}</td></tr>`).join("");
  return page({
    title: "قیمت مسکن در شهرهای ایران — قیمت هر متر آپارتمان | تحلیل بازار مسکن",
    desc: `میانه قیمت هر متر آپارتمان در ${FA(list.length)} شهر ایران، بر پایه آگهی‌های فروش دیوار و شیپور، با قیمت محله‌ها و روند ماهانه.`,
    canonical: `${SITE}/shahr`,
    body: `<h1>قیمت مسکن در شهرهای ایران</h1>
<p class="lead">میانه قیمت هر متر مربع آپارتمان در ${FA(list.length)} شهر، از آگهی‌های فروش فعال در دیوار و شیپور. روی هر شهر بزنید تا قیمت محله‌ها و روند بازار آن را ببینید.</p>
<table><thead><tr><th>شهر</th><th>میانه هر متر آپارتمان</th><th>تعداد آگهی</th></tr></thead><tbody>${rows}</tbody></table>`,
  });
}

async function sitemap(env) {
  const s = await stats(env);
  const day = (s.generated || new Date().toISOString()).slice(0, 10);
  const urls = ["/", "/stats", "/compare", "/ads", "/value", "/about", "/shahr",
    ...s.cities.map((c) => `/shahr/${encodeURIComponent(c.name)}`)];
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${day}</lastmod><changefreq>daily</changefreq></url>`).join("\n")}
</urlset>`;
  return new Response(body, { headers: {
    "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

const ROBOTS = `User-agent: *
Allow: /
Disallow: /data/
Disallow: /cf-
Sitemap: ${SITE}/sitemap.xml
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
    try {
      if (path === "/robots.txt") return new Response(ROBOTS, { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (path === "/sitemap.xml") return sitemap(env);
      if (path === "/shahr") return html(await cityIndex(env));
      if (path.startsWith("/shahr/")) {
        const p = await cityPage(env, path.slice(7));
        if (p) return html(p);
        return html(page({ title: "شهر پیدا نشد | تحلیل بازار مسکن", desc: "", canonical: `${SITE}/shahr`,
          body: `<h1>این شهر پیدا نشد</h1><p class="lead"><a href="/shahr">فهرست همه شهرها</a></p>` }), 404);
      }
    } catch (e) {
      return new Response("error", { status: 500 });
    }
    return env.ASSETS.fetch(request);
  },
};
