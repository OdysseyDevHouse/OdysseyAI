-- ─────────────────────────────────────────────────────────────────────────
-- The three things a merchant may change about checkout, and no more.
--
-- ── WHY THE LIST IS THIS SHORT ───────────────────────────────────────────
--
-- Checkout is where the money is and where a broken layout costs a sale that
-- never comes back. Its own header argues for one page rather than a wizard,
-- and that reasoning is right — so there is deliberately no section builder
-- here, no field reordering and no step splitting. A merchant-arrangeable
-- checkout is how a shop ends up shipping a Pay button below three product
-- rows.
--
-- What IS offered is the wording somebody genuinely needs and currently has
-- nowhere to put:
--
--   · POLICY LINKS. "What happens if it does not fit" is the question asked at
--     the moment of paying, and a shop that answers it on a page nobody can
--     reach from here has answered nobody. Up to three of the shop's own pages,
--     as a row above the button.
--
--   · A TRUST LINE. One sentence. "Every order is checked by hand before it
--     leaves." Text only — no links, no rich text, nothing that can grow into a
--     second paragraph competing with the button beside it.
--
--   · THE ORDER NOTE. The field already exists and says "Anything else?", which
--     is the right question for a grocer and the wrong one for a florist who
--     needs a gift message, or a fitment centre that needs a registration
--     number. A label, and whether it must be filled in.
--
-- ── THE POLICY PAGES ARE IDS, NOT A LIST OF LINKS ────────────────────────
--
-- CSV of storefront_pages ids, resolved to a slug at render time — the same
-- decision the menu made, and for the same reason. A page that is renamed keeps
-- its link, and one that is deleted or unpublished simply stops appearing
-- rather than becoming a dead link on the page that takes payments.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE online_store_settings
  -- Up to three page ids, as CSV. Anything not a published page is dropped on
  -- read, so a deleted page cannot leave a broken link at the payment step.
  ADD COLUMN IF NOT EXISTS checkout_policy_pages VARCHAR(60) NOT NULL DEFAULT '',
  -- One sentence above the button. Empty hides it.
  ADD COLUMN IF NOT EXISTS checkout_trust_line VARCHAR(200) NOT NULL DEFAULT '',
  -- What the free-text field asks for. Empty keeps the existing wording.
  ADD COLUMN IF NOT EXISTS checkout_note_label VARCHAR(60) NOT NULL DEFAULT '',
  -- Whether it must be filled in. Only meaningful with a label, since a
  -- required field with no question is a form nobody can complete.
  ADD COLUMN IF NOT EXISTS checkout_note_required TINYINT(1) NOT NULL DEFAULT 0;
