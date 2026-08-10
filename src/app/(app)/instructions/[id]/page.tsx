import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getGroup, listGroups, listOptions } from '@/lib/site/instructions'
import { storefrontImagesByIds } from '@/lib/site/storefrontImages'
import { listProducts } from '@/lib/site/products'
import { Callout, PageBody, PageHeader } from '@/components/ui'
import InstructionForm from '../InstructionForm'
import DeleteInstructionButton from '../DeleteInstructionButton'

export const dynamic = 'force-dynamic'

export default async function EditInstructionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('products.edit')
  const { id } = await params
  const { error } = await searchParams

  const groupId = Number(id)
  if (!Number.isFinite(groupId) || groupId <= 0) notFound()

  const group = await getGroup(siteId, groupId)
  if (!group) notFound()

  // Inactive options are shown: they are still attached, and hiding them would
  // make an option look deleted when it is only switched off.
  const options = await listOptions(siteId, groupId, true)
  const { items } = await listProducts(siteId, { limit: 500 })

  // Every other instruction, for the "then ask" picker. Inactive ones are left
  // out: revealing a question the till will not ask is a dead end.
  const groups = await listGroups(siteId)

  // Only the group's own thumbnail is resolved here. An option's picture is
  // fetched by its picker when the row is opened — pre-loading one per row
  // would be a query for pictures nobody has scrolled to.
  const images = await storefrontImagesByIds(siteId, group.imageId ? [group.imageId] : [])

  return (
    <>
      <PageHeader
        title={group.name}
        subtitle={`${group.optionCount} option${group.optionCount === 1 ? '' : 's'} · used by ${group.productCount} product${group.productCount === 1 ? '' : 's'}`}
        backHref="/instructions"
      />

      <PageBody>
        {error && <Callout tone="danger">{error}</Callout>}

        <InstructionForm
          group={group}
          options={options}
          products={items.map((p) => ({ id: p.id, code: p.code, description: p.description }))}
          groups={groups.map((g) => ({ id: g.id, name: g.name }))}
          groupImage={(group.imageId && images.get(group.imageId)) || null}
          rowActions={
            <DeleteInstructionButton
              id={group.id}
              name={group.name}
              productCount={group.productCount}
            />
          }
        />
      </PageBody>
    </>
  )
}
