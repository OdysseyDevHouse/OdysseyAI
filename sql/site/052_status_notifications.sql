-- Telling the customer when their order reaches a status.
--
-- ── THREE MODES, NOT A PILE OF FLAGS ────────────────────────────────────
--
-- A status either says nothing, sends the standard message for one of a few
-- known moments, or sends the shop's own email. `use_template` decides which
-- of the last two applies, and it is an explicit flag rather than "is the html
-- column empty" — so a shop can draft an email over a week without it going
-- out on every order in the meantime.
--
-- Silence is the default for every existing status. A migration that suddenly
-- started emailing a shop's customers on statuses they set up months ago would
-- be indefensible.

ALTER TABLE online_order_statuses
  -- '' means no standard message. The four values are moments a shopper
  -- actually wants to hear about, not a message per step: a notification on
  -- every internal step is how a customer learns to ignore all of them.
  ADD COLUMN notify_kind ENUM('', 'accepted', 'ready', 'on_the_way', 'cancelled')
    NOT NULL DEFAULT '' AFTER role,
  ADD COLUMN use_template TINYINT(1) NOT NULL DEFAULT 0 AFTER notify_kind,
  ADD COLUMN email_subject VARCHAR(255) NOT NULL DEFAULT '' AFTER use_template,
  -- MEDIUMTEXT: an email with an inlined logo as a data: URI runs past what
  -- TEXT holds, and truncating someone's template mid-tag is worse than the
  -- extra bytes. Sanitised on write AND on read.
  ADD COLUMN email_html MEDIUMTEXT NULL AFTER email_subject;

-- Seed the standard messages onto the statuses that already mean those things,
-- matched on ROLE where there is one and on code otherwise. A shop that has
-- renamed "Ready" to "Waiting at the counter" still gets the right message,
-- because the role is what carries the meaning.
--
-- 'new' is deliberately left silent: the "we've got your order" message goes
-- out when the order is PLACED, and setting it here as well would thank the
-- same person twice within a second.
UPDATE online_order_statuses SET notify_kind = 'cancelled' WHERE role = 'cancelled';
UPDATE online_order_statuses SET notify_kind = 'on_the_way' WHERE role = 'dispatched';
UPDATE online_order_statuses SET notify_kind = 'ready'
  WHERE notify_kind = '' AND role = '' AND code = 'ready';
UPDATE online_order_statuses SET notify_kind = 'accepted'
  WHERE notify_kind = '' AND role = '' AND code = 'accepted';
