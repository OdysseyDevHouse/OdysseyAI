-- ============================================================================
-- One answer can ask further questions.
--
-- "Make it a meal" is not an answer on its own — it is the start of two more
-- questions ("which side?", "which drink?"). Without this a shop can only model
-- that by attaching both questions to the product and asking them of everybody,
-- so the customer who wanted a plain burger is still asked which chips they
-- would like.
--
-- ── WHY A TABLE AND NOT A COLUMN ────────────────────────────────────────────
--
-- A nullable reveals_group_id on instruction_options would be smaller, and for
-- "add a side → which side?" it would be enough. It cannot express the case
-- above, where one answer opens more than one question, and that case is the one
-- combo meals are made of. Reaching it through a chain of single reveals would
-- mean inventing a placeholder group whose only answer reveals the next one —
-- configuration that exists to work around the schema rather than to describe
-- the menu.
--
-- ── DEPTH AND CYCLES ────────────────────────────────────────────────────────
--
-- Nothing here stops a group revealing itself, directly or round a loop. A
-- FOREIGN KEY cannot express "and not back to where you started", so the rule is
-- enforced in code, twice and deliberately:
--
--   · when SAVING, so the person configuring it gets a sentence explaining that
--     the questions would loop, and can fix it;
--   · when RESOLVING for the till, with a visited-set and a hard depth cap,
--     regardless of what this table happens to contain.
--
-- The second is not redundant. Two people editing two groups at the same time
-- can each save something valid and leave a cycle behind that neither save could
-- see, and a till that meets it must truncate quietly rather than hang with a
-- customer at the counter. The cap is 3: a cashier with a queue cannot navigate
-- a deeper decision tree, and the modal has to show the whole chain at once to
-- be usable.
-- ============================================================================

CREATE TABLE instruction_option_reveals (
  option_id  INT UNSIGNED NOT NULL,
  group_id   INT UNSIGNED NOT NULL,
  -- The order the revealed questions appear in, so "which side?" can be asked
  -- before "which drink?" rather than in whatever order the ids fall.
  sort_order INT NOT NULL DEFAULT 0,

  PRIMARY KEY (option_id, group_id),
  -- Answering "which groups does this option reveal" is the common read; the
  -- reverse — "is anything revealing this group?" — is what deleteGroup asks
  -- before it lets a group go, and it needs its own index to be cheap.
  KEY ix_reveal_group (group_id),

  -- CASCADE from the option, for the reason 010 gives about its own options: a
  -- reveal has no meaning once the answer that triggers it is gone.
  CONSTRAINT fk_reveal_option FOREIGN KEY (option_id)
    REFERENCES instruction_options (id) ON DELETE CASCADE,
  -- CASCADE from the group as well, and this one deserves a note because it
  -- looks dangerous: deleting a group would silently turn a two-step question
  -- into a one-step one. It cannot happen — deleteGroup refuses while any reveal
  -- points at the group, exactly as it already refuses while any product asks it.
  -- The cascade is the backstop for a group removed by hand in SQL, where
  -- leaving a row pointing at nothing would be worse.
  CONSTRAINT fk_reveal_group FOREIGN KEY (group_id)
    REFERENCES instruction_groups (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
