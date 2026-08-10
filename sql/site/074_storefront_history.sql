-- ─────────────────────────────────────────────────────────────────────────
-- Two ways to not lose work: what a page USED to be, and pieces worth reusing.
--
-- Both are storage for `HomeSection[]` documents, both are written by the page
-- builder, and neither is queried inside — so they land in one migration
-- rather than two that would arrive together anyway.
-- ─────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────
-- Every version of a page that was ever live.
--
-- ── WHY THE UNDO STACK IS NOT ENOUGH ─────────────────────────────────────
--
-- The builder's undo is per SESSION and lives in the browser. Close the tab
-- and it is gone. So the only recovery from "I published that and it was
-- wrong" was to rebuild the page by hand from memory — and the owner is doing
-- that on a live shop, in a hurry, which is when second mistakes happen.
--
-- A row is written at the moment of publishing, holding what was live BEFORE
-- it. That ordering matters: it means the history is a list of states a
-- shopper actually saw, not a list of drafts.
--
-- ── CAPPED, AND TRIMMED ON WRITE ─────────────────────────────────────────
--
-- A shop that republishes its front page twice a day for three years is 2000
-- copies of a document nobody will ever read past the tenth. The application
-- deletes all but the newest MAX_VERSIONS per page as it inserts — see
-- `recordVersion`. A cap enforced by a nightly job would let the table grow
-- unbounded between runs, and there is no job to hang it off.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE storefront_page_versions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  page_id     INT UNSIGNED NOT NULL,

  -- The sections as they were live. Same document the page column holds.
  layout      TEXT NULL,

  -- Who published over it, and when. A name rather than a user id: this is a
  -- label in a list an owner reads, the row must survive the person leaving,
  -- and there is no screen that would join from here to a user.
  replaced_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  replaced_by VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),

  -- The one query: this page's versions, newest first.
  KEY ix_version_page (page_id, replaced_at),

  -- CASCADE, unlike most FKs here. A version of a page that no longer exists
  -- is unreachable by any screen — there is nothing to restore it onto — so
  -- keeping it would be keeping a row nobody can see or delete.
  CONSTRAINT fk_version_page FOREIGN KEY (page_id)
    REFERENCES storefront_pages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────
-- Sections worth keeping and using again.
--
-- ── WHY THIS EXISTS ONCE THERE IS MORE THAN ONE PAGE ─────────────────────
--
-- A shop's delivery-info cards belong on the front page, the Delivery page and
-- probably the checkout-adjacent one too. Before pages existed there was one
-- place to put them and nothing to reuse. Now the same three tiles get retyped
-- per page, and drift the moment one of them is corrected.
--
-- A saved section is a snapshot, NOT a live link. Using one COPIES it onto the
-- page, and later edits to either are independent. That is the less clever
-- choice deliberately: a live template would mean editing the delivery cards
-- silently rewrites three published pages at once, with no diff, no draft and
-- no warning — the opposite of everything the publish flow is built on.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE storefront_saved_sections (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What the owner calls it in the "insert a saved section" list.
  name       VARCHAR(80)  NOT NULL,

  -- The section kind, so the list can show what each one IS without parsing
  -- the document to find out.
  kind       VARCHAR(20)  NOT NULL DEFAULT '',

  -- ONE section, stored as the same JSON a layout holds an array of. Not an
  -- array: "save this section" is the gesture, and a saved group would need a
  -- second gesture to select one and a second shape to normalise.
  section    TEXT NOT NULL,

  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- Two saved sections called "Delivery cards" is a list nobody can use.
  UNIQUE KEY uq_saved_name (name),
  KEY ix_saved_kind (kind, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
