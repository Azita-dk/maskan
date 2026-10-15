-- Finer price bands for Tehran, Mashhad, Karaj and Isfahan.
--
-- Their twelve coarse bands were nearly all full: Tehran reached 59,000
-- apartments against Divar's 177,125, because each band stops at about
-- 5,600 listings. The new scrape.js gives these four cities 36 narrower
-- bands instead, lifting the ceiling to about 200,000.
--
-- Deploy the new scrape.js BEFORE running this.

-- 1 of 2 — remove their coarse bands, so the same prices are not searched
-- twice. Only scrape_state changes; no listing is touched.
DELETE FROM scrape_state
WHERE city IN ('تهران','مشهد','کرج','اصفهان') AND band LIKE 'b%';

-- 2 of 2 — then open this once, which adds the 36 fine bands for each:
--
--   https://maskan-scrape.azita-maskan.workers.dev/seed

-- check
--   SELECT city, COUNT(*) FROM scrape_state
--   WHERE city IN ('تهران','مشهد','کرج','اصفهان') GROUP BY city;
-- each should be 108: 3 kinds x 36 bands.
