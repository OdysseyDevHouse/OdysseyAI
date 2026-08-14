import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requireCustomer } from '../../guard'
import { portalJob } from '@/lib/site/portalData'
import { publicSiteName } from '@/lib/sites'
import PortalShell, { PortalNav } from '../../PortalShell'
import SignOutButton from '../../SignOutButton'
import PortalJobActions from './PortalJobActions'
import PortalUpload from './PortalUpload'
import { Badge, TextLink } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your job',
  robots: { index: false, follow: false },
}

/**
 * One job, as the customer sees it.
 *
 * ── WHAT IS ON THIS PAGE, AND WHAT IS NOT ──────────────────────────────────
 *
 * On it: what the job is, what stage it is at, when somebody is coming, quotes
 * with their totals, messages either side has shared, files either side has
 * shared, and any custom field marked public.
 *
 * NOT on it, deliberately: what anything cost the business, which technician is
 * assigned, staff notes, hours worked, kilometres driven, or any other job.
 * portalData names its columns for exactly this reason — see its header.
 *
 * ── NOT FOUND AND NOT YOURS LOOK IDENTICAL ─────────────────────────────────
 *
 * portalJob puts the customer id in the WHERE, so both return null and both end
 * here as a 404. A distinguishable "that is not yours" would confirm the job
 * exists, which is itself worth something to somebody guessing ids.
 */
export default async function PortalJobPage({
  params,
}: {
  params: Promise<{ token: string; id: string }>
}) {
  const { token, id } = await params
  const ctx = await requireCustomer(token)

  const jobId = Number(id)
  if (!Number.isFinite(jobId) || jobId <= 0) notFound()

  const [job, name] = await Promise.all([
    portalJob(ctx.siteId, ctx.customerId, jobId),
    publicSiteName(ctx.siteId).catch(() => null),
  ])
  if (!job) notFound()

  // How many the customer has already sent, so the control can say how many are
  // left rather than refusing after the fact.
  const mineCount = job.files.filter((f) => f.mine).length

  return (
    <PortalShell
      name={name ?? undefined}
      nav={<PortalNav token={token} active="jobs" onSignOut={<SignOutButton token={token} />} />}
    >
      <p className="text-xs text-muted">
        <TextLink href={`/portal/${token}/jobs`}>&larr; All your jobs</TextLink>
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-ink">{job.title}</h1>
        <Badge tone={job.isClosed ? 'neutral' : 'brand'}>{job.statusName}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted">
        {job.documentNumber ?? `Job ${job.id}`}
        {job.reportedAt ? ` · logged ${job.reportedAt}` : ''}
        {job.closedAt ? ` · finished ${job.closedAt}` : ''}
      </p>

      {job.description && (
        <p className="mt-4 whitespace-pre-line text-sm text-ink-2">{job.description}</p>
      )}

      {job.extras.length > 0 && (
        <dl className="mt-5 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {job.extras.map((e) => (
            <div key={e.name} className="flex flex-col">
              <dt className="text-xs uppercase tracking-wide text-muted">{e.name}</dt>
              <dd className="text-sm text-ink">{e.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {job.visits.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            When somebody is coming
          </h2>
          <ul className="divide-y divide-border">
            {job.visits.map((v) => (
              <li key={v.id} className="flex items-center gap-3 py-2">
                <span className="flex-1 text-sm text-ink">
                  {v.startsAt ?? 'To be arranged'}
                  {v.endsAt ? ` — ${v.endsAt.slice(11)}` : ''}
                </span>
                {/* Deliberately no technician name: who comes is the business's
                    to arrange, and it changes. */}
                <Badge tone="neutral">{v.status}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      {job.quotes.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Quotes</h2>
          <ul className="divide-y divide-border">
            {job.quotes.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="text-sm text-ink">
                    {q.documentNumber ?? `Quote ${q.id}`}
                  </span>
                  <span className="block text-xs text-muted">{q.docDate}</span>
                </span>
                <span className="numeric text-sm text-ink">{formatMoney(q.total)}</span>
                {q.isAccepted ? (
                  <Badge tone="success">Accepted</Badge>
                ) : q.status === 'declined' ? (
                  <Badge tone="neutral">Declined</Badge>
                ) : ctx.settings.allowQuoteAccept ? (
                  <PortalJobActions
                    token={token}
                    jobId={job.id}
                    kind="quote"
                    quoteId={q.id}
                    allowComments={ctx.settings.allowComments}
                  />
                ) : (
                  <Badge tone="warning">Awaiting your answer</Badge>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(job.files.length > 0 || (ctx.settings.allowUploads && !job.isClosed)) && (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Files</h2>
          {job.files.length > 0 && (
            <ul className="divide-y divide-border">
              {job.files.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2">
                  <span className="flex-1 text-sm text-ink">{f.name}</span>
                  {f.mine && <Badge tone="neutral">You sent this</Badge>}
                  <span className="text-xs text-muted">{f.uploadedAt}</span>
                </li>
              ))}
            </ul>
          )}
          {ctx.settings.allowUploads && !job.isClosed && (
            <PortalUpload
              token={token}
              jobId={job.id}
              remaining={Math.max(0, ctx.settings.maxUploadsPerJob - mineCount)}
            />
          )}
        </section>
      )}

      <section className="mt-6 border-t border-border pt-5">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">Messages</h2>
        {job.comments.length === 0 ? (
          <p className="text-sm text-muted">Nothing has been shared yet.</p>
        ) : (
          <ul className="space-y-3">
            {job.comments.map((c) => (
              <li
                key={c.id}
                className={c.mine ? 'rounded-card bg-surface-2 p-3' : 'rounded-card border border-border p-3'}
              >
                <p className="whitespace-pre-line text-sm text-ink-2">{c.body}</p>
                <p className="mt-1 text-xs text-muted">
                  {c.mine ? 'You' : c.author} · {c.createdAt}
                </p>
              </li>
            ))}
          </ul>
        )}

        {ctx.settings.allowComments && !job.isClosed && (
          <PortalJobActions
            token={token}
            jobId={job.id}
            kind="comment"
            allowComments={ctx.settings.allowComments}
          />
        )}
      </section>
    </PortalShell>
  )
}
