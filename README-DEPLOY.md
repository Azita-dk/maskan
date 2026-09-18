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

## Endpoints

- /status on any worker — counts, no side effects
- /seed on maskan-scrape — registers cities and kinds, safe to re-run
- /probe?kind=land on maskan-scrape — tries category names against Divar
- /run — do not use; the cron does the same work with more headroom
