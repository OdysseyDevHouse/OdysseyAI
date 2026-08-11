import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { PageBody, PageHeader } from '@/components/ui'
import { specFor } from '@/lib/import/registry'
import type { Capability } from '@/lib/site/permissions'
import ImportClient from './ImportClient'

export const dynamic = 'force-dynamic'

/** Where each import's records live, for the link at the finish line. */
const LIST_HREF: Record<string, string> = {
  products: '/products',
  departments: '/departments',
  customers: '/customers',
  suppliers: '/suppliers',
}

export default async function ImportEntityPage({
  params,
}: {
  params: Promise<{ entity: string }>
}) {
  const { entity } = await params
  const spec = specFor(entity)
  if (!spec) notFound()

  // A hidden menu entry is not a boundary — this URL is typeable. Importing
  // products IS editing products, so the guard is the target's own capability
  // rather than a separate one that could drift away from it.
  await requireCapability(spec.capability as Capability)

  return (
    <>
      <PageHeader
        title={`Import ${spec.title.toLowerCase()}`}
        subtitle={spec.description}
        backHref="/setup/import"
        backLabel="Import"
      />
      <PageBody>
        <ImportClient
          entity={spec.entity}
          title={spec.title}
          singular={spec.singular}
          listHref={LIST_HREF[spec.entity] ?? '/setup/import'}
        />
      </PageBody>
    </>
  )
}
