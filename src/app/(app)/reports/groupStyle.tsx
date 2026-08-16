import type { ReactNode } from 'react'
import { Icons } from '@/components/ui'

/**
 * How a banded report's group breaks are decorated: one accent colour and one
 * glyph per band.
 *
 * ── WHY COLOUR IS HASHED, NOT CYCLED ─────────────────────────────────────
 *
 * The obvious implementation gives band 1 the first colour, band 2 the second,
 * and so on. That makes a band's colour a function of its POSITION, so sorting
 * the report by a different column — or a quiet week that drops a clerk out of
 * the list — reshuffles every colour on screen. Hashing off the LABEL instead
 * means a given clerk, department or till keeps the same colour across re-runs,
 * re-sorts and periods, which is the only way the colour becomes something a
 * reader can learn rather than decoration that moves.
 *
 * ── WHY PAYMENT TYPES ARE SPECIAL-CASED ──────────────────────────────────
 *
 * Tenders are the one dimension where the colours carry meaning people already
 * hold: card reads blue, cash reads green. Hashing those would be technically
 * consistent and read as wrong, so a tender break takes its accent from the
 * value rather than from the hash.
 *
 * Ported from the v2 reporting screen, whose behaviour this matches deliberately
 * — a shop moving across should find its reports banded the way they were. The
 * tokens are this app's (`--color-chart-*`), not v2's, so light and dark both
 * work and a palette change lands here too.
 */

/** A band's accent, named. Resolved to a token below. */
const ACCENT_COLORS: Record<string, string> = {
  blue: 'var(--color-chart-1)',
  teal: 'var(--color-chart-2)',
  amber: 'var(--color-chart-3)',
  violet: 'var(--color-chart-4)',
  pink: 'var(--color-chart-5)',
  cyan: 'var(--color-chart-6)',
  emerald: 'var(--color-success)',
  orange: 'var(--color-warning)',
}

export type GroupAccent = { accent: string; icon?: ReactNode }

/**
 * Payment-type breaks: card-ish tenders read blue, cash green, loyalty violet,
 * account teal, and anything else (EFT, vouchers, Other) orange — so the tender
 * bands of a sales report are tellable apart at a glance. Never returns
 * undefined: an unknown tender still gets the orange "other" treatment.
 */
export function tenderAccent(value: string): GroupAccent {
  const v = value.toLowerCase()
  if (/card|credit|debit|speed|snap|zapper|tap/.test(v))
    return { accent: 'blue', icon: <Icons.CreditCard size={16} strokeWidth={1.7} /> }
  if (/cash/.test(v)) return { accent: 'emerald', icon: <Icons.Banknote size={16} strokeWidth={1.7} /> }
  if (/loyalty|points|voucher/.test(v))
    return { accent: 'violet', icon: <Icons.Star size={16} strokeWidth={1.7} /> }
  if (/account/.test(v)) return { accent: 'teal', icon: <Icons.Contact size={16} strokeWidth={1.7} /> }
  return { accent: 'orange', icon: <Icons.Coins size={16} strokeWidth={1.7} /> }
}

/**
 * Whether a band VALUE is unmistakably a tender, whatever it is banded on.
 *
 * The field name is not always enough: a report banded on a column called
 * "type" or "method" still shows Card and Cash, and hashing those gave cash an
 * amber wash — actively wrong for the one dimension where readers already hold
 * the colours. Matched on whole words so a customer called "Cash Converters"
 * or a department named "Cardboard" is not mistaken for a payment type.
 */
function looksLikeTender(value: string): boolean {
  return /^(?:cash|card|credit card|debit card|account|loyalty|voucher|points|eft|snapscan|zapper)$/i.test(
    value.trim(),
  )
}

/**
 * A default glyph for the dimension being banded on, matched by pattern rather
 * than exactly — `userName`, `clerkName` and `servedBy` should all read as a
 * person without each needing an entry.
 */
function iconForField(field: string | undefined): ReactNode {
  const f = (field ?? '').toLowerCase()
  if (/clerk|user|served|supervisor|technician|owner/.test(f))
    return <Icons.Users size={16} strokeWidth={1.7} />
  if (/till|terminal|device|workstation|computer/.test(f))
    return <Icons.Terminal size={16} strokeWidth={1.7} />
  if (/store|site|branch|supplier/.test(f)) return <Icons.Store size={16} strokeWidth={1.7} />
  if (/department|category/.test(f)) return <Icons.Tag size={16} strokeWidth={1.7} />
  if (/payment|tender/.test(f)) return <Icons.CreditCard size={16} strokeWidth={1.7} />
  if (/customer|account/.test(f)) return <Icons.Contact size={16} strokeWidth={1.7} />
  if (/product|item|stock/.test(f)) return <Icons.Boxes size={16} strokeWidth={1.7} />
  if (/status|state|reason/.test(f)) return <Icons.StatusSuccess size={16} strokeWidth={1.7} />
  if (/day|date|month|hour|period/.test(f))
    return <Icons.CalendarClock size={16} strokeWidth={1.7} />
  return <Icons.LayoutGrid size={16} strokeWidth={1.7} />
}

/** The accents a band falls back to, in the order the hash walks them. */
const FALLBACK_ACCENTS = ['blue', 'teal', 'violet', 'amber', 'pink', 'emerald', 'orange', 'cyan']

/** Stable across re-runs and re-sorts — see the note at the top of the file. */
function accentForLabel(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  return FALLBACK_ACCENTS[h % FALLBACK_ACCENTS.length]
}

/**
 * The glyph and colour for one band.
 *
 * `field` is the column being banded on, which decides the default glyph; a
 * tender band overrides both from its own value.
 */
export function groupStyleFor(
  label: string,
  field: string | undefined,
  /** The accent already given to the band above, so two neighbours differ. */
  avoid?: string,
): { icon: ReactNode; color: string; accent: string } {
  const isTender = /payment|tender/.test((field ?? '').toLowerCase()) || looksLikeTender(label)
  const mapped = isTender ? tenderAccent(label) : undefined

  /*
   * A hash over eight accents collides often — on real data, "GL Test" and
   * "Instructions Test" both landed on emerald and the two bands were
   * indistinguishable. Nudging a colliding band to the next accent keeps the
   * hash's stability (a label's colour still does not depend on its position,
   * only on the one band above it) while guaranteeing neighbours differ.
   *
   * A tender keeps its meaningful colour regardless: two cash-ish tenders
   * reading green is correct, and shifting one to amber to be different would
   * be a worse answer than the collision.
   */
  let accent = mapped?.accent ?? accentForLabel(label)
  if (!mapped && avoid && accent === avoid) {
    const i = FALLBACK_ACCENTS.indexOf(accent)
    accent = FALLBACK_ACCENTS[(i + 1) % FALLBACK_ACCENTS.length]
  }

  return {
    icon: mapped?.icon ?? iconForField(field),
    color: ACCENT_COLORS[accent] ?? ACCENT_COLORS.blue,
    accent,
  }
}

/**
 * The tinted tile at the head of a band.
 *
 * The fill is mixed from the accent rather than being a second token, so one
 * palette change moves the tile, the count pill and the header wash together.
 */
export function GroupTile({ icon, color }: { icon: ReactNode; color: string }) {
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control"
      style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
    >
      {icon}
    </span>
  )
}
