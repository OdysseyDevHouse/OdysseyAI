-- When a line was FIRST rung, as opposed to when this row was written.
--
-- `created_at` cannot answer that question on a tab. A table bill rewrites its
-- lines wholesale on every save (tableActions.updateTableBillAction), so every
-- existing line is deleted and reinserted each time a waiter adds a round —
-- and `created_at DEFAULT CURRENT_TIMESTAMP` therefore reports the moment of
-- the LAST save for a starter ordered forty minutes ago.
--
-- The till shows each line's age so a waiter reopening a table can see how long
-- the customer has been waiting for it. That figure has to be the age of the
-- ORDER, so it is carried by the client across park and recall and written
-- here, rather than being inferred from a row that keeps getting recreated.
--
-- NULL for every line written before this column existed, and for every counter
-- line that never parks — both read as "no recorded order time", and the till
-- falls back to when the line entered the current basket.
ALTER TABLE sales_document_lines
  ADD COLUMN IF NOT EXISTS ordered_at DATETIME NULL;
