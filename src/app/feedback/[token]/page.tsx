import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { readFeedbackToken } from '@/lib/feedbackToken'
import { publicSiteName } from '@/lib/sites'
import { siteQueryOne } from '@/lib/siteDb'
import { feedbackFor } from '@/lib/site/jobFeedback'
import FeedbackForm from './FeedbackForm'

export const dynamic = 'force-dynamic'

/**
 * "How did we do?" — a customer rates a finished job, with no login.
 *
 * ── WHAT THIS PAGE DELIBERATELY DOES NOT SHOW ──────────────────────────────
 *
 * The job NUMBER and its title. Nothing else. Not what was charged, not who did
 * it, not the address, not the customer's own name, not any other job.
 *
 * That is a deliberate floor rather than an oversight: the link arrives by email
 * and email gets forwarded, screenshotted and left in shared inboxes. Everything
 * on this page is something the customer already knows, so a leaked link leaks
 * nothing — which is what lets the token be simple.
 *
 * ── IT EXPLAINS ITSELF RATHER THAN 404-ing ─────────────────────────────────
 *
 * Same reading as the reservation page: somebody who followed a link from their
 * own email is entitled to be told the link has expired rather than shown a dead
 * page. An invalid token still says nothing useful about which jobs exist —
 * every failure produces the same words.
 */

export const metadata: Metadata = {
  title: 'How did we do?',
  // Never indexed. The URL is a credential.
  robots: { index: false, follow: false },
}

export default async function FeedbackPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const claim = await readFeedbackToken(token)

  if (claim === null) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-ink">This link is no longer valid</h1>
        <p className="mt-2 text-sm text-muted">
          Rating links stop working after a couple of months. If you would still like to say
          something about the work, please contact the business directly.
        </p>
      </Shell>
    )
  }

  const { siteId, jobId } = claim
  const [name, existing, job] = await Promise.all([
    publicSiteName(siteId).catch(() => null),
    feedbackFor(siteId, jobId),
    // Only the two fields the page shows. Written as an explicit column list
    // rather than a helper precisely so nothing else can arrive here by accident
    // when somebody widens a shared query later.
    siteQueryOne<{ document_number: string | null; title: string }>(
      siteId,
      `SELECT document_number, title FROM job_cards WHERE id = ?`,
      [jobId],
    ).catch(() => null),
  ])

  /*
   * No row means nobody was asked about this job.
   *
   * recordFeedback refuses it too — it is an UPDATE, so it affects nothing — but
   * saying so here means somebody with a valid signature for an unasked job gets
   * the same dead end as somebody with a forged one, rather than a form that
   * silently fails on submit.
   */
  if (!existing) {
    return (
      <Shell name={name ?? undefined}>
        <h1 className="text-xl font-semibold text-ink">This link is no longer valid</h1>
        <p className="mt-2 text-sm text-muted">
          If you would still like to say something about the work, please contact the business
          directly.
        </p>
      </Shell>
    )
  }

  const label = job?.document_number ?? `Job ${jobId}`

  return (
    <Shell name={name ?? undefined}>
      <FeedbackForm
        token={token}
        jobLabel={label}
        jobTitle={job?.title ?? ''}
        existingRating={existing.rating}
        existingComment={existing.comment}
      />
    </Shell>
  )
}

function Shell({ name, children }: { name?: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto w-full max-w-lg rounded-card border border-border bg-surface p-6 shadow-card">
        {name ? <p className="mb-1 text-sm text-muted">{name}</p> : null}
        {children}
      </div>
    </main>
  )
}
