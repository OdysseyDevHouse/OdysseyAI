-- ============================================================================
-- 196_till_sequences.sql — every till gets a sequence for what a counter issues
-- ============================================================================
--
-- A till has always had its own `invoice` sequence, created when it was
-- registered, so it could number a sale with no server. It had nothing for the
-- other three documents a counter writes — credit notes, quotes and orders —
-- because those numbered from the shared site-wide run.
--
-- They no longer do. `numberSegmentsFor` now segments all four (see
-- SEGMENTED_DOC_TYPES), which means the next credit note raised at a claimed
-- till draws from that till's own row — and without one, `nextDocumentNumber`
-- throws "No numbering sequence is configured for credit_sale on till 9" and
-- refuses the sale.
--
-- It refuses on purpose. Falling back to the shared run would be the "helpful"
-- thing and is the wrong one: it drops a till's document into the middle of the
-- shared register silently, and nobody finds out until the numbers are
-- reconciled. So the rows have to exist before the code that needs them runs.
--
-- ── WHY credit_sale WAS ALREADY HALF-BROKEN ─────────────────────────────────
--
-- The offline till has had its own credit-note sequence since it learned to
-- take returns with no server (posOffline/saleNumber.ts, `SequenceKind`). So a
-- credit note raised OFFLINE already numbered from the till's run while one
-- raised online numbered from the shared one. On a live site that is visible:
-- terminal 9 sits at 3315 and the shared run at 3900 — two registers of credit
-- notes for one shop, and no way to tell from a number which run it came from.
--
-- This makes the online path agree with the offline one rather than the other
-- way round, because the offline path is the one that cannot be changed: a till
-- with no line has no shared counter to reach.
--
-- ── STARTS AT 1, AND THAT IS CORRECT ────────────────────────────────────────
--
-- A till with no row for a doc type has issued nothing under it, so 1 is the
-- first number it can honestly claim. The shared run keeps its own position and
-- keeps issuing to everything that is not a counter.
--
-- The two do not collide: a segmented number carries the store and till
-- (CRN_01_01_000001) and a shared one does not (CRN000009), so `uq_doc_number`
-- sees different strings even at the same counter value.
--
-- ── NOTHING IS RENUMBERED ───────────────────────────────────────────────────
--
-- This creates sequences. Every document already issued keeps the number
-- printed on it, and `numberValueOf` reads a counter out of both shapes, so a
-- register that spans the change still sorts and reprints.

-- Prefixes match the site-wide rows so a shop's numbers keep their letters and
-- only gain the segments. INSERT IGNORE rather than a plain INSERT: a till
-- part-way through a run must keep its counter, and only a MISSING row is
-- created.
INSERT IGNORE INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
SELECT t.id, s.doc_type, s.prefix, 1, 6
  FROM terminals t
  CROSS JOIN (
    SELECT 'invoice'     AS doc_type, 'INV' AS prefix
    UNION ALL SELECT 'credit_sale', 'CRN'
    UNION ALL SELECT 'quote',       'QUO'
    UNION ALL SELECT 'sales_order', 'SO'
  ) s
 WHERE t.is_active = 1;
