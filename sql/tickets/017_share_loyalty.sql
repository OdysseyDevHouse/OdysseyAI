-- Sharing the loyalty programme across a store group.
--
-- ── WHY LOYALTY GETS ITS OWN SWITCH ──────────────────────────────────────
--
-- Until now loyalty was central only by RIDING ON the customer file's owner:
-- every read and write went through customerQuery / customerTransaction, and
-- customerDb.ts even named loyalty a member of the "customer cluster". So the
-- only shape available was "shared customers ⇒ shared loyalty", and a group
-- with twenty separate debtors books could not run one programme.
--
-- That is the ordinary case, not an exotic one. A franchise runs one card
-- across stores that each invoice their own account customers. So loyalty gets
-- its own flag, its own resolver (loyaltyOwnerSite) and its own wrappers, and
-- the three switches are independent: a group may share loyalty and nothing
-- else, or customers and not loyalty.
--
-- Per member rather than per group, exactly like shares_customers: a branch
-- that has not switched it on neither contributes to the shared programme nor
-- reads from it, and the primary having it on is not enough to pull a branch
-- in. Both ends must hold it.

ALTER TABLE cp2_store_group_members
  ADD COLUMN shares_loyalty TINYINT(1) NOT NULL DEFAULT 0 AFTER shares_suppliers;

-- ── May separate companies share the WALLET? ─────────────────────────────
--
-- This one is on the GROUP, not the member, because it is one commercial
-- judgement about the whole arrangement rather than a per-branch choice — the
-- same shape and the same reason as legal_entity in 016.
--
-- POINTS AND THE WALLET ARE NOT THE SAME KIND OF THING, and this column exists
-- because the difference only matters for one of them.
--
--   Points, tiers and punch cards are a MARKETING PROMISE. A franchise group
--   running one card across separately-owned stores is ordinary and legitimate;
--   nothing is owed between the companies when a shopper earns at one and
--   redeems at another, because points were never anybody's money.
--
--   The wallet is MONEY THE SHOPPER HANDED OVER. Topped up with R500 at store
--   3 and spent at store 7, store 3 is a different registered company holding
--   cash that store 7 has now given goods for. That is an inter-company balance
--   neither company's books record — precisely the objection 016 raises about
--   sharing a debtors book across taxpayers, and it does not go away because
--   the instrument is called a wallet.
--
-- ── SO WHY IS IT AN OPTION RATHER THAN A REFUSAL? ────────────────────────
--
-- Because it is a commercial decision the owner is entitled to make and the
-- software is not entitled to make for them. A franchise group with a
-- settlement agreement between its members has already answered the question;
-- one without has not, and would be walking into it unaware.
--
-- What the software CAN do is make the trade visible at the moment of choosing
-- rather than discoverable afterwards. So this defaults to 0 — the safe answer,
-- and the one that needs no agreement — and the screen states the consequence
-- in plain terms beside the switch.
--
-- It is only ever consulted when legal_entity = 'several'. One company sharing
-- its own wallet across its own branches raises no question at all: there is
-- one taxpayer, one set of books, and the float is already theirs.

ALTER TABLE cp2_store_groups
  ADD COLUMN shares_loyalty_wallet TINYINT(1) NOT NULL DEFAULT 0 AFTER legal_entity;
