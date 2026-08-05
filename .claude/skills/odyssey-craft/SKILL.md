---
name: odyssey-craft
description: How an OdysseyAI screen should be composed so it looks considered rather than merely legal — density, hierarchy, colour as meaning, table and form structure, empty and loading states. Use this alongside odyssey-ui whenever building or reworking a screen, laying out a page, adding a table/list/dashboard/form, or when asked to "make it look better", "tidy this up", "make it modern", or "why does this look flat".
---

# OdysseyAI craft

`odyssey-ui` says which component and which token — *is this legal?* This says
how to arrange them — *is this good?* A screen can pass every check in that file
and still look flat, and flat is what this exists to prevent.

The audience is a back-office operator who lives in this app all day: staff
pricing stock, capturing GRVs, running cash-ups. They are not visiting a
landing page. Their measure of good is **how fast the screen answers the
question they opened it with**, not how impressive it looks in a screenshot.

## The governing idea: chrome is roomy, data is dense

One rule explains most of the numbers below.

**Chrome** — page header, stat strip, toolbar, filters, form fields — is
touched once per visit. It gets room. Cramped controls are the single thing
that makes a back office feel cheap.

**Data** — table rows — is scanned hundreds of times. It gets tight. Every
row of padding is a row of product the user has to scroll to reach.

Getting this backwards in either direction is the most common way an OdysseyAI
screen goes wrong: airy rows that show ten products on a 1,284-product
catalogue, or a 28px-tall search box wedged against a table.

## Numbers

Defaults, not laws — but deviate on purpose, not by accident.

| Element | Value | Why |
| --- | --- | --- |
| Page gutter | `px-6` (`PageBody`) | Already the kit default. |
| Section gap | `gap-5` (`PageBody`) | Between stat strip, toolbar-card, pagination. |
| Stat tile | `p-4`, `text-2xl` value, `text-xs` label | `StatTile` already ships this. |
| Stat strip → card | `gap-5` | Part of `PageBody`'s flow. |
| Toolbar padding | `px-4 py-3.5` | Roomy. This is the part users click. |
| Control height | `h-control` (40px) | Search, selects, buttons — never shrink these. |
| Table header | `px-4 pt-3 pb-2.5` (`TABLE_TH`) | Unchanged. |
| **Table cell** | **`px-4 py-1.5`** (`TABLE_TD`) | **36px rows.** The one number that differs from the old kit. |
| Inline row action | `h-control-sm` (32px) | Smaller than a real button, still hittable. |

Row height is the number to hold onto: **36px**, roughly 16 rows visible before
scrolling at a normal viewport. Rows at 48px show 10, and on a catalogue of
1,284 products that is the difference between one scroll and two on every
single lookup.

Money and quantities: `numeric` class, right-aligned, always. Columns that
don't line up are unreadable at speed, and this app is nothing but columns of
numbers.

## Hierarchy: something must be loudest

A screen where everything is the same weight gives the eye nowhere to land.
This is what "flat" actually means, and it is nearly always the real problem
when a screen looks wrong but every component is correct.

On any screen, decide in this order:

1. **The one number or row that matters.** The exception — 37 below minimum,
   the negative margin, the unposted GRV. Give it colour or weight.
2. **The one action that matters.** Exactly one `primary` button per screen.
   Two primaries is zero primaries. Everything else is `secondary` or `ghost`.
3. **Everything else recedes.** `text-muted` for labels and hints, `text-ink-2`
   for table body, `text-ink` reserved for what you actually want read.

Concretely: in a stat strip, the count that means *act on me* takes
`tone="warning"` or `"danger"`; the plain counts stay `default`. Three tiles
all in the same ink is three tiles nobody looks at.

## Colour marks exceptions, never decorates

The tokens carry meaning. Spending them on decoration destroys the signal that
makes an exception visible.

- `danger` — destructive, blocked, out of stock, negative
- `warning` — needs attention, below minimum, expiring, unposted
- `success` — good, in stock, posted, paid
- `brand` — new, informational, the current selection
- neutral (`badge` on `surface-2`) — a plain count with no judgement attached

If most rows in a column are coloured, the colour has stopped meaning anything —
either the threshold is wrong or that column shouldn't be a badge at all.

**State gets a form, not just a value.** `0` and `142` in the same grey column
read identically at scanning speed. Out-of-stock becomes a `danger` badge, low
stock a `warning` badge, normal stock a plain tabular number. The exceptions
then pop without anyone reading a single digit — which is the entire job of a
stock column.

## Tables

The default surface of this app. Most craft problems are table problems.

**Column count.** Past about 8 columns a table stops being scannable. Move
detail to the row's own screen or a drawer and keep the list to what someone
scans *for*: identity, state, the number they came to check. "It's all useful"
is not a reason to show it all at once — everything visible means nothing
prominent.

**Column order.** Identity first (SKU, code, name), then state, then numbers,
then actions hard right. Numbers grouped together so they can be compared
without the eye jumping over text columns.

**Row identity.** A leading tile or thumbnail makes a row findable by shape
rather than by reading — worth the 26px on any list of products or people. Use
`tiles.ts` so the colour is stable per record, not random per render.

**Actions.** Icon-only, `ghost`/`bare`, right-aligned, revealed on row hover
where practical. A visible "Edit" button on every row is 50 buttons competing
with the data. Anything beyond two actions goes in a `Menu`.

**Sorting.** Give any column a `sortValue` when its cell renders anything but a
plain string or number, or it will sort by rendered markup and appear broken.

## Forms

**Group by what the user is doing**, not by table column order. A product form
is *Identity / Pricing / Stock / Suppliers*, each its own `Card`. One long
undifferentiated column of fields is where data entry goes to die.

**Field width should hint at content length.** A full-width input for a 3-digit
reorder level tells the user the wrong thing. Constrain short fields.

**Required, not optional, is what gets marked.** Most fields are required in
this app; mark the exceptions.

**Errors go under the field** via `Field`'s `error` prop, never only in a
toast. A toast saying "3 fields invalid" with nothing marked is a puzzle.

**Every mutation ends in a toast.** Silence after a save reads as failure —
the user cannot tell "saved" from "did nothing".

## Empty, loading, and error states

These are most of what a new user sees, and are usually the least considered
part of a screen.

**Empty means one of three things — say which.** Nothing exists yet (offer the
action that creates one), a filter excluded everything (offer to clear it), or
a search missed (echo the term). `EmptyState` must always name what is missing
*and* what to do next. "No results" alone is a dead end.

**Loading should preserve layout.** A skeleton at the table's real row height
beats a spinner that collapses the page and then shoves it back down.

**Errors state the fix.** "Could not save — the SKU AB-100 already exists"
beats "An error occurred", always.

## Density is not the same as cramped

Dense rows work *because* the chrome around them is roomy. Tightening both is
how a screen becomes genuinely unpleasant to use. If a table starts to feel
oppressive, the fix is usually more room around it — toolbar padding, section
gaps, page gutter — not taller rows.

Never compensate by shrinking the type. `text-sm` (14px) is the floor for
anything a user reads repeatedly; `text-xs` is for labels and hints only.

## When a screen looks wrong but passes every check

Run through these in order — the answer is nearly always in the first three:

1. Is anything the loudest thing? (Hierarchy — usually the culprit.)
2. Is colour marking exceptions, or is it decorating?
3. Are chrome and data at the right densities — or backwards?
4. Are the numbers `numeric` and right-aligned?
5. Does the table have more than ~8 columns?
6. Is there exactly one `primary` button?
7. Do the empty and loading states say what to do next?

## Latitude

If a screen would be materially better restructured — a 14-column table that
wants to be 6 plus a detail drawer, a flat field list that wants grouping —
**say so in a sentence and build the better version.** Do not silently
implement a worse layout because it was what was literally asked for, and do
not stop to ask permission for ordinary design judgement. The user course-
corrects if they disagree; that is cheaper than a screen nobody likes.

This latitude covers *composition* — arrangement, grouping, density, hierarchy.
It does not extend to changing what data a screen shows, what a mutation does,
or anything in `odyssey-ui`'s hard rules.
