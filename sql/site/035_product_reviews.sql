-- ─────────────────────────────────────────────────────────────────────────
-- Product reviews for the online store.
--
-- ── MODERATED, ALWAYS ────────────────────────────────────────────────────
--
-- Nothing appears on the storefront until a person approves it, and there is
-- deliberately NO auto-approve setting.
--
-- Storefront shoppers are anonymous — a name and maybe an order number, no
-- account behind either. A self-publishing public form on a shop's own page is
-- a spam and defamation surface, and the store carries the consequences of
-- whatever appears there. "Approve everything automatically" is a switch that
-- would be turned on once, forgotten, and regretted; leaving it out is the
-- feature.
--
-- ── order_number IS NOT PROOF OF PURCHASE ────────────────────────────────
--
-- It is captured when the shopper offers one, purely so staff can see "this
-- person did buy it" while moderating. Nothing verifies it — anyone can type
-- any order number — so it must NEVER be shown to shoppers as a "verified
-- purchase" badge. Doing that would put the shop's credibility behind a claim
-- nothing checked. A real badge needs the review raised from a signed-in
-- customer against an order that actually contains the product, and that is a
-- different feature.
--
-- ── WHY THE PRODUCT IS A FOREIGN KEY ─────────────────────────────────────
--
-- The old design stored a StockCode string, which drifts the moment a product
-- is recoded and leaves reviews attached to nothing. CASCADE on delete: a
-- product that is genuinely removed takes its reviews with it, because a review
-- of something that no longer exists cannot be shown or moderated. (Products
-- are normally archived rather than deleted, which leaves reviews intact.)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_reviews (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id     INT UNSIGNED NOT NULL,

  -- 1..5, clamped on write. A rating outside that is a bug or a hand-crafted
  -- request, and neither should reach a star display.
  rating         TINYINT UNSIGNED NOT NULL DEFAULT 5,
  title          VARCHAR(120)  NOT NULL DEFAULT '',
  body           VARCHAR(1000) NOT NULL DEFAULT '',

  -- What the shopper typed. Not a customer record: most reviewers are guests.
  author_name    VARCHAR(80)   NOT NULL DEFAULT '',
  -- Unverified. See the note above.
  order_number   VARCHAR(32)   NOT NULL DEFAULT '',

  status         ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  -- Why it was turned down, for whoever asks later.
  decline_reason VARCHAR(190)  NOT NULL DEFAULT '',

  submitted_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  moderated_at   DATETIME     NULL,
  moderated_by   VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  -- The moderation queue: oldest pending first.
  KEY ix_review_status (status, submitted_at),
  -- The storefront's product page: approved reviews for one product.
  KEY ix_review_product (product_id, status),
  CONSTRAINT ck_review_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_review_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Whether the storefront shows reviews at all, and invites new ones. Off by
-- default: a shop should decide to take public feedback, not discover it has.
ALTER TABLE online_store_settings
  ADD COLUMN reviews_enabled TINYINT(1) NOT NULL DEFAULT 0;
