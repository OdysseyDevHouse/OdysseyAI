-- ── Auto-numbered till codes ──────────────────────────────────────────────
--
-- Tills join customers, suppliers and products on the master-code sequence
-- added in 062. A till's `code` is typed by hand, must be unique, and prints on
-- every slip while grouping every report — so it wants to be regular, and
-- "TILL01, TILL02" is what a shop types anyway when nothing offers it.
--
-- ⚠ NOT `till_number`. That is the two-digit segment inside an invoice number,
-- allocated by nextFreeTillNumber() in src/lib/site/terminals.ts, which picks
-- the LOWEST FREE number so a decommissioned till's slot is reused. This
-- sequence never reuses: a code identifies a register in the audit trail, and
-- handing a new till a retired one's code would merge two registers' history.
-- The two are allocated independently on the same insert, on purpose.
--
-- Padding 2, not the 5 the other three use: a shop has a handful of tills, not
-- thousands, and TILL00001 on a slip is five characters of nothing. `formatNumber`
-- does not truncate, so a shop that somehow reaches 100 tills gets TILL100
-- rather than a clash.
--
-- INSERT IGNORE, not INSERT: a no-op on a site that somehow already has these
-- rows, rather than failing the whole run.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period) VALUES
  ('terminal', 'TILL', 1, 2, 'none');

-- ON by default, unlike 062's original three. There is no imported coding
-- scheme to preserve for tills — a shop sets them up once, in this app — so the
-- reason those started off does not apply. A typed code still wins, and the
-- switch is in Setup → Numbering & posting beside the other three.
INSERT INTO settings (setting_key, setting_value) VALUES ('autocode_terminal', '1')
  ON DUPLICATE KEY UPDATE setting_value = setting_value;
