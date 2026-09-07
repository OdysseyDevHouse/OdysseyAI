'use client'

import type { ReactNode } from 'react'
import { Icons, StatIcon } from '@/components/ui'
import type { SalesKpis } from '@/lib/site/salesDashboard'
import { money, percent, decimal } from './format'
import { plural } from './insights'
import { KPI_IDS, type KpiId } from './widgets'

/**
 * The headline band — the six figures across the top of the dashboard.
 *
 * ONE card cut into cells, not six cards in a row. The figures sit on a common
 * baseline, the hairlines between them divide rather than frame, and the whole
 * row scans in a single left-to-right movement. Six separate cards made six
 * objects with a gutter between each, and the eye had to climb over every gap.
 * See the note at the `kpis` widget in widgets.ts for why that means the BAND
 * is the widget and the cells are not.
 *
 * A cell is three lines and nothing else: what this is, what it came to, and
 * the one thing worth saying about that figure. The third line is the whole
 * design — a number on its own is unreadable ("R1 196 000" is that good?), and
 * the note is what turns it into a statement the reader can act on.
 *
 * THE SPARKLINE IS GONE, and it was not dropped by accident. Every tile used
 * to carry a month of daily readings under its figure, which bought a genuine
 * piece of information — the shape behind the total — at the cost of 76px per
 * tile and a second thing to read in a strip whose whole job is to be glanced
 * at. Six charts across the top of a dashboard that has eight real charts
 * below them were the least informative charts on the screen. The trend still
 * lives, at a size it can actually be read at, in the per-day and per-hour
 * widgets directly underneath. What a cell spends that room on instead is the
 * note, which says in words what the sparkline only implied.
 */

/** What a note is telling the reader, which is what colours it. */
export type NoteTone = 'up' | 'down' | 'flat'

export type Note = { text: string; tone: NoteTone }

/** Everything a note can draw on: this period, the last one, and its name. */
export type NoteCtx = {
  kpis: SalesKpis
  compare: SalesKpis | null
  compareShort: string
}

type KpiDef = {
  id: KpiId
  label: string
  /**
   * The glyph in the cell's medallion.
   *
   * It names the KIND of figure — money, a margin, a basket — so a row can be
   * found by shape before it is read. Six different glyphs are the point:
   * identical ones would say only "these are six things", which the six
   * captions already say. The tint is the same on all six, deliberately — see
   * StatIcon.
   */
  icon: ReactNode
  value: (k: SalesKpis) => string
  /**
   * The line under the figure.
   *
   * Most are a comparison; two are not. Turnover-excl and items-per-sale have
   * something more useful to say than "up 7% on July" — the VAT that separates
   * the two turnover tiles, and the unit count the average is a mean of — and
   * a tile that prints a comparison nobody asked for, because every other tile
   * did, is padding.
   */
  note: (ctx: NoteCtx) => Note
}

const NO_COMPARISON: Note = { text: 'No comparison data', tone: 'flat' }

/**
 * A change too small to be a change.
 *
 * Without this the flat months print "+0.0% on July", which reads as a
 * measured improvement of nothing. Half of the last shown digit, so the
 * threshold is exactly the point where the printed figure would round to zero.
 */
const NEGLIGIBLE = 0.05

/** The percentage change against the same metric last period. */
export function pctDelta(pick: (k: SalesKpis) => number) {
  return ({ kpis, compare, compareShort }: NoteCtx): Note => {
    if (!compare) return NO_COMPARISON
    const now = pick(kpis)
    const base = pick(compare)

    // A zero baseline is called out rather than divided by: the division either
    // explodes or, worse, quietly reports 100% and reads as a modest gain on a
    // month that actually traded nothing.
    if (base === 0) {
      if (now === 0) return { text: `Nothing in either period`, tone: 'flat' }
      return { text: `New — nothing in ${compareShort}`, tone: now > 0 ? 'up' : 'down' }
    }

    const change = ((now - base) / Math.abs(base)) * 100
    if (Math.abs(change) < NEGLIGIBLE) return { text: `Flat on ${compareShort}`, tone: 'flat' }
    const up = change > 0
    return {
      text: `${up ? '+' : '-'}${Math.abs(change).toFixed(1)}% on ${compareShort}`,
      tone: up ? 'up' : 'down',
    }
  }
}

/**
 * The change in a metric that is ITSELF a percentage, in points.
 *
 * "GP down 2%" is the one comparison on this strip that can be read two ways —
 * two percent of the margin, or two points off it — and they are wildly
 * different numbers. Points, said out loud, is the only unambiguous form.
 */
function pointsDelta(pick: (k: SalesKpis) => number) {
  return ({ kpis, compare, compareShort }: NoteCtx): Note => {
    if (!compare) return NO_COMPARISON
    const diff = pick(kpis) - pick(compare)
    if (Math.abs(diff) < NEGLIGIBLE) return { text: `Flat on ${compareShort}`, tone: 'flat' }
    const up = diff > 0
    return {
      text: `${Math.abs(diff).toFixed(1)} points ${up ? 'up' : 'down'} on ${compareShort}`,
      tone: up ? 'up' : 'down',
    }
  }
}

/**
 * The change as an AMOUNT rather than a proportion.
 *
 * For the average sale, which moves in rands a shop can picture: "+R2.40 on
 * July" is a basket with another packet of crisps in it, where "+2.1%" is a
 * ratio nobody can act on.
 */
function moneyDelta(pick: (k: SalesKpis) => number) {
  return ({ kpis, compare, compareShort }: NoteCtx): Note => {
    if (!compare) return NO_COMPARISON
    const diff = pick(kpis) - pick(compare)
    if (Math.abs(diff) < 0.005) return { text: `Level with ${compareShort}`, tone: 'flat' }
    const up = diff > 0
    return {
      text: `${up ? '+' : '-'}${money(Math.abs(diff))} on ${compareShort}`,
      tone: up ? 'up' : 'down',
    }
  }
}

/**
 * The VAT between the two turnover tiles.
 *
 * The excl tile's note is the difference the tile beside it makes, which is
 * the only reason a shop reads the two together. The rate is derived from the
 * figures rather than assumed to be fifteen: a period spanning a rate change,
 * or a basket of zero-rated stock, produces a blended rate, and printing "at
 * 15%" over a number that says otherwise is the one thing worse than not
 * printing the rate at all.
 */
function vatNote({ kpis }: NoteCtx): Note {
  const vat = kpis.turnoverIncl - kpis.turnoverExcl
  if (kpis.turnoverExcl <= 0 || vat <= 0) return { text: 'No VAT in the period', tone: 'flat' }
  const rate = (vat / kpis.turnoverExcl) * 100
  const shown =
    Math.abs(rate - Math.round(rate)) < NEGLIGIBLE ? String(Math.round(rate)) : rate.toFixed(1)
  return { text: `${money(vat)} VAT at ${shown}%`, tone: 'flat' }
}

/** The total the items-per-sale average was taken over. */
function itemsNote({ kpis }: NoteCtx): Note {
  return { text: `${plural(kpis.itemCount, 'item')} sold`, tone: 'flat' }
}

/*
 * Six tiles, one figure each.
 *
 * Money first and widening — what was taken, what of it is the shop's, what
 * was made on it, and at what margin — then the shape of the basket behind
 * that money. The sale COUNT is not here: it is the denominator under half of
 * these figures rather than a headline of its own, and it opens the rates band
 * directly below, where it sits beside the per-day and per-hour readings that
 * are the only useful things to divide it by.
 */
export const KPI_DEFS: KpiDef[] = [
  {
    id: 'turnoverIncl',
    // "incl VAT" spelled out on both turnover tiles. Abbreviated to "incl" they
    // were two tiles apparently showing the same thing at different values,
    // which is exactly the confusion the pair exists to resolve.
    label: 'Turnover incl VAT',
    icon: <Icons.Money size={16} />,
    value: (k) => money(k.turnoverIncl),
    note: pctDelta((k) => k.turnoverIncl),
  },
  {
    id: 'turnoverExcl',
    label: 'Turnover excl VAT',
    icon: <Icons.Coins size={16} />,
    value: (k) => money(k.turnoverExcl),
    note: vatNote,
  },
  {
    id: 'grossProfit',
    label: 'Gross profit',
    icon: <Icons.BarChart size={16} />,
    value: (k) => money(k.grossProfit),
    note: pctDelta((k) => k.grossProfit),
  },
  {
    id: 'grossProfitPct',
    // Its own tile rather than a bracketed rider on the gross profit figure.
    // The margin is the number a buyer actually manages — it survives a slow
    // month that drags the rand figure down, and it is the first thing to move
    // when discounting gets out of hand — and a figure in brackets gets no
    // comparison of its own, which is the only way to see either of those.
    label: 'GP percentage',
    icon: <Icons.Percent size={16} />,
    value: (k) => percent(k.grossProfitPct),
    note: pointsDelta((k) => k.grossProfitPct),
  },
  {
    id: 'avgSaleValue',
    label: 'Average sale',
    icon: <Icons.Wallet size={16} />,
    value: (k) => money(k.avgSaleValue),
    note: moneyDelta((k) => k.avgSaleValue),
  },
  {
    id: 'avgItemsPerSale',
    label: 'Items per sale',
    icon: <Icons.Boxes size={16} />,
    value: (k) => decimal(k.avgItemsPerSale),
    note: itemsNote,
  },
]

/** Kept for the registry's sake: the ids the band knows how to draw. */
export const KPI_BY_ID = new Map(KPI_DEFS.map((d) => [d.id, d]))

/* The registry and this file must agree on which six figures exist. A cell
   added to one and not the other is a switch that toggles nothing, or a figure
   nobody can switch off — both silent. */
if (KPI_DEFS.length !== KPI_IDS.length) {
  throw new Error('KPI_DEFS and KPI_IDS disagree about which figures the band holds')
}

/**
 * Type size for a headline figure, chosen by how long it is.
 *
 * A shop turning over R2 000 and one turning over R2 658 421.55 both get a
 * tile the same width, and the second must not be clipped to fit. Stepping the
 * size down keeps the number whole — which matters more than every tile
 * sharing one type size.
 *
 * RECALIBRATED FOR THE MEDALLION, which is the cost of adding it. A sixth of
 * the band is ~216px at a 1600px viewport; the icon and its gap take 42 of
 * those and the padding 24, leaving ~150px of text column where the cell used
 * to have ~184. The tabular `numeric` face advances about 0.6em per character,
 * so the steps fall at 10 characters (24px × 0.6 × 10 = 144), 12 at 20px, and
 * 14 at 18px.
 *
 * What that means in practice: a shop turning over tens of thousands keeps the
 * full 24px headline, and one turning over millions — "R1 196 000.00", 13
 * characters — now reads at 18px rather than 24. That is the trade the icons
 * bought, and it is still the right way round: a smaller whole number beats a
 * larger truncated one, which is the rule this function has always enforced.
 */
function valueSize(value: string): string {
  if (value.length <= 10) return 'text-2xl'
  if (value.length <= 12) return 'text-xl'
  if (value.length <= 14) return 'text-lg'
  return 'text-base'
}

export const NOTE_TONE: Record<NoteTone, string> = {
  up: 'text-success',
  down: 'text-danger',
  // Not a lesser note — the VAT and the unit count are the most useful lines on
  // their tiles. Grey because they are STATEMENTS rather than verdicts, and
  // green on "R156 000 VAT" would say VAT went well.
  flat: 'text-muted',
}

/**
 * The band itself.
 *
 * All six figures or none — the widget panel has one switch for the row, the
 * way it has one for the rates band underneath. There was a switch per figure
 * briefly; see the note at the `kpis` widget in widgets.ts for why it came
 * out again.
 */
export function KpiStrip({
  kpis,
  compareKpis,
  compareShort,
  loading,
}: {
  kpis: SalesKpis
  compareKpis: SalesKpis | null
  compareShort: string
  loading?: boolean
}) {
  return (
    /*
     * FLAT, and deliberately so.
     *
     * This was once six shadowed cards with coloured icon medallions — six
     * objects competing for attention at the top of a screen whose whole job is
     * to be glanced at. One flat band with hairline dividers puts every figure
     * on the same baseline and lets nothing in the row claim to be more
     * important than the number beside it.
     *
     * h-full so the band fills the grid cell it was given rather than sizing to
     * its text and leaving a gap under itself.
     */
    <div className="grid h-full grid-cols-2 overflow-hidden rounded-card border border-border bg-surface sm:grid-cols-3 lg:grid-cols-6">
      {KPI_DEFS.map((def) => (
        <Cell
          key={def.id}
          def={def}
          kpis={kpis}
          compareKpis={compareKpis}
          compareShort={compareShort}
          loading={loading}
        />
      ))}
    </div>
  )
}

/** One figure in the band: caption, value, note. */
function Cell({
  def,
  kpis,
  compareKpis,
  compareShort,
  loading,
}: {
  def: KpiDef
  kpis: SalesKpis
  compareKpis: SalesKpis | null
  compareShort: string
  loading?: boolean
}) {
  const value = def.value(kpis)
  const note = def.note({ kpis, compare: compareKpis, compareShort })

  return (
    /*
     * Rules on the top and left of every cell, clipped away at the band's own
     * edges by the container's `overflow-hidden` and a negative offset. The
     * same scheme the rates band uses, and for the same reason: it survives
     * EVERY column count without one of them being written down. At six across
     * it draws five vertical rules; at two it draws one vertical and two
     * horizontal; nothing has to know which shape it is in.
     *
     * Centred rather than top-aligned. Three lines of text no longer fill the
     * cell the way a sparkline did, and a block pinned to the top leaves a band
     * of empty white under it that reads as something failing to load.
     */
    <div className="-ml-px -mt-px flex items-center gap-2.5 overflow-hidden border-l border-t border-border px-3 py-3">
      <StatIcon>{def.icon}</StatIcon>

      {/* min-w-0 is what makes the truncation below work at all: without it a
          flex child refuses to shrink past its content and the caption pushes
          the medallion out of the cell instead of being clipped. */}
      <div className="min-w-0 flex-1">
        {/* Warm, not grey — see --color-stat-label. Six big black figures in a
            row have no reading order; the captions are the line the eye runs
            along, and they can only be that if they are one colour of their
            own. */}
        <div className="truncate text-xs font-medium text-stat-label" title={def.label}>
          {def.label}
        </div>

        {/* NOT truncated.
            Truncating here is what produced "R2 658 …" on a dashboard whose
            only job is showing numbers — the clipping hid the problem instead
            of solving it. The size steps down for a long figure instead, so a
            seven-digit turnover fits at a smaller type size and stays readable.
            Nothing here is ever cut off. */}
        <div
          className={`numeric mt-0.5 font-semibold leading-tight tracking-tight text-ink ${valueSize(value)} ${loading ? 'opacity-40' : ''}`}
        >
          {value}
        </div>

        {/* One line, truncated, with the full text on hover. This is the one
            place in the cell where clipping is right: the note is a sentence, a
            sentence that wraps costs the band a whole line of height it does
            not have, and half of "R156 000 VAT at 15%" still says what the line
            is about. The figure above it never clips; its commentary may. */}
        <div
          className={`mt-1 truncate text-xs ${NOTE_TONE[note.tone]} ${loading ? 'opacity-40' : ''}`}
          title={note.text}
        >
          {note.text}
        </div>
      </div>
    </div>
  )
}
