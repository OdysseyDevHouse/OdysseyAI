# Storefront customization: making a shop look and feel like its owner's

A plan, partly implemented. Scope: take the online store from *one page builder
with a brand colour* to **a shop an owner can make theirs** — the look, the
listings, the navigation, and the ways of grouping stock that a catalogue needs
and a department tree cannot express.

Ordered in phases. Each ends shippable; no phase depends on a later one.

---

## What already existed, and what it meant for this

The page builder is in unusually good shape — 19 section kinds, four page kinds,
draft and publish per page, version history, scheduled publish, saved sections,
presets, and a canvas that renders the *real* storefront component rather than a
mock. Five phases of `page-builder-next.md` shipped. The **content** of a page
was genuinely customizable.

What was not customizable was **everything around the content**. Three gaps,
found by reading the code rather than the summary:

**Every shop resolved to the same picture.** `StoreChrome` overrode exactly one
CSS variable — `--color-brand`. The other ~30 tokens were the back office's, so
surfaces, corner radius, spacing, control height and header layout were
identical for every store. A butchery and a boutique differed by an accent and a
logo.

**A department page could not show a department.** `publishedProducts` clamped
to `Math.min(Math.max(limit ?? 60, 1), 120)` and ordered by `p.description`; the
`offset` parameter existed and no route passed it. A department with 400
products showed 120, alphabetically, forever, under a footnote telling the
shopper to search. On the site the storefront suite runs against, that is 120 of
**40,000**.

**A merchant could not say what a group of products *is*.** There is no tag, no
collection, no merchandising attribute. Departments are the inventory tree,
shared with the till and the stockroom. "Gifts under R300", "Summer" and "New
arrivals" are not departments and never will be.

**The system is not live.** No customers, no data to migrate, no backwards
compatibility — which is why Phase 0 was a refactor, and why it had to be first.

---

## What must survive every phase

- **The preview IS the shop.** `BuilderCanvas` renders the same `HomeSections` a
  shopper gets, via the `renderSection` seam.
- **One resolver, two callers.** `resolveSectionContent` decides what a section
  contains, for shop and builder alike.
- **One emptiness rule**, now `SECTION_CATALOG[kind].isEmpty`.
- **`normaliseSections` is the security boundary**, run on write, with hard caps.
- **Key order is load-bearing.** The builder's dirty check compares
  `JSON.stringify`; a field written in one branch and not another is a permanent
  "unsaved changes" no saving clears. Phase 0 made this structural.
- **Every owner-supplied URL goes through `safeLinkTarget`.**
- **No raw HTML, no third-party scripts.**
- **House rules** (`AGENTS.md`): kit components, tokens only, no raw colour.
- **Migrations get applied, not written** — `site-migrate.mjs` per site, verified
  against `information_schema`.

---

## Phase 0 — The section catalog ✅ DONE

> **Shipped.** `src/lib/storefront/catalog.ts` declares each of the 19 kinds:
> label, hint, icon, legal page kinds, starting values, emptiness rule, and the
> stored fields with their coercions. `SECTION_LABEL`, `SECTION_HINT`,
> `kindsFor`, `newSection`, `sectionIsEmpty` and `normaliseSections` all read it.
> `Builder.tsx` fell from 4,207 lines to ~4,000 while absorbing new features.
>
> Verified as byte-identical at every step: all 19 kinds serialise exactly as
> before (6,472 bytes over 20 sections, including hostile input), `kindsFor`
> returns the same list for all four page kinds, and `sectionIsEmpty` agrees
> across 57 cases.
>
> Three decisions worth recording, all found by testing rather than reading:
>
> - **The catalog owns `SECTION_KINDS` and the shared defaults; the model
>   re-exports them.** Importing runtime values back from the model made a
>   cycle, and whichever module node loaded second read `undefined` and threw
>   before a line of the app ran. `tsc` was silent, and the builder suite passed
>   because it happens to import the model first.
> - **`BASE` spreads AFTER `title`, never before.** The two orders hold identical
>   values and serialise differently — the permanent unsaved-changes bug, caught
>   on all nineteen kinds by a parity check.
> - **`HomeSection` stays flat.** A discriminated union would force narrowing at
>   nine call sites; sections are interchangeable everywhere except rendering and
>   editing, which is why drag/drop, versioning and the diff are simple.

**One correction to the original plan.** It predicted a generic renderer would
replace ~700 lines of inspector. It does not: that chain is 33 plain controls
tangled with 29 conditionals, 14 contextual warnings and 7 bespoke editors — a
product row's options depend on the page kind and the published departments, a
banner back-fills alt text from the library, a video reduces a pasted URL to an
id as it is typed. A schema able to express that would be a worse language than
the JSX. Three genuinely plain kinds are declarative; sixteen keep their panels,
and `ui` is optional on a field so the write boundary stays complete either way.

---

## Phase 1 — The theme layer ✅ DONE

> **Shipped.** `sql/site/183_storefront_design_tokens.sql` applied to both active
> sites and verified against `information_schema`.
> `src/lib/storefront/tokens.ts` holds the tokens, palettes, presets and
> `themeVars`; `ThemePicker.tsx` is the panel; `StoreChrome` applies the whole
> set. `npm run test:storefront-theme` walks the space.

Eight controls, each a key into a curated list: surface, ink, corners, density,
button style, page width, product density, and a heading font that can differ
from the body. Six ready-made looks set them together, because eight separate
pickers is a colour wheel by another name — every individual choice is safe and
the COMBINATION is where a shop looks assembled rather than designed.

**Stored as JSON, not columns.** 040 and 077 chose columns and were right then;
the reasoning inverted. The theme scalars are read whole, written whole, never
filtered or joined — already a document spread across seventeen columns. The
type safety a column would give was never there: `readTheme` has always been the
coercion layer.

**Draft and published**, unlike the rest of the theme. A single colour is safe
to apply on save; eight controls that restyle every page are not, because an
owner will change half a look and be interrupted. It publishes *after* the
layout — a publish that half-succeeded should leave the shop looking as it did,
not restyled to match a page that never landed.

Two findings, both from checking rather than looking:

- **The first palettes failed AA in eight places**, all `muted` on a tinted fill
  — the "slightly grey on slightly beige" that looks fine to whoever picked it
  and is unreadable on a phone in daylight. Tightest surviving pairing: 4.84.
- **Three of six presets shipped a brand colour unreadable as a link on their
  own background**, worst at 2.27. A brand colour has two jobs that pull
  opposite ways: filling a button under a white label, and colouring text on the
  page. One hex cannot always do both. The fill keeps exactly what the owner
  chose — that is the one they hold against their signage — and the text shade is
  derived from it and the surface, stepping darker on a light shop and lighter on
  a dark one until it clears AA. Verified over every swatch and seven typed
  colours including white, black and pure yellow: tightest 4.52.

**Every variable is written, including unchanged ones.** The storefront sits
inside the app's stylesheet, which redefines them all under
`prefers-color-scheme` — so emitting only the diff would leave the rest
following the shopper's phone, and a shop that chose "paper" would render as
paper cards on a near-black canvas for everyone with dark mode on. The shop's
look wins; `color-scheme` goes with it. Neither Shopify nor WooCommerce flips a
storefront because a visitor's OS is set that way.

Two bugs a browser pass caught and no test would have: the `<body>` sits outside
the themed subtree and kept the app's canvas, showing as a white band under
short pages and behind every overscroll; and an import landed above the
`'use client'` directive in `BuilderCanvas` and 500'd the whole screen.

---

## Phase 2 — Listing pages that can show a department ✅ DONE

### Done: paging, sorting, and an honest count ✅

> **Shipped.** Four sorts mapped through a literal record; `p.id` as a tie-break
> on every one; `publishedProductsCount` sharing ONE extracted filter with the
> listing; `PER_PAGE = 24` with a numbered `Pager`; a redirect for pages past the
> end; `SortBar` chips beside the facets. 13 assertions added.

Every sort ends with `p.id`. Without it two products at the same price have no
defined order *between* pages, so one shows twice and another never appears —
which reads as the catalogue losing stock rather than as a sort bug.

The count is a second query over the *same* filter, extracted rather than
copied: two copies drift on the first facet anybody adds, and the symptom is a
pager promising pages the grid comes back empty for.

Two test bugs worth recording, both mine:

- **"by name really is" compared a field that does not exist**, so it compared
  `undefined` to `undefined` and passed for every possible input. A check that
  reports success without looking is worse than one that fails.
- **Corrected, it then failed a correct `ORDER BY`.** JavaScript's `<=` sorts by
  code unit; MySQL's collation is case- and accent-insensitive. It uses
  `localeCompare` now.

### Done: the listing preset ✅

> **Shipped.** `sql/site/185_online_listing_presets.sql` and `186`, applied to
> both sites. `src/lib/storefront/listing.ts` holds the vocabulary and
> coercion, `src/lib/site/listingPresets.ts` the cascade, and
> `/online-store/listing` is the screen. 37 assertions in
> `npm run test:listing-presets`.

Columns, page size, default order, grid-or-list, which parts of a tile draw
and which facets appear — per department, falling back to a shop-wide row,
falling back to today’s behaviour. Clearing an override is a DELETE rather
than a flag, so following keeps meaning it as the shop changes later.

The card-field ORDER comes from the vocabulary, not the stored string:
otherwise a tile draws its price above its name because of the sequence
somebody’s tick boxes were saved in.

**The bug worth recording.** 185 marked the shop default with
`department_id IS NULL` and put a UNIQUE index on the column to keep it
single. MySQL does not constrain NULLs in a unique index — so
`ON DUPLICATE KEY UPDATE` never matched, every save INSERTED another default
row, and the read (which has no ORDER BY) returned whichever the engine felt
like. Saving 2 columns and reading back 3 looks like a caching bug and is a
schema one. 186 collapses the duplicates and switches to 0 as the sentinel,
safe because `departments.id` is AUTO_INCREMENT and never 0.

### Done: product badges ✅

> **Shipped.** `sql/site/187_listing_badge_rules.sql` applied to both sites.
> Rules on the shop's preset row, hand-written badges on `products`, both
> combined by `badgesFor`, and a panel on `/online-store/listing`.

Two kinds, because they answer different questions. **Rule badges** are true of
a product for a while and then stop being true — "New", "Best seller", "Almost
gone" — which is exactly the kind nobody remembers to take off by hand.
**Hand-written badges** are true regardless: no rule infers "Halaal" or "Made
here", and there was nowhere on a product to say them.

An empty label is the off switch, not a tick box beside each rule. A rule with
nothing to say cannot draw anything, so "off" and "blank" are one state rather
than two controls that can disagree about whether a badge shows. Every rule
ships off, so a shop that never opens the screen renders what it renders today.

Shop-wide only, read from the default preset row. "New" meaning thirty days in
one aisle and seven in another is not a distinction a shopper can perceive, and
it is how a shop ends up with badges that contradict each other.

Capped at two per tile, rules before the hand-written one — a rule badge is
about the moment, and that is the one a shopper acts on. A product that is new
AND nearly out AND hand-labelled is not unusual.

`bestSellerIds` returns ids rather than products: the caller already has the
products and only needs to know which of them wear the badge.

**The bug worth recording.** Extending the SELECTs with the badge columns also
rewrote the listing INSERT's column list without its VALUES, so every listing
save failed on a column count. A search-and-replace across a file holding both
a SELECT list and an INSERT list will hit both — the suite caught it in one
run, and reading the diff would not have.

---


## Phase 3 — Per-section styling and a columns block ✅ DONE

### Done: the section band ✅

> **Shipped.** `STYLE_FIELDS` in the catalog, `SectionBand.tsx` renders it, and
> the inspector draws the controls from the same list. 16 assertions in
> `npm run test:section-band`.

`tone: plain | tinted` was one bit. Three fields replace it — `background`,
`padding`, `width` — and the instinct on widening the first was to offer a
colour. That is the wrong direction: a section painted with a hex an owner
typed can fight the shop's palette and cannot follow a theme change, which are
the two things the token layer exists to prevent. These are **roles**, resolved
through the theme, exactly as rich-text colours are.

**`contrast` is why it was worth widening at all.** A dark band across a light
page is the most-used section control in every builder on the market and was
unreachable with two options. It uses `--color-ink` on `--color-canvas`, so a
shop that chose the dark theme gets a *light* band — hard-coding a dark colour
would make "contrast" mean "dark", which is wrong half the time.

**`width: full` needed real work.** The page's cap sits on `<main>`, so bleeding
past it means escaping a container rather than widening one: 50% of the
*viewport* minus 50% of the element, because `100vw` alone includes the
scrollbar and overflows by its width. The content goes back inside a container
that respects the shop's own page width, and the corners are squared — a card
radius against the screen edge leaves two slivers of page showing through.

**A section nobody styled gains no wrapper at all**, not a wrapper with no
classes. Every page saved before this renders through exactly the markup it
always did, and `tone: 'tinted'` still reads as `background: 'tinted'`.

`banded()` lives apart from `HomeSections`, and that is the point rather than
tidying: `HomeSections` reaches the database through its imports, so nothing
beside it can run outside a request. Pure, it is rendered by a test and drawn by
the builder's canvas through the same function the shop uses.

**The bug worth recording.** An unrecognised padding interpolated straight into
the class list, emitting `class="rounded-card undefined"` — silent, permanent,
and exactly what a stored layout from an older build would produce on a live
shop.

### Done: the columns block ✅

> **Shipped.** `columns` is the twentieth section kind. `SECTION_CATALOG` holds
> it, `normaliseSections` enforces the depth rule, `HomeSections` renders it,
> `resolvePageContent` fills its children, and the palette offers it.
> 26 assertions in `npm run test:section-columns`.

Every section was full width and stacked. Picture-beside-text was the one
structural gap left, and `split` covered the cheap 80% of it.

**The documented refusal was of *recursive* containers** — a tree of unbounded
depth, undraggable, un-diffable and uncappable. That failure mode does not
require refusing columns; it requires refusing nesting.

Four rules keep it there:

1. **Depth is structural, not counted.** `columns` is absent from
   `COLUMN_CHILD_KINDS` and the check runs *before* anything recurses, so no
   payload shape reaches a third level and there is no counter to get wrong.
2. **The child list is a whitelist**, not "everything minus columns". A carousel
   in a third of a column looks fine in the builder and reads as broken on a
   phone; a department grid inside one is a second front page.
3. **One budget for the whole page.** A per-level cap would admit
   20 × 3 × 4 = 240 sections and satisfy every check on the way in. Verified:
   twenty columns of thirty children normalise to nine sections.
4. **Ids stay globally unique across columns**, which is what keeps the drag
   layer, the publish diff and version history working on a child without any of
   them knowing columns exist.

`columnCount` is authoritative — too few columns are padded and too many
trimmed, because the renderer maps over what is stored.

**Two real bugs, both predicted by the plan and both confirmed present.**
`pageWarnings` did not see inside a column, so an undescribed picture reached a
shop with no warning; and `describeLayoutChanges` reported a page as unedited
when a column's contents had changed — the one summary an owner reads before
publishing, quietly wrong about the part they had just been working on.
`flattenSections` fixes both, declared once rather than nested in each caller.

**`resolvePageContent` replaced the two-step every route did by hand.** Five
routes called `resolveSectionContent` then mapped each section beside its
content; adding "and now flatten, resolve and redistribute the columns" to each
was five chances to get it wrong. It flattens before resolving so the batched
queries stay batched — recursing section by section would turn a page with three
columns into a dozen round trips.

Verified in a browser: two columns with a child each, full-bleed at exactly the
viewport width with no horizontal overflow, and the builder's canvas drawing the
same thing through the same renderer.

**What is NOT done: dragging into a column.** A columns section can be added,
styled, filled and rendered, but its children are arranged in the inspector
rather than by dragging them between columns. Nested `SortableContext` inside
the page-level `DndContext` is the remaining work, and it is the part that
touches a drag layer which currently works well — worth doing on its own.

---

## Phase 4 — Menus and collections ✅ DONE

> **Shipped.** `sql/site/188_storefront_menus.sql` and `189_storefront_collections.sql`,
> applied to both sites. `/online-store/menu` and `/online-store/collections` are
> the screens; `/store/[token]/k/[slug]` is the public route.
> `npm run test:storefront-menus` (22) and `test:storefront-collections` (29).

### The menu editor

The rail was assembled: published departments in tree order, a divider, then
whichever standard pages had `show_in_nav`. A shop could not put "Sale" first,
link to its own Instagram, push a product, or hide a department from the menu
while leaving it browsable — and `navPages` is `WHERE kind = 'standard'`, so a
department page could never appear at all.

**An empty table means "still generated", and that is the whole migration
story.** A shop that never opens the editor keeps exactly the rail it has always
drawn — verified in a browser as unchanged. The editor's first action
materialises that rail into real rows, so an owner's first edit is a change
rather than a rebuild.

**Null and `[]` mean opposite things and are kept apart.** Null is a shop that
never made a menu; `[]` is an owner who cleared theirs and meant it. Reading
them the same way is exactly how a feature launch blanks somebody's navigation,
and it would pass any test that only checked "does a saved menu render".

**A kind and a reference, never a stored URL.** A department lives at `/c/<id>`
behind a signed token and both halves can move; storing the built path would
freeze them into every row in every shop. A page is stored by *id* and linked by
*slug*, because the id survives a rename.

One level of nesting, capped structurally: a child is written with the id of a
top-level row and nothing recurses, so no input shape reaches a third level. The
dropdown opens on focus as well as hover — `group-hover` alone puts a whole
level of navigation behind a mouse.

### Collections

A merchant could not group products except by which aisle they live in.
Departments are the inventory tree — shared with the till, the stockroom and
every report — and "Gifts under R300" is none of those things.

**Manual and rule-based, because both are real.** A lookbook is a set of
decisions somebody made and a rule that "maintained" it would be undoing them;
"on special" is the opposite. The vocabulary is deliberately `PRODUCT_SOURCES`,
so a merchant learns the idea once.

**A readable slug, unlike a department's id.** A collection exists to be shared,
so its address is the thing a merchant chose, and renaming the title leaves it
alone. `/k/summer` rather than `/c/47`.

**Every rule goes through the publish gates, including manual** — a merchant who
unpublishes a picked product watches it leave rather than finding it still
there.

Sections render above the grid, the way a department page's do. **That
combination is a lookbook, and a `split` over a `products` row is shop-the-look
— no new section kinds were needed.**

**Two bugs worth recording.** A stale product id made the foreign key refuse the
whole transaction, so a merchant who arranged twenty products — one deleted by
somebody else meanwhile — lost all twenty to an error naming a constraint. And
the first version of the suite selected fixtures by `show_online = 1` on a shop
that publishes by DEPARTMENT: the list was empty, so two assertions compared
nothing to nothing and passed. They go through `publishedProducts` now, with
"the fixture has something to pick" asserted out loud.

---

## Phase 5 — The pages nobody can touch

**A real cart page.** `/checkout` is the cart today, and no page says "here is
your basket" without immediately asking for an address. The cart drawer is
`md:hidden`, so desktop shoppers have no cart view at all. Add `/cart` (already
in `RESERVED_SLUGS`) with a builder-editable strip below it, `kind='cart'`,
restricted to `cards|text|richtext|products|testimonial|divider|spacer`.

**The thank-you page.** `done/page.tsx` is 90 lines of fixed content on the
highest-attention page in the funnel. Add `'thankyou'` to `PAGE_KINDS`, one row
per site. The fixed confirmation block stays fixed — it carries the signed token
— with sections below. **Constraint:** the page looks nothing up, deliberately,
because the shopper is anonymous; `together` and `sameDepartment` are excluded.

**Checkout, the safe subset only.** Policy links, one trust line, and a
configurable order-note field. Nothing else. **No section-builder freedom on
checkout, ever** — that is how a shop ships a Pay button below three product
rows.

Also cheap and embarrassing when a merchant finds them first:
`page/[slug]/page.tsx` hard-codes `robots: { index: false }` while every other
route calls `catalogueRobots`, so enabling indexing indexes products and
silently excludes About/Delivery/Returns. And currency is hard-coded — `'R'` in
`formatMoney`, `'ZAR'` in `productJsonLd`.

---

## Deliberately not in this plan

- **A custom CSS field.** The safety half is already answered in
  `storefrontModel.ts`. The stronger argument is support: a merchant with custom
  CSS has a shop you cannot safely change, and every later fix becomes "did we
  break someone's CSS?", unknowably. Shopify absorbs that with a theme
  marketplace; a single-vendor retail product cannot. **Phase 1's presets are the
  pressure valve.**
- **Third-party embeds.** If demand appears, a validated `embed` kind with a
  provider whitelist — the `video` pattern extended. Never a free `<script>` on a
  page that takes payments.
- **Bundles.** A pricing and stock construct, not a storefront one.
  `productComposition.ts` is where it belongs; a storefront-only bundle sells
  stock the till does not know left.
- **A/B testing.** A small retailer lacks the traffic to reach significance.
- **Per-breakpoint overrides.** Doubles every field for a case the container
  queries already handle.
- **Per-department product layouts** and **product-detail knobs** are real and
  small, but wait until a shop has a reason to differ.

---

## Verification

1. `npx tsc --noEmit` — zero errors in the files being changed.
2. `npm run test:storefront`, `test:builder`, `test:storefront-theme`. Grepping
   for FAIL misses a suite that throws — check the exit code and the tail.
3. **Migrations applied, not written.** `site-migrate.mjs` per active site,
   verified with `information_schema`. Schema drifts between sites.
4. **A browser pass over the real screens**, every time. Phases 0, 1 and 2 each
   produced a bug that `tsc` and the suites were silent on: an import above
   `'use client'`, a body background outside the themed subtree, and a pager
   reading "Showing 3993–14 of 14". Drive Chrome over CDP against :4100; the
   storefront needs a token from `createPublicStoreToken`, and site 1's shop is
   switched off, so use site 2.
5. **Say what a cap covers.** The paging walk stops at 12 pages and prints it —
   a silent cap reads as full coverage.
