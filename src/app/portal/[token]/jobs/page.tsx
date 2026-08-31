import type { Metadata } from 'next'
import { requireSection } from '../guard'
import { portalJobs } from '@/lib/site/portalData'
import { letterheadFor } from '../letterhead'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import { Badge, EmptyState, Icons, TextLink } from '@/components/ui'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your jobs',
  robots: { index: false, follow: false },
}

/**
 * Everything this customer has asked the business to do.
 *
 * ── OPEN FIRST, THEN NEWEST ────────────────────────────────────────────────
 *
 * A customer opens this to answer one question — "what is happening with my
 * thing" — so what is still running goes first regardless of age.
 */
export default async function PortalJobsPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const ctx = await requireSection(token, 'jobs')

  const [jobs, head] = await Promise.all([
    portalJobs(ctx.siteId, ctx.customerId),
    letterheadFor(ctx.siteId),
  ])

  const open = jobs.filter((j) => !j.isClosed)
  const done = jobs.filter((j) => j.isClosed)

  return (
    <PortalShell
      name={head.name ?? undefined}
      hasLogo={head.hasLogo}
      token={token}
      onSignOut={<SignOutButton token={token} />}
      nav={<PortalNav token={token} active="jobs" settings={ctx.settings} />}
    >
      <h1 className="text-xl font-semibold text-ink">Your jobs</h1>
      <p className="mt-1 text-sm text-muted">Signed in as {ctx.customerName}.</p>

      {jobs.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Icons.Wrench size={22} />}
            title="Nothing here yet"
            hint="Once the business logs a job for you it will appear here, with what stage it is at."
          />
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {open.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                Still going ({open.length})
              </h2>
              <ul className="divide-y divide-border">
                {open.map((j) => (
                  <JobRow key={j.id} job={j} token={token} />
                ))}
              </ul>
            </section>
          )}

          {done.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                Finished ({done.length})
              </h2>
              <ul className="divide-y divide-border">
                {done.map((j) => (
                  <JobRow key={j.id} job={j} token={token} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </PortalShell>
  )
}

function JobRow({
  job,
  token,
}: {
  job: { id: number; documentNumber: string | null; title: string; statusName: string; isClosed: boolean; reportedAt: string | null }
  token: string
}) {
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="min-w-0 flex-1">
        <TextLink href={`/portal/${token}/jobs/${job.id}`}>{job.title}</TextLink>
        <span className="block text-xs text-muted">
          {job.documentNumber ?? `Job ${job.id}`}
          {job.reportedAt ? ` · logged ${job.reportedAt}` : ''}
        </span>
      </span>
      {/* The stage NAME, in the business's own words. Never its internal role. */}
      <Badge tone={job.isClosed ? 'neutral' : 'brand'}>{job.statusName}</Badge>
    </li>
  )
}
