-- ─────────────────────────────────────────────────────────────────────────
-- People who asked the shop to email them.
--
-- ── WHY NOT A COLUMN ON `customers` ──────────────────────────────────────
--
-- Because a subscriber is not a customer, and conflating them causes two
-- separate problems.
--
-- A `customers` row is an ACCOUNT: it has a code, a status, a credit limit, an
-- ageing position and a statement. Creating one every time a stranger types an
-- email into a form on the front page would fill the customer file — the thing
-- staff search all day, and the thing the age analysis reports on — with rows
-- that will never transact. `customers.code` is NOT NULL and unique, so each
-- one would also need a number allocated from the same sequence real accounts
-- draw from.
--
-- And in the other direction: most subscribers never become customers, while
-- most customers never consented to marketing. Storing consent on the account
-- would leave every existing customer in an undefined state — which is exactly
-- the state you must not be in when somebody asks whether you had permission.
--
-- So: its own table, holding the one fact it exists to hold. A subscriber who
-- later opens an account is matched by email at that point if anybody cares.
--
-- ── CONSENT IS EVIDENCE, NOT A FLAG ──────────────────────────────────────
--
-- POPIA (and GDPR, for a shop with EU customers) both turn on being able to
-- SHOW that permission was given, not merely on asserting it. A boolean cannot
-- do that. So the row records when they agreed and what the form said at the
-- time — because the wording changes, and "they consented" means nothing
-- without knowing what they were consenting to.
--
-- Unsubscribing sets `unsubscribed_at` rather than deleting the row: proving
-- somebody opted OUT matters just as much, and a deleted row cannot be
-- distinguished from one that was never there when the same address signs up
-- again.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE storefront_subscribers (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Stored lowercase and trimmed by the application, so the unique key below
  -- actually prevents duplicates. 190 to stay inside utf8mb4's index limit,
  -- matching `customers.email`.
  email           VARCHAR(190) NOT NULL,

  -- Optional: the form asks for it, and plenty of people will not give it.
  name            VARCHAR(120) NOT NULL DEFAULT '',

  -- ── THE EVIDENCE ───────────────────────────────────────────────────────
  --
  -- When they agreed, and to what. `consent_text` is a copy of the wording
  -- beside the tick box at the moment they ticked it — not a reference to the
  -- current wording, which is the version that will have changed by the time
  -- anybody asks.
  consented_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consent_text    VARCHAR(300) NOT NULL DEFAULT '',

  -- Which page they signed up from. Useful, and cheap to keep.
  source_page     VARCHAR(60)  NOT NULL DEFAULT '',

  -- NULL means still subscribed. See the header on why this is not a DELETE.
  unsubscribed_at DATETIME     NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One row per address. A second sign-up from the same person updates the
  -- existing row rather than creating a duplicate the shop would email twice.
  UNIQUE KEY uq_subscriber_email (email),

  -- The export a shop actually runs: everyone still subscribed, in order.
  KEY ix_subscriber_live (unsubscribed_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
