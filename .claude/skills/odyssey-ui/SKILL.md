---
name: odyssey-ui
description: The OdysseyAI design system — the shared UI kit, colour/radius/size tokens, and the rules for building screens. Use this BEFORE writing or changing any UI in this repo: pages, forms, tables, toolbars, buttons, dialogs, badges, styling, colours, spacing, or anything visual. Also use when asked to restyle a screen, match the style guide, add a component, or change a colour/theme.
---

# OdysseyAI design system

Every screen is assembled from one kit so that a single edit restyles the whole
product. Read this before touching UI.

This file covers **which component and which token** — the rules that keep the
system intact. For **how to arrange them** — density, hierarchy, when colour
means something, how a table or form should be composed — see the
`odyssey-craft` skill. A screen can satisfy every rule here and still look
flat; that is what the other file exists to prevent. Building a screen usually
wants both.

## The three layers

| Layer | File | What changes here |
| --- | --- | --- |
| Tokens | `src/app/globals.css` | Colour, radius, shadow, control height. The one source of truth. |
| Skins | `src/components/ui/styles.ts` | The shared class strings (`buttonClass()`, `CONTROL`). |
| Components | `src/components/ui/*` | The building blocks every screen imports. |

Restyling the app = editing layer 1 or 2. If a visual change needs edits across
several screens, it is being made in the wrong layer.

The live reference is **`/setup/style-guide`**
(`src/app/(app)/setup/style-guide/page.tsx`). It imports the real components, so
it can never drift from reality. **Anything you add to the kit, add there too.**

## This is enforced automatically

`scripts/check-ui-kit.mjs` runs as a PostToolUse hook on every Write/Edit
(wired in `.claude/settings.json`). Touch a `.tsx` outside `components/ui/` and
it reports raw colours, direct `lucide-react` imports, hand-rolled
buttons/inputs, and ad-hoc `<th>` styling — then blocks so they get fixed while
the context is still live.

Run it by hand any time: `node scripts/check-ui-kit.mjs <file>`.

**The escape hatch.** A few elements are genuinely not kit components — a nav
row that must match a sibling `<Link>`, a circular avatar, a multi-line
selection row. Mark those `data-kit-ok` and put a comment above saying why. Use
it sparingly: reach for it only after deciding the kit should *not* gain a
variant, and never to silence a check you'd rather not fix.

The hook is a backstop, not the plan. Read this file and open
`/setup/style-guide` **before** writing UI, so the check has nothing to find.

## Hard rules

1. Import UI from `@/components/ui`. Never hand-roll a button, input, table,
   tab bar, dropdown, badge or empty state.
2. **No raw colours, ever.** No hex, no `rgb()`, no stock Tailwind palette
   (`bg-blue-600`, `text-gray-500`, `border-slate-200`, `bg-red-50`). Only tokens.
3. Icons come from `@/components/ui/icons` (re-exported and renamed there), not
   from `lucide-react` directly.
4. Need something the kit lacks? Add it to `src/components/ui/`, export it from
   `index.ts`, render it on the Style Guide page — then use it.
5. Never restyle a control at the call site to make it look different. Add a
   variant to the component instead.

## Tokens

Defined in `@theme` in `src/app/globals.css`; Tailwind turns each into
utilities. Dark mode overrides the same variables (both an OS media query and an
explicit `[data-theme]` block — keep the two in sync).

**Surfaces** `canvas` (page) · `surface` (cards, inputs, menus) · `surface-2`
(table headers, hover, subtle fills) · `border` (hairlines) · `border-strong`
(input borders)

**Text** `ink` (primary) · `ink-2` (table body, labels) · `muted` (hints,
descriptions) · `faint` (placeholders, disabled)

**Accents** — each has three steps: base fill, `-ink` (hover/active, and text on
a tint), `-soft` (pale badge/pill background):
`brand` · `success` · `warning` · `danger`

Meaning drives the choice: success = good/in stock, danger = destructive or
blocked, warning = needs attention, brand = new/informational, neutral = a count.

**Shape & size** `rounded-control` (8px: buttons, inputs) · `rounded-card` (12px)
· `rounded-pill` · `shadow-card` · `shadow-pop` (menus, toasts) ·
`h-control` / `w-control` (36px — every interactive control) · `h-control-sm`
(32px — inline table actions)

Money and quantities get the `numeric` class (tabular figures) and are
right-aligned, so columns line up.

## The kit

```tsx
import { Button, Card, CardHeader, CardBody, DataTable, Icons } from '@/components/ui'
```

**Buttons** — `<Button variant>` and `<ButtonLink>` (navigation).
Variants: `primary` (main confirm, one per screen) · `secondary` (back) ·
`success` (positive go, POS) · `danger` (destructive confirm) · `danger-ghost`
(inline destructive in tables) · `ghost` (toolbars). Sizes `md` | `sm`;
`iconOnly` makes it square — pass an `aria-label` with it.

**Forms** — `<Field label hint error>` wraps `<Input>` (optional leading
`icon`), `<NumberInput>`, `<CurrencyInput>`, `<Textarea>`, `<Select>`,
`<Switch>`, `<Checkbox>`, `<Radio>`. They all share one skin: change `CONTROL`
in `styles.ts` and every form in the app follows.

**Layout** — `<PageHeader title subtitle action>` then `<PageBody>`.
`<Card>` + `<CardHeader title description action>` + `<CardBody>` +
`<CardFooter>`.

**Tables** — `<DataTable>` for anything that renders values. When a table's
cells hold live inputs (DataTable can't express that), build the `<table>` by
hand but wear the shared skin: `TABLE_HEAD_ROW`, `TABLE_TH`, `TABLE_TD`,
`TABLE_NUMERIC` from `@/components/ui`. DataTable itself uses those exact
constants, so the two can never drift. Never invent `<th>` padding or type
scale at the call site — that is what broke the pricing tables.

**Lists** — `<TableToolbar actions={...}>` holds `<SegmentedControl>` and
`<ToolbarSearch>` above a `<DataTable>`. DataTable takes `columns`, `rows`,
`getRowKey`, optional `actions(row)`, and an `empty` object; give a column
`sortValue` whenever its cell renders anything but a plain string or number.
Pass `sort` + `onSortChange` for server-side sorting, or omit both and it sorts
itself.

**Navigation** — `<Tabs>` switches between sections of one record;
`<SegmentedControl>` filters one list into slices. `<LinkTabs>` keeps tab state
in the URL.

**Feedback** — `useToast()` returns `{ success, error, info }`. Every mutation
should end in a toast so the user is never guessing. `<Menu>` + `<MenuItem>`
handles outside-click, Escape and aria for you. `<Badge tone>` and
`<EmptyState>` (always say what's missing *and* what to do next).

## Adding to the kit

1. New file in `src/components/ui/`. Add `'use client'` only if it uses hooks or
   handlers — keep the rest server-renderable.
2. Shared class strings go in `styles.ts`, not the component. Exports of a
   `'use client'` module become client references, so a server component calling
   `buttonClass()` from a client file would crash at runtime.
3. Export it from `index.ts`.
4. Add a live demo to the Style Guide page with its name and a one-line note.
5. Never build a class name dynamically (`` `bg-${tone}` ``) — Tailwind scans
   source text and will not emit it. Write full class strings in a lookup map.
