import { Plus } from '@/components/ui/icons'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listGroups } from '@/lib/site/instructions'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  Callout,
} from '@/components/ui'
import { InstructionsTable } from './InstructionsTable'

export const dynamic = 'force-dynamic'

export default async function InstructionsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; deleted?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('products.view')
  // Viewing and reordering are different rights: the drag handles are offered
  // only to someone whose save would actually be accepted.
  const canEdit = can(capabilities, 'products.edit')
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

      <PageBody>
        {(saved || deleted) && (
          <Callout tone="success" title={saved ? 'Instruction saved.' : 'Instruction deleted.'} />
        )}

        <Card>
          <InstructionsTable rows={groups} canEdit={canEdit} />
        </Card>
      </PageBody>
    </>
  )
}
