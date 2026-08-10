-- Tips and service charges.
--
-- ── WHY A TIP IS NOT A LINE ON THE INVOICE ─────────────────────────────────
--
-- Two invariants already in the code decide this, and neither is negotiable:
--
--   · assertBalanced() requires subtotalExcl + vatTotal === totalIncl on every
--     document. A tip carries NO VAT — it is not consideration for goods — so a
--     tip line would either break that assertion or fabricate VAT on a gratuity
--     and carry it into the VAT return.
--   · closeShift() derives the expected drawer from SUM(sales_tenders). A tip
--     that no query knows about leaves every drawer that took one reading OVER
--     by exactly the tip, with nothing to explain it.
--
-- So the invoice stays exactly what the goods cost, `sales_tenders.amount` stays
-- what was handed over, and a row here explains the difference. The three
-- numbers then reconcile: amount = goods + tip + change_given.
--
-- ── WHY NOT A COLUMN ON sales_tenders ──────────────────────────────────────
--
-- Tempting — the amount is already there. Rejected because a tip needs things a
-- tender has no business carrying: WHO it belongs to, whether it has been moved
-- to the pool, and who moved it. A nullable user_id and a reassignment trail on
-- `sales_tenders` would be four columns that mean nothing on the 99% of tenders
-- that are not tips, and every report summing takings would have to learn to
-- ignore them.

CREATE TABLE sales_tips (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id    INT UNSIGNED NOT NULL,

  /*
   * The tender the tip came in on.
   *
   * Load-bearing for cash-up rather than decorative: a CASH tip is physically in
   * the drawer and must be expected there, while a CARD tip arrives via the card
   * machine and is paid out through payroll — expecting it in the drawer would
   * leave every card-tipping shift short. `tender_types.tip_in_drawer` decides
   * which, so the rule is the shop's rather than hardcoded here.
   */
  tender_type_id INT UNSIGNED NOT NULL,

  /* The shift that took it. Denormalised from the document deliberately: cash-up
     reads this table by shift, and joining through sales_documents to get there
     on every close is a join for a column that never changes after insert. */
  shift_id       INT UNSIGNED NULL,

  amount         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  /*
   * How this tip came to exist. Reported on, not just recorded.
   *
   * 'over_tender'  — a no-change tender paid over the bill (card, account)
   * 'declared'     — a cashier said how much of the cash handed over was a tip
   * 'service'      — a service-charge tier fired on the bill value
   * 'manual'       — the add-tip key, with an amount typed
   *
   * A shop that finds 90% of its tips are 'service' is running a service charge,
   * not a tipping culture, and that is worth being able to see.
   */
  source         ENUM('over_tender','declared','service','manual') NOT NULL DEFAULT 'declared',

  /*
   * Who it is for. NULL means the POOL.
   *
   * Set from the document's own user_id at capture — whoever the sale is
   * attributed to is who served the table. NULL is not "unknown": it is the
   * explicit state a manager moves a tip into when it goes to the pool, which is
   * why there is no separate is_pooled flag to disagree with it.
   */
  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  /*
   * The reassignment trail.
   *
   * A tip must not be movable off somebody quietly — that is the whole reason
   * per-waiter attribution is worth anything. So the ORIGINAL owner is kept
   * alongside the current one, and who changed it, and when. Three columns
   * rather than a separate audit table because a tip is reassigned at most a
   * handful of times and a table would be a join for a rarity.
   */
  original_user_id  INT UNSIGNED NULL,
  reassigned_by     INT UNSIGNED NULL,
  reassigned_by_name VARCHAR(120) NOT NULL DEFAULT '',
  reassigned_at     DATETIME NULL,
  reassign_reason   VARCHAR(200) NOT NULL DEFAULT '',

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_tip_document (document_id),
  /* The two questions this table is asked: "what is this shift's drawer" and
     "what is this person owed". */
  KEY ix_tip_shift (shift_id, tender_type_id),
  KEY ix_tip_user (user_id, created_at),
  /* CASCADE with the document. A tip on a sale that no longer exists is not a
     tip anybody is owed — and unlike an offline sync claim, there is nothing to
     protect against a replay here, because the document is the only source. */
  CONSTRAINT fk_tip_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE CASCADE,
  -- RESTRICT, like sales_tenders: a tender type with history cannot be deleted.
  CONSTRAINT fk_tip_tender FOREIGN KEY (tender_type_id)
    REFERENCES tender_types (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Per-tender behaviour ───────────────────────────────────────────────────
--
-- `allows_change` already distinguishes the two cases and is NOT enough on its
-- own, which is why these are settings rather than derived:
--
--   · A tender that gives no change (card, account) can treat an over-tender as
--     a tip unambiguously — but a shop may want it to be an ERROR instead, and
--     silently keeping R20 because somebody fat-fingered an amount is worse than
--     refusing it.
--   · CASH gives change, so an over-tender is ambiguous: R100 on a R50 bill
--     might be R50 change, or R10 tip and R40 change. It cannot be inferred, so
--     cash is declared explicitly at the pad. See tips_declare.
ALTER TABLE tender_types
  /* Over-tender on this method becomes a tip, with no prompt. Off by default:
     a shop that has not asked for this should not start keeping change. */
  ADD COLUMN tip_on_over_tender TINYINT(1) NOT NULL DEFAULT 0 AFTER allows_refund,
  /*
   * Whether a tip on this tender lands in the DRAWER.
   *
   * Defaults to 1 because the common case is cash, and a tip that is in the
   * drawer but not expected leaves the count over. A card tender is set to 0 so
   * its tips are recorded and paid through payroll without ever being expected
   * at the counter.
   */
  ADD COLUMN tip_in_drawer TINYINT(1) NOT NULL DEFAULT 1 AFTER tip_on_over_tender;

-- Cash gives change, so its tips are declared rather than inferred — but they DO
-- sit in the drawer, which is the default above. Nothing to change for cash.
-- Card and EFT: an over-tender is unambiguous, and the money is not at the till.
UPDATE tender_types
   SET tip_in_drawer = 0
 WHERE allows_change = 0
   AND (integration_key IS NOT NULL OR code IN ('CARD','EFT','ONLINE'));

/*
 * ⚠ THE STATEMENT ABOVE MISSES ACCOUNT, and this one fixes it.
 *
 * Left as two statements rather than corrected in place because this file is already
 * applied on both sites and `schema_migrations` records by NAME — editing the first
 * statement would change nothing on any database that has run it, while quietly making
 * the file disagree with reality. See the migrations-are-recorded-by-name note.
 *
 * The rule I should have written first: a tip lands in the drawer only if the MONEY does.
 * `posts_to_debtor` is exactly that question — an account tip is charged to a debtor and
 * collected later, so it never touches the till, and expecting it there would leave every
 * account-tipping shift short by the tip.
 *
 * A code list was the wrong instrument anyway: it misses any tender a shop adds itself.
 */
UPDATE tender_types SET tip_in_drawer = 0 WHERE posts_to_debtor = 1;

-- ── Service-charge tiers ───────────────────────────────────────────────────
--
-- Bands by bill value: R500–R1000 → 10%, R1000–R1500 → 8%. A table rather than
-- a settings string because a shop edits these, and a JSON blob in `settings`
-- cannot be validated, ordered or reported on.
--
-- `min_total` is inclusive and `max_total` EXCLUSIVE, so adjacent bands cannot
-- both match one bill — 500..1000 and 1000..1500 meet at exactly 1000 and the
-- second one owns it. A NULL max_total is the open-ended top band.
CREATE TABLE service_charge_tiers (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  min_total   DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  max_total   DECIMAL(12,2) NULL,
  percent     DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_tier_range (is_active, min_total)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The removal trail for a FORCED charge ──────────────────────────────────
--
-- A service charge is automatic and cannot be removed by a waiter. It CAN be
-- removed by somebody holding sales.discount_override — because the alternative
-- is a bill nobody in the building can correct in front of a customer who has
-- refused it, or a tier that fired on a mis-keyed amount.
--
-- Recorded rather than silent, which is what makes the policy enforceable: a
-- shop can see who removes service charges and how often.
CREATE TABLE service_charge_removals (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id  INT UNSIGNED NULL,
  /* The amount that WOULD have been charged. Kept because the tip row is gone by
     definition — this table is the only record the charge ever applied. */
  amount       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  user_id      INT UNSIGNED NULL,
  user_name    VARCHAR(120) NOT NULL DEFAULT '',
  reason       VARCHAR(200) NOT NULL DEFAULT '',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_removal_user (user_id, created_at),
  /* SET NULL: the removal happened even if the document was later voided, and
     losing that record would hide exactly the pattern this table exists to show. */
  CONSTRAINT fk_removal_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
