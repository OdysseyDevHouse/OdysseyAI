import { notFound } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import { getGroup, listOptions } from '@/lib/site/instructions'
import { listProducts } from '@/lib/site/products'
import { Button, PageHeader } from '@/components/ui'
import InstructionForm from '../InstructionForm'
import { deleteInstructionAction } from '../actions'
import { Trash, StatusError } from '@/components/ui/icons'

export const dynamic = 'force-dynamic'

export default async function EditInstructionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ saved?: string; error?: string }>
}) {
  const siteId = await requireSiteId()
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

  return (
    <>
      <PageHeader
        title={group.name}
        subtitle={`${group.optionCount} option${group.optionCount === 1 ? '' : 's'} · used by ${group.productCount} product${group.productCount === 1 ? '' : 's'}`}
      />

      <div className="p-6">
        {error && (
          <p
            role="alert"
            className="mb-4 flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <StatusError size={15} />
            {error}
          </p>
        )}

        <InstructionForm
          group={group}
          options={options}
          products={items.map((p) => ({ id: p.id, code: p.code, description: p.description }))}
          rowActions={
            <form action={deleteInstructionAction}>
              <input type="hidden" name="id" value={group.id} />
              <Button type="submit" variant="danger">
                <Trash size={15} />
                Delete instruction
              </Button>
            </form>
          }
        />
      </div>
    </>
  )
}
