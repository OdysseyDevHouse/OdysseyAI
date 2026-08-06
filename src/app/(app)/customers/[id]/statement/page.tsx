import { notFound } from 'next/navigation'
import { requireSite } from '@/lib/auth'
import { buildStatement, type StatementFormat } from '@/lib/statements/render'
import { PageHeader, Card, ButtonLink, Menu, MenuItem, Icons, LinkTabs } from '@/components/ui'
import { StatementDocument } from '@/components/statements/StatementDocument'
import { withParams } from '@/lib/searchParams'
import PeriodPicker from './PeriodPicker'

export const dynamic = 'force-dynamic'

/**
 * The statement, on screen, exactly as it will print.
 *
 * Preview first, PDF second: most of the time someone wants to check a figure
 * before sending, and rendering the document in the page makes that instant.
 * The PDF route renders the same StatementData, so what is previewed is what is
 * sent.
 */
export default async function StatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ format?: string; from?: string; to?: string }>
}) {
  const site = await requireSite()
  const { id } = await params
  const { format: formatRaw, from, to } = await searchParams

  const customerId = Number(id)
  if (!Number.isFinite(customerId) || customerId <= 0) notFound()

  const format: StatementFormat = formatRaw === 'activity' ? 'activity' : 'open-item'

  const data = await buildStatement(site.id, site.displayName, site.vatNumber, customerId, {
    format,
    from: iso(from),
    to: iso(to),
  })
  if (!data) notFound()

  const basePath = `/customers/${customerId}/statement`

  // Only the dates the user actually asked for. Seeding these from data.period
  // instead would pin the 90-day default into every link, so "Reset" could
  // never get back to it.
  const period = { from: iso(from), to: iso(to) }
  const pdfHref = `/api/customers/${customerId}/statement${withParams(period, { format })}`

  return (
    <>
      <PageHeader
        title="Statement"
        subtitle={`${data.account.code} — ${data.account.name}`}
        backHref={`/customers/${customerId}?tab=transactions`}
        backLabel="Account"
        action={
          <div className="flex items-center gap-2">
            <ButtonLink href={pdfHref} variant="secondary">
              <Icons.Printer size={15} />
              Open PDF
            </ButtonLink>
            <Menu label="Send" variant="primary">
              <MenuItem
                href={`/api/customers/${customerId}/statement${withParams(period, {
                  format,
                  download: '1',
                })}`}
                download
              >
                <Icons.Download size={15} />
                Download PDF
              </MenuItem>
              <MenuItem
                href={
                  data.account.email
                    ? `mailto:${data.account.email}?subject=${encodeURIComponent(
                        `Statement — ${data.account.code}`,
                      )}`
                    : undefined
                }
                disabled={!data.account.email}
              >
                <Icons.Mail size={15} />
                {data.account.email ? 'Email to customer' : 'No email on file'}
              </MenuItem>
            </Menu>
          </div>
        }
      />

      <div className="flex flex-col gap-4 px-6 pt-4">
        <LinkTabs
          items={[
            {
              value: 'open-item',
              label: 'Open items',
              icon: <Icons.Receipt size={15} />,
              href: `${basePath}${withParams(period, { format: 'open-item' })}`,
            },
            {
              value: 'activity',
              label: 'Full activity',
              icon: <Icons.History size={15} />,
              href: `${basePath}${withParams(period, { format: 'activity' })}`,
            },
          ]}
          value={format}
          aria-label="Statement format"
        />

        {/* Open items are "everything still unpaid, whenever it was raised", so
            a period would only mislead — it belongs on the activity view. */}
        {format === 'activity' && (
          <PeriodPicker basePath={basePath} from={data.period.from} to={data.period.to} />
        )}
      </div>

      <div className="px-6 pt-4 pb-10">
        <Card className="overflow-hidden">
          <StatementDocument data={data} />
        </Card>
      </div>
    </>
  )
}

function iso(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}
