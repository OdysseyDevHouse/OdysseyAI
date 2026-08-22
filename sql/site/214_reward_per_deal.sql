-- ── One free garlic bread PER two pizzas ──────────────────────────────────
--
-- `free_item` grants its reward rows once per completed deal already -- that
-- part works. What it cannot say is whether a basket big enough for three
-- deals should hand over three breads or one.
--
-- Today it always scales, because the reward is multiplied by the deal count.
-- That is right for "buy 2 pizzas get a garlic bread" and wrong for "spend the
-- afternoon here and have a coffee on us", where the shop means once.
--
-- Defaults to 1 -- scaling -- because that is exactly what the code does today,
-- so no existing promotion changes.
ALTER TABLE specials
  ADD COLUMN reward_per_deal TINYINT(1) NOT NULL DEFAULT 1;
