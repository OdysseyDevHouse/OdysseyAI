-- The lot an adjustment line writes off (148) -- the recall workflow.
--
-- Beside serial_ids for the same reason serial_ids lives on the line: the
-- choice of WHICH stock is going is part of what was decided when the
-- adjustment was keyed, and it must survive the draft the same way.
ALTER TABLE stock_adjustment_lines
  ADD COLUMN IF NOT EXISTS batch_id INT UNSIGNED NULL AFTER serial_ids;

ALTER TABLE stock_adjustment_lines DROP FOREIGN KEY IF EXISTS fk_adj_line_batch;
ALTER TABLE stock_adjustment_lines
  ADD CONSTRAINT fk_adj_line_batch FOREIGN KEY (batch_id)
    REFERENCES product_batches (id) ON DELETE SET NULL;
