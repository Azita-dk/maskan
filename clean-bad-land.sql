-- Remove the land listings that are not land.
--
-- Divar rejects every name tried for the land category but accepts the parent
-- category, so land was read from the parent and each post sorted by its own
-- category slug. The posts do not carry one. Unrecognised posts fell through
-- to "land", so the land listings filled with apartments.
--
-- The scraper no longer reads the parent, so no more of these are arriving.
-- These rows are already stored and have to go: an apartment counted as a
-- plot distorts the land median and shows the wrong adverts under
-- زمین و کلنگی.
--
-- Run in the D1 console, one block at a time.

-- ---------------------------------------------------------------- 1 of 3
-- How many there are, and where. Run this first and look at it before
-- deleting anything.
SELECT city, COUNT(*) AS n, ROUND(AVG(price_m2)/1e6, 1) AS avg_m2
FROM listings WHERE kind = 'land'
GROUP BY city ORDER BY n DESC;

-- ---------------------------------------------------------------- 2 of 3
-- Every land row came from the parent route, so every one is suspect: there
-- was never a working land category. Delete them all rather than guess which
-- are genuine.
DELETE FROM listings WHERE kind = 'land';

-- ---------------------------------------------------------------- 3 of 3
-- The snapshots built from them go too, or the trend line keeps the bad
-- medians.
DELETE FROM city_snapshots WHERE kind = 'land';
DELETE FROM hood_snapshots WHERE kind = 'land';

-- ---------------------------------------------------------------- check
--   SELECT kind, COUNT(*) FROM listings GROUP BY kind;
--
-- land should be gone. The زمین و کلنگی tab returns to a dash until the
-- category name is found and the scraper can read it properly.
