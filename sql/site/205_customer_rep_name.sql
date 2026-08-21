-- A customer's sales rep travels by NAME, not by id.
--
-- ── THE BUG ──────────────────────────────────────────────────────────────
--
-- sales_reps is a per-store table: each shop defines its own and the ids
-- increment independently. customers.rep_id moves to the group primary WITH the
-- customer file, so a branch's rep id ends up sitting in the owner's table and
-- every read resolves it against the OWNER's reps — a different person, or
-- nobody.
--
-- customerDb.ts records this and docs/cross-store-id-conflicts.md lists it as
-- open, with the two possible answers. The answer taken here is that a rep is a
-- GROUP-WIDE PERSON: they work for the company, not for a building, and the
-- same person can be attached to customers at any store. So the customer
-- carries the rep's identity rather than one store's id for them.
--
-- The consequences, all silent, all reproducible:
--
--   · The age analysis shows head office's rep names against branch customers —
--     and that report is sent to reps and used to pay commission.
--   · Filtering any customer list by rep binds a branch id and matches whoever
--     holds that id at the owner.
--   · Bulk-assigning a rep writes a branch id into the shared file.
--   · deleteSalesRep counts customers in the branch's empty table, so it never
--     refuses a delete that should have been refused.
--
-- ── WHY NAME AND NOT CODE ────────────────────────────────────────────────
--
-- `code` is the obvious candidate and it is the wrong one here: it is NULLable
-- and carries no unique key, so it does not identify a rep even within one
-- store. `name` has uq_sales_rep_name, and every existing lookup in
-- customerLookups.ts already finds a rep BY NAME — including the duplicate
-- guard on create and rename. It is the key the module already behaves as if it
-- had.
--
-- That also matches how the other cross-store references were resolved:
-- price_structures by name, departments by name, products by code, vat_rates by
-- rate. See docs/cross-store-id-conflicts.md.
--
-- ── WHY THE ID STAYS ─────────────────────────────────────────────────────
--
-- rep_id is NOT dropped. Within a single store it is a correct, indexed foreign
-- key with an ON DELETE SET NULL that does real work, and every unshared site —
-- which today is all of them — keeps using it exactly as before. The name is
-- the fallback that makes the reference survive the boundary, in the same shape
-- as origin_site_id in 198: the local answer stays, and the portable one is
-- added beside it.
--
-- Backfilled from the rep the customer already points at, so nothing is lost on
-- a site that has been running.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS rep_name VARCHAR(120) NULL AFTER rep_id;

-- The filter and the "who reps this account" lookup both resolve through this.
ALTER TABLE customers
  ADD INDEX IF NOT EXISTS ix_customer_rep_name (rep_name);

-- Existing accounts keep the rep they have. Runs against whatever sales_reps
-- this database holds, which for an unshared site is the right table by
-- definition — and a shared site's branch table is empty, so it does nothing
-- there rather than writing a wrong name.
UPDATE customers c
   JOIN sales_reps r ON r.id = c.rep_id
    SET c.rep_name = r.name
  WHERE c.rep_name IS NULL;
