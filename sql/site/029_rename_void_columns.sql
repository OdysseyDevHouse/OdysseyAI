-- ─────────────────────────────────────────────────────────────────────────
-- Finishing what 022 started: no column anywhere says "void".
--
-- Migration 022 renamed the sales STATUS value from void to cancelled, but
-- left the three companion columns alone — void_reason, voided_at,
-- voided_by_user_id — on the grounds that renaming columns across live sites
-- was risk for a cosmetic gain.
--
-- Nobody is live yet, so the gain is no longer cosmetic: a schema that says
-- one thing while the product says another is something every future reader
-- has to learn and work around. Doing it now costs a handful of rows.
--
-- ── WHY "CANCELLED" AND NOT "CANCELED" ───────────────────────────────────
--
-- Two Ls, matching finalised, authorised and the cancelled status value that
-- 022 already stored. The codebase is South African English throughout, and a
-- canceled_at column sitting beside status = cancelled would be worse than
-- either spelling used consistently.
--
-- ── WHAT THIS TOUCHES ────────────────────────────────────────────────────
--
--   sales_documents      void_reason, voided_at, voided_by_user_id
--   purchase_documents   void_reason, voided_at, and the status ENUM
--   stock_transfers      void_reason, voided_at, and the status ENUM
--
-- The two ENUMs still carried a void value that 022 never reached, so
-- purchasing and transfers were saying void while sales said cancelled. Both
-- are folded into cancelled here, the same way 022 folded the sales pair.
--
-- NOTE: no apostrophes in comments in this file. The runner sends it as one
-- multipleStatements batch, and MariaDB reads a lone apostrophe inside a --
-- comment as opening a string literal, swallowing the SQL that follows.
--
-- DDL auto-commits, so every statement is written to be re-runnable.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Sales ────────────────────────────────────────────────────────────────
-- RENAME COLUMN is not re-runnable on its own: a second pass finds no
-- void_reason and errors. Guarded on information_schema so it is.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_documents'
      AND COLUMN_NAME = 'void_reason') = 1,
  'ALTER TABLE sales_documents CHANGE COLUMN void_reason cancel_reason VARCHAR(190) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_documents'
      AND COLUMN_NAME = 'voided_at') = 1,
  'ALTER TABLE sales_documents CHANGE COLUMN voided_at cancelled_at DATETIME NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_documents'
      AND COLUMN_NAME = 'voided_by_user_id') = 1,
  'ALTER TABLE sales_documents CHANGE COLUMN voided_by_user_id cancelled_by_user_id INT UNSIGNED NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Purchasing ───────────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_documents'
      AND COLUMN_NAME = 'void_reason') = 1,
  'ALTER TABLE purchase_documents CHANGE COLUMN void_reason cancel_reason VARCHAR(190) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_documents'
      AND COLUMN_NAME = 'voided_at') = 1,
  'ALTER TABLE purchase_documents CHANGE COLUMN voided_at cancelled_at DATETIME NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Widen, move the data, then narrow — the same three steps 022 used. Doing
-- the ENUM and the data in one statement would blank every row whose value is
-- not yet legal in the new definition.
ALTER TABLE purchase_documents
  MODIFY COLUMN status ENUM('draft','issued','finalised','void','cancelled')
    NOT NULL DEFAULT 'draft';
UPDATE purchase_documents SET status = 'cancelled' WHERE status = 'void';
ALTER TABLE purchase_documents
  MODIFY COLUMN status ENUM('draft','issued','finalised','cancelled')
    NOT NULL DEFAULT 'draft';

-- ── Stock transfers ──────────────────────────────────────────────────────
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_transfers'
      AND COLUMN_NAME = 'void_reason') = 1,
  'ALTER TABLE stock_transfers CHANGE COLUMN void_reason cancel_reason VARCHAR(190) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_transfers'
      AND COLUMN_NAME = 'voided_at') = 1,
  'ALTER TABLE stock_transfers CHANGE COLUMN voided_at cancelled_at DATETIME NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE stock_transfers
  MODIFY COLUMN status ENUM('draft','posted','void','cancelled') NOT NULL DEFAULT 'draft';
UPDATE stock_transfers SET status = 'cancelled' WHERE status = 'void';
ALTER TABLE stock_transfers
  MODIFY COLUMN status ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft';
