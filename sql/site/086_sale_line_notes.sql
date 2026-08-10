-- ============================================================================
-- A note on a sale line.
--
-- "No ice." "Allergy: nuts." "Table 4's, not table 6's." A shop can define a
-- question for anything it expects to be asked, but a kitchen also gets asked
-- things nobody planned for, and until now the till had nowhere to put them: a
-- document-level note exists (sales_documents.notes) but it belongs to the whole
-- sale, so "no ice" on one of four drinks was unsayable.
--
-- ── WHY ON THE LINE AND NOT AN INSTRUCTION ──────────────────────────────────
--
-- An instruction is a question the shop DECIDED to ask, with answers it can
-- price and count and report on. This is the opposite: unplanned, unpriceable,
-- and interesting only to whoever reads the ticket. Modelling it as an
-- instruction option would mean inventing a row per phrase a customer might say.
--
-- ── LENGTH ──────────────────────────────────────────────────────────────────
--
-- 190, matching `description` on this table and `line_note` on
-- online_order_lines. Long enough for a sentence, short enough that it still
-- prints on a 58mm slip, and the same figure the storefront already accepted so
-- the two paths cannot disagree about what fits.
--
-- NOT NULL DEFAULT '' rather than nullable: every existing row means "no note",
-- and an empty string says that without every reader having to decide whether
-- NULL and '' differ. They do not.
-- ============================================================================

ALTER TABLE sales_document_lines
  ADD COLUMN line_note VARCHAR(190) NOT NULL DEFAULT '';
