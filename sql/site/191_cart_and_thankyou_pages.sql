-- ─────────────────────────────────────────────────────────────────────────
-- Two more pages an owner can arrange: the basket, and the thank you.
--
-- ── THE BASKET ───────────────────────────────────────────────────────────
--
-- A basket is where a shopper hesitates. They are short of the free-delivery
-- threshold, or wondering whether they can send it back, or trying to remember
-- what else they came for. Those are exactly the things a merchant wants to
-- say, and until now there was nowhere to say them — /checkout WAS the basket,
-- so the only page showing what somebody was buying was also the page asking
-- for their address.
--
-- ── THE THANK YOU ────────────────────────────────────────────────────────
--
-- The highest-attention page in the whole funnel, and ninety lines of fixed
-- text. Somebody who has just paid is the most willing they will ever be to
-- read what a shop has to say, join its list, or look at one more thing — and
-- a merchant could not put a single word there.
--
-- ── ONE ROW EACH, LIKE 'product' ─────────────────────────────────────────
--
-- Neither is attached to anything, so neither is per-something. `department_id`
-- and `collection_id` stay NULL, and uniqueness comes from the same
-- (kind, department_id) index that already guarantees one home page — NULL is
-- permitted any number of times in a unique index, so this is enforced in the
-- write path instead. See `singletonPage`.
--
-- No slug either: neither has an address of its own. /cart and /done are real
-- routes, and RESERVED_SLUGS already refuses both to a standard page.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE storefront_pages
  MODIFY COLUMN kind ENUM(
    'home','standard','department','product','collection','cart','thankyou'
  ) NOT NULL DEFAULT 'standard';
