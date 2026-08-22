-- ── Where a promotion came from ───────────────────────────────────────────
--
-- A store IS a site with its own database (003), so a special has always been
-- per-branch by construction -- and nothing ever fanned one out. Head office
-- could not push one promotion to twenty branches; somebody retyped it twenty
-- times, and the twentieth was different from the first.
--
-- This column records which site a copy came FROM, following the convention
-- 198 set for shared files. NULL means "this store wrote it itself", which is
-- what every existing row is.
--
-- ── WHY IT IS RECORDED AT ALL ─────────────────────────────────────────────
--
-- Two reasons, and neither is bookkeeping.
--
-- A branch that edits its own copy of a head-office promotion must not push
-- that edit back up the chain -- the same rule productOwnership enforces for a
-- product, and it needs to know who owns the row to enforce it.
--
-- And a group asking "what did the Easter promotion cost us across all
-- twenty stores" needs to know that twenty differently-numbered rows are one
-- campaign. Ids increment independently per database, so the id cannot say it.
ALTER TABLE specials
  ADD COLUMN origin_site_id INT UNSIGNED NULL,
  ADD KEY ix_special_origin (origin_site_id);
