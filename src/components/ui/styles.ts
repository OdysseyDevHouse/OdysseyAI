/**
 * Shared class strings for the UI kit.
 *
 * These live in a plain module (no 'use client') on purpose: exports of a
 * client module become client *references* in RSC, so a server component that
 * imported buttonClass() from Button.tsx would crash when it called it. Keeping
 * the skins here lets both sides use them.
 *
 * This is the layer to edit when a control should look different everywhere.
 * Colours themselves are tokens — see src/app/globals.css.
 */

export type ButtonVariant =
  | 'primary' /* main confirm / save action — one per screen */
  | 'secondary' /* back / secondary actions */
  | 'success' /* positive go / confirm, mostly POS-side */
  /*
   * A confirm that needs a second look, but is NOT destructive.
   *
   * Added for the till's Refund key, which sits exactly where Pay does. Green there would
   * be the one piece of colour on that screen that could actively mislead — it means
   * "money coming in" on every other control — and `danger` would paint a normal,
   * correct act as a destructive one and make cashiers hesitate over something they are
   * supposed to do cheerfully. Also fits a "release the stock hold" or "overwrite the
   * draft" confirm: consequential, reversible, not a mistake.
   */
  | 'warning'
  | 'danger' /* destructive confirm */
  | 'danger-ghost' /* inline destructive, e.g. delete in a table row */
  | 'ghost' /* low emphasis, toolbars */
  | 'key' /* a keypad key — neutral fill, till PIN pad */
  | 'bare' /* chromeless icon affordance — editor toolbars, sidebar/topbar */

/**
 * `touch` and `touch-lg` exist for the till and should not appear in the back
 * office — a 56px button in a toolbar of 40px ones just looks broken. They are
 * sizes rather than call-site overrides so that "how big is a finger target"
 * stays one answer in one place; see --spacing-touch in globals.css.
 */
export type ButtonSize = 'md' | 'sm' | 'touch' | 'touch-lg' | 'keypad' | 'keypad-sm'

/* Layout, radius, type scale and motion — identical for every variant, so
   none of them can drift. Only colour changes below. */
/* The radius, type size and weight are NOT here.
   They belong to BUTTON_SIZE, and a copy in the base defeats it: both land in
   the same Tailwind layer, so `text-sm` here beat the `text-base` a touch
   button asked for purely on source order, and every till button rendered at
   14px — the exact thing the note on `touch` below says the sizes exist to
   stop. `md` and `sm` carry the old defaults explicitly instead. */
const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap border transition ' +
  'disabled:pointer-events-none'

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-brand text-white hover:bg-brand-ink disabled:bg-brand/40',
  secondary:
    'border-brand/35 bg-surface text-brand hover:border-brand hover:bg-brand-soft ' +
    'disabled:border-border disabled:bg-surface disabled:text-faint',
  success: 'border-transparent bg-success text-white hover:bg-success-ink disabled:bg-success/40',
  /* Same recipe as success and danger — only the token changes, which is the point of
     having tokens. White text: --color-warning is a mid amber in light mode and a
     brighter one in dark, and both carry white at the weight a touch button uses. */
  warning: 'border-transparent bg-warning text-white hover:bg-warning-ink disabled:bg-warning/40',
  danger: 'border-transparent bg-danger text-white hover:bg-danger-ink disabled:bg-danger/40',
  'danger-ghost':
    'border-danger/30 bg-surface text-danger hover:border-danger hover:bg-danger-soft ' +
    'disabled:border-border disabled:text-danger/40',
  ghost:
    'border-border bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink ' +
    'disabled:bg-surface disabled:text-faint',
  /* A key on a keypad, which `ghost` cannot be: ghost rests on `surface` and so
     disappears into the card it sits on, and `secondary` is brand-tinted, which
     would make every digit compete with the one key that acts. Filled and
     bordered, so ten of them read as a physical pad; the brand only arrives on
     hover, to confirm the finger is on the right key. */
  key:
    'border-border bg-surface-2 text-ink hover:border-brand hover:bg-brand-soft ' +
    'disabled:border-border disabled:bg-surface-2 disabled:text-faint',
  /* No border and no resting fill — for icons that sit inside other chrome
     (an editor toolbar, the sidebar rail) where a bordered button would read
     as a second frame inside the first. */
  bare:
    'border-transparent bg-transparent text-muted hover:bg-surface-2 hover:text-ink ' +
    'disabled:bg-transparent disabled:text-faint',
}

/* Icon-only buttons go square at the same height, so a toolbar of mixed
   buttons still lines up. */
const BUTTON_SIZE: Record<ButtonSize, { text: string; icon: string }> = {
  md: {
    text: 'h-control px-3.5 rounded-control text-sm font-medium',
    icon: 'h-control w-control rounded-control text-sm font-medium',
  },
  sm: {
    text: 'h-control-sm px-3 rounded-control text-[13px] font-medium',
    icon: 'h-control-sm w-control-sm rounded-control text-sm font-medium',
  },
  /* Type steps up with the box. A 56px button wearing 14px text reads as a
     small button that has been stretched, which is exactly how the till's
     buttons looked before these existed. */
  touch: {
    text: 'h-touch px-5 rounded-control text-base font-medium',
    icon: 'h-touch w-touch rounded-control text-base font-medium',
  },
  /* SHADOWED, and only at this size. `touch-lg` is reserved for the keys that
     END a sale — Close and Pay — and on a screen built from floating cards those
     two should sit on the surface the same way the cards do, rather than looking
     printed onto the basket. Every smaller button stays flat: a shadow on all of
     them would be a page of lifted rectangles, which is no hierarchy at all. */
  'touch-lg': {
    text: 'h-touch-lg px-6 rounded-control text-lg font-semibold shadow-card',
    icon: 'h-touch-lg w-touch-lg rounded-control text-lg font-semibold shadow-card',
  },
  /* A NUMBER-PAD KEY, and only that. Not a height but a proportion: the key
     fills the column its grid gives it and takes its height from that, so one
     pad can be a block in a modal and another can span a whole card without
     two different sets of numbers to keep in step.

     `rounded-card` rather than `rounded-control` because at this size the
     tighter radius reads as a text input rather than a key to press. */
  keypad: {
    text: 'h-auto w-full rounded-card py-5 text-3xl font-bold',
    icon: 'h-auto w-full rounded-card py-5',
  },
  /* The same full-width key, for a pad that shares its dialog with a figure, a
     text field and a footer rather than owning the screen.

     MEASURED, not eyeballed: at `keypad` the drawer-movement dialogs came to
     556px of body against a 560px cap on a 1366×768 till — four pixels, which
     is a coincidence rather than a margin, and the row that fell off the bottom
     first was the Reason field the dialog refuses to record without. This buys
     64px back, and the key still measures 62px at its narrowest — past the 56px
     (--spacing-touch) a finger needs, and taller again in a wider dialog. */
  'keypad-sm': {
    text: 'h-auto w-full rounded-card py-3.5 text-2xl font-bold',
    icon: 'h-auto w-full rounded-card py-3.5',
  },
}

export function buttonClass({
  variant = 'primary',
  size = 'md',
  iconOnly = false,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  iconOnly?: boolean
} = {}) {
  return `${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${
    iconOnly ? BUTTON_SIZE[size].icon : BUTTON_SIZE[size].text
  }`
}

/**
 * A button's GEOMETRY with no colour attached — box, radius, type scale, motion.
 *
 * For the one control that cannot pick a `ButtonVariant`, because its colour is
 * a runtime value rather than a meaning: `TintButton`, which wears a subject's
 * `CategoryTone`. It could have called `buttonClass()` and written its tint
 * after, but "after" is not how Tailwind resolves a conflict — both classes land
 * in the same layer and the winner is decided by the stylesheet's order, not the
 * attribute's. That is a coin toss between `bg-brand` and the tone, and a coin
 * toss is exactly what a design system is for removing.
 *
 * So the colour is never emitted in the first place. Same base and same size map
 * as every other button, which is the part that must not drift.
 */
export function buttonShape({
  size = 'md',
  iconOnly = false,
}: { size?: ButtonSize; iconOnly?: boolean } = {}) {
  return `${BUTTON_BASE} ${iconOnly ? BUTTON_SIZE[size].icon : BUTTON_SIZE[size].text}`
}

/* ── Tables ──────────────────────────────────────────────────────────────── */

/**
 * The one skin every table wears — DataTable and any hand-built table that
 * needs a layout DataTable can't express (multi-row headers, inputs in cells).
 *
 * Editing these changes every table in OdysseyAI at once, which is the whole
 * point: a screen that hard-codes its own `px-3 py-2.5 text-xs` looks right
 * today and drifts the first time this changes.
 */
export const TABLE_HEAD_ROW = 'border-y border-border bg-surface-2'

/**
 * The scroll container a table sits in.
 *
 * A wide table used to be wrapped in a bare `overflow-x-auto`, which grows to
 * the table's full height — so its horizontal scrollbar sits at the BOTTOM of
 * the whole table. On a 300-row report that means scrolling to the end of the
 * data to reach the scrollbar, dragging it, then scrolling back up to read the
 * columns you just revealed.
 *
 * `overflow-auto` (not `overflow-x-auto`) so the SAME box scrolls both ways
 * once something caps its height — which is what puts the horizontal scrollbar
 * at the bottom of the window instead of the bottom of the data.
 *
 * The cap itself is not here, because it cannot be a constant: the chrome above
 * a table differs on every screen. `useFitViewport` measures it. A table that
 * fits gets no cap at all and looks exactly as it always did.
 *
 * NO PADDING HERE, deliberately. The gutter that keeps a table off the card's
 * edge lives on `TABLE_FRAME` below, which does not scroll.
 *
 * Padding on a scrolling box scrolls WITH its content, and that breaks a sticky
 * header two ways at once: at `top-0` the header parks one gutter down with
 * rows sliding past in the margin above it, and pulling it back to `-top-3` to
 * fix that leaves a transparent strip above the header — the header's own
 * background only covers the header — so the rows show through the gap instead.
 * Neither is fixable from inside the scroller; the gutter has to be outside it.
 */
export const TABLE_SCROLLER = 'overflow-auto'

/**
 * The static frame a table's scroll box sits in — this is where the gutter is.
 *
 * Padding here rather than on TABLE_SCROLLER means it never scrolls, so the
 * sticky header can use a plain `top-0` and sit flush against the top of the
 * box with nothing above it to show through.
 *
 * It also keeps the gutter out of the scroll box's own height, which matters
 * more than it sounds: the box is capped to the room left below it, so 24px of
 * vertical padding INSIDE it used to push the page itself into overflow and
 * give a screen two scrollbars — an outer one scrolling nothing but padding.
 */
export const TABLE_FRAME = 'p-3'

/**
 * The header row of a scrolling table. Sticks to the top of TABLE_SCROLLER so
 * the columns stay readable while the body scrolls under them — without it,
 * capping the height would mean scrolling a wide report with no idea which
 * column is which.
 *
 * `bg-surface-2` is not decoration here: the body rows scroll UNDER this row,
 * so it has to be opaque. The border is drawn as a shadow because a sticky
 * element's own border scrolls away with the cell box in some engines.
 */
export const TABLE_HEAD_STICKY =
  'sticky top-0 z-10 bg-surface-2 shadow-[inset_0_-1px_0_var(--color-border)]'

/**
 * Kept as an alias so existing callers keep working — there is no longer any
 * difference between the two.
 *
 * This used to be `-top-3`, compensating for a gutter that lived on the scroll
 * box and therefore scrolled with the content. The gutter now lives on
 * `TABLE_FRAME`, outside the scroller, so there is nothing to compensate for:
 * a negative offset here would only lift the header off the top of the box and
 * reopen the transparent strip it was meant to close.
 */
export const TABLE_HEAD_STICKY_INSET = TABLE_HEAD_STICKY

/* Sentence case, regular weight: a heading labels its column, it does not
   compete with the values under it. align-top so a heading that wraps to two
   lines sits above its column rather than floating in the middle of it. */
export const TABLE_TH =
  'px-4 pt-3 pb-2.5 text-left align-top text-[13px] font-normal leading-tight text-muted'

/**
 * A second line under a column heading, saying what the column MEANS.
 *
 * For the columns whose one-word name is not the whole answer: a switch headed
 * "Visible" does not say visible WHERE, and a swatch headed "Colour" does not
 * say what the colour is for. The caption carries that so the heading can stay
 * a short label rather than growing into a sentence.
 *
 * Faint and small on purpose — this is chrome read once, not a value scanned,
 * and a caption that competes with its own heading has made the header worse.
 * `TABLE_TH` is already align-top and leading-tight, so a captioned heading
 * lines up beside a plain one without either moving.
 *
 * Use it sparingly. Captions on every column is a table explaining itself
 * instead of a table, and the ones that need saying stop standing out.
 */
export const TABLE_TH_CAPTION = 'mt-0.5 block text-[11px] font-normal leading-tight text-faint'

/* 36px rows. Tight on purpose: the chrome around a table (toolbar, stat strip,
   page gutter) is what gets the breathing room, because it is touched once per
   visit — rows are scanned hundreds of times, and every extra pixel of padding
   is a product the user has to scroll to reach. At py-3 a 1,284-product list
   showed 10 rows; at py-1.5 it shows 16. See .claude/skills/odyssey-craft. */
export const TABLE_TD = 'px-4 py-1.5 text-ink-2'

/**
 * A cell holding a form control rather than text.
 *
 * Tight horizontal padding on purpose: the control fills the cell, so the
 * padding IS the gap between neighbouring boxes. Text cells want room to
 * breathe (TABLE_TD above); a row of inputs reads better when the boxes are
 * wide and the gaps are narrow.
 */
export const TABLE_TD_INPUT = 'px-1.5 py-2 text-ink-2'

/** Numeric columns: tabular figures, right-aligned, never wrapped. */
export const TABLE_NUMERIC = 'numeric text-right whitespace-nowrap'

/** The <table> element itself. */
export const TABLE = 'w-full border-collapse text-sm'

/**
 * A body row. Hand-built tables must use this rather than `divide-y` on the
 * body: divide-y draws no line under the last row and gives no hover, so a
 * hand-rolled table sits visibly differently from every DataTable beside it.
 *
 * `group` is here so cells can reveal things on row hover (DataTable's
 * hover-revealed actions ride on it) — it costs nothing when unused.
 */
export const TABLE_ROW =
  'group border-b border-border transition last:border-b-0 hover:bg-surface-2'

/**
 * A totals row — the tfoot of an ageing report, the "Net profit" line of a
 * statement. Nine screens each invented a slightly different combination of
 * border/tint/weight for this; use this one everywhere so they stop drifting.
 */
export const TABLE_TOTAL_ROW = 'border-t-2 border-border bg-surface-2 font-medium text-ink'

/* ── Modals ──────────────────────────────────────────────────────────────── */

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full'

/**
 * The dialog panel itself.
 *
 * `m-auto` is what centres a native <dialog> in the top layer — it has no
 * containing block to flex against, so the usual fixed/inset centring does not
 * apply. `p-0` overrides the UA stylesheet's padding, which would otherwise sit
 * outside our own header/body/footer borders and make them stop short.
 *
 * `text-left` is not decoration: a <dialog> paints in the top layer but still
 * INHERITS from wherever it was mounted in the DOM. Mounted from a button in a
 * right-aligned table cell — a row action, which is where row actions live —
 * every unaligned label inside the dialog silently came out right-aligned. The
 * panel has to state its own alignment so its contents never depend on the
 * markup that happened to open it.
 *
 * `open:flex flex-col` + `overflow-hidden`: the PANEL itself must never scroll.
 * A dialog whose body scrolls its own children instead of scrolling as one
 * piece — the till's cash-up, with a pinned numpad and three panes — otherwise
 * ends up with TWO scrollbars: the inner pane's, and the panel's own, because
 * the UA caps a <dialog> at `calc(100% - 2em)` and header + body + footer
 * outgrow it. Laying the panel out as a column lets the body take what is
 * actually left after the header and footer rather than guessing at a fraction
 * of the viewport, and clips anything that still would not fit.
 *
 * `open:flex` and NEVER a bare `flex`. A <dialog> is hidden by exactly one UA
 * rule — `dialog:not([open]) { display: none }` — so an unconditional
 * `display: flex` overrides it and every CLOSED dialog in the app paints where
 * it stands. That shipped for real: eight stacked bulk-action dialogs on the
 * customers list, on landing. The layout is only ever needed while the dialog
 * is open, so it is scoped to `[open]` and a closed one keeps the UA's
 * `display: none`.
 *
 * The max-height restates the UA's own ceiling in `dvh`, so a phone's
 * disappearing browser chrome cannot push the footer under the address bar.
 */
export const MODAL_PANEL =
  'm-auto open:flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-card ' +
  'border border-border bg-surface p-0 text-left text-ink shadow-pop backdrop:bg-ink/40'

export const MODAL_SIZE: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  /* For a dialog whose content is a grid rather than a form — the bulk options
     catalogue, where a third column at 3xl clips the longer action names. */
  xl: 'max-w-5xl',
  /*
   * The whole screen, for a dialog that IS a workspace rather than a question.
   *
   * The till's cash-up is the case this exists for: a denomination grid, a
   * numpad, every tender and a dozen counter tiles have to be readable at once,
   * because a cashier counting a drawer works across all three at the same time.
   * Capped at 1600px so the panels do not stretch into unreadable bands on a
   * back-office widescreen.
   */
  full: 'max-w-[1600px]',
}

export type DrawerSize = 'sm' | 'md' | 'lg'

/**
 * A dialog anchored to an edge of the screen instead of centred.
 *
 * `h-dvh` and `max-h-none` override the UA stylesheet, which caps a <dialog>
 * at calc(100% - 6px) of the viewport and would otherwise leave a hairline of
 * page showing above and below a panel meant to run the full height. `dvh`
 * rather than `vh` so a phone's collapsing address bar does not push the foot
 * of the panel under itself.
 *
 * The rest matches MODAL_PANEL for the reasons documented there — `p-0` beats
 * the UA padding, and `text-left` stops the panel inheriting alignment from
 * whatever cell happened to open it.
 */
export const DRAWER_PANEL =
  'my-0 h-dvh max-h-none w-[calc(100vw-2rem)] border border-border bg-surface p-0 text-left text-ink shadow-pop ' +
  'backdrop:bg-ink/40'

export const DRAWER_SIZE: Record<DrawerSize, string> = {
  sm: 'max-w-sm',
  /* Wide enough for a list of choices that each carry an icon, a name and a
     line of explanation — the product type picker is what this was sized
     against. */
  md: 'max-w-lg',
  lg: 'max-w-2xl',
}

/* ── Form controls ───────────────────────────────────────────────────────── */

/**
 * The caption above a control.
 *
 * `Field` wears this, and so should anything that has to sit beside a Field and
 * look like it belongs — a heading over a GROUP of controls, which Field itself
 * cannot label because it labels exactly one.
 *
 * A constant rather than a string typed twice: it had already been copied into
 * the till-tile panel, and the department picker had drifted to a different size
 * AND colour, so one card showed the same kind of caption three ways.
 */
export const FIELD_LABEL = 'mb-1.5 block text-sm font-medium text-ink-2'

/** The one skin every single-line control wears. Edit here, every form follows. */
export const CONTROL =
  'w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-ink ' +
  'placeholder:text-faint transition outline-none ' +
  /* Focus is ONE brand line, not a border plus a ring. The inset shadow sits on
     top of the border rather than outside it, so it reads as a single 2px edge
     — see the :focus-visible opt-out in globals.css. */
  'hover:border-brand/50 focus:border-brand focus:shadow-[inset_0_0_0_1px_var(--color-brand)] ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-faint ' +
  /* A read-only field looks the same as a disabled one, because to the person
     using it the two mean the same thing: "you cannot change this". They are
     NOT the same to the browser — a disabled input is left out of the form
     entirely, which silently drops the value from every save. So a field that
     must be submitted but not edited uses readOnly, and needs to look the part.
     The hover cue is cancelled too; there is nothing to invite.

     Every rule here is narrowed to input/textarea, because :read-only does NOT
     mean what it looks like: the spec defines :read-write for text-entry elements
     only, so a <select> matches :read-only ALWAYS — readonly is not even a valid
     attribute on one. Unqualified, these rules painted EVERY dropdown in the app
     with the disabled grey and cancelled its hover, while the inputs beside them
     stayed white. Deleting them instead fixes the dropdowns but leaves a readOnly
     field looking fully editable, so they are scoped rather than dropped.

     The `[&:is(...)]` arbitrary variant is deliberate: `read-only:where(...)` is
     not valid Tailwind and compiles to nothing at all, silently dropping the
     read-only skin rather than scoping it. Verified against the emitted CSS. */
  'read-only:[&:is(input,textarea)]:cursor-default read-only:[&:is(input,textarea)]:bg-surface-2 ' +
  'read-only:[&:is(input,textarea)]:text-muted read-only:[&:is(input,textarea)]:hover:border-border-strong ' +
  'read-only:[&:is(input,textarea)]:focus:border-border-strong read-only:[&:is(input,textarea)]:focus:shadow-none'

export const CONTROL_H = 'h-control'

/**
 * The same skin at till height.
 *
 * Type steps up with the box for the reason the touch buttons do: a scan field
 * is read at arm's length while the cashier is looking at the customer, and
 * 14px in a 56px box reads as a small field that has been stretched.
 */
export const CONTROL_H_TOUCH = 'h-touch text-base'

/** Applied on top of CONTROL when a field is showing an error. */
export const CONTROL_INVALID =
  'border-danger hover:border-danger focus:border-danger ' +
  'focus:shadow-[inset_0_0_0_1px_var(--color-danger)]'

/**
 * Applied on top of CONTROL for a field that HOLDS focus by design — the till's
 * scan box, which is re-focused after every add so a scanner gun always lands in
 * it. The standard focus edge is maximum emphasis, and a field wearing it all
 * shift long is the loudest thing on the screen forever. This trades the 2px
 * brand edge for a calm half-strength 1px line: still visibly "scans land here",
 * no longer shouting over the basket and the Pay key.
 */
export const CONTROL_QUIET_FOCUS = 'focus:shadow-none focus:border-brand/50'

/**
 * How wide an editing screen is allowed to get.
 *
 * Capped rather than full-bleed: the pricing tables are wide, but past about
 * 1100px a form's labelled fields stretch into lines the eye loses its place in
 * halfway across a 4K monitor.
 *
 * Shared because a record's panels must AGREE. The product screen stacks a form,
 * a variants panel and a photographs gallery down one page; when only the form
 * carried the cap, the two panels below ran to the window edge and the right
 * edge of the page zig-zagged. Anything stacked as part of one record wears this.
 */
export const EDIT_COLUMN = 'w-full max-w-[1100px]'

/* ── The till's coloured edge ─────────────────────────────────────────────── */

/**
 * A surface's colour, carried as its BORDER rather than as a bar drawn on top.
 *
 * Shared by every till surface that has an identity worth colour-coding — the
 * department rail's rows, the product tiles, the quick keys. One definition because
 * the three sit on screen together: a rail whose edge curves and a tile grid whose
 * edge does not is the drift the kit exists to prevent.
 *
 * Full strength on the LEADING edge, 30% on the other three. The leading edge is the
 * part found across a scrolling grid; a tile at full strength on all four sides is a
 * box shouting for attention, and twenty are twenty boxes all shouting.
 *
 * Being a real border is what curves the bar's inner side: border-radius tapers a
 * border from both ends, so the colour narrows into the corners exactly as the card
 * does. An absolutely-positioned span can only round the two outer corners and leaves
 * a hard vertical line facing the text.
 *
 * Class strings written out in full and never interpolated — Tailwind scans source
 * text, so a computed `border-cat-${tone}` is not emitted and the edge renders as
 * nothing at all.
 */
export const EDGE_RING: Record<string, string> = {
  indigo: 'border-cat-indigo/30',
  violet: 'border-cat-violet/30',
  emerald: 'border-cat-emerald/30',
  amber: 'border-cat-amber/30',
  sky: 'border-cat-sky/30',
  rose: 'border-cat-rose/30',
  teal: 'border-cat-teal/30',
  orange: 'border-cat-orange/30',
  slate: 'border-cat-slate/30',
}

/**
 * The leading edge alone, at full strength.
 *
 * Separate from the ring so a SELECTED surface can take the brand's hairline on three
 * sides and still keep its own colour on the fourth — being chosen must not change
 * which department or product a surface reads as.
 */
export const EDGE_LEAD: Record<string, string> = {
  indigo: 'border-l-cat-indigo',
  violet: 'border-l-cat-violet',
  emerald: 'border-l-cat-emerald',
  amber: 'border-l-cat-amber',
  sky: 'border-l-cat-sky',
  rose: 'border-l-cat-rose',
  teal: 'border-l-cat-teal',
  orange: 'border-l-cat-orange',
  slate: 'border-l-cat-slate',
}
