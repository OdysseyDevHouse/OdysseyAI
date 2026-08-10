# The page builder: pages, blocks, and the things a shop is judged on

A plan, not an implementation. Scope agreed: take the front-page builder from
*one page of seven section kinds* to **a multi-page builder with the blocks,
metadata and safety rails every commercial storefront builder has**.

Ordered in five phases. Each phase ends with something shippable — no phase
depends on a later one being finished, and stopping after any of them leaves
the product in a coherent state.

---

## What already exists, and what it means for this

The builder is in unusually good shape, and that shapes every decision below.
Three properties are load-bearing and **must survive every phase**:

**The preview IS the shop.** `BuilderCanvas` renders the same `HomeSections`
component a shopper gets, via the `renderSection` wrapper prop
(`HomeSections.tsx:100`). There is no second implementation to drift. Every new
section kind gets this for free — and any new kind that renders through a
*different* path in the builder than in the shop has broken the one property
that makes this screen trustworthy.

**One resolver, two callers.** `resolveSectionContent` (`storefront.ts:588`)
decides what a section contains, for both the shop and the builder. Every new
data-backed kind extends *that function*, never the builder.

**One emptiness rule, four callers.** `sectionIsEmpty` (`storefrontModel.ts:564`)
is asked by the shop, the builder's placeholder, the page-level catalogue
fallback and the publish summary. Every new kind adds a `case` there, or it will
render an empty heading on somebody's live shop.

What we reuse unchanged:

| Thing | Where | Why it fits |
|---|---|---|
| `normaliseSections` | `storefrontModel.ts:831` | Untrusted-input coercion, caps, stable key order. Already page-agnostic — it takes a `HomeSection[]`, not a page. |
| `describeLayoutChanges` | `storefrontModel.ts:637` | The publish diff. Works on any two section arrays, so it works per page. |
| `storefront_images` + `PicturePicker` | 060, `storefrontImages.ts` | A library of pictures referred to by id. Reused by every new kind that needs one. |
| `safeLinkTarget` / `safeUrl` / `safeColour` | `storefrontModel.ts:1045+` | The three validators standing between owner input and a page that takes payments. Non-negotiable for every new field. |
| `approvedReviewsFor` | `productReviews.ts:220` | Moderated reviews, already indexed `(product_id, status)`. Phase 2's reviews block. |
| `liveSpecials` | `specials.ts:107` | Wall-clock text windows, already excluded from timezone parsing. Phase 2's countdown. |
| Container queries | `HomeSections.tsx:118` | `@sm:`/`@lg:` watch the box, not the viewport. This is why the phone preview is exact, and why adding a tablet width is one line. |

### One finding that changes the routing plan

**Department browsing is a query parameter, not the `c/[departmentId]` route.**

`page.tsx:41` treats `?department=` or `?q=` as "browsing" and renders
`Catalogue` instead of the built page. Meanwhile `c/[departmentId]/page.tsx`
exists and renders `CategoryBrowser`, and the categories section links to
**`?department=`** (`HomeSections.tsx:221`), not to `/c/`.

So there are two department experiences and the built page links to the one
that is *not* the dedicated route. Phase 1 has to resolve this before layering
per-department layouts on top, or we will be adding sections to a page most
shoppers never reach. See Phase 1.

---

## Phase 1 — More than one page ✅ DONE

**The single change with the widest effect.** Everything after it is better for
existing, and two of the later phases are much smaller once it lands.

> **Shipped.** `070_storefront_pages.sql` applied to site 1;
> `lib/site/storefrontPages.ts` owns the table; `storefrontLayout.ts` keeps the
> theme and delegates the front page. Public routes: `/page/<slug>` for standard
> pages, department layouts above the product list, `?department=` 307s to
> `/c/<id>` carrying its search term. Builder has a page switcher and per-page
> draft/publish; `/online-store/pages` manages the rest. 21 new assertions in
> `test-builder.ts`, 138 passing overall.
>
> Two decisions worth recording, both made during the build:
>
> - **`seo_image_id` is BIGINT.** `storefront_images.id` is BIGINT UNSIGNED (060),
>   and an FK across mismatched integer widths is rejected with an errno 150 that
>   names nothing useful.
> - **`kindsFor(pageKind)` gates the section menus.** The welcome banner renders
>   the theme's hero text, so on a non-home page it either duplicates the front
>   page's greeting or draws nothing. Presets and the Appearance "Front page"
>   group are hidden off the home page for the same reason — a control that
>   appears to do something and does not is worse than an absent one.

### The schema

Today the layout is two columns on the settings row (`040_storefront_layout.sql`):
`home_layout` and `home_layout_draft`. That is exactly right for one page and
cannot express two.

New table, `storefront_pages`:

```
id             INT PK
slug           VARCHAR(60)   -- 'home' is reserved; unique per site
title          VARCHAR(120)  -- the <h1> and the nav label
kind            VARCHAR(20)   -- 'home' | 'standard' | 'department'
department_id  INT NULL      -- only for kind='department'
layout         TEXT NULL     -- published; NULL means never published
layout_draft   TEXT NULL     -- NULL means nothing unpublished
show_in_nav    TINYINT(1)
nav_order      INT
is_published   TINYINT(1)
seo_title      VARCHAR(120)  -- Phase 4 fills these in; the columns land here
seo_description VARCHAR(300)
seo_image_id   INT NULL
```

**Why a table and not more JSON.** The layout stays a document — nothing queries
inside it, it is read whole and written whole, and 040's reasoning holds. But
the *set of pages* is a list that gets ordered, filtered by `show_in_nav`, and
looked up by slug on every request. That is a table.

**Migration.** `home_layout` and `home_layout_draft` move into a `kind='home'`,
`slug='home'` row. The old columns are **left in place and stopped being read**
rather than dropped — per the memory that migration files are recorded by name
and an already-applied file cannot be edited, a wrong drop is unrecoverable.
Drop them in a later migration once the new path has run in anger.

### The three page kinds

- **`home`** — exactly one, cannot be deleted or renamed. What exists today.
- **`standard`** — About, Delivery, Returns, FAQ. Slug-routed at
  `/store/[token]/page/[slug]`. This is the outright hole today: **a shop taking
  payments has nowhere to publish a refund policy.**
- **`department`** — an *optional* layout for one department. Absent means the
  department renders exactly as it does now. Present means the sections render
  above the product list.

Department pages are the fiddliest and I would ship them **last within the
phase**, behind the other two, because of the routing tangle below.

### Resolving the two department routes

Before per-department layouts, pick one:

**Recommendation: make `?department=` redirect to `/c/[departmentId]`.** The
dedicated route already exists, already resolves and 404s correctly, already has
`generateMetadata`, and is the only one of the two that can carry a per-page
`<title>` and OG image in Phase 4. A query parameter cannot have its own SEO
metadata, which makes the alternative a dead end.

That means changing the categories section's link (`HomeSections.tsx:221`) and
the department rail in `StoreChrome`, and keeping `?department=` working as a
redirect so existing WhatsApp links and posters do not break. Nothing else
depends on it.

### What the builder gains

- A **page switcher** in the canvas toolbar — the current single-page toolbar
  becomes "Home ▾ | Add a section | Preview: Computer/Phone".
- **Draft and publish become per-page.** `getLayout`, `saveDraft`,
  `publishDraft`, `discardDraft` all take a `pageId` alongside `siteId`. The
  publish summary is already per-array and needs no change.
- A **Pages screen** at `/online-store/pages` — list, create, reorder nav,
  publish/unpublish, delete. Ordinary `DataTable`, and per the memory it needs a
  client wrapper because the column array cannot be defined in a server page.

### Not in this phase

Per-page theme overrides. One shop, one palette — the theme stays on the
settings row. A per-page brand colour is how a storefront ends up looking like
five different shops.

---

## Phase 2 — The blocks other builders have ✅ DONE

> **Shipped.** Eleven new kinds: `split`, `reviews`, `countdown`, `richtext`,
> `signup`, `testimonial`, `logos`, `video`, `map`, `divider`, `spacer` — 17
> kinds in total. `071_storefront_subscribers.sql` applied. 26 new assertions
> (190 passing overall), most of them on the normalisation boundary.
>
> Decisions worth recording:
>
> - **Two-column shipped as the cheap 80%,** exactly as the plan recommended: a
>   fixed picture-plus-words kind, no recursion, no changes to the drag layer.
>   DOM order carries which side the picture is on, so a screen reader and a
>   stacked phone get the same order the eye does — `flex-row-reverse` would
>   have silently flipped one of them.
> - **Rich text stores a tree and the renderer is a switch over literal tags.**
>   There is no path from data to a tag name, so there is nothing to sanitise.
>   `href` still goes through `safeLinkTarget`.
> - **A video is a provider + an id, never an embed snippet.** The id is
>   filtered to `[A-Za-z0-9_-]`, which makes a second host unrepresentable
>   rather than something to strip — that filter *is* the validation for the URL
>   the renderer builds.
> - **Consent is evidence, not a flag.** Subscribers got their own table rather
>   than a column on `customers`: a subscriber is not an account, and every row
>   stores when they agreed *and the exact wording they saw*, because the
>   wording changes and "they consented" means nothing without it.
> - **The countdown follows its special.** Bound by id and re-read per request,
>   so extending a sale moves the clock. A typed date is the fallback.
> - **`sectionIsEmpty` absorbed the catalogue fallback.** `page.tsx` was
>   hand-enumerating six kinds — already wrong for a carousel, and it would have
>   judged a page of only new sections "empty" and replaced it with the
>   catalogue.
>
> Two bugs the browser pass caught, both invisible to tests: a bold link
> rendered as plain bold text (`text-ink` on the inner `<strong>` beat
> `text-brand` on the `<a>`), and the link hints actively recommended `/store`,
> which 404s because a shop lives under `/store/<token>/`. Three inspector
> fields now warn on a tokenless in-shop path.

## Phase 2 — The blocks other builders have

All additive to `SECTION_KINDS` (`storefrontModel.ts:38`). Each one is: a kind, a
`SECTION_LABEL`/`SECTION_HINT` entry, a `normaliseSections` branch, a
`sectionIsEmpty` case, an inspector panel, a `sectionBody` branch, and — where it
reads data — a `resolveSectionContent` branch. That repetition is the price of
the one-definition rule and it is worth paying.

Ordered by value per unit of work:

**Reviews.** You already collect and moderate these, and they surface only on
the product page. `approvedReviewsFor` is per-product; this needs a
`recentApprovedReviews(siteId, limit)` — same table, same index, no schema
change. Two display modes: recent across the shop, or reviews for the products
in a chosen department. Empty when there are none, which for a new shop is the
normal case, so the builder placeholder must say "no approved reviews yet"
rather than looking broken.

**Countdown.** Binds to a **real special** by id rather than a typed-in date, so
"Sale ends in 4:12:07" cannot outlive the sale it advertises. `liveSpecials`
already returns wall-clock `endsAt` text; the client ticks toward it. When the
special ends the section renders nothing, which is `sectionIsEmpty` doing its
job. A free-typed date is offered as a fallback for shops not using specials.

**Rich text.** Today `text` is `whitespace-pre-line` with no bold, no link, no
list, and `HomeSections.tsx:341` explains why: a rich editor means pasted HTML on
a page that takes payments. That reasoning is right and the answer is not to
abandon it — it is a **restricted** editor storing a small JSON tree
(`{ type: 'p' | 'ul' | 'h3', children: [{ text, bold?, italic?, href? }] }`)
rendered by a switch that can only emit those tags. `href` through
`safeLinkTarget`. No HTML is ever stored, so none can ever be rendered.
The existing `text` kind stays as-is; this is a new kind beside it.

**Spacer and divider.** Trivial, and the thing owners ask for within a day.

**Newsletter signup.** A form posting to a server action that writes to
`customers` with a marketing-consent flag. Needs a small migration and a
consent checkbox — an opt-in you cannot evidence is worse than no list.

**Video.** A self-hosted file or a YouTube/Vimeo **id** — never arbitrary iframe
HTML, for the same reason rich text stores a tree.

**Map / find us.** A static image plus address text. No map SDK: a third-party
script on a page that takes payments is a CSP and a privacy problem for a block
that shows where the shop is.

**Testimonial.** Hand-written quotes, no product attached. Distinct from reviews
because it is content, not data.

**Logo strip.** "Brands we stock", from the pictures library.

### The one that is not like the others

**Two-column / split.** Picture-beside-text is the most-used layout in every
builder on the market, and it is the only genuinely *structural* gap — every
section today is full-width and stacked.

It is also a **model change, not a new kind**: a section that holds children.
`HomeSection` becomes recursive, `normaliseSections` needs depth limiting (a
hand-crafted payload must not nest 10 000 deep), the drag layer needs to handle
nesting, `describeLayoutChanges` needs to diff a tree, and `sectionIsEmpty`
becomes "empty if every child is empty".

**Recommendation: put this at the end of Phase 2 and treat it as its own
decision.** A cheaper 80% is a *fixed* two-column kind holding exactly one
picture and one text block — no arbitrary nesting, no recursion, no drag
changes. That covers the real use case and can ship in a day. Full nesting can
come later if it is genuinely wanted; going straight there risks destabilising
the drag-and-drop that currently works well.

---

## Phase 3 — Making the builder faster to use ✅ DONE

> **Shipped.** All seven items. `074_storefront_history.sql` and
> `075_storefront_publish_at.sql` applied to **both** sites. 38 new assertions
> (202 passing overall).
>
> Decisions worth recording:
>
> - **The preview pass is the store token's opposite in every property.**
>   `publicStoreToken` is deterministic and never expires because it goes on
>   till slips; this one expires in 15 minutes, names ONE page, and carries its
>   own audience so neither token can be replayed as the other. Three leak paths
>   are asserted: wrong site, wrong page, wrong token type.
> - **Restoring a version loads a draft; it does not publish.** Otherwise it
>   would be the one control that changes the live shop with no change summary
>   and no confirmation — decided from a list of timestamps, the least
>   informative place to make that call.
> - **A saved section is a snapshot, not a live template.** A live one would mean
>   editing the delivery cards silently rewrites three published pages at once,
>   with no diff and no draft. Saving on one page and adding on another is also
>   how "copy to another page" is delivered — no page picker needed.
> - **Scheduled publish is late-tolerant and early-intolerant.** `publish_at <=
>   now`, so a missed cron run still fires; an early one never does. Going live
>   four minutes late is a non-event, four minutes early leaks the pricing.
>   The time is cleared before the publish attempt, so a page that cannot
>   publish is not retried forever.
> - **`/api/storefront/publish` is in `PUBLIC_PREFIXES`.** Behind the cookie gate
>   it would 307 to login and a shop's Black Friday page would simply never go
>   live — a failure whose only symptom is the trading figures.
>
> The cron route caught a real problem on first call: **site 2 was three
> migrations behind** and errored with "Unknown column 'publish_at'". Both sites
> are now current.

## Phase 3 — Making the builder faster to use

Small, compounding, and several fall out of Phase 1 almost free.

**Saved sections.** "Save this row as a template", reuse anywhere. Once there
are multiple pages this becomes obvious rather than a nicety. A small table of
named `HomeSection` fragments.

**Copy a section to another page.** Falls straight out of Phase 1 — the
duplicate logic already deep-copies ids correctly (`Builder.tsx:540`).

**Preview as a shopper.** The canvas is `pointer-events-none`, so **nobody can
click through their own draft.** `View shop` only shows what is published. A
short-lived signed preview token rendering the *draft* on the real storefront
routes would let an owner walk the actual journey before publishing. This is the
one item here I would rank as near-essential rather than nice.

**Tablet width.** `WIDTHS` (`BuilderCanvas.tsx:91`) has phone and desktop. The
container queries mean adding 768px is one line.

**Version history.** A table of the last ~10 published layouts per page, written
on publish. Gives "restore Tuesday's page", which is what an owner wants after a
bad publish — and today the only recovery is undo within the session. Cheap,
because the JSON is already stored whole.

**Scheduled publish.** Sections schedule; the publish itself does not. "Make
this page live at 6am Friday" is the Black Friday feature. Needs a cron entry —
and per the memory, `proxy.ts` needs the route in `PUBLIC_PREFIXES` or it
silently 307s to login.

**Outline / layer list.** On a 20-section page, scrolling the canvas is the only
way to find a section. A collapsible list beside it makes long pages navigable
and gives keyboard reordering a proper home.

---

## Phase 4 — What a shop is judged on ✅ DONE

> **Shipped.** `077_storefront_presentation.sql` applied to both sites. 16 new
> assertions (218 passing overall). Verified in the served HTML: `og:image`
> present, `robots` still `noindex` by default, the strip rendering, and **no
> `fonts.googleapis` request** — 58 `.woff2` files emitted locally by the build.
>
> Decisions worth recording:
>
> - **A font is a KEY into a curated list, never a name.** `next/font/google` is
>   a build-time transform that self-hosts the files, so the shop's choice can
>   never become a runtime request to a third party. That only works if every
>   family is a top-level literal — hence all five declared in `fonts.ts` and the
>   shop picking between class names. The key also has to cross into
>   `StoreChrome` as a resolved CLASS, since a client component cannot call it.
> - **The announcement strip is chrome, not a section, and not dismissible.**
>   A section would have to be added to each page and removed from each when the
>   offer ends. A dismiss button could only remember itself in the shopper's
>   browser — back on their phone, gone on their laptop long after the text
>   changed. The DATES are the control, and they are evaluated server-side so an
>   out-of-season strip never reaches the page source.
> - **The publish check warns and never blocks.** A publish that can be refused
>   is one that refuses somebody correcting a wrong price on a Saturday night.
>   Hidden sections are skipped — warning about what nobody will see is the noise
>   that stops the check being read at all.
>
> **A collision worth noting.** Another session was building `allow_indexing` on
> the same settings row from the Setup screen. Their `078` defers to this
> migration for the column, so the schema is fine — but two writers on one column
> is a silent bug, so `saveTheme` deliberately reads it and does not write it.
> Setup owns that switch; the storefront's robots tag consumes it.
>
> The test suite also turned out to be **leaving the shop's real font and
> announcement rewritten** — its snapshot list had not grown with the columns.
> Fixed, and the snapshot now names every column `saveTheme` touches.

## Phase 4 — What a shop is judged on

Small surface, disproportionate effect. These are gaps that make a competent
shop look amateur.

**SEO and social.** There is no page title, meta description or share image
anywhere. `layout.tsx:42` sets one OG entry for the whole storefront with no
image at all — so **a storefront link pasted into WhatsApp shows no picture**,
which is how most of your customers' customers share links. The columns land in
Phase 1's table; this phase fills in the UI and wires `generateMetadata` per
page. Note `robots: { index: false }` is currently set deliberately
(`layout.tsx:49`) — this phase should make that a per-shop opt-in, not flip it.

**Announcement bar.** The thin strip above the masthead — "Free delivery over
R500". Universal, and it is *chrome*, not a section: it belongs on the theme so
it shows on every page. Reuses the section schedule fields so it can be dated.

**Fonts.** The theme controls one colour. A heading/body pairing from 2–3
curated, self-hosted choices is the cheapest way to make two shops look
genuinely different. Self-hosted, not Google Fonts — a third-party font request
on a payments page is a privacy leak and a CSP exception.

**Accessibility check at publish.** The builder already warns about missing alt
text per banner (`Builder.tsx:1000`). Rolling that into the publish dialog beside
the change list — "2 pictures have no description" — costs almost nothing and
catches it at the one moment it matters. Non-blocking: a warning, not a refusal.

---

## Phase 5 — Product and department page blocks ✅ DONE

> **Shipped.** `079_storefront_product_page.sql` applied to both sites. 17 new
> assertions (235 passing overall), `tsc` at zero errors.
>
> Decisions worth recording:
>
> - **One product-page layout, not one per product.** A department page attaches
>   to a department by id because a shop has twenty of them; a shop has forty
>   thousand products and nobody will arrange a cross-sell row that many times.
>   So `kind='product'` carries no slug and no department, and its sections
>   resolve against whichever product is being viewed. `uq_page_department`
>   already gives exactly one such row per site — the same mechanism that
>   guarantees one home page — so no new constraint was needed.
> - **`boughtTogether` counts baskets, not quantity.** `COUNT(DISTINCT d.id)`
>   rather than `SUM(qty)`, so one bulk order of twelve cannot decide the row.
>   Invoices only — a credit note is a *return*, and counting one recommends the
>   thing somebody brought back.
> - **The arrangement REPLACES the built-in suggestions.** An owner who has
>   arranged their product page has said what belongs there; appending our
>   "you may also like" underneath would duplicate a row they may have placed
>   deliberately.
> - **Recently viewed has no table.** It lives in `localStorage`, so there is
>   nothing to disclose, nothing to expire, and nothing following anybody to
>   another device. That also makes it the one kind `sectionIsEmpty` cannot
>   answer for — it returns false and the component decides.
> - **A product page cannot hold a carousel or a department grid.** Its sections
>   sit below one product; those blocks would make it a second front page.
>
> Verified `boughtTogether` against real sales data: Coca-Cola returned Avo and
> White Bread Loaf from a genuine basket, anchor correctly excluded. The test
> shop publishes nothing (`show_online = 0` on every product), so two products
> were flagged temporarily and restored afterwards.
>
> Two coordination notes: the other session had already written `RememberView`
> against this phase's `recentlyViewed` helper — the tracking half arrived
> before the storage half, and they fit. And the test cleanup needed widening:
> product pages have no slug, so the `zz-test-%` filter could not reach them and
> one left behind failed the next run against its own leftovers.

## Phase 5 — Product and department page blocks

Deferred to last because it depends on Phase 1's department pages *and* Phase
2's blocks, and because the front page is where the traffic lands.

- **"Customers also bought"** — a cross-sell row on the product page. The data
  is in `sale_lines`; `popularProducts` (`storefront.ts:460`) is the precedent
  for the 90-day window.
- **Trust cards under Add-to-basket** — the `cards` kind, on the product page.
- **Recently viewed** — browser storage, no schema.
- **Department intro banners** — Phase 1's department pages carrying Phase 2's
  blocks.

---

## Sequencing, and what to do first

| Phase | Rough size | Ship independently? |
|---|---|---|
| 1 — Multi-page | Largest. Migration, routing, nav, sitemap, builder switcher. | Yes |
| 2 — Blocks | Medium, and highly parallel — each kind is independent. | Yes, one kind at a time |
| 3 — Builder UX | Small, several are near-free after Phase 1. | Yes, individually |
| 4 — SEO / chrome | Small. | Yes, individually |
| 5 — Product pages | Medium, depends on 1 and 2. | Yes |

**Start with Phase 1.** It unlocks the most, and Phases 3 and 5 get materially
cheaper once it exists.

**Two things worth pulling forward** out of order, because they are small and
currently embarrassing:

- The **OG share image** (Phase 4) — a link with no preview card is the first
  thing anyone sees.
- **Preview as a shopper** (Phase 3) — an owner cannot currently click through
  their own draft.

Both are independent of Phase 1 and could ship while it is in progress.

---

## Constraints that apply throughout

- **Every screen uses the kit.** `@/components/ui`, tokens only, no raw colour,
  icons from `@/components/ui/icons`. Anything new added to the kit goes on
  `/setup/style-guide` in the same change.
- **Every owner-supplied URL goes through `safeLinkTarget`.** A `javascript:`
  link on a page that takes payments is stored XSS. This has already been got
  right twice (banner and slide) and will be got wrong on the third if it is not
  said out loud.
- **Every new kind touches four places or it is broken**: `normaliseSections`,
  `sectionIsEmpty`, `sectionBody`, and the inspector. A kind missing from
  `sectionIsEmpty` renders an empty heading on a live shop.
- **Migrations get applied, not merely written** — `site-migrate.mjs` for every
  active site, verified with `SHOW COLUMNS`, before any of this counts as done.
- **Schema drifts between sites.** Probe `information_schema` rather than
  assuming a table is present.
- **`normaliseSections` key order is load-bearing.** The builder's dirty check
  compares JSON; a new field written in one branch and not another produces a
  permanent "unsaved changes" that no amount of saving clears.
