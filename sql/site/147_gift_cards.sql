-- Gift cards: sellable bearer stored value.
--
-- The balance is a LEDGER (gift_card_events, signed amounts) with a cached
-- figure on the card row, refreshed inside every write transaction -- the
-- loyalty rule from 052. Selling a card is not revenue; it is a liability
-- (money held for the bearer), so activation posts DR tender / CR 2500 and
-- redemption drains 2500 through the ordinary tender mapping.

CREATE TABLE IF NOT EXISTS gift_cards (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code            VARCHAR(30) NOT NULL,
  -- pending = pre-generated stock not yet sold; active = carries value;
  -- redeemed = drained to zero; expired = swept; void = cancelled.
  status          ENUM('pending','active','redeemed','expired','void')
                    NOT NULL DEFAULT 'pending',
  initial_value   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  balance         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  expires_on      DATE NULL,
  activated_at    DATETIME(3) NULL,
  activated_doc_id INT UNSIGNED NULL,
  activated_doc_number VARCHAR(40) NOT NULL DEFAULT '',
  -- A courtesy link only; a gift card is bearer and never requires a customer.
  customer_id     INT UNSIGNED NULL,
  note            VARCHAR(255) NOT NULL DEFAULT '',
  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gift_card_code (code),
  KEY idx_gift_card_status_expiry (status, expires_on),
  KEY idx_gift_card_document (activated_doc_id),
  CONSTRAINT fk_gift_card_document FOREIGN KEY (activated_doc_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_gift_card_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only, SIGNED: activation/reload/refund positive, redeem/expire negative.
CREATE TABLE IF NOT EXISTS gift_card_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  card_id         BIGINT UNSIGNED NOT NULL,
  entry_type      ENUM('activation','redeem','reload','refund','expire','adjust') NOT NULL,
  amount          DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  document_id     INT UNSIGNED NULL,
  document_number VARCHAR(40) NOT NULL DEFAULT '',
  order_id        INT UNSIGNED NULL,
  shift_id        INT UNSIGNED NULL,
  terminal_id     INT UNSIGNED NULL,
  note            VARCHAR(255) NOT NULL DEFAULT '',
  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_gc_event_card (card_id, created_at),
  KEY idx_gc_event_document (document_id),
  KEY idx_gc_event_type_date (entry_type, created_at),
  -- One event of a kind per card per document, arbitrated by the database
  -- rather than a racing SELECT -- the 052 uq_ledger_document_earn rule.
  UNIQUE KEY uq_gc_event_doc (card_id, document_id, entry_type),
  CONSTRAINT fk_gc_event_card FOREIGN KEY (card_id)
    REFERENCES gift_cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_gc_event_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The activation line remembers WHICH card it sold (the 140 discount_code_id
-- precedent on lines).
ALTER TABLE sales_document_lines
  ADD COLUMN IF NOT EXISTS gift_card_code VARCHAR(30) NULL AFTER discount_code_id;

-- The redemption tender. Inactive on arrival (the loyalty precedent); no
-- drawer cash, no change (change off a gift card is a laundering route),
-- refundable (a credit note may pay back ONTO the card), reference REQUIRED --
-- the reference IS the card code, which is how the posting engine finds it.
INSERT INTO tender_types
  (code, name, posts_to_debtor, requires_customer, counts_as_drawer_cash,
   opens_cash_drawer, allows_change, allows_split, allows_refund,
   requires_reference, reference_label, rounds_to_cash_denomination,
   min_amount, max_amount, surcharge_pct, integration_key,
   icon, color, position, is_active, is_system)
SELECT 'GIFT_CARD', 'Gift card', 0, 0, 0, 0, 0, 1, 1,
       1, 'Card number', 0, 0.0000, 0.0000, 0.000, 'gift_card',
       'gift', NULL, 82, 0, 1
WHERE NOT EXISTS (SELECT 1 FROM tender_types WHERE code = 'GIFT_CARD');

-- Accounts: 2500 is the first free current-liability code; 4910 sits in
-- other income beside 4900.
INSERT INTO gl_accounts (account_code, name, account_type, subtype, control_type, is_postable, sort_order)
SELECT '2500', 'Gift card liability', 'liability', 'current_liability', NULL, TRUE, 335
 WHERE NOT EXISTS (SELECT 1 FROM gl_accounts WHERE account_code = '2500');
INSERT INTO gl_accounts (account_code, name, account_type, subtype, control_type, is_postable, sort_order)
SELECT '4910', 'Gift card breakage', 'income', 'other_income', NULL, TRUE, 695
 WHERE NOT EXISTS (SELECT 1 FROM gl_accounts WHERE account_code = '4910');

-- NULL-ref default mappings: NOT EXISTS, never INSERT IGNORE -- NULLs are
-- always distinct under the unique key, so IGNORE would stack duplicates.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'gift_card_liability', NULL, a.id FROM gl_accounts a
 WHERE a.account_code = '2500'
   AND NOT EXISTS (SELECT 1 FROM gl_mappings m
                    WHERE m.mapping_key = 'gift_card_liability' AND m.ref_id IS NULL);
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'gift_card_breakage', NULL, a.id FROM gl_accounts a
 WHERE a.account_code = '4910'
   AND NOT EXISTS (SELECT 1 FROM gl_mappings m
                    WHERE m.mapping_key = 'gift_card_breakage' AND m.ref_id IS NULL);

-- The redemption tender lands in the liability account: mirrorSale resolving
-- this mapping IS the liability drawdown, with no gift-card code in the mirror.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'tender', t.id, a.id
  FROM tender_types t JOIN gl_accounts a ON a.account_code = '2500'
 WHERE t.code = 'GIFT_CARD'
   AND NOT EXISTS (SELECT 1 FROM gl_mappings m
                    WHERE m.mapping_key = 'tender' AND m.ref_id = t.id);
