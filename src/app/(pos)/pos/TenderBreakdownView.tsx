'use client'

import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_TOTAL_ROW,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { TenderBreakdown, BreakdownSection } from '@/lib/site/cashupBreakdown'

/**
 * One tender's expected figure, opened up — every transaction that made it.
 *
 * ── IT REPLACES THE BOARD RATHER THAN COVERING IT ───────────────────────────
 *
 * This renders INSIDE the cash-up dialog, in place of the count, with a Back
 * that returns to it. Not a second dialog over the first: a modal on a modal
 * puts a count somebody is halfway through behind a scrim they have to dismiss
 * blind, and on a till screen the inner one has nowhere left to be. The dialog
 * is already full-width and full-height, which is exactly the room a table of
 * transactions wants — so the sensible thing is to give it that room, not to
 * open a smaller window inside it.
 *
 * ── AND IT IS NOT A REPORT ──────────────────────────────────────────────────
 *
 * Deliberately not routed through the report builder. See the long note in
 * cashupBreakdown.ts: this is the audit trail of an arithmetic, not rows
 * matching a filter, and no single report source can express it. Building it
 * as one would put the cash-up's arithmetic in a second place, free to drift
 * from the one that signs it off.
 *
 * ── THE SHAPE IS THE ARGUMENT ───────────────────────────────────────────────
 *
 * Sections in the order they add up, each with its own subtotal, and the
 * headline at the foot where the eye lands after reading down. A supervisor is
 * following a chain of reasoning — "float, plus sales, less that payout, comes
 * to this" — so the layout is that sentence and not a flat list somebody has to
 * re-add themselves.
 *
 * Money is `numeric` and right-aligned throughout; the entries are DATA and get
 * the tight 36px row, while the section headings around them get room. That is
 * the density split this app runs on, and a table of forty tenders is exactly
 * where it earns itself.
 */
export default function TenderBreakdownView({
  breakdown,
  onBack,
}: {
  breakdown: TenderBreakdown
  /** Returns to the count. The one way out — this view has no close of its own. */
  onBack: () => void
}) {
  const {
    tenderName,
    expected,
    declared,
    total,
    reconciles,
    sections,
    offLedgerTotal,
    drawerExpected,
    countsAsDrawerCash,
  } = breakdown

  const reconciling = sections.filter((s) => !s.informational)
  const informational = sections.filter((s) => s.informational)

  const difference = declared === null ? null : Math.round((declared - expected) * 100) / 100

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* ── The way back, and what you are looking at ──────────────────────
          Back sits FIRST and hard left, where a back control belongs — a
          supervisor who has drilled in needs the exit to be the first thing
          their eye finds, not something to hunt for past a wall of figures. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <Button variant="secondary" onClick={onBack}>
          <Icons.ChevronLeft size={16} />
          Back to the count
        </Button>
        <div className="text-right">
          <div className="text-xs text-muted">Expected on {tenderName}</div>
          <div className="numeric text-2xl font-semibold text-ink">{formatMoney(expected)}</div>
        </div>
      </div>

      {/* The one thing that must never be quiet. If the evidence does not add
          up to the headline, say so before anybody reads a single row of it —
          a breakdown silently missing money sends somebody hunting a theft
          that is really a source this product has not been taught about. */}
      {!reconciles && (
        <Callout tone="danger" title="This breakdown does not add up">
          The transactions below come to {formatMoney(total)}, but the cash-up expects{' '}
          {formatMoney(expected)} — a difference of {formatMoney(Math.abs(total - expected))}. Some
          money reached this tender by a route this screen cannot see. Treat the expected figure as
          the authority and report this.
        </Callout>
      )}

      {reconciling.length === 0 && informational.length === 0 ? (
        <EmptyState
          icon={<Icons.Receipt size={28} />}
          title={`Nothing was taken on ${tenderName}`}
          hint="No sale, payout or deposit on this shift touched this tender, so there is nothing to add up."
        />
      ) : (
        /* `till-pane`: the 12px thumb and contained overscroll the rest of this
           dialog uses, because it is read at arm's length and dragged with a
           finger. The app's 8px default is unhittable on a counter screen. */
        <div className="till-pane min-h-0 flex-1 overflow-y-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={`${TABLE_TH} w-24`}>Time</th>
                <th className={TABLE_TH}>What</th>
                <th className={TABLE_TH}>Who</th>
                <th className={`${TABLE_TH} w-36 text-right`}>Amount</th>
              </tr>
            </thead>

            {reconciling.map((s) => (
              <Section key={s.key} section={s} />
            ))}

            {/* ── The headline, at the foot of its own evidence ──────────── */}
            <tbody>
              <tr className={TABLE_TOTAL_ROW}>
                <td className={TABLE_TD} colSpan={3}>
                  Expected on {tenderName}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-base`}>
                  {formatMoney(total)}
                </td>
              </tr>
              {/* Only where somebody has actually counted. A difference against
                  nothing is not zero, it is a question nobody has answered. */}
              {declared !== null && difference !== null && (
                <>
                  <tr className={TABLE_ROW}>
                    <td className={TABLE_TD} colSpan={3}>
                      Declared
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(declared)}</td>
                  </tr>
                  <tr className={TABLE_ROW}>
                    <td className={TABLE_TD} colSpan={3}>
                      Difference
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {difference === 0 ? (
                        <Badge tone="success">0.00</Badge>
                      ) : (
                        <Badge tone={difference < 0 ? 'danger' : 'warning'}>
                          {difference < 0 ? '−' : '+'}
                          {formatMoney(Math.abs(difference))}
                        </Badge>
                      )}
                    </td>
                  </tr>
                </>
              )}
            </tbody>

            {/* ── Below the line ──────────────────────────────────────────
                Real money on this tender that the Expected column above does
                NOT include — see the off-ledger note in cashupBreakdown.ts.
                Shown because a supervisor hunting R500 needs to see the lay-by
                that explains it; kept out of the total because folding it in
                would make this disagree with the column it sits under. */}
            {informational.length > 0 && (
              <>
                <tbody>
                  <tr>
                    <td colSpan={4} className="px-4 pt-6 pb-1">
                      <div className="text-sm font-semibold text-ink">
                        Also taken on {tenderName}
                      </div>
                      <p className="mt-1 max-w-prose text-xs text-muted">
                        Money that went through
                        {countsAsDrawerCash ? ' the drawer' : ' this tender'} without a sale
                        posting. It is <span className="font-medium text-ink-2">not</span> part of
                        the expected figure above
                        {countsAsDrawerCash
                          ? ', but it is part of what the drawer should physically hold.'
                          : '.'}
                      </p>
                    </td>
                  </tr>
                </tbody>
                {informational.map((s) => (
                  <Section key={s.key} section={s} />
                ))}
                <tbody>
                  <tr className={TABLE_TOTAL_ROW}>
                    <td className={TABLE_TD} colSpan={3}>
                      Taken without a sale
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {formatMoney(offLedgerTotal)}
                    </td>
                  </tr>
                  {/* The figure that actually settles the argument on a drawer
                      tender: what the notes in the till should come to, deposits
                      and all. Panel 3 calls it "available to bank" less the
                      float; this is that same expectation, whole. */}
                  {countsAsDrawerCash && drawerExpected !== null && (
                    <tr className={TABLE_TOTAL_ROW}>
                      <td className={TABLE_TD} colSpan={3}>
                        What the drawer should hold
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-base`}>
                        {formatMoney(drawerExpected)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </>
            )}
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * One group of entries, under its own heading, with its own subtotal.
 *
 * Its own `<tbody>` per section: it is what lets a heading row and a subtotal
 * row bracket the entries without either being mistaken for one of them, and
 * the browser keeps the column widths shared across all of them — which is the
 * whole reason this is one table rather than a stack of small ones that would
 * each size their columns differently.
 */
function Section({ section }: { section: BreakdownSection }) {
  const { title, hint, entries, subtotal } = section

  return (
    <tbody>
      {/* Chrome: read once, so it gets room. The rows below are data and stay
          at the tight 36px. */}
      <tr>
        <td colSpan={4} className="px-4 pt-5 pb-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span className="text-sm font-semibold text-ink">
              {title}
              <span className="ml-2 text-xs font-normal text-muted">
                {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
              </span>
            </span>
            <span
              className={`numeric text-sm font-semibold ${
                subtotal < 0 ? 'text-danger' : 'text-ink'
              }`}
            >
              {formatMoney(subtotal)}
            </span>
          </div>
          <p className="mt-0.5 max-w-prose text-xs text-muted">{hint}</p>
        </td>
      </tr>

      {entries.map((e, i) => (
        /* No id on an entry: these are rows from five different tables and any
           key built from them would be unique only by accident. The list is
           server-ordered, never reordered or filtered in the browser, and never
           re-keyed — so the index is a stable identity here rather than the
           usual mistake. */
        <tr key={`${section.key}-${i}`} className={TABLE_ROW}>
          <td className={`${TABLE_TD} numeric whitespace-nowrap text-muted`}>{clock(e.at)}</td>
          <td className={TABLE_TD}>
            <span className="text-ink">{e.label}</span>
            {e.party && <span className="ml-2 text-xs text-muted">{e.party}</span>}
          </td>
          <td className={`${TABLE_TD} text-muted`}>{e.userName ?? '—'}</td>
          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
            {/* Money leaving is the exception in a column of money arriving, so
                it is the only thing here that takes a colour. */}
            <span className={e.amount < 0 ? 'text-danger' : undefined}>
              {formatMoney(e.amount)}
            </span>
          </td>
        </tr>
      ))}
    </tbody>
  )
}

/**
 * The time of day, from a stored DATETIME.
 *
 * getUTC*, NOT getHours: the pool runs at timezone 'Z', so the wall-clock
 * reading the till recorded sits in the Date's UTC fields. Reading it locally
 * shifts every row by the browser's offset — two hours, in this shop's case,
 * which would put the morning's takings in the small hours.
 */
function clock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
