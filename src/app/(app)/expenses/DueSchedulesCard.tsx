import { Card, CardHeader, CardBody } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { GenerateButton } from './GenerateButton'

/**
 * The "recurring expenses are due" card, shared by the expenses list and the
 * recurring screen so the two cannot drift apart. It leads on both because
 * nothing else will produce these drafts — they are simply missing until
 * generated.
 *
 * Server-renderable on purpose: the expenses list is a Server Component, and
 * only the button inside needs to be a client island.
 */
export type DueSchedule = {
  id: number
  name: string
  frequencyLabel: string
  nextDue: string | null
  totalIncl: number
}

export function DueSchedulesCard({ schedules }: { schedules: DueSchedule[] }) {
  if (schedules.length === 0) return null

  return (
    <Card>
      <CardHeader
        title={`${schedules.length} recurring expense${schedules.length === 1 ? '' : 's'} due`}
        description="These have not been raised yet. Generating creates drafts to review — nothing is posted."
        action={<GenerateButton />}
      />
      <CardBody>
        <ul className="divide-y divide-border">
          {schedules.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <span className="text-ink">{s.name}</span>
                <span className="ml-2 text-xs text-muted">
                  {s.frequencyLabel.toLowerCase()}
                  {s.nextDue ? ` · due ${s.nextDue}` : ''}
                </span>
              </div>
              <span className="numeric text-ink-2">{formatMoney(s.totalIncl)}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}
