import { redirect } from 'next/navigation'
import { requireCapability, requireSession } from '@/lib/auth'
import { getSiteForUser } from '@/lib/sites'
import { listSiteDatabases, probeSiteDatabase } from '@/lib/siteDb'
import {
  PageHeader,
  PageBody,
  Badge,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  Icons,
  SettingRow,
} from '@/components/ui'

/**
 * Site details and database health.
 *
 * The probe is the point: every configured database is contacted when this
 * page loads, so a broken connection is reported HERE, by name, rather than
 * as a 500 on whichever screen happened to read from it first.
 *
 * Deliberately NOT streamed/Suspense'd: the probes gate the whole page, and
 * restructuring the server rendering is out of scope for a visual pass.
 */

export const dynamic = 'force-dynamic'

/** cp2_site_databases purposes, as a person would say them. */
function purposeLabel(purpose: string): string {
  const known: Record<string, string> = {
    master: 'Master',
    site: 'Site',
    stock_file: 'Stock file',
    customer_file: 'Customer file',
  }
  if (known[purpose]) return known[purpose]
  const spaced = purpose.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export default async function SiteDatabasesPage() {
  // Server hostnames, database names and usernames are on this page — worth a
  // stronger gate than "has a session".
  await requireCapability('setup.edit')

  const session = await requireSession()
  if (session.siteId === null) redirect('/select-site')

  const site = await getSiteForUser(session.userId, session.siteId)
  if (!site) redirect('/select-site')

  const databases = await listSiteDatabases(site.id)
  const probes = await Promise.all(databases.map((d) => probeSiteDatabase(site.id, d.purpose)))

  const details: [string, string | null][] = [
    ['Site code', site.code],
    ['Company', site.companyName],
    ['Trading name', site.tradingName],
    ['Registration no.', site.registrationNumber],
    ['VAT no.', site.vatNumber],
    ['Contact', site.contactName],
    ['Phone', site.phone],
    ['Email', site.email],
    [
      'Address',
      [site.address1, site.address2, site.address3, site.postalCode].filter(Boolean).join(', ') ||
        null,
    ],
    ['Back office', site.backofficeType],
    ['Your role', site.role],
  ]

  return (
    <>
      <PageHeader
        title="Site & databases"
        subtitle={site.displayName}
        action={
          <div className="flex items-center gap-2">
            {site.status !== 'active' && <Badge tone="warning">{site.status}</Badge>}
            <Badge tone={site.isPaid ? 'success' : 'neutral'}>
              {site.isPaid ? 'Paid' : 'Unpaid'}
            </Badge>
          </div>
        }
      />

      <PageBody className="lg:flex-row lg:items-start">
        <Card className="flex-1">
          <CardHeader title="Site details" description={`Signed in as ${session.email}`} />
          <div>
            {details.map(([label, value]) => (
              <SettingRow key={label} label={label}>
                <span className="max-w-64 truncate text-sm text-ink" title={value ?? undefined}>
                  {value || '—'}
                </span>
              </SettingRow>
            ))}
          </div>
        </Card>

        <Card className="flex-1">
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <Icons.Database size={15} className="text-muted" />
                Site databases
              </span>
            }
            description="Each connection is tested when this page loads."
          />

          {databases.length === 0 ? (
            <EmptyState
              icon={<Icons.Database size={22} />}
              title="No databases configured"
              hint="This site has no rows in cp2_site_databases. Add one in the v2 backend."
            />
          ) : (
            <ul className="divide-y divide-border">
              {databases.map((d, i) => {
                const probe = probes[i]
                return (
                  <li key={d.id} className="px-5 py-3.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-ink">
                        {purposeLabel(d.purpose)}
                      </span>
                      {probe.ok ? (
                        <Badge tone="success">Connected</Badge>
                      ) : (
                        <Badge tone="danger">Unreachable</Badge>
                      )}
                    </div>
                    {/* Mono: a connection string gets compared character by
                        character against configs elsewhere, and a proportional
                        face hides the o/0 and l/1 slips. */}
                    <div className="mt-1 truncate font-mono text-sm text-muted">
                      {d.host}:{d.port}/{d.databaseName}
                    </div>
                    {!d.credentialsUsable && (
                      <Callout tone="warning" className="mt-2">
                        {process.env.ENCRYPTION_KEY
                          ? 'Stored password could not be decrypted — ENCRYPTION_KEY does not match the backend that wrote it.'
                          : 'ENCRYPTION_KEY is not set in .env — copy it from the v2 backend.'}
                      </Callout>
                    )}
                    {probe.error && (
                      <Callout tone="danger" className="mt-2">
                        <span className="break-words">{probe.error}</span>
                      </Callout>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  )
}
