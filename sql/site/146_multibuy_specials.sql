-- Multibuy quantity tiers: "3 for R25, 6 for R45".
--
-- A new combo MODE rather than a new type -- it counts trigger products into
-- deals exactly like the other four modes and differs only in what the deal
-- hands back (a laddered price for a quantity). The tiers live in their own
-- table because a deal can carry several and the specials row is one row.
ALTER TABLE specials
  MODIFY combo_mode ENUM('','cheapest_free','free_item','percent_off','bundle_price','multibuy')
    NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS special_tiers (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  special_id INT UNSIGNED NOT NULL,
  -- How many units the tier prices. A one-unit tier is just the shelf price,
  -- so the model starts at two; the code refuses less.
  qty        INT UNSIGNED NOT NULL,
  price_incl DECIMAL(12,4) NOT NULL,
  PRIMARY KEY (id),
  -- Two tiers at the same quantity would be two answers to one question.
  UNIQUE KEY ux_tier_qty (special_id, qty),
  CONSTRAINT fk_tier_special FOREIGN KEY (special_id)
    REFERENCES specials (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
