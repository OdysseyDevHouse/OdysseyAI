'use client'

import { Button, ButtonLink, Callout, Card, Icons } from '@/components/ui'

/**
 * The error boundary for every screen inside the app shell.
 *
 * ── WHY THIS FILE HAS TO EXIST ──────────────────────────────────────────────
 *
 * Not merely so a failed page looks tidy. Without a boundary at this level a
 * server render that throws is an error thrown OUTSIDE any boundary, and Next
 * handles that case by pairing it with its own diagnostic in an AggregateError
 * before streaming it to the client. React's dev deserialiser then rebuilds
 * that error — `new AggregateError(revivedErrors, …)` — and when the outlined
 * `errors` array does not survive the trip it is handed `null`, which throws
 * `object null is not iterable` from inside the Flight stream reader.
 *
 * That throw is an uncaughtException, not a render error, so nothing catches
 * it and the stream is never finished: the browser holds an open connection
 * and spins. A dead site database — the commonest cause, one refused socket in
 * requireSiteUser — presented as an app that hangs forever rather than an app
 * that says what is wrong. See lib/siteDb.ts, which flattens the driver's own
 * AggregateError for the same reason.
 *
 * A boundary here keeps the failure inside React, where it is a render error
 * with a message, a reset, and a way out.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CATCH ─────────────────────────────────────
 *
 * The layout's own failure. `error.tsx` sits INSIDE its segment's layout, so a
 * throw from (app)/layout.tsx passes it by — which is correct: the connection
 * screen that layout renders is a better answer than this one, and it already
 * handles the case. This is for the pages below it.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-full items-center justify-center bg-canvas p-6">
      <Card className="w-full max-w-xl">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-pill bg-danger-soft text-danger-ink">
              <Icons.StatusError size={24} />
            </span>
            <div>
              <h1 className="text-lg font-bold text-ink">This screen didn&rsquo;t load</h1>
              <p className="mt-1 text-sm text-muted">
                The rest of the app is still working — the sidebar will take you elsewhere.
              </p>
            </div>
          </div>

          {/* The message, not a digest. Every route inside this group renders
              behind requireSiteUser, so the only reader is a signed-in operator
              of this installation — the same standard ControlUnreachable
              applies, and for the same reason: the text is usually the whole
              remedy. In production Next replaces it with its own generic
              sentence, so nothing internal leaks either way. */}
          <div className="rounded-card border border-border bg-surface-2 p-3">
            <p className="break-words font-mono text-xs leading-relaxed text-ink-2">
              {error.message || 'No message was given.'}
            </p>
            {error.digest && (
              <p className="mt-2 font-mono text-xs text-faint">digest {error.digest}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={reset}>
              <Icons.Refresh size={18} />
              Try again
            </Button>
            <ButtonLink href="/dashboard" variant="secondary">
              Back to dashboard
            </ButtonLink>
            <ButtonLink href="/select-site" variant="secondary">
              <Icons.Store size={18} />
              Choose another store
            </ButtonLink>
          </div>

          {/* Named because it is the one cause a person can act on without a
              developer, and the one this boundary exists for. */}
          <Callout tone="brand">
            <p className="text-sm">
              A <code className="font-mono">connect ECONNREFUSED</code> or{' '}
              <code className="font-mono">ETIMEDOUT</code> here means this store&rsquo;s database
              could not be opened — check the row in{' '}
              <code className="font-mono">cp2_site_databases</code>, or open a different store.
            </p>
          </Callout>
        </div>
      </Card>
    </div>
  )
}
