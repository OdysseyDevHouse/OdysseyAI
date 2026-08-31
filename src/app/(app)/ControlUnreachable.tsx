import { Callout, Card, Icons } from '@/components/ui'
import { describeErrorChain, isStoreDetailsUnavailable } from '@/lib/sites'
import NeedsInternetScreen from './NeedsInternetScreen'
import RetryConnectionButton from './RetryConnectionButton'

/**
 * What to show when the control database cannot be reached.
 *
 * ── THE SAME ERROR MEANS TWO DIFFERENT THINGS ───────────────────────────────
 *
 * On a till, `connect ECONNREFUSED` means the shop's line is down. The reader
 * is the owner, the remedy is a network cable, and NeedsInternetScreen says so
 * — nothing is broken and nothing has been lost.
 *
 * On the web build, that same screen is wrong in every particular. There is no
 * "this machine" to plug in; the reader is signed in to a server in a rack, and
 * the fault is almost always a setting rather than a cable. Telling them their
 * takings are safe on this machine is worse than saying nothing: it is a
 * confident answer to a question they did not ask, and it HIDES the one fact
 * that would let them fix it. That happened — a site database pointed at the
 * wrong host, reported as "No internet connection".
 *
 * So the build decides. Desktop keeps the reassurance; the web shows the error.
 *
 * ── WHY IT IS SAFE TO SHOW IT HERE ──────────────────────────────────────────
 *
 * global-error.tsx withholds the real error in a browser, deliberately: it can
 * be reached by anybody, and a connection error names your database host and
 * port.
 *
 * This screen cannot. Both layouts that render it call requireSession() first
 * and it throws or redirects for anyone unauthenticated, so the reader is a
 * signed-in operator of this installation. That is the same standard the rest
 * of the app applies to site connection details, which are visible on the setup
 * screens to exactly these people.
 *
 * If that ordering ever changes — a gate moved above the session check — this
 * reasoning goes with it, and the screen must go back to a digest.
 */
export default function ControlUnreachable({ err }: { err: unknown }) {
  /* Read on the server from the baked build mode, not from the client. Same
     check as the layouts' own `isDesktop`; it is repeated here rather than
     passed in so that both call sites cannot drift into different answers. */
  if (process.env.APP_MODE === 'desktop') {
    return <NeedsInternetScreen firstRun={isStoreDetailsUnavailable(err)} />
  }

  const chain = describeErrorChain(err)

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <Card className="w-full max-w-2xl">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-pill bg-danger-soft text-danger-ink">
              <Icons.StatusError size={24} />
            </span>
            <div>
              <h1 className="text-lg font-bold text-ink">Couldn&rsquo;t reach the database</h1>
              <p className="mt-1 text-sm text-muted">
                The server could not open this site&rsquo;s data. This is the error it returned.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {chain.map((link, i) => (
              /* Keyed by position: a cause chain is an ordered list that is
                 rendered once and never reordered, and two links can legitimately
                 carry the same code and message. */
              <div
                key={i}
                className="rounded-card border border-border bg-surface-2 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-ink-2">{link.name}</span>
                  {link.code && (
                    <span className="rounded-pill bg-danger-soft px-2 py-0.5 font-mono text-xs text-danger-ink">
                      {link.code}
                    </span>
                  )}
                  {i > 0 && <span className="text-xs text-faint">caused by</span>}
                </div>
                <p className="mt-1 break-words font-mono text-xs leading-relaxed text-ink-2">
                  {link.message}
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <RetryConnectionButton />
            <span className="text-sm text-muted">
              Drops the cached connections, then retries.
            </span>
          </div>

          <Callout tone="brand">
            <p className="text-sm">
              A connection error at this point is usually the address rather than the
              credentials. Site databases store <code className="font-mono">localhost</code>,
              meaning localhost <em>of the database server</em> — set{' '}
              <code className="font-mono">SITE_DB_HOST_OVERRIDE</code> in the server&rsquo;s{' '}
              <code className="font-mono">.env</code> when that is a different machine. It
              overrides the stored value for every site, so a corrected row is ignored while
              it is set. The control database is <code className="font-mono">DB_HOST</code>.
            </p>
            {/* The distinction that costs the most time when it is missing: one of
                these two edits is picked up by the button above and the other is
                not, and both look like "I changed it and nothing happened". */}
            <p className="mt-2 text-sm">
              <strong>Try again</strong> picks up a changed row in{' '}
              <code className="font-mono">cp2_site_databases</code>. A changed{' '}
              <code className="font-mono">.env</code> does <strong>not</strong> — the server
              reads that once at startup, so it needs restarting.
            </p>
          </Callout>
        </div>
      </Card>
    </div>
  )
}
