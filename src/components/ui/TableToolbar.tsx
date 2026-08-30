'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { Search } from './icons'
import { Select } from './Field'
import { CONTROL, CONTROL_H } from './styles'

/**
 * The bar that sits above a list: filters and search on the left, actions on
 * the right. Use TableToolbar rather than hand-rolling a flex row, so every
 * list screen has the same rhythm and control heights.
 *
 * ── WHERE THE PADDING COMES FROM ──────────────────────────────────────────
 *
 * A toolbar sits in one of two places, and they want opposite things:
 *
 *   · INSIDE A CARD, directly above a table. It is a band of the card, so it
 *     needs the card's own gutter and a rule under it — and that gutter must
 *     be `px-4`, the same as TABLE_TD, or the search box hangs off the edge of
 *     the column headings below it. Pass `inCard`.
 *   · FREE-STANDING IN A PageBody, above a separate Card. It is its own row on
 *     the page and takes no padding at all. That is the default.
 *
 * `inCard` exists because the in-card case used to be a class string copied
 * from screen to screen, and a screen that forgot it — or typed `px-6` — was a
 * toolbar visibly out of line with its own table. Spelling the intent instead
 * of the spacing makes the aligned version the easy one to write.
 */
export function TableToolbar({
  children,
  actions,
  filters,
  inCard = false,
  className = '',
  id,
}: {
  /** Left side — segmented control, search, filter selects. */
  children?: ReactNode
  /** Right side — Export, New, and friends. */
  actions?: ReactNode
  /**
   * APPLIED filters — the chips saying what the list is currently narrowed to.
   * They get a row of their own, under the controls and anchored left.
   *
   * ── WHY A SECOND ROW AND NOT MORE CHIPS IN THE FIRST ──────────────────
   *
   * The controls row and the chips answer different questions. A control is
   * something you OPERATE — a search box, a picker, the Filter button. A chip
   * REPORTS what is already on, and its only action is to remove itself. Mixed
   * into one row they compete: a chip reading "Where: Product type is
   * Returnable product" is far wider than any picker beside it, so it pushed
   * the search box narrow and shoved the controls out of their usual places.
   * The row a person reaches for stopped being the same shape from screen to
   * screen, which is the one thing a toolbar has to be.
   *
   * Given its own line the chip can be as wide as its sentence needs, the
   * controls keep their geometry however many filters are on, and the reading
   * order comes out right: here is what you can do, and here is what is
   * currently applied.
   *
   * Renders nothing at all when there are no chips, so the row costs an
   * unfiltered list no vertical space. Pass a <FilterBar>, which already
   * collapses itself when empty.
   */
  filters?: ReactNode
  /**
   * The toolbar is a band inside a Card with content beneath it: take the
   * card gutter and a dividing rule. Leave it off for a free-standing row.
   */
  inCard?: boolean
  className?: string
  /**
   * For the global setting search to scroll to and flash, the same way <Card id>
   * is used — see SettingAnchor. A toolbar is the right target where the setting
   * somebody searched for IS the control in this band (the role picker on
   * Roles & permissions) rather than any one card beneath it.
   *
   * Declared rather than spread from `...rest`: a prop this component does not
   * name is dropped in silence, which is how an anchor comes to name an id that
   * never reaches the DOM — and the anchor test would then fail on a screen
   * whose source does contain the string.
   */
  id?: string
}) {
  return (
    <div id={id} className={`${inCard ? TOOLBAR_IN_CARD : ''} ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* The left group takes the space it needs and the actions take the rest.
            When a list carries enough filters to fill the row, the actions wrap
            to a line of their own — and `ml-auto` keeps them against the RIGHT
            edge when they do. Without it they landed bottom-left, under the
            filters, where a table control reads as one more filter. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {filters}
    </div>
  )
}

/**
 * The in-card band. `px-4` matches TABLE_TD so the toolbar's controls line up
 * with the column headings underneath them.
 */
const TOOLBAR_IN_CARD = 'border-b border-border px-4 py-3.5'

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  /** Optional count pill, e.g. All 162. */
  count?: number
  /**
   * A glyph before the label, giving each slice a shape the eye can find
   * without reading. Either every option carries one or none does — a bar with
   * icons on some segments and not others looks broken rather than considered.
   */
  icon?: ReactNode
}

/**
 * SegmentedControl — switches which slice of a list is shown (the GRV
 * All / Orders / GRVs filter). For mutually exclusive *views* of the same data;
 * if the choices navigate somewhere else, use Tabs instead.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
  size = 'default',
  'aria-label': ariaLabel,
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (next: T) => void
  className?: string
  /**
   * `touch` is the till's step: the bar spans the width it is given, its
   * segments divide that width equally, and each one is a finger target rather
   * than a 28px toolbar chip.
   *
   * It is a size rather than a call-site override because the default bar is an
   * `inline-flex` sized to its labels — a modal passing `w-full` widened the
   * BAR while leaving three small chips huddled at its left edge, which reads
   * as a broken control rather than a bigger one.
   */
  size?: 'default' | 'touch'
  'aria-label'?: string
}) {
  const touch = size === 'touch'
  return (
    <SegmentedBar className={className} ariaLabel={ariaLabel} touch={touch}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={segmentClass(option.value === value, touch)}
        >
          <SegmentLabel option={option} active={option.value === value} />
        </button>
      ))}
    </SegmentedBar>
  )
}

/**
 * Same control, but each segment is a route — for list filters that live in the
 * URL, which is most of them on the document screens.
 *
 * Each option carries its own `href` rather than the bar taking an `hrefFor`
 * function, for the same reason LinkTabs does: this file is `'use client'`, and
 * a Server Component cannot pass a FUNCTION across the boundary. The list pages
 * that need this are server-rendered, so a callback-only control would be
 * unusable there. Strings cross fine.
 */
export function LinkSegmentedControl<T extends string>({
  options,
  value,
  className = '',
  'aria-label': ariaLabel,
}: {
  options: readonly (SegmentedOption<T> & { href: string })[]
  value: T
  className?: string
  'aria-label'?: string
}) {
  return (
    <SegmentedBar className={className} ariaLabel={ariaLabel}>
      {options.map((option) => (
        <Link
          key={option.value}
          href={option.href}
          aria-current={option.value === value ? 'page' : undefined}
          className={segmentClass(option.value === value)}
        >
          <SegmentLabel option={option} active={option.value === value} />
        </Link>
      ))}
    </SegmentedBar>
  )
}

/**
 * A URL filter with too many options to be a segmented bar.
 *
 * `LinkSegmentedControl` above is right for three or four choices a person picks by
 * position. It is wrong for forty departments — the bar wraps to four lines and the
 * screen loses its shape. This is the same "each option is a route" idea in a dropdown.
 *
 * ── WHY IT IS A `<select>` THAT NAVIGATES, AND NOT A LIST OF LINKS ────────
 *
 * A menu of forty `<Link>`s would need its own open/close state, its own keyboard
 * handling and its own focus trapping. A native select already has all three, in a form
 * every OS renders the way its users expect — including the touch pickers on the
 * tablets some of these screens run on.
 *
 * The cost is that navigation happens in `onChange`, which needs a router, which is why
 * this sits in a `'use client'` file. Each option still carries its own `href` rather
 * than the control taking an `hrefFor` function — same reason as its sibling: a Server
 * Component cannot pass a function across the boundary, and every screen using this is
 * server-rendered.
 */
export function LinkSelect({
  options,
  value,
  icon,
  className = '',
  'aria-label': ariaLabel,
}: {
  options: readonly { value: string; label: string; href: string }[]
  value: string
  icon?: ReactNode
  className?: string
  'aria-label'?: string
}) {
  const router = useRouter()
  return (
    <Select
      aria-label={ariaLabel}
      icon={icon}
      value={value}
      className={className}
      onChange={(event) => {
        const chosen = options.find((o) => o.value === event.target.value)
        // `push`, not `replace`: a filter is a place someone can go Back from.
        if (chosen) router.push(chosen.href)
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  )
}

function SegmentedBar({
  children,
  className,
  ariaLabel,
  touch = false,
}: {
  children: ReactNode
  className: string
  ariaLabel?: string
  touch?: boolean
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`items-center gap-1 rounded-control border border-border bg-surface p-1 ${
        /* `flex w-full` rather than `inline-flex`, so the segments below have a
           width to divide. `surface-2` because at this size the bar is a band
           across the dialog rather than a control tucked in a toolbar, and on
           `surface` it would be an outline around nothing. */
        /* A BAR NEVER SPILLS OUT OF WHAT HOLDS IT.

           `inline-flex` sizes to its labels, and every segment is
           `whitespace-nowrap`, so a bar with enough choices — the specials form
           offers eight ways a combo can work — simply grew past the card it sat
           in and ran off over the page beside it. Capped at the space available
           and allowed to wrap, it takes a second row instead. Wrapping rather
           than scrolling because a choice a shopkeeper cannot see is a choice
           they will never make; the bar getting taller says "there are more",
           a hidden scroller says nothing at all. Three chips in a wide toolbar
           are unaffected — there is nothing to wrap. */
        touch ? 'flex w-full bg-surface-2' : 'inline-flex max-w-full flex-wrap'
      } ${className}`}
    >
      {children}
    </div>
  )
}

function segmentClass(active: boolean, touch = false) {
  const base = touch
    ? /* `flex-1 basis-0` — equal thirds regardless of label length, so the bar
         does not shuffle when "Rand" sits beside "Percent". `h-touch` is the
         same finger target every other till control uses. */
      'flex flex-1 basis-0 h-touch justify-center rounded-control px-2 text-base font-semibold'
    : 'inline-flex rounded-[6px] px-3 py-1.5 text-sm font-medium'
  return `items-center gap-2 whitespace-nowrap transition ${base} ${
    active
      ? `bg-brand text-white${touch ? ' shadow-card' : ''}`
      : /* On a `surface-2` bar the default hover fill is the bar's own colour,
           so the segment would light up into nothing. Lift to `surface`. */
        `text-muted hover:text-ink ${touch ? 'hover:bg-surface' : 'hover:bg-surface-2'}`
  }`
}

function SegmentLabel<T extends string>({
  option,
  active,
}: {
  option: SegmentedOption<T>
  active: boolean
}) {
  return (
    <>
      {/* Inactive icons sit back a step so the label stays the thing being
          read; on the active segment both are white and equally loud. */}
      {option.icon && (
        <span aria-hidden className={`shrink-0 ${active ? '' : 'text-faint'}`}>
          {option.icon}
        </span>
      )}
      {option.label}
      {option.count !== undefined && (
        <span
          className={`numeric rounded-pill px-1.5 text-xs font-medium ${
            active ? 'bg-white/20 text-white' : 'bg-surface-2 text-muted'
          }`}
        >
          {option.count}
        </span>
      )}
    </>
  )
}

/** The standard list search box — leading icon, control height, brand focus. */
export function ToolbarSearch({
  value,
  onChange,
  placeholder = 'Search...',
  className = 'w-64',
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  className?: string
  'aria-label'?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <Search
        size={16}
        className="pointer-events-none absolute inset-y-0 left-3 my-auto text-faint"
      />
      <input
        type="search"
        value={value}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL} ${CONTROL_H} pl-9`}
      />
    </div>
  )
}
