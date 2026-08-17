-- Where each store in a group actually IS, so one storefront can serve a chain.
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
--
-- A chain of ten shops wants one online store. A shopper opens it and has to be
-- offered the branch nearest them; the order they place has to land in THAT
-- branch's database, because that is the shop that will pack it and take the
-- money. cp2_store_groups already links the stores. What it cannot answer is
-- "which of them is closest" and "which of them is open for business".
--
-- ── WHY THIS IS A COPY, AND NOT A JOIN ──────────────────────────────────────
--
-- Both answers already exist in the stores' OWN databases: coordinates on the
-- main stock_locations row (107), and is_enabled on online_store_settings (034).
-- Reading them properly would mean opening ten separate database connections on
-- the first page load of every shopper who has not yet chosen a branch.
--
-- So this table is a published COPY, written when a shop saves its settings and
-- refreshable by hand. storeGroups.ts already keeps site-database reads out of
-- membersOfGroup() for exactly this reason — that function runs on every product
-- page load, and opening every linked store's database to draw a list would be
-- wasteful. The same argument applies with more force to a public storefront.
--
-- The trade is staleness, and it is worth taking because the failure is benign:
-- a branch shown as open 404s when it is opened, and a pin a few days out of
-- date puts a shop in very nearly the right place. The alternative — ten round
-- trips before the first byte — fails on every page load rather than rarely.
--
-- The stores' own tables stay the source of truth. Nothing reads this table to
-- decide what to charge, what is in stock, or whether an order may be placed.
-- It exists to draw a list and sort it by distance.
--
-- ── NOTE ON THE SHARED DATABASE ─────────────────────────────────────────────
--
-- odyssey_tickets is shared with the v2 backend. This is a new cp2_-prefixed
-- table and one added column on cp2_store_groups, which this repo owns. As in
-- 008 there are deliberately NO foreign keys to cp2_sites: that table is the v2
-- backend's, and constraining it from here would couple the two products'
-- deploys together. A row whose site is deleted is tidied by the app, not by
-- the schema.

-- ── Where a branch is, and whether it is open ───────────────────────────────
CREATE TABLE IF NOT EXISTS cp2_store_branches (
  -- One row per site. No AUTO_INCREMENT id: the site IS the identity, and a
  -- second row for the same shop is a bug rather than a thing to represent.
  site_id        INT UNSIGNED NOT NULL,

  -- Hand-pinned, copied from the site's main stock_locations row.
  --
  -- NULL is a normal, expected state, not an error: a group part-way through
  -- being set up has branches nobody has pinned yet. Those must still appear in
  -- the picker — sorted last, with no distance shown — because a shop that
  -- cannot be found by GPS must still be choosable by name. Nothing here may
  -- assume a pin exists.
  latitude       DECIMAL(10,7) NULL,
  longitude      DECIMAL(10,7) NULL,

  -- A copy of the branch's own online_store_settings.is_enabled. Answers "should
  -- this shop appear in the picker at all", nothing more. The branch's own
  -- database is still what decides whether it will actually accept an order —
  -- see the staleness note above.
  accepts_online TINYINT(1) NOT NULL DEFAULT 0,

  -- What the picker draws. Copied rather than joined for the same reason as the
  -- pin: drawing a list of ten branches must not open ten databases.
  display_name   VARCHAR(160) NOT NULL DEFAULT '',
  address_line   VARCHAR(190) NOT NULL DEFAULT '',
  phone          VARCHAR(40)  NOT NULL DEFAULT '',

  -- The owner's running order, for when there is no GPS fix to sort by. Their
  -- ordering beats alphabetical, which would put a small suburb branch above
  -- the flagship.
  sort_order     INT NOT NULL DEFAULT 0,

  -- When the copy above was last refreshed. Shown on the setup screen so an
  -- owner can see a pin has gone stale rather than having to guess.
  synced_at      DATETIME NULL,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Whether a group runs one storefront ─────────────────────────────────────
--
-- This is a fact about a GROUP, not about a site, so it cannot live in the
-- `settings` KV table in any one store's database — there is no single store
-- entitled to hold it, and putting it in the primary's would mean a shop that
-- left the group silently took the switch with it.
--
-- OFF by default. Every existing group's shops keep their own separate
-- storefronts until somebody deliberately chooses otherwise, which is exactly
-- what all of them have today.
ALTER TABLE cp2_store_groups
  ADD COLUMN IF NOT EXISTS online_group_mode TINYINT(1) NOT NULL DEFAULT 0;
