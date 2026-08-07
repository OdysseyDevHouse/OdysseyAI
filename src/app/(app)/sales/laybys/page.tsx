import { requireCapability } from '@/lib/auth'
import { listLaybys, LAYBY_STATUS_LABELS } from '@/lib/site/laybys'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  ButtonLink,
  Card,
  SearchBar,
  StatTile,
  StatStrip,
  LinkSegmentedControl,
  Pagination,
  Icons,
} from '@/components/ui'
import ExpireButton from './ExpireButton'
import LaybysTable, { type LaybyTableRow } from './LaybysTable'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export default async function LaybysPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.view')
  const params = await searchParams

  const status = (['open', 'completed', 'cancelled', 'expired'] as const).find(
    (s) => s === params.status,
  )
  const page = pageFrom(params.page)

  const { items, total } = await listLaybys(siteId, {
    status,
    q: params.q,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  const { items: open } = await listLaybys(siteId, { status: 'open', limit: 500 })
  const today = new Date().toISOString().slice(0, 10)
  const overdue = open.filter((l) => l.dueDate && l.dueDate < today)
  const held = open.reduce((sum, l) => sum + l.paidTotal, 0)
  const committed = open.reduce((sum, l) => sum + l.outstanding, 0)

  const href = hrefBuilder('/sales/laybys', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  // DataTable's cells are functions, which cannot cross the server→client
  // boundary — so the table lives in LaybysTable and gets plain rows.
  const rows: LaybyTableRow[] = items.map((layby) => ({
    id: layby.id,
    laybyNumber: layby.laybyNumber,
    customerName: layby.customerName,
    dueDate: layby.dueDate,
    status: layby.status,
    statusLabel: LAYBY_STATUS_LABELS[layby.status],
    totalIncl: layby.totalIncl,
    paidTotal: layby.paidTotal,
    outstanding: layby.outstanding,
  }))

  return (
    <>
      <PageHeader
        title="Lay-bys"
        subtitle={`${total} lay-by${total === 1 ? '' : 's'}`}
        action={
          <>
            <ExpireButton />
            <PrimaryLink href="/sales/new">
              <Icons.Plus size={15} />
              New lay-by at the till
            </PrimaryLink>
          </>
        }
      />

      <PageBody>
        <StatStrip columns={4}>
          <StatTile
            label="Open"
            value={String(open.length)}
            hint="Being paid off"
            icon={<Icons.Package size={16} />}
            href={filterHref({ status: 'open' })}
          />
          {/* The figure a manager needs to understand and most systems hide:
              this is money in the bank that is not the shop's. */}
          <StatTile
            label="Customers' money held"
            value={formatMoney(held)}
            hint="Refundable — not yet earned"
            tone={held > 0 ? 'warning' : 'default'}
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Still to collect"
            value={formatMoney(committed)}
            hint="Before the goods go out"
            icon={<Icons.HandCoins size={16} />}
          />
          <StatTile
            label="Past due"
            value={String(overdue.length)}
            hint={overdue.length > 0 ? 'Chase these' : 'Nothing overdue'}
            tone={overdue.length > 0 ? 'danger' : 'default'}
            icon={<Icons.Clock size={16} />}
          />
        </StatStrip>

        {/* SearchBar carries its own page gutter, so back PageBody's out. */}
        <div className="-mx-6 -my-3">
          <SearchBar
            action="/sales/laybys"
            defaultValue={params.q}
            placeholder="Search by lay-by number or customer…"
            keep={{ status: params.status }}
          />
        </div>

        <div>
          <LinkSegmentedControl
            aria-label="Filter by status"
            value={status ?? 'all'}
            options={[
              { value: 'all', label: 'All', href: filterHref({ status: null }) },
              ...(['open', 'completed', 'cancelled', 'expired'] as const).map((value) => ({
                value,
                label: LAYBY_STATUS_LABELS[value],
                href: filterHref({ status: value }),
              })),
            ]}
          />
        </div>

        <Card>
          <LaybysTable
            rows={rows}
            today={today}
            empty={
              params.q
                ? {
                    icon: <Icons.Search size={22} />,
                    title: `Nothing matches “${params.q}”`,
                    hint: 'Try a different lay-by number or customer.',
                    action: (
                      <ButtonLink href="/sales/laybys" variant="secondary">
                        Clear the search
                      </ButtonLink>
                    ),
                  }
                : status
                  ? {
                      icon: <Icons.Package size={22} />,
                      title: `No ${LAYBY_STATUS_LABELS[status].toLowerCase()} lay-bys`,
                      hint: 'Nothing is in this slice right now.',
                      action: (
                        <ButtonLink href="/sales/laybys" variant="secondary">
                          Show all lay-bys
                        </ButtonLink>
                      ),
                    }
                  : {
                      icon: <Icons.Package size={22} />,
                      title: 'No lay-bys',
                      hint: 'Start one from the till: ring up the goods, attach a customer, then Save as lay-by.',
                      action: (
                        <PrimaryLink href="/sales/new">
                          <Icons.Plus size={15} />
                          New lay-by at the till
                        </PrimaryLink>
                      ),
                    }
            }
          />

          <Pagination
            page={page}
            pageCount={pageCountFor(total, PAGE_SIZE)}
            total={total}
            pageSize={PAGE_SIZE}
            hrefFor={(next) => href({ page: next === 1 ? null : next })}
          />
        </Card>
      </PageBody>
    </>
  )
}
