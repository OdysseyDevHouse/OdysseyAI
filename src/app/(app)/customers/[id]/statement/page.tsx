import { notFound } from 'next/navigation'
import { requireSite, requireModuleCapability } from '@/lib/auth'
import { buildStatement, type StatementFormat } from '@/lib/statements/render'
import { PageHeader, PageBody, Card, ButtonLink, Menu, MenuItem, Icons, LinkTabs } from '@/components/ui'
import { StatementDocument } from '@/components/statements/StatementDocument'
import { withParams } from '@/lib/searchParams'
import { getCustomer, type Customer } from '@/lib/site/customers'
import { today } from '@/lib/site/ledger'
import {
  statementPeriods,
  periodFromKey,
  CYCLE_LABELS,
  type CycleConfig,
} from '@/lib/statementCycles'
import CyclePeriodPicker from './CyclePeriodPicker'

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
  searchParams: Promise<{ format?: string; from?: string; to?: string; period?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireModuleCapability('customers', 'customers.view')
  const site = await requireSite()
  const { id } = await params
  const { format: formatRaw, from, to, period: periodKey } = await searchParams

  const customerId = Number(id)
  if (!Number.isFinite(customerId) || customerId <= 0) notFound()

  const format: StatementFormat = formatRaw === 'activity' ? 'activity' : 'open-item'

  const customer = await getCustomer(site.id, customerId)
  if (!customer) notFound()

  const config: CycleConfig = {
    cycle: customer.statementCycle,
    anchorDay: customer.statementAnchorDay,
    anchorDate: customer.statementAnchorDate,
    fallbackAnchor: isoDate(customer.createdAt),
  }
  const now = today()
  const periods = statementPeriods(config, now, 13)

  // Explicit dates win over the dropdown. Both cannot be honoured, and the
  // custom range has to stay reachable — so a from/to in the URL means the user
  // asked for exactly that window.
  const explicit = iso(from) ?? iso(to)
  const chosen = explicit ? null : (periodFromKey(config, periodKey, now) ?? periods[0])

  const data = await buildStatement(site.id, site.displayName, site.vatNumber, customerId, {
    format,
    from: chosen ? chosen.from : iso(from),
    to: chosen ? chosen.to : iso(to),
  })
  if (!data) notFound()

  const basePath = `/customers/${customerId}/statement`

  // The PDF route knows nothing about cycles, so links always carry resolved
  // dates. The composite key is a UI affordance; keeping it out of the API means
  // that route needs no change and cannot disagree about what a key resolves to.
  const period = { from: data.period.from, to: data.period.to }
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

      <PageBody>
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

        {/* On BOTH formats. A free-form range genuinely did not belong on open
            items, but a cycle period does: it dates the document, names the PDF,
            and now sets the aging and the closing balance as at its end. */}
        <CyclePeriodPicker
          basePath={basePath}
          periods={periods}
          selectedKey={chosen?.key ?? null}
          from={data.period.from}
          to={data.period.to}
          cycleNote={cycleNote(customer.statementCycle, data.period.from)}
          hint={
            format === 'open-item'
              ? 'Dates the statement and ages it to the period end. Open items are listed whenever they were raised.'
              : 'Movements inside this period, after the balance brought forward.'
          }
        />

        <Card className="overflow-hidden">
          <StatementDocument data={data} />
        </Card>
      </PageBody>
    </>
  )
}

function iso(value: string | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Why these dates — otherwise "28 Jul – 3 Aug" looks arbitrary. */
function cycleNote(cycle: Customer['statementCycle'], from: string): string {
  const label = CYCLE_LABELS[cycle]
  if (cycle === 'monthly') {
    const day = Number(from.slice(8, 10))
    return day === 1 ? `${label} · calendar months` : `${label} · cut on the ${ordinal(day)}`
  }
  const weekday = new Date(`${from}T00:00:00`).getDay()
  return `${label} · ${WEEKDAYS[weekday]} to ${WEEKDAYS[(weekday + 6) % 7]}`
}

function ordinal(day: number): string {
  if (day > 3 && day < 21) return `${day}th`
  return `${day}${['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'}`
}

/** A Date to yyyy-mm-dd in local time, for the cycle anchor fallback. */
function isoDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${value.getFullYear()}-${month}-${day}`
}
