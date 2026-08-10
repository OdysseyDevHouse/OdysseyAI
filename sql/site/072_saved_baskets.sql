-- Saved baskets: the shopping someone left behind, and the one email about it.
--
-- ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
--
-- The basket lives in the browser's localStorage (CartContext.tsx), which is
-- the right place for it: no account needed, no server round trip per tap, and
-- nothing of a browsing stranger stored anywhere. But it also means a shopper
-- who fills a basket on their phone, gets interrupted, and comes back on a
-- laptop has lost it — and the shop never knew there was one.
--
-- Roughly seven baskets in ten are abandoned across the industry. This table is
-- what lets a shop send ONE email about it.
--
-- ── THIS IS AN OPT-IN, NOT A NET ─────────────────────────────────────────
--
-- Nothing here is captured by browsing. A row exists only when the shopper
-- typed an address into a box that says "save my basket", or was already signed
-- in. There is deliberately no fingerprint, no cookie-keyed shadow profile and
-- no capture on the way into checkout — a shop emailing people who never asked
-- is how a storefront gets marked as spam, and it is the wrong thing to do.
--
-- ── ONE REMINDER, EVER ───────────────────────────────────────────────────
--
-- `reminded_at` is the guard, and it is a timestamp rather than a counter
-- because there is no second reminder to count. A sequence of three "did you
-- forget?" emails is what turns a helpful nudge into the reason someone
-- unsubscribes from a shop they actually liked.
--
-- ── WHY THE LINES ARE JSON ───────────────────────────────────────────────
--
-- A saved basket is a MEMO, not a document. It is never priced, never
-- reserved, never posted; it exists to be handed back to the same cart the
-- shopper already had. A child table would buy referential integrity over
-- product ids that are re-resolved from the catalogue at recovery time anyway
-- — the recovery path re-prices from `products`, exactly as checkout does, so
-- a stale id in here becomes a line that is quietly dropped rather than a
-- basket that cannot be restored.
--
-- online_order_lines is the opposite case and keeps its own table: an order is
-- evidence of what was agreed, so its lines must be rows that outlive the
-- product file.

CREATE TABLE IF NOT EXISTS online_saved_baskets (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Who to write to. The only reason a row exists.
  contact_email   VARCHAR(190) NOT NULL,
  contact_name    VARCHAR(160) NOT NULL DEFAULT '',

  -- Set when the shopper was signed in. Kept so a reminder can address them by
  -- the name on their account rather than whatever they typed, and so a shop
  -- can see that a saved basket belongs to a real customer.
  customer_id     INT UNSIGNED NULL,

  -- [{ "productId": 12, "qty": 2 }, ...] — ids and quantities, nothing else.
  -- No prices: see the note above, and the storefront's rule that a posted
  -- price is ignored rather than validated.
  --
  -- Named `basket_lines` rather than `lines` because LINES is a reserved word
  -- in MariaDB (it belongs to LOAD DATA). Backquoting it everywhere would work
  -- until the one query that forgot.
  basket_lines    JSON NOT NULL,

  -- What the basket was worth WHEN SAVED, for the shop's own reporting and to
  -- put a figure in the reminder. Never used to charge anything.
  subtotal_incl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The unguessable half of the recovery link. Random per row rather than
  -- derived from the id or the email, so one link cannot be turned into
  -- another by editing it.
  recovery_token  CHAR(43)     NOT NULL,

  -- NULL until the one reminder goes out. See the note above.
  reminded_at     DATETIME     NULL,

  -- Set when the shopper follows the link back. Keeps a recovered basket from
  -- being reminded about again, and tells the shop whether any of this works.
  recovered_at    DATETIME     NULL,

  -- Set when the basket becomes an order, so a shopper who checks out is never
  -- asked whether they forgot something they just bought.
  ordered_at      DATETIME     NULL,

  -- The shopper's own "stop emailing me". Distinct from deleting the row:
  -- the basket may still be recovered from a link they already hold, and a
  -- deleted row would simply be recreated on their next save.
  unsubscribed    TINYINT(1)   NOT NULL DEFAULT 0,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- ONE live basket per shopper, upserted.
  --
  -- Without this, every visit writes another row and the sweep below sends one
  -- email per row — the exact "three reminders" failure the design refuses.
  -- The email is the identity because that is what a reminder is addressed to.
  UNIQUE KEY uq_saved_basket_email (contact_email),

  UNIQUE KEY uq_saved_basket_token (recovery_token),

  -- The sweep's query: baskets never reminded, never recovered, never ordered,
  -- old enough to have been abandoned.
  KEY ix_saved_basket_due (reminded_at, recovered_at, ordered_at, updated_at),

  -- SET NULL, not CASCADE: deleting a customer record must not silently
  -- destroy the evidence that a basket was saved. The email on the row is
  -- what the reminder needs, and it stands on its own.
  CONSTRAINT fk_saved_basket_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The shop's controls ──────────────────────────────────────────────────
-- On the settings row rather than in `settings`, for the same reason
-- everything else on that table is: these are read together on the storefront
-- request that decides whether to show the save box at all.
ALTER TABLE online_store_settings
  -- OFF by default, deliberately. Emailing shoppers is a decision a shop makes,
  -- not one that happens to it because a migration ran.
  ADD COLUMN basket_reminders   TINYINT(1) NOT NULL DEFAULT 0,

  -- How long a basket sits untouched before it counts as abandoned. Four hours
  -- by default: long enough that someone who is still shopping is not chased,
  -- short enough that the reminder arrives while they still want the goods.
  ADD COLUMN basket_reminder_hours SMALLINT UNSIGNED NOT NULL DEFAULT 4,

  -- What the reminder says, above the items. Empty means the standard wording.
  ADD COLUMN basket_reminder_note VARCHAR(500) NOT NULL DEFAULT '';
