# Going back to the free plan

Four numbers. Change them, redeploy that folder, done.

| Folder | Setting | Paid | **Free** |
|---|---|---|---|
| cf-scrape | PAGES_PER_RUN | 300 | **40** |
| cf-enrich | PER_RUN | 300 | **15** |
| cf-enrich | SHARDS | 1 | **3** |
| cf-build | SLICE | 48 | **8** |
| cf-build | crons | */5 * * * * | **\*/10 * * * *** |
| cf-scrape | crons | */2 * * * * | **0 * * * *** |
| cf-scrape | PAUSE_MS | 250 | **400** |

Each is in that folder's `wrangler.toml`, under `[vars]`. The free value is
written in the comment above it too.

After changing each one:

    cd C:\maskan\<folder>
    npx wrangler deploy

Enrichment also needs its two extra workers back: on free, one worker at 15
a minute cannot keep up with what the scraper adds. Copy cf-enrich twice to
cf-enrich-b and cf-enrich-c, set `name` to maskan-enrich-b / maskan-enrich-c
and `SHARD` to "1" / "2" (SHARDS = "3" in all three), then deploy each.

Do all of this before the paid month ends. On free limits the paid values fail:
enrichment dies at the 10 ms CPU limit, the scraper exceeds 50 subrequests,
and the build worker exceeds CPU — the same failures as the week of 11–16
September.

## Before downgrading, check D1 storage

Free D1 allows 5 GB. Storage & Databases -> D1 -> maskan. It was 97 MB on
16 September. If a month of faster collection put it over 5 GB, the
downgrade is a real problem rather than just slower — deal with that first.

## What is safe to keep

Nothing else here depends on the paid plan. The code is the same either way;
only these five numbers change.
