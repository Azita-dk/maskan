-- Adds property kind: apartment, villa, land.
--
-- Run this in the D1 console, one block at a time, with the scraper cron
-- paused. It rewrites three tables because SQLite cannot alter a primary
-- key, and kind has to be part of the key rather than an ordinary column:
-- a villa and a flat in the same neighbourhood on the same day are two
-- separate measurements, not one.
--
-- Nothing is deleted. Every existing row becomes kind='apartment', which is
-- what it is — the scraper has only ever asked Divar for apartment-sell.

-- ---------------------------------------------------------------- 1 of 5
-- New columns on listings. Cheap: SQLite adds a column without rewriting
-- the table, and both are nullable.
ALTER TABLE listings ADD COLUMN kind TEXT;
ALTER TABLE listings ADD COLUMN land_area_m2 REAL;

-- ---------------------------------------------------------------- 2 of 5
-- Everything collected so far is a flat.
-- About 113,000 row writes, so this alone is most of a day's budget.
UPDATE listings SET kind = 'apartment' WHERE kind IS NULL;

-- ---------------------------------------------------------------- 3 of 5
-- city_snapshots: kind joins the primary key.
CREATE TABLE city_snapshots_v2 (
  city       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'apartment',
  day        TEXT NOT NULL,
  jyear      INTEGER,
  jmonth     INTEGER,
  median_m2  REAL,
  n_listings INTEGER,
  PRIMARY KEY (city, kind, day)
);
INSERT INTO city_snapshots_v2 (city, kind, day, jyear, jmonth, median_m2, n_listings)
  SELECT city, 'apartment', day, jyear, jmonth, median_m2, n_listings
  FROM city_snapshots;
DROP TABLE city_snapshots;
ALTER TABLE city_snapshots_v2 RENAME TO city_snapshots;

-- ---------------------------------------------------------------- 4 of 5
-- hood_snapshots: the same.
CREATE TABLE hood_snapshots_v2 (
  city       TEXT NOT NULL,
  hood       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'apartment',
  day        TEXT NOT NULL,
  median_m2  REAL,
  n_listings INTEGER,
  PRIMARY KEY (city, hood, kind, day)
);
INSERT INTO hood_snapshots_v2 (city, hood, kind, day, median_m2, n_listings)
  SELECT city, hood, 'apartment', day, median_m2, n_listings
  FROM hood_snapshots;
DROP TABLE hood_snapshots;
ALTER TABLE hood_snapshots_v2 RENAME TO hood_snapshots;
CREATE INDEX IF NOT EXISTS idx_hoodsnap ON hood_snapshots(city, kind, day);

-- ---------------------------------------------------------------- 5 of 5
-- scrape_state: each city is now scraped once per kind, tracked separately,
-- so a slow category cannot stall the others.
CREATE TABLE scrape_state_v2 (
  source     TEXT NOT NULL,
  city       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'apartment',
  city_id    TEXT,
  page       INTEGER DEFAULT 0,
  pagination TEXT,
  last_run   TEXT,
  done_today TEXT,
  PRIMARY KEY (source, city, kind)
);
INSERT INTO scrape_state_v2 (source, city, kind, city_id, page, pagination, last_run, done_today)
  SELECT source, city, 'apartment', city_id, page, pagination, last_run, done_today
  FROM scrape_state;
DROP TABLE scrape_state;
ALTER TABLE scrape_state_v2 RENAME TO scrape_state;

-- Indexes that now need to know about kind.
CREATE INDEX IF NOT EXISTS idx_listings_kind ON listings(kind, city);
DROP INDEX IF EXISTS idx_enrich_queue;
CREATE INDEX IF NOT EXISTS idx_enrich_queue ON listings(enriched_at, scraped_at DESC);

-- ---------------------------------------------------------------- check
-- Run these afterwards. The first should return only 'apartment'; the second
-- should match the listing count you had before starting.
--   SELECT kind, COUNT(*) FROM listings GROUP BY kind;
--   SELECT COUNT(*) FROM city_snapshots;
--   SELECT COUNT(*) FROM hood_snapshots;
