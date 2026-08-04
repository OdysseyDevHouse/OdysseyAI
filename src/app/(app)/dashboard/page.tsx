import { redirect } from 'next/navigation'
import { StatusSuccess as CheckCircle2, StatusFailure as XCircle, Database } from '@/components/ui/icons'
import { requireSession } from '@/lib/auth'
import { getSiteForUser } from '@/lib/sites'
import { listSiteDatabases, probeSiteDatabase } from '@/lib/siteDb'
import { PageHeader, Card, Badge } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const session = await requireSession()
  if (session.siteId === null) redirect('/select-site')

  const site = await getSiteForUser(session.userId, session.siteId)
  if (!site) redirect('/select-site')

  const databases = await listSiteDatabases(site.id)
  // Probe each configured database so a broken route shows up here rather than
  // as a 500 on whichever page first tried to read from it.
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
        title={site.displayName}
        subtitle={`Signed in as ${session.email}`}
        action={
          <div className="flex items-center gap-2">
            {site.status !== 'active' && <Badge tone="warning">{site.status}</Badge>}
            <Badge tone={site.isPaid ? 'positive' : 'default'}>
              {site.isPaid ? 'Paid' : 'Unpaid'}
            </Badge>
          </div>
        }
      />

      <div className="grid gap-4 p-6 lg:grid-cols-2">
        <Card>
          <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-ink">
            Site details
          </h2>
          <dl className="divide-y divide-border">
            {details.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 px-4 py-2.5 text-sm">
                <dt className="shrink-0 text-muted">{label}</dt>
                <dd className="truncate text-right text-ink">{value || '—'}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <h2 className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-ink">
            <Database size={14} className="text-muted" />
            Site databases
          </h2>

          {databases.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              No databases configured for this site in{' '}
              <code className="text-xs">cp2_site_databases</code>.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {databases.map((d, i) => {
                const probe = probes[i]
                return (
                  <li key={d.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-ink">{d.purpose}</span>
                      {probe.ok ? (
                        <span className="flex items-center gap-1.5 text-xs text-positive">
                          <CheckCircle2 size={13} />
                          Connected
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-xs text-danger">
                          <XCircle size={13} />
                          Unreachable
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-muted">
                      {d.host}:{d.port}/{d.databaseName}
                    </div>
                    {!d.credentialsUsable && (
                      <div className="mt-1 text-xs text-warning">
                        {process.env.ENCRYPTION_KEY
                          ? 'Stored password could not be decrypted — ENCRYPTION_KEY does not match the backend that wrote it.'
                          : 'ENCRYPTION_KEY is not set in .env — copy it from the v2 backend.'}
                      </div>
                    )}
                    {probe.error && (
                      <div className="mt-1 break-words text-xs text-danger">{probe.error}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  )
}
