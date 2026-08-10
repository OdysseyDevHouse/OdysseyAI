-- ============================================================================
-- Instructions, part two: an answer can be COUNTED, pictured, and routed.
--
-- 010 gave a group its bounds — how many of its answers may be chosen. What it
-- had no way to say is how many of ONE answer: "extra bacon" was a yes or a no,
-- and a customer who wanted three rashers was rung up as one. This adds the
-- count, and with it the two bounds that make a count safe to put in front of a
-- cashier.
--
-- ── WHY THE COUNT IS ON THE OPTION AND NOT THE GROUP ────────────────────────
--
-- They answer different questions and a shop needs both. The group's
-- min_choices/max_choices decide HOW MANY OF THE ANSWERS may be picked ("up to
-- two toppings"). These decide HOW MANY OF THIS ONE ("bacon, up to three").
--
-- The interaction is the thing that will be got wrong by whoever reads this
-- next, so it is written down: max_choices counts DISTINCT OPTIONS CHOSEN, not
-- units. "Up to 2 toppings" with bacon ×3 and cheese ×1 is TWO choices against
-- that ceiling, not four. Summing the counts instead would refuse an order the
-- shop plainly meant to allow.
-- ============================================================================

ALTER TABLE instruction_options
  -- How many of this option one item may carry.
  --
  -- max_qty 1 is the classic answer — a tick box, chosen or not — and it is the
  -- default, so every row that exists today keeps behaving exactly as it does.
  -- Above 1 the till shows a stepper. 0 means NO CEILING, matching the meaning
  -- max_choices already has on the group (010): one convention, even though a
  -- ceiling of "zero" reads oddly the first time, beats two.
  ADD COLUMN max_qty     SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  -- The floor once this option is CHOSEN — not a way of making it compulsory.
  --
  -- Compulsion belongs to the group (is_required / min_choices), and the two are
  -- kept apart for the same reason 010 keeps is_required and min_choices apart:
  -- "if you want gravy at all you must take at least two ladles" and "you must
  -- answer this question" are different sentences and a shop means one or the
  -- other. A min_qty on an unchosen option constrains nothing.
  ADD COLUMN min_qty     SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- The count applied when is_default puts this option up pre-ticked.
  --
  -- is_default stays the flag for "is it ticked"; this is "at what count". Zero
  -- with is_default set reads as one — a pre-ticked answer at a count of nothing
  -- is not a state anybody means, and resolving it here keeps every reader from
  -- having to.
  ADD COLUMN default_qty SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- A picture of the answer, for a touchscreen till and for the shop.
  --
  -- Points at storefront_images for the same reasons 064 gives for departments:
  -- that table already owns the magic-byte check on the way in, the serving
  -- routes with their sandbox CSP, the picker, and the library cap. A second
  -- uploads table would duplicate all four and the copy is what would miss one.
  --
  -- NO FOREIGN KEY, also per 064: a picture may be deleted while an option still
  -- names it, and that is not an error — every reader resolves a missing id to
  -- null and falls back to the name alone. The readers must cope with a dangling
  -- id regardless, since the row can vanish between the read and the render, so
  -- the rule lives in one place rather than two that can disagree.
  ADD COLUMN image_id    BIGINT UNSIGNED NULL DEFAULT NULL,

  -- Where this answer is REPEATED once it has been chosen.
  --
  -- These are not about money — an option with no price adjustment still has to
  -- reach the kitchen. "No onions" costs nothing, must be on the ticket the cook
  -- reads, and is clutter on the customer's slip. "Regular milk" is the opposite:
  -- worth confirming on the slip, nothing for the kitchen to do differently.
  -- Without these two flags a shop can only choose between telling everyone and
  -- telling no one.
  --
  -- Both default to 1 — printing everything is the only safe behaviour for a shop
  -- that upgrades into this, because an option silently missing from a kitchen
  -- ticket is a wrong plate going out.
  ADD COLUMN prints_on_kitchen TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN prints_on_receipt TINYINT(1) NOT NULL DEFAULT 1;

-- A picture for the question itself, shown at the head of the group.
ALTER TABLE instruction_groups
  ADD COLUMN image_id BIGINT UNSIGNED NULL DEFAULT NULL;

-- ── When a product's questions last changed ─────────────────────────────────
--
-- For the till's catalogue sync, which asks "what has changed since?" and gets
-- its answer from updated_at columns. products.updated_at does NOT move when a
-- group is attached to or detached from a product — this is the same blind spot
-- product_prices had, and the reason pricesChangedSince() exists.
--
-- The other two tables in this feature already carry updated_at; this join table
-- was the one that did not, because until now nothing read it at sale time.
ALTER TABLE product_instruction_groups
  ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP;
