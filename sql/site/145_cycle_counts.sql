-- Cycle counting: a recurring programme that generates draft stock takes.
--
-- A programme names a SLICE of the shop (a department, a brand, a supplier,
-- or everything) and a rhythm. Generation is button-driven -- the recurring
-- journals precedent -- and each generated sheet is an ORDINARY draft stock
-- take: same grid, same posting, same variance rules.
CREATE TABLE IF NOT EXISTS cycle_count_programmes (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name               VARCHAR(100) NOT NULL,
  location_id        INT UNSIGNED NOT NULL,
  -- The stock_takes vocabulary, minus manual: a recurring programme names a
  -- slice of the shop, not a hand-picked list.
  scope              ENUM('full','department','brand','supplier') NOT NULL DEFAULT 'department',
  scope_ref_id       INT UNSIGNED NULL,
  include_zero_stock TINYINT(1) NOT NULL DEFAULT 0,
  -- The shared recurrence vocabulary (expenseModel), so the date math has one
  -- definition across expenses, contracts, journals and counts.
  frequency          ENUM('weekly','monthly','quarterly','annually') NOT NULL DEFAULT 'weekly',
  day_of_week        TINYINT UNSIGNED NULL,
  day_of_month       TINYINT UNSIGNED NULL,
  starts_on          DATE NOT NULL,
  ends_on            DATE NULL,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  last_generated_for DATE NULL,
  user_name          VARCHAR(120) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_ccp_location FOREIGN KEY (location_id)
    REFERENCES stock_locations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which programme produced a sheet. SET NULL on programme delete -- the count
-- already happened, and its history must keep reading.
ALTER TABLE stock_takes
  ADD COLUMN IF NOT EXISTS programme_id INT UNSIGNED NULL AFTER scope_ref_id,
  ADD KEY IF NOT EXISTS ix_take_programme (programme_id);

ALTER TABLE stock_takes DROP FOREIGN KEY IF EXISTS fk_take_programme;
ALTER TABLE stock_takes
  ADD CONSTRAINT fk_take_programme FOREIGN KEY (programme_id)
    REFERENCES cycle_count_programmes (id) ON DELETE SET NULL;
