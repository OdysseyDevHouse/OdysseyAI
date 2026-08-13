import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listAssets, listAssetTypes, assetsDueCount } from '@/lib/site/jobAssets'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  CardHeader,
  StatStrip,
  StatTile,
  TableToolbar,
  SearchBar,
  LinkSelect,
  EmptyState,
  Icons,
} from '@/components/ui'
import EquipmentTable from './EquipmentTable'

export const dynamic = 'force-dynamic'

type Search = {
  q?: string
  type?: string
  due?: string
  retired?: string
}

/**
 * Customer equipment.
 *
 * ── WHY THIS IS UNDER /jobs AND NOT UNDER /customers ───────────────────────
 *
 * An asset belongs to a customer, so the customer screen is where you look one up
 * when you have the customer in front of you. But the question this list answers
 * is "what is due a service" — a dispatcher's question, asked across every
 * customer at once, and the answer turns into jobs. So it lives beside the work
 * rather than beside the account, and the customer's own assets appear on their
 * record too.
 *
 * ── FILTERS IN THE URL ─────────────────────────────────────────────────────
 *
 * As with the job list: a filtered view is a link somebody can send, and the back
 * button does what it should.
 */
export default async function EquipmentPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('jobs.view')
  const params = await searchParams

  const search = params.q?.trim() ?? ''
  const typeId = params.type ? Number(params.type) : null
  const dueOnly = params.due === '1'
  const includeRetired = params.retired === '1'

  const [assets, types, dueCount] = await Promise.all([
    listAssets(siteId, {
      search: search || undefined,
      assetTypeId: typeId ?? undefined,
      dueOnly,
      includeRetired,
      limit: 300,
    }),
    listAssetTypes(siteId, false),
    assetsDueCount(siteId),
  ])

  const href = (next: Partial<Search>) => {
    const merged = { q: search, type: params.type, due: params.due, retired: params.retired, ...next }
    const query = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== '' && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&')
    return query ? `/jobs/equipment?${query}` : '/jobs/equipment'
  }

  return (
    <>
      <PageHeader
        title="Equipment"
        subtitle="What we look after for customers, and what is due a service."
        action={
          can(capabilities, 'jobs.edit') ? (
            <PrimaryLink href="/jobs/equipment/new">
              <Icons.Plus size={15} />
              Add equipment
            </PrimaryLink>
          ) : undefined
        }
      />
      <PageBody>
        {/* One tile, because there is one question. A strip of five figures about
            equipment counts would be four numbers nobody acts on. */}
        <StatStrip>
          <StatTile
            label="Due a service"
            value={String(dueCount)}
            tone={dueCount > 0 ? 'warning' : 'default'}
            href="/jobs/equipment?due=1"
          />
        </StatStrip>

        <Card>
          <CardHeader
            title={dueOnly ? 'Due a service' : includeRetired ? 'All equipment' : 'Equipment in use'}
            description={
              dueOnly
                ? 'The service date has arrived or passed. Raising a job against one of these is what clears it.'
                : 'Searching matches the description, make, model, serial and customer — and the serial past any spacing or capitals.'
            }
          />
          <TableToolbar
            actions={
              /* A plain GET form, exactly as the job list does: the search
                 survives a reload and the result is a link. */
              <SearchBar
                action="/jobs/equipment"
                defaultValue={search}
                placeholder="Description, serial, make or customer"
                keep={{ type: params.type, due: params.due, retired: params.retired }}
                className="p-0"
              />
            }
          >
            <LinkSelect
              value={params.type ?? ''}
              options={[
                { value: '', label: 'Every kind', href: href({ type: undefined }) },
                ...types.map((t) => ({
                  value: String(t.id),
                  label: t.name,
                  href: href({ type: String(t.id) }),
                })),
              ]}
              aria-label="Kind of equipment"
            />
            <LinkSelect
              value={dueOnly ? '1' : ''}
              options={[
                { value: '', label: 'Any service date', href: href({ due: undefined }) },
                { value: '1', label: 'Due a service', href: href({ due: '1' }) },
              ]}
              aria-label="Service due"
            />
            <LinkSelect
              value={includeRetired ? '1' : ''}
              options={[
                { value: '', label: 'In use', href: href({ retired: undefined }) },
                { value: '1', label: 'Including retired', href: href({ retired: '1' }) },
              ]}
              aria-label="Retired equipment"
            />
          </TableToolbar>

          {assets.length === 0 ? (
            <EmptyState
              icon={<Icons.Wrench size={22} />}
              title={
                search || typeId || dueOnly
                  ? 'Nothing matches'
                  : 'No equipment on file yet'
              }
              hint={
                search || typeId || dueOnly
                  ? 'Try a looser search, or clear the filters.'
                  : 'Record the units you service — an air conditioner, a pump, a compressor. A job can then name the thing it was about, and its history builds itself.'
              }
              action={
                can(capabilities, 'jobs.edit') && !search && !dueOnly ? (
                  <PrimaryLink href="/jobs/equipment/new">
                    <Icons.Plus size={15} />
                    Add equipment
                  </PrimaryLink>
                ) : undefined
              }
            />
          ) : (
            <EquipmentTable rows={assets} />
          )}
        </Card>
      </PageBody>
    </>
  )
}
