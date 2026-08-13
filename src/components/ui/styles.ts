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
export type ButtonSize = 'md' | 'sm' | 'touch' | 'touch-lg'

/* Layout, radius, type scale and motion — identical for every variant, so
   none of them can drift. Only colour changes below. */
const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control border text-sm font-medium transition ' +
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
  md: { text: 'h-control px-3.5', icon: 'h-control w-control' },
  sm: { text: 'h-control-sm px-3 text-[13px]', icon: 'h-control-sm w-control-sm' },
  /* Type steps up with the box. A 56px button wearing 14px text reads as a
     small button that has been stretched, which is exactly how the till's
     buttons looked before these existed. */
  touch: { text: 'h-touch px-5 text-base', icon: 'h-touch w-touch' },
  /* SHADOWED, and only at this size. `touch-lg` is reserved for the keys that
     END a sale — Close and Pay — and on a screen built from floating cards those
     two should sit on the surface the same way the cards do, rather than looking
     printed onto the basket. Every smaller button stays flat: a shadow on all of
     them would be a page of lifted rectangles, which is no hierarchy at all. */
  'touch-lg': {
    text: 'h-touch-lg px-6 text-lg font-semibold shadow-card',
    icon: 'h-touch-lg w-touch-lg shadow-card',
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

/* Sentence case, regular weight: a heading labels its column, it does not
   compete with the values under it. align-top so a heading that wraps to two
   lines sits above its column rather than floating in the middle of it. */
export const TABLE_TH =
  'px-4 pt-3 pb-2.5 text-left align-top text-[13px] font-normal leading-tight text-muted'

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
export const TABLE_ROW = 'group border-b border-border transition last:border-b-0 hover:bg-surface-2'

/**
 * A totals row — the tfoot of an ageing report, the "Net profit" line of a
 * statement. Nine screens each invented a slightly different combination of
 * border/tint/weight for this; use this one everywhere so they stop drifting.
 */
export const TABLE_TOTAL_ROW = 'border-t-2 border-border bg-surface-2 font-medium text-ink'

/* ── Modals ──────────────────────────────────────────────────────────────── */

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

/**
 * The dialog panel itself.
 *
 * `m-auto` is what centres a native <dialog> in the top layer — it has no
 * containing block to flex against, so the usual fixed/inset centring does not
 * apply. `p-0` overrides the UA stylesheet's padding, which would otherwise sit
 * outside our own header/body/footer borders and make them stop short.
 */
export const MODAL_PANEL =
  'm-auto w-[calc(100vw-2rem)] rounded-card border border-border bg-surface p-0 text-ink shadow-pop ' +
  'backdrop:bg-ink/40'

export const MODAL_SIZE: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  /* For a dialog whose content is a grid rather than a form — the bulk options
     catalogue, where a third column at 3xl clips the longer action names. */
  xl: 'max-w-5xl',
}

/* ── Form controls ───────────────────────────────────────────────────────── */

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
