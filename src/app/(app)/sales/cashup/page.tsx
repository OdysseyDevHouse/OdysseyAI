import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listTerminals } from '@/lib/site/terminals'
import {
  listShifts,
  shiftPosition,
  listDrawerMovements,
  shiftCounts,
  cashupMode,
} from '@/lib/site/shifts'
import { getNumericSetting } from '@/lib/site/settings'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  StatStrip,
  StatTile,
  Badge,
  ButtonLink,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import CashupClient from './CashupClient'
import ViewDeclarationButton from './ViewDeclarationButton'

export const dynamic = 'force-dynamic'

export default async function CashupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('sales.cashup')

  const [terminals, recent, tolerance, mode] = await Promise.all([
    listTerminals(siteId, false),
    listShifts(siteId, { limit: 20 }),
    getNumericSetting(siteId, 'cashup_variance_tolerance'),
    cashupMode(siteId),
  ])

  // The open shifts, with their live drawer position.
  const open = recent.filter((s) => s.isOpen)
  const positions = await Promise.all(open.map((s) => shiftPosition(siteId, s.id)))
  const movements = await Promise.all(open.map((s) => listDrawerMovements(siteId, s.id)))

  const closed = recent.filter((s) => !s.isOpen)
  // Per-tender counts for EVERY closed shift the table renders — computing
  // them for a shorter slice left the later rows with an empty breakdown.
  const closedCounts = await Promise.all(closed.map((s) => shiftCounts(siteId, s.id)))

  // Whether the history below still has tills worth a column. Asked of the rows
  // rather than the setting, so switching a site to user mode does not blank
  // the till out of every cash-up it did before the switch.
  const showTill = closed.some((s) => s.terminalCode !== null)

  const expectedNow = positions.reduce((sum, p) => sum + (p?.expectedCash ?? 0), 0)
  const today = new Date().toISOString().slice(0, 10)
  const closedToday = closed.filter(
    (s) => s.closedAt && s.closedAt.toISOString().slice(0, 10) === today,
  )
  const varianceToday = closedToday.reduce((sum, s) => sum + s.variance, 0)

  return (
    <>
      <PageHeader
        title="Cash-up"
        subtitle={
          mode === 'user'
            ? 'What each person took, against what they handed over.'
            : 'What the drawer should hold, against what was counted.'
        }
        /* The tolerance behind every "an explanation is required" on this
           screen. Somebody asking why a R3 difference was waved through is
           standing HERE, not in the setup hub. */
        action={
          can(capabilities, 'setup.edit') ? (
            <ButtonLink href="/settings?tab=cashup" variant="secondary">
              <Icons.Settings size={15} />
              Cash-up settings
            </ButtonLink>
          ) : undefined
        }
      />
      <PageBody>
        {(open.length > 0 || closed.length > 0) && (
          <StatStrip columns={3}>
            <StatTile
              label={mode === 'user' ? 'Held by staff' : 'Expected in drawers'}
              value={formatMoney(expectedNow)}
              hint={`Across ${open.length} open shift${open.length === 1 ? '' : 's'}`}
              icon={<Icons.Banknote size={16} />}
            />
            <StatTile
              label="Open shifts"
              value={String(open.length)}
              hint={mode === 'user' ? 'One person and their float' : 'One person on one till'}
              icon={mode === 'user' ? <Icons.Users size={16} /> : <Icons.Terminal size={16} />}
            />
            <StatTile
              label="Variance today"
              value={formatMoney(varianceToday)}
              tone={Math.abs(varianceToday) > tolerance ? 'danger' : 'default'}
              hint={
                closedToday.length === 0
                  ? 'No cash-ups yet today'
                  : `${closedToday.length} cash-up${closedToday.length === 1 ? '' : 's'} today`
              }
              icon={<Icons.Scale size={16} />}
            />
          </StatStrip>
        )}

        <CashupClient
          mode={mode}
          terminals={terminals.map((t) => ({ id: t.id, code: t.code, name: t.name }))}
          shifts={open.flatMap((shift, index) => {
            const position = positions[index]
            return position
              ? [
                  {
                    id: shift.id,
                    documentNumber: shift.documentNumber,
                    terminalCode: shift.terminalCode,
                    userName: shift.userName,
                    openedAt: shift.openedAt.toISOString(),
                    openingFloat: position.openingFloat,
                    movementsTotal: position.movementsTotal,
                    expectedCash: position.expectedCash,
                    takingsTotal: position.takingsTotal,
                    salesCount: position.salesCount,
                    tenders: position.tenders,
                    movements: movements[index].map((m) => ({
                      id: m.id,
                      type: m.type,
                      amount: m.amount,
                      reason: m.reason,
                    })),
                  },
                ]
              : []
          })}
          tolerance={tolerance}
        />

        {closed.length > 0 && (
          <Card>
            <CardHeader
              title="Recent cash-ups"
              description="Variance is counted minus expected. Negative is short."
            />
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    {/* Driven by the ROWS, not the site's current mode. A shift
                        records the mode it was opened under, so a site that
                        switches still has terminal-mode history to show — and
                        hiding the column would silently drop the one thing
                        identifying those cash-ups. Gone only when nothing
                        listed has a till, where it would be a row of dashes. */}
                    {/* The number leads, as a document number does everywhere
                        else in the app. It is what somebody phoning about a
                        short drawer will read out. */}
                    <th className={TABLE_TH}>Cash-up</th>
                    {showTill && <th className={TABLE_TH}>Till</th>}
                    <th className={TABLE_TH}>{mode === 'user' ? 'Person' : 'Cashier'}</th>
                    <th className={TABLE_TH}>Closed</th>
                    <th className={`${TABLE_TH} text-right`}>Expected</th>
                    <th className={`${TABLE_TH} text-right`}>Counted</th>
                    <th className={`${TABLE_TH} text-right`}>Variance</th>
                    <th className={TABLE_TH}></th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((shift, index) => {
                    const counts = closedCounts[index] ?? []
                    const short = shift.variance < 0
                    const outside = Math.abs(shift.variance) > tolerance
                    const byTender = counts
                      .filter((c) => c.variance !== 0)
                      .map(
                        (c) =>
                          `${c.tenderName} ${c.variance < 0 ? '−' : '+'}${formatMoney(Math.abs(c.variance))}`,
                      )
                    return (
                      <tr key={shift.id} className={TABLE_ROW}>
                        {/* Falls back to the id for a shift opened before this
                            site had a sequence — the label it carried before
                            cash-ups were numbered, rather than a blank cell
                            that reads as data loss. */}
                        <td className={TABLE_TD}>
                          <span className="text-ink">
                            {shift.documentNumber ?? `Cash-up #${shift.id}`}
                          </span>
                        </td>
                        {showTill && <td className={TABLE_TD}>{shift.terminalCode ?? '—'}</td>}
                        <td className={TABLE_TD}>
                          <div className="text-ink">{shift.userName}</div>
                          {shift.varianceNote && (
                            <div className="text-xs text-muted">{shift.varianceNote}</div>
                          )}
                        </td>
                        <td className={TABLE_TD}>
                          {shift.closedAt?.toLocaleString('en-ZA') ?? '—'}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(shift.expectedTotal)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(shift.countedTotal)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {/* State gets a form: only the exceptions wear a
                              badge, so they pop without reading a digit. A
                              variance inside tolerance — zero included — is a
                              plain figure. */}
                          {outside ? (
                            <Badge tone={short ? 'danger' : 'warning'}>
                              {short ? 'Short' : 'Over'} {formatMoney(Math.abs(shift.variance))}
                            </Badge>
                          ) : (
                            <span className="text-ink-2">{formatMoney(shift.variance)}</span>
                          )}
                          {byTender.length > 0 && (
                            <div className="text-xs whitespace-nowrap text-muted">
                              {byTender.join(' · ')}
                            </div>
                          )}
                        </td>
                        {/* Read the signed declaration back, exactly as it was
                            committed — in the same dialog that counted it.
                            Hard right, as row actions always are. */}
                        <td className={`${TABLE_TD} text-right`}>
                          <ViewDeclarationButton shiftId={shift.id} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
