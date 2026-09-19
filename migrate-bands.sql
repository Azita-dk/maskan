-- Adds a price band to scrape_state.
--
-- Divar stops paging at about 215 pages, so one search reaches roughly 5,600
-- listings no matter how often it runs. Tehran has 177,125 apartments; the
-- database held 12% of them and could not have held more. Each search gets
-- its own page allowance, so the same city is now swept once per price band
-- and the ceiling multiplies by the number of bands.
--
-- Run in the D1 console, one block at a time.
--
-- Nothing in `listings` is touched. Only the scraper's own progress table is
-- rewritten, and existing progress is preserved as the first band.

-- ---------------------------------------------------------------- 1 of 3
-- band joins the primary key: a city and kind now has one row per band, and
-- each keeps its own page cursor. SQLite cannot alter a primary key, so the
-- table is rebuilt.
CREATE TABLE scrape_state_v3 (
  source     TEXT NOT NULL,
  city       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'apartment',
  band       TEXT NOT NULL DEFAULT 'b0',
  city_id    TEXT,
  page       INTEGER DEFAULT 0,
  pagination TEXT,
  last_run   TEXT,
  done_today TEXT,
  PRIMARY KEY (source, city, kind, band)
);

-- ---------------------------------------------------------------- 2 of 3
-- Existing rows become band b0. Their page cursors are reset: a cursor from
-- an unfiltered search means nothing inside a filtered one.
INSERT INTO scrape_state_v3
  (source, city, kind, band, city_id, page, pagination, last_run, done_today)
  SELECT source, city, kind, 'b0', city_id, 0, NULL, last_run, NULL
  FROM scrape_state;

DROP TABLE scrape_state;
ALTER TABLE scrape_state_v3 RENAME TO scrape_state;

-- ---------------------------------------------------------------- 3 of 3
-- Then open this once, which inserts the remaining bands for every city and
-- kind. It uses INSERT OR IGNORE, so the b0 rows above keep their history:
--
--   https://maskan-scrape.azita-maskan.workers.dev/seed
--
-- Expect about 1,728 rows afterwards: 48 cities x 3 kinds x 12 bands.

-- ---------------------------------------------------------------- check
--   SELECT COUNT(*) FROM scrape_state;
--   SELECT band, COUNT(*) FROM scrape_state GROUP BY band ORDER BY band;
