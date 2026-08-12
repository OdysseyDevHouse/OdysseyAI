import type { ReactNode } from 'react'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listDocuments, DOC_LABELS, type SalesDocStatus } from '@/lib/site/salesDocuments'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  ButtonLink,
  Card,
  SearchBar,
  StatStrip,
  StatTile,
  FilterChip,
  LinkSegmentedControl,
  TableToolbar,
  Pagination,
  Icons,
} from '@/components/ui'
import { STATUS_LABELS } from '../status'
import NewInvoiceButton from './NewInvoiceButton'
import InvoicingTable, { type InvoiceTableRow } from './InvoicingTable'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/**
 * The invoice register.
 *
 * ── WHY THERE IS NO LONGER A SEPARATE "DOCUMENTS" SCREEN ─────────────────
 *
 * There used to be two menu rows over the same table: Documents (/sales) listed
 * everything finalised, this screen listed only what was still being captured.
 * Both were `listDocuments` with a different status filter, and a user had to
 * know which of the two an invoice had moved to in order to find it — a
 * distinction the system cared about and nobody else did.
 *
 * So they are one list, and STATUS became a filter rather than an address.
 * /sales redirects here and /sales/[id] is still the record screen, so every
 * link, bookmark and printed reference keeps working.
 *
 * It opens on "In progress" rather than "All" deliberately: the person who
 * comes here most is capturing invoices, and that is a worklist — it should be
 * short, and it should empty out as the work gets done.
 */

/** The status slices, in the order an invoice passes through them. */
const SLICES = ['progress', 'finalised', 'cancelled', 'all'] as const
type Slice = (typeof SLICES)[number]

const SLICE_LABELS: Record<Slice, string> = {
  progress: 'In progress',
  finalised: STATUS_LABELS.finalised,
  cancelled: STATUS_LABELS.cancelled,
  all: 'All',
}

/**
 * A glyph per slice, so the bar is findable by shape once someone has used the
 * screen twice. They echo the outcome each slice holds — a worklist, a tick, a
 * cancellation, everything — rather than being four decorative marks.
 */
const SLICE_ICONS: Record<Slice, ReactNode> = {
  progress: <Icons.List size={15} />,
  finalised: <Icons.StatusSuccess size={15} />,
  cancelled: <Icons.StatusFailure size={15} />,
  all: <Icons.LayoutGrid size={15} />,
}

/**
 * A slice is a set of statuses, not one status — "in progress" is draft AND
 * saved, which is the whole reason this cannot just reuse `toDocStatus`.
 * `issued` rides with finalised: it is a number that has left the building.
 */
const SLICE_STATUSES: Record<Slice, readonly SalesDocStatus[] | undefined> = {
  progress: ['draft', 'saved'],
  finalised: ['finalised', 'issued'],
  cancelled: ['cancelled'],
  all: undefined,
}

function toSlice(value: unknown): Slice {
  const raw = String(value ?? '')
  return (SLICES as readonly string[]).includes(raw) ? (raw as Slice) : 'progress'
}

export default async function InvoicingPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    status?: string
    type?: string
    from?: string
    to?: string
    page?: string
  }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  //
  // `sales.view`, not `sales.edit`: this list is now the record of what was
  // issued as well as the capture worklist, so a user who may only LOOK at
  // sales has to be able to reach it. The New invoice button below is what
  // requires sales.edit, and it checks for itself.
  const { siteId, capabilities } = await requireCapability('sales.view')
  const params = await searchParams

  const slice = toSlice(params.status)
  const page = pageFrom(params.page)
  const canEdit = can(capabilities, 'sales.edit')

  // Credit notes belong beside the invoices they reverse, so they are in this
  // list by default and `type` narrows to one or the other.
  const docTypes =
    params.type === 'invoice'
      ? (['invoice'] as const)
      : params.type === 'credit_sale'
        ? (['credit_sale'] as const)
        : (['invoice', 'credit_sale'] as const)

  const { items, total } = await listDocuments(siteId, {
    docTypes,
    statuses: SLICE_STATUSES[slice],
    search: params.q,
    from: params.from,
    to: params.to,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  // Today's takings, which is the figure a manager opens this screen for.
  const today = new Date().toISOString().slice(0, 10)
  const [{ items: todayDocs }, { total: openTotal }] = await Promise.all([
    listDocuments(siteId, {
      docTypes: ['invoice', 'credit_sale'],
      statuses: ['finalised'],
      from: today,
      to: today,
      limit: 500,
    }),
    // The SITE-WIDE in-progress count, not the count on this page — a stat
    // strip must never mix denominators, and the page slice is not one.
    listDocuments(siteId, {
      docTypes: ['invoice', 'credit_sale'],
      statuses: ['draft', 'saved'],
      limit: 1,
    }),
  ])
  const takings = todayDocs.reduce((sum, d) => sum + d.totalIncl, 0)

  const href = hrefBuilder('/sales/invoicing', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  const filtered = Boolean(params.q || params.type || params.from || params.to)

  // DataTable's cells are functions, which cannot cross the server→client
  // boundary — so the table lives in InvoicingTable and gets plain rows.
  const rows: InvoiceTableRow[] = items.map((doc) => ({
    id: doc.id,
    documentNumber: doc.documentNumber,
    docTypeLabel: doc.docType !== 'invoice' ? DOC_LABELS[doc.docType] : null,
    documentDate: doc.documentDate,
    customerName: doc.customerName,
    reference: doc.reference,
    terminalCode: doc.terminalCode,
    userName: doc.userName,
    totalIncl: doc.totalIncl,
    status: doc.status,
    cancelReason: doc.cancelReason,
  }))

  return (
    <>
      <PageHeader
        title="Invoicing"
        icon={<Icons.FileText size={18} />}
        subtitle={`${total} ${total === 1 ? 'document' : 'documents'}`}
        action={canEdit ? <NewInvoiceButton /> : undefined}
      />

      <PageBody>
        <StatStrip columns={3}>
          <StatTile
            label="Today's takings"
            value={formatMoney(takings)}
            hint={`${todayDocs.length} sale${todayDocs.length === 1 ? '' : 's'}`}
            iconTone="success"
            icon={<Icons.Coins size={20} />}
          />
          <StatTile
            label="Documents"
            value={String(total)}
            hint="Matching the current filter"
            icon={<Icons.Receipt size={20} />}
          />
          <StatTile
            label="In progress"
            value={String(openTotal)}
            hint="Still to be finished"
            tone={openTotal > 0 ? 'warning' : 'default'}
            icon={<Icons.Clock size={16} />}
            href={filterHref({ status: 'progress' })}
          />
        </StatStrip>

        {/* Status is not a chip — the segmented control already shows which
            slice is active and how to leave it. Type and the dates get chips:
            they have no other visible affordance to clear them. */}
        <TableToolbar
          actions={
            <div className="w-80">
              <SearchBar
                action="/sales/invoicing"
                defaultValue={params.q}
                placeholder="Search number, customer or order number…"
                className="p-0"
                keep={{
                  status: params.status,
                  type: params.type,
                  from: params.from,
                  to: params.to,
                }}
              />
            </div>
          }
        >
          <LinkSegmentedControl
            aria-label="Filter by status"
            value={slice}
            options={SLICES.map((value) => ({
              value,
              label: SLICE_LABELS[value],
              icon: SLICE_ICONS[value],
              href: filterHref({ status: value === 'progress' ? null : value }),
            }))}
          />
          {params.type && (
            <FilterChip
              label="Type"
              value={params.type === 'credit_sale' ? 'Credit notes' : 'Invoices'}
              clearHref={filterHref({ type: null })}
            />
          )}
          {params.from && (
            <FilterChip label="From" value={params.from} clearHref={filterHref({ from: null })} />
          )}
          {params.to && (
            <FilterChip label="To" value={params.to} clearHref={filterHref({ to: null })} />
          )}
        </TableToolbar>

        <Card>
          <InvoicingTable
            rows={rows}
            empty={
              params.q
                ? {
                    title: `Nothing matches “${params.q}”`,
                    hint: 'Check the number, customer or order number, or clear the search.',
                    icon: <Icons.Search size={22} />,
                    action: (
                      <ButtonLink variant="secondary" href={filterHref({ q: null })}>
                        Clear the search
                      </ButtonLink>
                    ),
                  }
                : filtered
                  ? {
                      title: 'Nothing in this slice',
                      hint: 'No documents match the current filters.',
                      icon: <Icons.Filter size={22} />,
                      action: (
                        <ButtonLink variant="secondary" href="/sales/invoicing">
                          Clear the filters
                        </ButtonLink>
                      ),
                    }
                  : slice === 'progress'
                    ? {
                        title: 'Nothing in progress',
                        hint: 'Start an invoice to capture one off an order form, or look at what has already been issued.',
                        icon: <Icons.FileText size={22} />,
                        action: canEdit ? (
                          <NewInvoiceButton />
                        ) : (
                          <ButtonLink
                            variant="secondary"
                            href={filterHref({ status: 'finalised' })}
                          >
                            See finalised invoices
                          </ButtonLink>
                        ),
                      }
                    : {
                        title: 'No invoices yet',
                        hint: 'Ring one up from the till, or capture one here.',
                        icon: <Icons.Receipt size={22} />,
                        action: (
                          <ButtonLink variant="secondary" href="/pos">
                            <Icons.Banknote size={15} />
                            Open the till
                          </ButtonLink>
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
