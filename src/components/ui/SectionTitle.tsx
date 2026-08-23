'use client'

import type { ReactNode } from 'react'
import { ChevronDown } from './icons'

/**
 * The heading bar at the top of a card that holds one section of a form.
 *
 * The icon sits in a tinted brand tile so a long form reads as a stack of
 * distinct blocks rather than a wall of text — on the product screen there are
 * six of these, and finding the one you want should not mean reading every
 * heading.
 *
 * Distinct from <CardHeader>, which carries a description and an action and is
 * used for cards that are a screen in their own right.
 *
 * The heading marks its card with a brand-rule line down the card's left edge,
 * so a long stack of sections reads as a set of distinct blocks. That is the
 * default across the app; tone="default" drops the rule for the rare card that
 * should not draw the eye.
 *
 * ── FOLDING ──────────────────────────────────────────────────────────────
 *
 * Pass `open` + `onToggle` and the whole bar becomes the fold control for its
 * card, with a chevron at the right. Use <SectionBody> for the part that folds:
 * it HIDES rather than unmounts, which is the whole reason this exists instead
 * of <Accordion>. These cards sit inside a native <form> whose save reads the
 * DOM, so a section that unmounted while shut would silently post nothing for
 * its fields — a folded "Cost price" would save a cost of zero. Hiding keeps
 * every input present and submitted; `hidden` also takes them out of the tab
 * order and off the accessibility tree, so a shut section cannot be tabbed into.
 */
export function SectionTitle({
  icon,
  children,
  action,
  tone = 'brand',
  open,
  onToggle,
}: {
  /** A 16px glyph from @/components/ui/icons. */
  icon?: ReactNode
  children: ReactNode
  action?: ReactNode
  /** 'default' opts out of the brand rule. */
  tone?: 'default' | 'brand'
  /** Present together with `onToggle` to make this heading fold its card. */
  open?: boolean
  onToggle?: () => void
}) {
  const brand = tone === 'brand'
  const foldable = onToggle !== undefined && open !== undefined

  const heading = (
    // Ink, not brand: the rule on the card's edge already marks the section,
    // and the tinted icon tile carries the colour.
    <h2 className="flex min-w-0 items-center gap-2.5 text-sm font-semibold text-ink">
      {icon && (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-control border border-brand/25 bg-brand-soft text-brand">
          {icon}
        </span>
      )}
      <span className="truncate">{children}</span>
    </h2>
  )

  return (
    <div
      /* The card draws the rule down its own left edge and keys off this
         marker — a border here could only be as tall as the heading. See
         globals.css. */
      data-brand-rule={brand ? '' : undefined}
      className="flex items-center justify-between gap-3 border-b border-border px-5 py-3"
    >
      {foldable ? (
        /* The whole bar is the target, not just the chevron — a fold whose hit
           area is a 16px arrow is one that gets clicked twice. Negative margin
           with matching padding so the hover tint reaches the card's edges
           without moving the title off the column every other heading sits in. */
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="-mx-5 -my-3 flex min-w-0 flex-1 items-center gap-3 rounded-t-card px-5 py-3 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
        >
          <span className="min-w-0 flex-1">{heading}</span>
          {/* Rotated rather than swapped for an up-chevron: the same glyph
              turning is read as one control changing state, where two different
              arrows read as two different buttons. */}
          <ChevronDown
            size={16}
            className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      ) : (
        heading
      )}
      {action}
    </div>
  )
}

/**
 * The body of a card whose <SectionTitle> folds. Hidden, never unmounted — see
 * the note above; these sections live inside forms that read the DOM on save.
 */
export function SectionBody({
  open,
  children,
  className = '',
}: {
  open: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div hidden={!open} className={className}>
      {children}
    </div>
  )
}
