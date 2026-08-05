import { requireSiteId } from '@/lib/auth'
import { listTerminals } from '@/lib/site/terminals'
import { listShifts, shiftPosition, listDrawerMovements, shiftCounts } from '@/lib/site/shifts'
import { getNumericSetting } from '@/lib/site/settings'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import CashupClient from './CashupClient'

export const dynamic = 'force-dynamic'

export default async function CashupPage() {
  const siteId = await requireSiteId()

  const [terminals, recent, tolerance] = await Promise.all([
    listTerminals(siteId, false),
    listShifts(siteId, { limit: 20 }),
    getNumericSetting(siteId, 'cashup_variance_tolerance'),
  ])

  // The open shifts, with their live drawer position.
  const open = recent.filter((s) => s.isOpen)
  const positions = await Promise.all(open.map((s) => shiftPosition(siteId, s.id)))
  const movements = await Promise.all(open.map((s) => listDrawerMovements(siteId, s.id)))

  const closed = recent.filter((s) => !s.isOpen)
  const closedCounts = await Promise.all(closed.slice(0, 5).map((s) => shiftCounts(siteId, s.id)))

  return (
    <>
      <PageHeader
        title="Cash-up"
        subtitle="What the drawer should hold, against what was counted."
      />
      <PageBody>
        <CashupClient
          terminals={terminals.map((t) => ({ id: t.id, code: t.code, name: t.name }))}
          shifts={open.flatMap((shift, index) => {
            const position = positions[index]
            return position
              ? [
                  {
                    id: shift.id,
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
                    <th className={TABLE_TH}>Till</th>
                    <th className={TABLE_TH}>Cashier</th>
                    <th className={TABLE_TH}>Closed</th>
                    <th className={`${TABLE_TH} text-right`}>Expected</th>
                    <th className={`${TABLE_TH} text-right`}>Counted</th>
                    <th className={`${TABLE_TH} text-right`}>Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.map((shift, index) => {
                    const counts = closedCounts[index] ?? []
                    const short = shift.variance < 0
                    const outside = Math.abs(shift.variance) > tolerance
                    return (
                      <tr key={shift.id} className={TABLE_ROW}>
                        <td className={TABLE_TD}>{shift.terminalCode}</td>
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
                          {shift.variance === 0 ? (
                            <Badge tone="success">Exact</Badge>
                          ) : (
                            <span
                              title={counts
                                .filter((c) => c.variance !== 0)
                                .map((c) => `${c.tenderName} ${c.variance.toFixed(2)}`)
                                .join(', ')}
                              className={outside ? (short ? 'text-danger' : 'text-warning') : 'text-ink-2'}
                            >
                              {formatMoney(shift.variance)}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {open.length === 0 && closed.length === 0 && (
          <Card>
            <div className="flex items-center gap-3 px-6 py-6">
              <Icons.Coins size={20} className="text-faint" />
              <p className="text-sm text-muted">
                No shifts yet. Open one on a till to start counting its drawer.
              </p>
            </div>
          </Card>
        )}
      </PageBody>
    </>
  )
}
