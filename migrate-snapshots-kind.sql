-- Price history for villa and land.
--
-- The price-trend chart was empty for خانه و ویلا and زمین و کلنگی. The build
-- worker only records history per property type when the snapshot tables
-- have a `kind` column; without one it records apartments alone, so as not
-- to write villa figures into the apartment series. These two tables never
-- got that column — the earlier land cleanup failed on it with
-- "no such column: kind" — so villa and land have never had a day recorded.
--
-- This adds it. Existing rows are all apartment history, and become exactly
-- that. Nothing is deleted.
--
-- Run in the D1 console, ONE BLOCK AT A TIME, in order.

-- ================================================================ 1 of 6
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

-- ================================================================ 2 of 6
INSERT INTO city_snapshots_v2 (city, kind, day, jyear, jmonth, median_m2, n_listings)
  SELECT city, 'apartment', day, jyear, jmonth, median_m2, n_listings
  FROM city_snapshots;

-- ================================================================ 3 of 6
DROP TABLE city_snapshots;
ALTER TABLE city_snapshots_v2 RENAME TO city_snapshots;

-- ================================================================ 4 of 6
CREATE TABLE hood_snapshots_v2 (
  city       TEXT NOT NULL,
  hood       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'apartment',
  day        TEXT NOT NULL,
  median_m2  REAL,
  n_listings INTEGER,
  PRIMARY KEY (city, hood, kind, day)
);

-- ================================================================ 5 of 6
INSERT INTO hood_snapshots_v2 (city, hood, kind, day, median_m2, n_listings)
  SELECT city, hood, 'apartment', day, median_m2, n_listings
  FROM hood_snapshots;

-- ================================================================ 6 of 6
DROP TABLE hood_snapshots;
ALTER TABLE hood_snapshots_v2 RENAME TO hood_snapshots;
CREATE INDEX IF NOT EXISTS idx_hoodsnap ON hood_snapshots(city, kind, day);

-- ================================================================ check
-- Both should now list a `kind` column:
--   PRAGMA table_info(city_snapshots);
--   PRAGMA table_info(hood_snapshots);
--
-- From the next build onward, villa and land get one point of history a day.
-- The chart needs two points to draw a line, so it fills in after tomorrow.
