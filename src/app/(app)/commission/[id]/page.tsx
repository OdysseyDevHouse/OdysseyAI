import { notFound, redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getRun, runSummary, statement } from '@/lib/site/commissionRuns'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  Badge,
  Icons,
  EmptyState,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * One period's commission.
 *
 * Shows the per-person totals and, for whoever is selected, the lines behind
 * them. The lines matter: the first question anyone asks about a commission
 * figure is "on what?", and a total with nothing behind it cannot answer.
 */
export default async function CommissionRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ user?: string }>
}) {
  const { site, user, capabilities } = await requireSiteUser()
  const { id } = await params
  const { user: selected } = await searchParams

  const runId = Number(id)
  if (!Number.isFinite(runId) || runId <= 0) notFound()

  const seesEveryone = can(capabilities, 'commission.view_all') || can(capabilities, 'commission.run')
  if (!seesEveryone && !can(capabilities, 'commission.view_own')) redirect('/not-allowed')

  const run = await getRun(site.id, runId)
  if (!run) notFound()

  const summary = await runSummary(site.id, runId)
  // Someone who may only see their own figures is pinned to themselves,
  // whatever the query string says.
  const rows = seesEveryone ? summary : summary.filter((r) => r.userId === user.id)

  const showFor = seesEveryone
    ? selected
      ? Number(selected)
      : (rows[0]?.userId ?? null)
    : user.id
  const lines = showFor ? await statement(site.id, runId, showFor) : []
  const person = rows.find((r) => r.userId === showFor)

  return (
    <>
      <PageHeader
        title={`${run.periodStart} to ${run.periodEnd}`}
        subtitle={run.note ?? 'Commission'}
        backHref="/commission"
        backLabel="Commission"
        action={
          run.status === 'locked' ? (
            <Badge tone="success">Locked{run.lockedByName ? ` by ${run.lockedByName}` : ''}</Badge>
          ) : run.calculatedAt ? (
            <Badge tone="warning">Calculated — not locked</Badge>
          ) : (
            <Badge tone="default">Not calculated</Badge>
          )
        }
      />

      <PageBody>
        {!run.calculatedAt ? (
          <Card>
            <EmptyState
              title="Nothing calculated yet"
              hint="Go back and press Calculate to work out what everyone earned in this period."
            />
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader
                title="Who earned what"
                description={
                  run.status === 'locked'
                    ? 'Frozen. These figures will not change again.'
                    : 'Still open — recalculating will replace these figures.'
                }
              />
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Person</th>
                      <th className={`${TABLE_TH} text-right`}>Lines</th>
                      <th className={`${TABLE_TH} text-right`}>Earned</th>
                      <th className={`${TABLE_TH} text-right`}>Clawback</th>
                      <th className={`${TABLE_TH} text-right`}>Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.userId}
                        className={`${TABLE_ROW} ${r.userId === showFor ? 'bg-surface-2' : ''}`}
                      >
                        <td className={TABLE_TD}>
                          {seesEveryone ? (
                            <a
                              href={`/commission/${runId}?user=${r.userId}`}
                              className="font-medium text-brand hover:underline"
                            >
                              {r.userName}
                            </a>
                          ) : (
                            <span className="font-medium text-ink">{r.userName}</span>
                          )}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{r.entries}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(r.earned)}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {r.clawback < 0 ? (
                            <span className="text-danger">{formatMoney(r.clawback)}</span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium text-ink`}>
                          {formatMoney(r.amount)}
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr className={TABLE_ROW}>
                        <td className={TABLE_TD} colSpan={5}>
                          <span className="text-muted">
                            Nobody earned commission in this period.
                          </span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            {person && (
              <Card>
                <CardHeader
                  title={`${person.userName} — every line`}
                  description="The rule, basis and rate are the ones that were used, not today's."
                />
                <div className="overflow-x-auto">
                  <table className={TABLE}>
                    <thead>
                      <tr className={TABLE_HEAD_ROW}>
                        <th className={TABLE_TH}>Date</th>
                        <th className={TABLE_TH}>Document</th>
                        <th className={TABLE_TH}>Item</th>
                        <th className={TABLE_TH}>Rule</th>
                        <th className={`${TABLE_TH} text-right`}>Base</th>
                        <th className={`${TABLE_TH} text-right`}>Rate</th>
                        <th className={`${TABLE_TH} text-right`}>Commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.id} className={TABLE_ROW}>
                          <td className={TABLE_TD}>
                            <span className="text-muted">{l.documentDate}</span>
                          </td>
                          <td className={TABLE_TD}>
                            <div className="text-ink-2">{l.documentNumber}</div>
                            {l.docType === 'credit_sale' && (
                              <Badge tone="danger">Credit</Badge>
                            )}
                          </td>
                          <td className={TABLE_TD}>
                            <div className="text-ink-2">{l.description}</div>
                            {l.productCode && (
                              <div className="text-xs text-muted">{l.productCode}</div>
                            )}
                          </td>
                          <td className={TABLE_TD}>
                            <div className="text-ink-2">{l.ruleName}</div>
                            <div className="text-xs text-muted">
                              {l.basis === 'gross_profit' ? 'profit' : 'turnover'}
                            </div>
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                            {formatMoney(l.baseAmount)}
                          </td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{l.ratePct}%</td>
                          <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-medium text-ink`}>
                            {formatMoney(l.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            <Card>
              <div className="flex items-start gap-3 px-6 py-4">
                <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
                <div className="text-sm">
                  <p className="font-medium text-ink">A clawback lands in the open period.</p>
                  <p className="text-muted">
                    Crediting a sale from a locked period does not reopen it — the reversal appears
                    in whichever period is open when the credit is raised, so a figure somebody has
                    already been paid stays paid. Deducting a negative from a wage needs the
                    employee’s written consent under the BCEA, so settle it against future
                    commission rather than payroll.
                  </p>
                </div>
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
