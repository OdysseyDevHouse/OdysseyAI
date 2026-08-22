-- ── One SHAPE, instead of a type and a mode that must agree ───────────────
--
-- 058 split a special into a `type` and, for a combo, a `combo_mode`. The
-- reasoning was about how a shopkeeper TALKS about a deal -- "it is a combo,
-- buy three get one free" -- and that reasoning was right. The form still asks
-- the two questions in that order.
--
-- But no code ever worked in those terms. Every consumer immediately collapsed
-- the pair back into one value:
--
--   const shape = type === 'combo' ? comboMode : type
--
-- in validateSpecial, in computeSpecials, in itemsFor, in dealSummary and in
-- the form. Five reconstructions of one fact is five chances to reconstruct it
-- differently, and it already had a cost: `saveSpecial` had to blank
-- `combo_mode` by hand on every write, because a happy hour carrying a
-- leftover mode from when it was a combo is a row that reads as nonsense.
--
-- So the STORAGE becomes the flat shape the code already uses, and the two-step
-- choice becomes what it always was -- a question the form asks, not a fact the
-- database keeps.
--
-- ── EVERY FUTURE SHAPE IS DECLARED HERE, ONCE ─────────────────────────────
--
-- The enum below already names shapes nothing implements yet: quantity_break,
-- second_at_pct, mix_and_match, free_delivery, bonus_points. Declaring them now
-- costs nothing -- an enum value no row uses is a few bytes of table metadata --
-- and it means the work that implements them adds code rather than another
-- ALTER on a table every till reads.
--
-- ── AND `applies_to_all` GOES ─────────────────────────────────────────────
--
-- A happy hour could carry BOTH a scope list and applies_to_all = 1, and the
-- flag silently won -- so the products someone carefully picked were ignored
-- with nothing on screen to say so. An empty scope means the whole store. One
-- representation of one idea, and the impossible state stops existing.

-- There is no data to preserve: no site has ever run a promotion. A careful
-- UPDATE ... WHERE kind = ... migration like 058 had to write would be
-- ceremony over an empty table.
ALTER TABLE specials
  ADD COLUMN shape ENUM(
    'happy_hour','special_price',
    'cheapest_free','free_item','percent_off','bundle_price','multibuy',
    'spend',
    'quantity_break','second_at_pct','mix_and_match','free_delivery','bonus_points'
  ) NOT NULL DEFAULT 'happy_hour' AFTER name;

-- Carry across whatever a development database happens to hold, so a tree with
-- test rows in it does not come back with every special looking like a happy
-- hour. Ordered so the combo modes win over the type they sat under.
UPDATE specials SET shape = 'happy_hour'    WHERE type = 'happy_hour';
UPDATE specials SET shape = 'special_price' WHERE type = 'special_price';
UPDATE specials SET shape = 'spend'         WHERE type = 'spend';
UPDATE specials SET shape = combo_mode      WHERE type = 'combo' AND combo_mode <> '';

ALTER TABLE specials
  DROP COLUMN type,
  DROP COLUMN combo_mode,
  DROP COLUMN applies_to_all;

-- ── A tier can ladder a PERCENTAGE as well as a price ─────────────────────
--
-- multibuy ladders prices: 3 for R25, 6 for R45. quantity_break ladders
-- percentages: 10 or more at 5% off, 50 or more at 10%. That is how trade and
-- wholesale actually price, and it is not expressible today.
--
-- Its own column rather than reinterpreting price_incl by the parent's shape.
-- One column holding a rand in some rows and a percentage in others is a column
-- every reader has to ask the parent about first, and the first reader that
-- forgets prices a deal at five rand instead of five percent.
ALTER TABLE special_tiers
  ADD COLUMN discount_pct DECIMAL(6,3) NOT NULL DEFAULT 0 AFTER price_incl;

-- ── A slot for the meal deal that is not built yet ────────────────────────
--
-- "Burger plus any side plus any drink" needs rows that are ALTERNATIVES rather
-- than all required: pick one from slot 1, one from slot 2. Nothing reads this
-- column yet and no screen sets it.
--
-- It is added now because this is the one migration altering special_items, and
-- a nullable column costs nothing where a later table rewrite would cost a
-- migration on a table the till reads on every catalogue refresh. NULL means
-- "required", which is exactly how every row behaves today.
ALTER TABLE special_items
  ADD COLUMN slot TINYINT UNSIGNED NULL AFTER role;
