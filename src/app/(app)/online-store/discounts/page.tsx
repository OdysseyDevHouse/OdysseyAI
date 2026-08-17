import { requireModuleCapability } from '@/lib/auth'
import { listCodes, codeStats } from '@/lib/site/discountCodes'
import { listDepartments } from '@/lib/site/departments'
import { PageBody, PageHeader } from '@/components/ui'
import DiscountsTable from './DiscountsTable'

/**
 * Discount codes.
 *
 * A server page that fetches and a client component that renders — DataTable
 * column definitions carry cell renderers, which cannot cross the server/client
 * boundary. Defining them here would build cleanly and then fail at request
 * time.
 */

export const dynamic = 'force-dynamic'

export default async function DiscountsPage() {
  const { siteId } = await requireModuleCapability('online_store', 'online.edit')

  const [codes, departments] = await Promise.all([
    listCodes(siteId).catch(() => []),
    listDepartments(siteId).catch(() => []),
  ])

  // Redemptions per code, so the list can say what each campaign actually did
  // rather than only what it was set up to do. One query per code is fine at
  // the scale a shop runs campaigns; a join would be premature.
  const stats = await Promise.all(
    codes.map(async (code) => ({ id: code.id, ...(await codeStats(siteId, code.id)) })),
  ).catch(() => [])

  const statsById = new Map(stats.map((s) => [s.id, s]))

  return (
    <>
      <PageHeader
        title="Discount codes"
        subtitle="Words a shopper types at checkout to pay less."
      />
      <PageBody>
        <DiscountsTable
          codes={codes.map((code) => ({
            ...code,
            startsAt: code.startsAt ? code.startsAt.toISOString() : null,
            endsAt: code.endsAt ? code.endsAt.toISOString() : null,
            uses: statsById.get(code.id)?.uses ?? 0,
            givenAwayIncl: statsById.get(code.id)?.totalIncl ?? 0,
          }))}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
        />
      </PageBody>
    </>
  )
}
