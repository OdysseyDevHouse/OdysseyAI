-- ─────────────────────────────────────────────────────────────────────────
-- Designed stationery — what a site's printed documents actually look like.
--
-- Customers want their paperwork to differ from ours, and the differences are
-- rarely grand: show unit cost on a purchase order, or never show it; our logo
-- top-left; our own terms in the footer. Before this, the only way to grant any
-- of that was to edit a React component and deploy, which means every such
-- request is a developer's afternoon and no shop can answer its own question.
--
-- ── WHY A TABLE AND NOT A SETTING ────────────────────────────────────────
--
-- The `settings` table is for "single scalar values a store owner changes and
-- nothing joins to" — see the header of src/lib/site/settings.ts, which is
-- explicit that anything with behaviour attached "earns a table". A template
-- has behaviour: it is validated, it has a draft and a published half, it is
-- selected per document type, and it can be rejected at render time. Also
-- `settings.setting_value` is VARCHAR(255), and a purchase order is 5KB.
--
-- ── THE BODY IS TEXT, AND IT IS RE-VALIDATED ON EVERY READ ───────────────
--
-- Exactly the doctrine saved_reports follows (054_reports.sql). Nothing here
-- needs the server to index or query INSIDE the document: it is read whole,
-- rendered whole and written whole. It is parsed and re-validated in TypeScript
-- on the way out, which has to happen regardless, because a template outlives
-- the catalog that produced it — a token that no longer exists renders empty
-- rather than breaking the page, and a template missing something now REQUIRED
-- falls back to the shipped default rather than printing an unlawful document.
--
-- Consequently a template is never trusted because it is in the database. It is
-- trusted because it passed validateTemplate() on the way out, today.
--
-- ── SANITISED ON THE WAY IN ──────────────────────────────────────────────
--
-- `body` holds markup a HUMAN wrote, which is later rendered into a page in
-- this application's own origin — a stored-XSS surface if it is ever trusted.
-- src/lib/stationery/sanitise.ts runs server-side at save and is the only thing
-- that decides; what is stored here is already clean. Nothing may write to this
-- table except through that path.
--
-- ── DRAFT AND PUBLISHED ──────────────────────────────────────────────────
--
-- Two columns rather than two rows, as 040_storefront_layout.sql does it and
-- for the same reason: editing live stationery is editing the document being
-- sent to a supplier right now. `body` is what prints. `draft_body` is what the
-- designer is working on, and is NULL when there is nothing in progress.
-- Publishing copies draft over body in one statement; discarding sets it NULL.
--
-- ── ONE ACTIVE TEMPLATE PER DOCUMENT TYPE ────────────────────────────────
--
-- A site may keep several designs for a purchase order — last year's, a
-- seasonal one, a fork someone is trying — but exactly one prints. That is
-- `is_active`, and the accessor clears the others in the same transaction as it
-- sets one. No UNIQUE index enforces it: MySQL cannot express "at most one row
-- per doc_type where is_active = 1", and a partial-unique emulation (a NULLable
-- generated column) would be a clever thing to debug at the moment a shop
-- cannot print. The invariant is one function's job, and resolveActive() takes
-- the newest active row so a broken invariant still prints something.

CREATE TABLE stationery_templates (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Which document this designs: 'purchase_order', 'invoice', 'quote', 'slip'.
  -- A VARCHAR rather than an ENUM because the set grows as document types gain
  -- catalog entries, and adding one should not be a schema change on every
  -- site. Unknown values are dropped on read by the catalog, not by the column.
  doc_type      VARCHAR(40)  NOT NULL,

  name          VARCHAR(120) NOT NULL,

  -- 'html' — an A4 document, markup rendered by the browser.
  -- 'slip'  — an 80mm till slip, an ordered block spec compiled to ESC/POS AND
  --           to HTML, because a thermal head has no CSS and the two prints
  --           must not disagree.
  -- The medium decides which designer opens the row, so it is stored rather
  -- than inferred from doc_type: a document could gain a slip variant later.
  format        ENUM('html','slip') NOT NULL DEFAULT 'html',

  -- What prints. Sanitised markup for 'html', a JSON block spec for 'slip'.
  -- MEDIUMTEXT: the shipped purchase order is ~5KB before anyone adds a logo,
  -- and TEXT's 64KB ceiling is close enough to a real letterhead to be a
  -- support call rather than a limit.
  body          MEDIUMTEXT   NOT NULL,

  -- Work in progress. NULL when the designer has nothing unpublished.
  draft_body    MEDIUMTEXT   NULL,

  -- Exactly one row per doc_type is 1. See the header.
  is_active     TINYINT(1)   NOT NULL DEFAULT 0,

  -- Guards future format changes, as CustomReportSpec.version does. A template
  -- written against version 1 keeps rendering when version 2 exists.
  version       SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  -- Provenance only, never a permission. Who may edit stationery is decided by
  -- the caller's own capabilities at the time they try, exactly as a saved
  -- report re-checks the caller rather than the author.
  created_by      INT UNSIGNED NULL,
  created_by_name VARCHAR(120) NOT NULL DEFAULT '',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The one query the print path makes: the active template for this document.
  KEY idx_type_active (doc_type, is_active),
  -- The designer's list, newest first.
  KEY idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
