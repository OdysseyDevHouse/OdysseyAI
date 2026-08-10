import { requireCapability } from '@/lib/auth'
import { listGroups } from '@/lib/site/instructions'
import { listProducts } from '@/lib/site/products'
import { PageBody, PageHeader } from '@/components/ui'
import InstructionForm from '../InstructionForm'

export const dynamic = 'force-dynamic'

export default async function NewInstructionPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('products.edit')

  // For the optional stock link on an option. Archived products are excluded —
  // linking an option to one would deduct stock nobody sells any more.
  const { items } = await listProducts(siteId, { limit: 500 })

  // For the "then ask" picker. A question being created cannot yet be revealed
  // by anything, so every active group is fair game.
  const groups = await listGroups(siteId)

  return (
    <>
      <PageHeader
        title="New instruction"
        subtitle="A question the till asks when an item is sold"
        backHref="/instructions"
      />
      <PageBody>
        <InstructionForm
          group={null}
          options={[]}
          products={items.map((p) => ({ id: p.id, code: p.code, description: p.description }))}
          groups={groups.map((g) => ({ id: g.id, name: g.name }))}
          groupImage={null}
        />
      </PageBody>
    </>
  )
}
