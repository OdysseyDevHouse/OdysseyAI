-- ─────────────────────────────────────────────────────────────────────────
-- What kind of till THIS till is.
--
-- The mode — retail counter, tables, trade counter — was a SITE setting:
-- `pos_mode`, one answer per shop. That is the wrong grain, and not marginally.
--
-- A builders' merchant runs a wholesale trade counter and a retail storefront
-- under one roof and one company. The trade desk wants the invoicing screen,
-- typing long documents for account customers; the front counter wants the
-- retail till, scanning a queue. With one answer per shop those two cannot both
-- be right, and the shop has to choose which half of its business gets the
-- wrong screen all day.
--
-- The machine is what a person stands at, so the machine is what the mode
-- belongs to.
--
-- ── WHY THE SITE SETTING GOES AWAY ENTIRELY ──────────────────────────────
--
-- Rather than becoming a default that a till may override. Two places to set
-- one thing is two places to read it, and the interesting question — "why is
-- this screen showing invoicing?" — then has two possible answers that a person
-- has to check in order. A single per-till value has exactly one.
--
-- The cost of that is a till with nothing set, which is answered below by the
-- column default rather than by a fallback chain.
--
-- ── retail IS THE DEFAULT, AND IT IS NOT ARBITRARY ───────────────────────
--
-- A till that cannot say what it is must still TRADE. Retail is the mode that
-- serves a queue with a scanner, which is what a machine sitting on a counter
-- almost always is; the other two are deliberate choices a shop makes for a
-- particular desk. The same reasoning `toPosMode()` already applies to an
-- unrecognised value, kept in step here so the database and the parser agree.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE terminals
  ADD COLUMN IF NOT EXISTS pos_mode
    ENUM('retail','hospitality','invoicing') NOT NULL DEFAULT 'retail'
    AFTER location;

-- The shop-wide setting is retired rather than left lying about.
--
-- Left in place it would keep being offered by `getSetting`, and the next
-- person to read `pos_mode` would find a value that looks authoritative and is
-- no longer consulted by anything — which is worse than no value at all.
DELETE FROM settings WHERE setting_key = 'pos_mode';
