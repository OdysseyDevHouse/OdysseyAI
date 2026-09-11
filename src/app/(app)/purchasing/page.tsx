import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import {
  listPurchaseDocuments,
  PURCHASE_DOC_LABELS,
  type PurchaseDocType,
} from '@/lib/site/purchaseDocuments'
import { supplierAgingSummary } from '@/lib/site/supplierLedger'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  ButtonLink,
  Card,
  SearchBar,
  StatStrip,
  StatTile,
  FilterBar,
  FilterChip,
  LinkSegmentedControl,
  Pagination,
  TableToolbar,
  Icons,
} from '@/components/ui'
import { purchaseStatusLabel } from './status'
import PurchasingTable, { type PurchasingRow } from './PurchasingTable'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/**
 * A glyph per document type, so the filter bar reads as three shapes rather
 * than three phrases. Keyed by value because the segments are built by mapping
 * over the type list — the bar's rule is all or none, and a `.map()` cannot
 * carry an icon per option without somewhere to look one up.
 */
const PURCHASE_DOC_ICONS = {
  purchase_order: <Icons.FileText size={15} />,
  grv: <Icons.PackageOpen size={15} />,
  supplier_return: <Icons.Reverse size={15} />,
} as const

export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; status?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('purchasing.view')
  const params = await searchParams

  // Viewing and editing are separate rights here, and a draft row opens in the
  // editor only for someone who holds the second. Not a security check — both
  // editors guard themselves — but the difference between resuming the work and
  // bouncing off /not-allowed.
  const canEdit = can(capabilities, 'purchasing.edit')

  /*
   * Which slice the screen is on, and what that means for the query.
   *
   * ── WHY "NO PARAMETER" IS PURCHASE ORDERS AND NOT EVERYTHING ──────────────
   *
   * Arriving at /purchasing means starting a piece of purchasing work, and that
   * work starts at an order. A mixed list of orders, receipts and returns is the
   * answer to "show me everything", which is a question somebody asks
   * deliberately — not the thing to open on.
   *
   * ── WHY "All" NEEDS ITS OWN VALUE ─────────────────────────────────────────
   *
   * It used to be linked as `type: null` — remove the parameter — which worked
   * only while an absent parameter meant everything. Now that absent means
   * purchase orders, the two readings collide: that link would land straight
   * back on orders and All would be a tab nobody could open. So it is written
   * into the URL like any other choice, and the three states stay distinct:
   *
   *     /purchasing                  -> purchase orders (the default)
   *     /purchasing?type=all         -> every type
   *     /purchasing?type=grv         -> that type
   */
  const DEFAULT_TYPE = 'purchase_order' as const
  const TABS = ['purchase_order', 'grv', 'completed', 'supplier_return', 'all'] as const
  type Tab = (typeof TABS)[number]
  const tab: Tab = TABS.find((t) => t === params.type) ?? DEFAULT_TYPE

  /*
   * What each tab actually asks the database for.
   *
   * ── WHY A TAB IS NOT SIMPLY A DOCUMENT TYPE ───────────────────────────────
   *
   * Four of them are, and "Completed" is not: it is goods received that are
   * FINISHED WITH, which is a type and a status together. Modelling it as a
   * fifth doc type would have meant inventing one that the database has never
   * heard of; modelling it as a status filter alone would have swept up
   * finalised orders and returns as well.
   *
   * ── WHY GOODS RECEIVED IS NOW ONLY THE UNFINISHED ONES ────────────────────
   *
   * Measured on the live data: 2,183 finalised receipts against 9 drafts. The
   * tab was 99.6% completed paperwork, so the nine receipts that actually need
   * somebody's attention were unfindable — and a draft GRV is the most
   * expensive kind of unfinished work in a shop (see alerts/kinds/unprocessedGrvs).
   * The finished ones have not gone anywhere: they are one tab to the right.
   *
   * 'issued' rides along with 'draft' deliberately. No GRV currently carries it
   * and the posting code never sets it, but if one ever did, this way it stays
   * visible as outstanding rather than falling between the two tabs.
   *
   * 'void' is NOT named here: migration 029 renamed it to 'cancelled' and the
   * column no longer accepts it, so naming it would be a filter value that can
   * never match. (status.ts still lists it, which is fine — that map is a
   * fallback for reading old rows, not a list of what is selectable.)
   */
  const TAB_QUERY: Record<Tab, { docTypes?: readonly PurchaseDocType[]; statuses?: readonly string[] }> = {
    purchase_order: { docTypes: ['purchase_order'] },
    grv: { docTypes: ['grv'], statuses: ['draft', 'issued'] },
    completed: { docTypes: ['grv'], statuses: ['finalised', 'cancelled'] },
    supplier_return: { docTypes: ['supplier_return'] },
    all: {},
  }
  const slice = TAB_QUERY[tab]

  /*
   * An explicit ?status= wins over the tab's own.
   *
   * The "On order" tile links to type=purchase_order&status=issued, and that
   * pairing has to keep working. Where a tab also implies statuses, the
   * narrower of the two is what the user just asked for — so the chip decides.
   */
  const statuses = params.status ? [params.status] : slice.statuses
  const page = pageFrom(params.page)

  const [{ items, total }, aging, open] = await Promise.all([
    listPurchaseDocuments(siteId, {
      docTypes: slice.docTypes,
      statuses,
      search: params.q,
      limit: PAGE_SIZE,
      offset: offsetFor(page, PAGE_SIZE),
    }),
    supplierAgingSummary(siteId),
    listPurchaseDocuments(siteId, { docTypes: ['purchase_order'], statuses: ['issued'], limit: 200 }),
  ])

  const href = hrefBuilder('/purchasing', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })
  const onOrder = open.items.reduce((sum, d) => sum + d.totalIncl, 0)
  const overdue = aging.d30 + aging.d60 + aging.d90 + aging.d120
  /* Whether the user NARROWED anything, which is what the empty state reads to
     decide between "nothing here yet" and "nothing matches". The default tab is
     not a narrowing — it is where the screen opens — so it must not count, or a
     shop with no purchase orders would be told its search had no matches. */
  const filtered = Boolean(params.q || params.status || tab !== DEFAULT_TYPE)

  // Only plain data crosses to the client table — functions cannot.
  const rows: PurchasingRow[] = items.map((doc) => ({
    id: doc.id,
    documentNumber: doc.documentNumber,
    // Carried so the table can send a draft row straight back into the screen
    // that raises it, rather than to a read-only copy of it. See hrefFor.
    docType: doc.docType,
    docLabel: doc.docLabel,
    documentDate: doc.documentDate,
    supplierName: doc.supplierName,
    supplierInvoiceNo: doc.supplierInvoiceNo,
    subtotalExcl: doc.subtotalExcl,
    totalIncl: doc.totalIncl,
    status: doc.status,
    fulfilmentStatus: doc.fulfilmentStatus,
    cancelReason: doc.cancelReason,
  }))

  return (
    <>
      <PageHeader
        title="Purchasing"
        subtitle={`${total} document${total === 1 ? '' : 's'}`}
        action={
          // Two acts, because purchasing genuinely has two: ask for goods, and
          // take them in. Receiving stays primary — a GRV can be raised with or
          // without an order, so it is the one that always applies.
          <div className="flex items-center gap-2">
            <ButtonLink href="/purchasing/suggest" variant="ghost">
              <Icons.Sparkles size={15} />
              What to order
            </ButtonLink>
            <ButtonLink href="/purchasing/new" variant="secondary">
              <Icons.Truck size={15} />
              New order
            </ButtonLink>
            <PrimaryLink href="/purchasing/receive">
              <Icons.PackageOpen size={15} />
              Receive goods
            </PrimaryLink>
          </div>
        }
      />

      <PageBody>
        {/* Three tiles, not four: "Documents" restated the subtitle, and no
            fetched figure earns the fourth slot. */}
        <StatStrip columns={3}>
          <StatTile
            label="Owed to suppliers"
            value={formatMoney(aging.total)}
            hint="Across every open invoice"
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Overdue"
            value={formatMoney(overdue)}
            tone={overdue > 0 ? 'warning' : 'default'}
            hint="Past their terms"
            icon={<Icons.StatusWarning size={16} />}
            href="/suppliers/age-analysis"
          />
          <StatTile
            label="On order"
            value={formatMoney(onOrder)}
            hint={`${open.items.length} order${open.items.length === 1 ? '' : 's'} awaiting delivery`}
            icon={<Icons.Truck size={16} />}
            href={filterHref({ type: 'purchase_order', status: 'issued' })}
          />
        </StatStrip>

        {/* SearchBar and FilterBar carry the page gutter themselves; unwind
            PageBody's so the controls still line up with everything else. */}
        <div className="-mx-6 -my-3">
          <SearchBar
            action="/purchasing"
            defaultValue={params.q}
            placeholder="Search by number, supplier or their invoice number…"
            keep={{ type: params.type, status: params.status }}
          />
        </div>

        {/* Type is not a chip here — the segmented control below already shows
            which slice is active. Status stays: the "On order" tile is the only
            thing that sets it, and this chip is the only way to clear it. */}
        {params.status && (
          <div className="-mx-6 -mt-5">
            {/* Clears the FILTERS, not the tab. A bare '/purchasing' would also
                drop the slice the user is looking at and drop them back on the
                default one — clearing a status chip while reading All should
                leave them on All. */}
            <FilterBar clearHref={filterHref({ status: null, q: null })}>
              <FilterChip
                label="Status"
                value={purchaseStatusLabel(params.status)}
                clearHref={filterHref({ status: null })}
              />
            </FilterBar>
          </div>
        )}

        <Card>
          <TableToolbar inCard>
            <LinkSegmentedControl
              aria-label="Filter by document type"
              value={tab}
              /* The document types lead, in the order the work happens: you
                 raise an order, you receive against it, and a return is the
                 exception. "All" is the fallback rather than the starting
                 point, so it sits at the end — it answers "show me everything"
                 rather than being the first thing a buyer reaches for. */
              /* Written out rather than mapped over the doc types, because
                 "Completed" is not one: it has no PURCHASE_DOC_LABELS entry and
                 never will. The order is the order the work happens — raise,
                 receive, file away, return — with All as the fallback at the
                 end rather than the opening view. */
              options={[
                {
                  value: 'purchase_order',
                  label: PURCHASE_DOC_LABELS.purchase_order,
                  href: filterHref({ type: 'purchase_order' }),
                  icon: PURCHASE_DOC_ICONS.purchase_order,
                },
                {
                  value: 'grv',
                  label: PURCHASE_DOC_LABELS.grv,
                  href: filterHref({ type: 'grv' }),
                  icon: PURCHASE_DOC_ICONS.grv,
                },
                {
                  value: 'completed',
                  label: 'Completed',
                  href: filterHref({ type: 'completed' }),
                  icon: <Icons.StatusSuccess size={15} />,
                },
                {
                  value: 'supplier_return',
                  label: PURCHASE_DOC_LABELS.supplier_return,
                  href: filterHref({ type: 'supplier_return' }),
                  icon: PURCHASE_DOC_ICONS.supplier_return,
                },
                {
                  value: 'all',
                  /* Written into the URL rather than clearing it — an absent
                     type now means the default tab, so `type: null` would send
                     this link back to purchase orders. */
                  label: 'All',
                  href: filterHref({ type: 'all' }),
                  icon: <Icons.LayoutGrid size={15} />,
                },
              ]}
            />
          </TableToolbar>

          <PurchasingTable
            rows={rows}
            search={params.q}
            filtered={filtered}
            canEdit={canEdit}
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
