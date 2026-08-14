import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { verifyPublicIntakeToken } from '@/lib/publicIntakeToken'
import { publicSiteName } from '@/lib/sites'
import { intakeSettings } from '@/lib/site/jobIntake'
import { listHeadlines } from '@/lib/site/jobHeadlines'
import RequestForm from './RequestForm'

export const dynamic = 'force-dynamic'

/**
 * "Ask us to do some work" — a stranger requests a callout, with no login.
 *
 * ── IT SHOWS ALMOST NOTHING ────────────────────────────────────────────────
 *
 * The business name, its own blurb, and the kinds of work it offers if it has
 * chosen to publish them. No prices, no availability, no staff, no customers,
 * and nothing at all about any existing job. A leaked link leaks a form.
 *
 * ── WHAT ARRIVES IS INERT ──────────────────────────────────────────────────
 *
 * A submission is a job_requests row and nothing else. It becomes a job only
 * when somebody in the business chooses a customer and accepts it — see the
 * module header. That is what makes a public write endpoint affordable here.
 *
 * ── IT EXPLAINS ITSELF RATHER THAN 404-ing ─────────────────────────────────
 *
 * The reservation page's reading, for the same reason: this link is printed on a
 * van and on a website, and somebody standing outside with a phone needs to be
 * told "not online, phone them" rather than shown a dead page. An invalid TOKEN
 * still says nothing useful.
 */

export const metadata: Metadata = {
  title: 'Request a job',
  robots: { index: false, follow: false },
}

export default async function RequestPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const siteId = await verifyPublicIntakeToken(token)

  if (siteId === null) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-ink">This link is not valid</h1>
        <p className="mt-2 text-sm text-muted">
          The link you followed is not valid any more. Please ask the business for a new one.
        </p>
      </Shell>
    )
  }

  const [name, settings] = await Promise.all([
    publicSiteName(siteId).catch(() => null),
    intakeSettings(siteId),
  ])

  if (!settings.isEnabled) {
    return (
      <Shell name={name ?? undefined}>
        <h1 className="text-xl font-semibold text-ink">Not taking requests online</h1>
        <p className="mt-2 text-sm text-muted">
          This business is not accepting requests through this form at the moment. Please phone
          them instead.
        </p>
      </Shell>
    )
  }

  /*
   * Only the ACTIVE kinds of work, and only if the business chose to publish
   * them. A retired headline must not appear, and the action re-checks the id
   * against the same list — so what the form offers and what the server accepts
   * cannot drift apart.
   */
  const headlines = settings.showHeadlines
    ? (await listHeadlines(siteId, false).catch(() => [])).map((h) => ({
        id: h.id,
        name: h.name,
      }))
    : []

  return (
    <Shell name={name ?? undefined}>
      <RequestForm token={token} blurb={settings.blurb} headlines={headlines} />
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
