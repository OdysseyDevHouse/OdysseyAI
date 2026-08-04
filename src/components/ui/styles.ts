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
  | 'danger' /* destructive confirm */
  | 'danger-ghost' /* inline destructive, e.g. delete in a table row */
  | 'ghost' /* low emphasis, toolbars */

export type ButtonSize = 'md' | 'sm'

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
  danger: 'border-transparent bg-danger text-white hover:bg-danger-ink disabled:bg-danger/40',
  'danger-ghost':
    'border-danger/30 bg-surface text-danger hover:border-danger hover:bg-danger-soft ' +
    'disabled:border-border disabled:text-danger/40',
  ghost:
    'border-border bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink ' +
    'disabled:bg-surface disabled:text-faint',
}

/* Icon-only buttons go square at the same height, so a toolbar of mixed
   buttons still lines up. */
const BUTTON_SIZE: Record<ButtonSize, { text: string; icon: string }> = {
  md: { text: 'h-control px-3.5', icon: 'h-control w-control' },
  sm: { text: 'h-control-sm px-3 text-[13px]', icon: 'h-control-sm w-control-sm' },
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

/* ── Form controls ───────────────────────────────────────────────────────── */

/** The one skin every single-line control wears. Edit here, every form follows. */
export const CONTROL =
  'w-full rounded-control border border-border-strong bg-surface px-3 text-sm text-ink ' +
  'placeholder:text-faint transition outline-none ' +
  'hover:border-brand/50 focus:border-brand ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-faint'

export const CONTROL_H = 'h-control'

/** Applied on top of CONTROL when a field is showing an error. */
export const CONTROL_INVALID = 'border-danger hover:border-danger focus:border-danger'
