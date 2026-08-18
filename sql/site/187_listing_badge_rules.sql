-- ─────────────────────────────────────────────────────────────────────────
-- The badge rules: "New", "Best seller", "Almost gone".
--
-- 185 added the hand-written half — `products.online_badge`, for the things no
-- rule can infer: "Halaal", "Made here", "Award winner". This is the other
-- half: the badges that are true of a product for a while and then stop being
-- true, which is exactly the kind nobody remembers to take off by hand.
--
-- ── ON THE LISTING PRESET, AND SHOP-WIDE ONLY ────────────────────────────
--
-- These sit on the same table as the rest of a listing's settings because they
-- are the same decision — what a tile says — and reading them together is one
-- row rather than two.
--
-- They are read from the SHOP'S row only, never a department's. "New" meaning
-- 30 days in one aisle and 7 in another is not a distinction a shopper can
-- perceive, and it is a fine way for an owner to end up with a shop whose
-- badges quietly contradict each other. The columns exist on every row because
-- they are on the table; the resolver ignores all but the default's.
--
-- ── AN EMPTY LABEL IS THE OFF SWITCH ─────────────────────────────────────
--
-- Rather than a separate boolean per rule. A rule with no wording cannot draw
-- anything, so "off" and "has nothing to say" are the same state — and two
-- fields that can disagree about whether a badge shows is a bug waiting for
-- somebody to set one and not the other.
--
-- Every rule ships OFF. A shop that has never opened this screen gets no badges
-- at all, which is exactly what it renders today.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE online_listing_presets
  ADD COLUMN IF NOT EXISTS badge_new_label VARCHAR(24) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS badge_new_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS badge_new_tone VARCHAR(12) NOT NULL DEFAULT 'brand',
  ADD COLUMN IF NOT EXISTS badge_best_label VARCHAR(24) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS badge_best_tone VARCHAR(12) NOT NULL DEFAULT 'success',
  ADD COLUMN IF NOT EXISTS badge_low_label VARCHAR(24) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS badge_low_at SMALLINT UNSIGNED NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS badge_low_tone VARCHAR(12) NOT NULL DEFAULT 'warning';
