-- ─────────────────────────────────────────────────────────────────────────
-- Custom comments on a sale, asked for by tender type.
--
-- ── WHY THIS IS NINE LINES AND NOT A NEW SUBSYSTEM ───────────────────────
--
-- The requirement reads as a new feature: "the customer must be able to
-- configure as many custom comment fields as they want, each with their own
-- label", replacing a legacy system's fixed four. Name, Surname, Age,
-- Occupation, captured when a sale is finalised on Account.
--
-- 127 already built that. `custom_field_defs` holds an unlimited number of
-- named fields with types, hints, ordering, a required flag and a retire flag,
-- and 127's own header states the design intent this migration is cashing in:
--
--     "nothing here mentions a job. The entity is a column, jobs are the first
--      consumer, and a customer field is not a job field wearing a flag."
--
-- So a sale becomes the fourth consumer. A second mechanism would mean two
-- unrelated screens for "extra fields of my own", each with its own validation
-- and its own reporting — and the one nobody maintained would be the one a
-- shop happened to use.
--
-- ── WHAT WAS GENUINELY MISSING, AND IS ADDED BELOW ───────────────────────
--
-- The TRIGGER. Every other consumer attaches fields to a record TYPE: every job
-- gets the job fields, always. A sale is different — the comments are wanted on
-- an Account sale and not on a cash one, so something has to say WHICH tenders
-- ask.
--
-- That is a property of the tender, not of the field, so it goes on
-- tender_types. One flag, not a join table between tenders and fields:
--
--   · A join table would let Account ask four questions and Deposit ask one,
--     which sounds better until a SPLIT sale pays half on each. Two different
--     question sets on one document has no sensible answer — ask both? the
--     first? the larger half? — and every answer is a rule nobody can predict.
--
--   · The flag has one answer by construction: the sale either asked or it did
--     not. A basket settled across three tenders where any one of them wants
--     comments asks once, for the whole set, and the ambiguity never exists.
--
-- The cost is stated plainly: a shop that genuinely wants different questions
-- per tender cannot have them. That is a real limit and it buys a rule a
-- cashier can predict at the counter, which on a till is worth more.
-- ─────────────────────────────────────────────────────────────────────────

-- A sale is now a thing fields may be attached to.
--
-- Both ENUMs, and they must agree: `custom_field_values.entity` is repeated
-- rather than read through field_id (see 127) precisely so a record's values
-- are one indexed read, and a value whose entity the column cannot hold would
-- be refused on write with an error naming neither table.
ALTER TABLE custom_field_defs
  MODIFY COLUMN entity ENUM('job','customer','equipment','sale') NOT NULL;

ALTER TABLE custom_field_values
  MODIFY COLUMN entity ENUM('job','customer','equipment','sale') NOT NULL;

-- Whether finalising on this tender asks for the sale's custom comments.
--
-- Off for every existing tender, including the seeded four. A shop that has
-- never defined a sale field sees no change at all, and one that defines some
-- still has to say where they are asked for — a field set that started
-- interrupting every cash sale the moment it was created would be a surprise
-- at a counter, which is the worst place to be surprised.
--
-- On tender_types beside `requires_reference`, which is the same shape of rule:
-- a property of the payment method that makes the till ask for something before
-- it will finalise.
ALTER TABLE tender_types
  ADD COLUMN IF NOT EXISTS asks_custom_comments TINYINT(1) NOT NULL DEFAULT 0
    AFTER reference_label;
