-- A special has a TYPE, and a combo has a MODE.
--
-- ── WHY THIS IS NOT SIX FLAT KINDS ──────────────────────────────────────
--
-- The first cut of this table stored six peers: percent_off, fixed_price,
-- cheapest_free, free_item, bundle_price, spend_get. That reads fine to a
-- programmer and badly to a shopkeeper, because four of the six are the same
-- thing — a combo — differing only in what the deal hands back. They all count
-- trigger products into groups; nothing else in the shop works that way.
--
-- Splitting it in two matches how the deal is actually described out loud:
-- "it's a combo, buy three get one free". The form follows the same shape, so
-- the second question is only asked once the first makes it relevant.
--
-- `happy_hour` and `special_price` also get their real names back. A shop
-- calls a five-to-seven discount a happy hour, not a "percentage off".

ALTER TABLE specials
  ADD COLUMN type ENUM('happy_hour','special_price','combo','spend')
    NOT NULL DEFAULT 'happy_hour' AFTER name,
  ADD COLUMN combo_mode ENUM('','cheapest_free','free_item','percent_off','bundle_price')
    NOT NULL DEFAULT '' AFTER type;

-- Carry the old kinds across. The four combo shapes become one type with a
-- mode; the two simple ones become types in their own right.
UPDATE specials SET type = 'happy_hour'    WHERE kind = 'percent_off';
UPDATE specials SET type = 'special_price' WHERE kind = 'fixed_price';
UPDATE specials SET type = 'spend'         WHERE kind = 'spend_get';
UPDATE specials SET type = 'combo', combo_mode = 'cheapest_free' WHERE kind = 'cheapest_free';
UPDATE specials SET type = 'combo', combo_mode = 'free_item'     WHERE kind = 'free_item';
UPDATE specials SET type = 'combo', combo_mode = 'bundle_price'  WHERE kind = 'bundle_price';

-- `kind` is dropped rather than kept as a shadow. Two columns describing the
-- same thing is how they end up disagreeing, and nothing reads it any more.
ALTER TABLE specials DROP COLUMN kind;
