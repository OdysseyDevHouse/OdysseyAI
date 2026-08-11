import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import {
  Callout, Card, CardBody, CardHeader, Icons, PageBody, PageHeader, TextLink,
} from '@/components/ui'
import { importCatalogue } from '@/lib/import/registry'
import { can, type Capability } from '@/lib/site/permissions'

export const dynamic = 'force-dynamic'

/**
 * What can be imported.
 *
 * Listed in the order a shop switching systems should actually run them, and
 * numbered to say so — a product file naming departments and suppliers that do
 * not exist yet is refused row by row, and the fix is running two other imports
 * first. Saying that here is cheaper than having someone discover it 20,000
 * refusals in.
 */
export default async function ImportIndexPage() {
  const { capabilities } = await requireSiteUser()

  // Filtered on the server, so an import somebody cannot run is never sent to
  // them at all — the same thing the Setup hub does.
  const allowed = importCatalogue().filter((item) =>
    can(capabilities, item.capability as Capability),
  )
  if (allowed.length === 0) redirect('/not-allowed')

  return (
    <>
      <PageHeader
        title="Import data"
        subtitle="Bring a spreadsheet in — a catalogue, a debtors list, a supplier book"
        backHref="/setup"
        backLabel="Setup"
      />
      <PageBody>
        <Callout tone="brand" title="Run them in this order">
          Products point at departments and suppliers, so those go in first. A file naming something that
          is not on file yet is refused rather than guessed at, and the refusal names what is missing.
        </Callout>

        <Card>
          <CardHeader
            title="What would you like to import?"
            description="Each one takes a .csv or .xlsx, checks it, and shows you what will happen before anything is written."
          />
          <CardBody className="p-0">
            <ul>
              {allowed.map((item, index) => (
                <li key={item.entity} className="border-b border-border last:border-b-0">
                  {/* A two-line row with a step number and a chevron — not a kit
                      component, and not worth becoming one for a single screen. */}
                  <Link
                    data-kit-ok
                    href={`/setup/import/${item.entity}`}
                    className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none"
                  >
                    <span className="numeric flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-sm font-semibold text-ink-2">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{item.title}</span>
                      <span className="block text-sm text-muted">{item.description}</span>
                    </span>
                    <Icons.ChevronRight size={16} className="shrink-0 text-faint" />
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>

        <p className="text-sm text-muted">
          Carrying in what customers and suppliers already owe is a separate job —
          it goes in per invoice, dated as it really was, through{' '}
          <TextLink href="/setup/opening-balances">opening balances</TextLink>.
        </p>
      </PageBody>
    </>
  )
}
