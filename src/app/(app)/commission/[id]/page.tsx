import { notFound, redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getRun, runSummary, statement } from '@/lib/site/commissionRuns'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  Badge,
  Icons,
  EmptyState,
  StatStrip,
  StatTile,
  TextLink,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { LinesTable } from './LinesTable'

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

  // The period at a glance, from the rows already fetched. Clawback is the
  // figure that changes what payroll does, so it alone gets a tone.
  const totalDue = rows.reduce((sum, r) => sum + r.amount, 0)
  const totalEarned = rows.reduce((sum, r) => sum + r.earned, 0)
  const totalClawback = rows.reduce((sum, r) => sum + r.clawback, 0)

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
              icon={<Icons.Calculator size={28} strokeWidth={1.75} />}
              action={<ButtonLink href="/commission">Back to periods</ButtonLink>}
            />
          </Card>
        ) : (
          <>
            <StatStrip>
              <StatTile
                label="Due"
                value={formatMoney(totalDue)}
                hint="What payroll pays out"
                icon={<Icons.HandCoins size={16} />}
              />
              <StatTile
                label="Earned"
                value={formatMoney(totalEarned)}
                icon={<Icons.Coins size={16} />}
              />
              <StatTile
                label="Clawback"
                value={formatMoney(totalClawback)}
                tone={totalClawback !== 0 ? 'danger' : 'default'}
                hint={totalClawback !== 0 ? 'Credited sales reversed here' : undefined}
                icon={<Icons.Reverse size={16} />}
              />
              <StatTile
                label="People"
                value={String(rows.length)}
                icon={<Icons.Users size={16} />}
              />
            </StatStrip>

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
                        /* Brand, not surface-2: the selection has to survive the
                           row-hover fill, which is surface-2 already. */
                        className={`${TABLE_ROW} ${r.userId === showFor ? 'bg-brand-soft' : ''}`}
                      >
                        <td className={TABLE_TD}>
                          {seesEveryone ? (
                            <TextLink href={`/commission/${runId}?user=${r.userId}`}>
                              {r.userName}
                            </TextLink>
                          ) : (
                            <span className="font-medium text-ink">{r.userName}</span>
                          )}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{r.entries}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(r.earned)}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {r.clawback !== 0 ? (
                            <Badge tone="danger">{formatMoney(r.clawback)}</Badge>
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
                <LinesTable lines={lines} />
              </Card>
            )}

            <Callout tone="brand" title="A clawback lands in the open period.">
              Crediting a sale from a locked period does not reopen it — the reversal appears
              in whichever period is open when the credit is raised, so a figure somebody has
              already been paid stays paid. Deducting a negative from a wage needs the
              employee’s written consent under the BCEA, so settle it against future
              commission rather than payroll.
            </Callout>
          </>
        )}
      </PageBody>
    </>
  )
}
