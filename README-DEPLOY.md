# Deploying

Each folder is one Cloudflare Worker. From inside it:

    npx wrangler deploy

Check the output says "Uploaded" and a "Current Version ID". A red
"ERROR Build failed" means it did NOT deploy and the old code is still
running — it looks like success otherwise.

| Folder | Worker | Runs |
|---|---|---|
| cf-scrape | maskan-scrape | hourly |
| cf-enrich | maskan-enrich | every minute |
| cf-build | maskan-build | every 10 minutes |
| site | the website | see below |

## Delete the two extra enrich workers

maskan-enrich-b and maskan-enrich-c are no longer used — one worker does the
whole queue on the paid plan. Cloudflare dashboard -> Workers & Pages ->
each one -> Settings -> Delete. Leaving them running would triple the D1
reads for no benefit.

## site

These are the frontend files only. This folder has NO wrangler.toml —
keep the one you already have, because I do not have a copy of it.

## Check afterwards

- maskan-scrape -> Deployments: the top entry should say seconds ago
- maskan-scrape -> Observability: no red bars
- https://maskan-enrich.azita-maskan.workers.dev/status
- https://maskan-scrape.azita-maskan.workers.dev/status

## Price bands — one-off, do this once

Divar stops paging at ~215 pages, so one search reaches about 5,600 listings
however often it runs. Tehran has 177,125 apartments and the database held
12% of them. Each search has its own allowance, so the same city is now swept
once per price band.

1. Deploy cf-scrape with the new scrape.js
2. D1 console: run migrate-bands.sql, one block at a time
3. Open https://maskan-scrape.azita-maskan.workers.dev/seed
4. Check: SELECT COUNT(*) FROM scrape_state;  -> about 1,728

A full pass is 1,728 combinations at 720 runs a day, so roughly two and a
half days. After that most runs find nothing changed and are cheap.

If the log says "band too wide" for a city, that band filled all 215 pages
and is still hiding listings — it needs splitting in BANDS in scrape.js.

## Endpoints

- /status on any worker — counts, no side effects
- /seed on maskan-scrape — registers cities and kinds, safe to re-run
- /probe?kind=land on maskan-scrape — tries category names against Divar
- /run — do not use; the cron does the same work with more headroom
