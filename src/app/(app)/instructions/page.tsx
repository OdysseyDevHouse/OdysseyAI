import Link from 'next/link'
import { Plus, StatusSuccess as CheckCircle2 } from '@/components/ui/icons'
import { requireSiteId } from '@/lib/auth'
import { listGroups } from '@/lib/site/instructions'
import {
  PageHeader,
  PrimaryLink,
  Card,
  EmptyState,
  Badge,
  TABLE_HEAD_ROW,
  TABLE_TH,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/** "Pick one", "Choose up to 3", "Choose 2 to 4" — the rule in plain words. */
function choiceRule(min: number, max: number): string {
  if (max === 1) return min > 0 ? 'Pick one' : 'Pick one (optional)'
  if (max === 0) return min > 0 ? `Choose at least ${min}` : 'Choose any number'
  if (min > 0 && min !== max) return `Choose ${min} to ${max}`
  if (min > 0 && min === max) return `Choose exactly ${min}`
  return `Choose up to ${max}`
}

export default async function InstructionsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; deleted?: string }>
}) {
  const siteId = await requireSiteId()
  const { saved, deleted } = await searchParams

  // Inactive groups are listed too: one switched off still applies to the
  // products it is attached to, so hiding it would be misleading.
  const groups = await listGroups(siteId, true)

  return (
    <>
      <PageHeader
        title="Instructions"
        subtitle="Questions the till asks when an item is sold — bread choice, egg style, extra toppings"
        action={
          <PrimaryLink href="/instructions/new">
            <Plus size={15} />
            New instruction
          </PrimaryLink>
        }
      />

      {(saved || deleted) && (
        <div className="px-6 pt-4">
          <p className="flex items-center gap-2 rounded-md bg-positive/10 px-3 py-2 text-sm text-positive">
            <CheckCircle2 size={15} />
            {saved ? 'Instruction saved.' : 'Instruction deleted.'}
          </p>
        </div>
      )}

      <div className="p-6">
        <Card>
          {groups.length === 0 ? (
            <EmptyState
              title="No instructions yet"
              hint="Create one — for example “Choice of bread” with white, brown and rye — then attach it to the products that should ask it."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Instruction</th>
                    <th className={TABLE_TH}>Rule</th>
                    <th className={`${TABLE_TH} text-right`}>Options</th>
                    <th className={`${TABLE_TH} text-right`}>Products</th>
                    <th className={TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groups.map((g) => (
                    <tr key={g.id} className="hover:bg-surface-2">
                      <td className="px-4 py-2.5">
                        <Link href={`/instructions/${g.id}`} className="text-brand hover:underline">
                          {g.name}
                        </Link>
                        {g.prompt && (
                          <span className="ml-2 text-xs text-muted">{g.prompt}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted">
                        {choiceRule(g.minChoices, g.maxChoices)}
                        {g.isRequired && (
                          <Badge className="ml-2" tone="warning">
                            required
                          </Badge>
                        )}
                      </td>
                      <td className="numeric px-4 py-2.5 text-right text-muted">
                        {g.optionCount}
                      </td>
                      <td className="numeric px-4 py-2.5 text-right text-muted">
                        {g.productCount}
                      </td>
                      <td className="px-4 py-2.5">
                        {g.isActive ? <Badge tone="positive">Active</Badge> : <Badge>Inactive</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
