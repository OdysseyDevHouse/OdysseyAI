---
description: Turn a meeting change register into a sequenced implementation plan
---

Turn a change register from `docs/meetings/` into an implementation plan the team can
work through, and a short readout the meeting's attendees can be sent.

Arguments the user gave: $ARGUMENTS

A path to a register file, or nothing — in which case use the newest file in
`docs/meetings/`. If they named specific `CR-` numbers, plan only those.

## Before planning

Read the register in full, then verify it against the code. The register was written
from what people said; you are now checking what it actually costs. For each item,
open the file it points at. Expect surprises in both directions — a "trivial" move is
sometimes a shared component used on nine screens, and a "needs design" ask is
sometimes a prop that already exists. Correct the size estimate in the register when
you find one wrong, and say in the plan that you did.

Anything touching `src/components/ui/` gets called out loudly: per AGENTS.md, that is
a product-wide restyle, not a screen tweak.

## Write the plan

Write to `docs/plans/<short-topic>.md`, matching the house style of the files already
in that folder. Structure:

1. **What this is** — one paragraph, and a link back to the register file.
2. **Batches**, in the order they should be done. Group by what makes them cheap to do
   together — same screen, same component, same migration — not by who asked. Each
   batch: the `CR-` numbers it closes, the files it touches, and what "done" looks like.
3. **Needs a decision first** — items blocked on a conflict or an unanswered question,
   with what the decision is between. These do not get scheduled.
4. **Deliberately not doing** — parked items, with the reason from the register, so
   nobody quietly re-adds them.
5. **Risk notes** — migrations, licensing, anything with an audit trail, anything that
   changes what an existing site already sees.

Sequence so that the visible wins land first where that costs nothing — bosses who see
their button move believe the rest of the plan — but never at the price of doing a
migration twice.

## Then

Report a short readout: batch count, rough shape of the work, what is blocked and on
whom. Offer to publish the readout as a shareable page for the attendees. Do not start
implementing.
