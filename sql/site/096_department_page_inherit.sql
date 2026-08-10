-- ─────────────────────────────────────────────────────────────────────────
-- Letting one department page stand in for the departments beneath it.
--
-- ── WHY THIS IS A COLUMN AND NOT A RULE ──────────────────────────────────
--
-- Products roll UP the tree: browsing "Wine" shows what is in "Wine › Red" as
-- well, because a shopper who picks the parent means the whole aisle. Pages did
-- not, and could not simply be made to — a shop that had built a "Wine" page
-- would suddenly find it appearing above four sub-departments it was never
-- written for, with no way to say no. Silently changing what a published page
-- renders on is not a thing a migration may do.
--
-- So inheritance is a CHOICE the owner makes per page, defaulting to 0: every
-- existing department page keeps applying to exactly the department it names,
-- which is what its owner arranged and checked. A shop with forty
-- sub-departments that wants one banner across a branch turns this on once; a
-- shop that wants each sub-department its own page simply builds them, and a
-- page of its own always wins over an inherited one.
--
-- ── WHY THE FLAG LIVES ON THE PARENT, NOT THE CHILD ──────────────────────
--
-- The alternative — a flag on each child saying "use my parent's" — needs a row
-- for every child that opts IN, which is a row per department the shop never
-- customised, and it cannot express "everything under here" for departments
-- added later. Put on the page doing the lending, one switch covers a branch
-- however it grows.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE storefront_pages
  ADD COLUMN applies_to_children TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'department pages: also render on descendant departments with no page of their own';
