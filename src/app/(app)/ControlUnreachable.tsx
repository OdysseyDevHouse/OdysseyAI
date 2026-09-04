import { ButtonLink, Callout, Card, Icons } from '@/components/ui'
import { getSession } from '@/lib/session'
import { describeErrorChain, isSiteDbRefusal, isStoreDetailsUnavailable } from '@/lib/sites'
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
 *
 * ── AND IT IS NOT A DEAD END ────────────────────────────────────────────────
 *
 * Every route inside (app) renders through the layout that shows this, so
 * without a way out the reader is stuck on it: no top bar, no site picker, no
 * sign-out. That is wrong for the commonest cause — ONE site's row pointing at
 * a host that no longer resolves — where the account can still open a different
 * store perfectly well, and it is wrong for the next commonest, wanting to come
 * back as somebody else.
 *
 * Sign out works whatever is down: it verifies the cookie, and releaseSession()
 * logs a failed control write rather than throwing, so the cookie is cleared
 * either way. The store picker does need the control database — it lists the
 * account's stores — which is why it is offered as the secondary of the two and
 * why /select-site carries its own catch for that case.
 */
export default async function ControlUnreachable({ err }: { err: unknown }) {
  /* ── A DATABASE THAT ANSWERED IS NOT A LINE THAT IS DOWN ───────────────────
   *
   * "Access denied for user 'ody10003'@'127.0.0.1'" proves the opposite of no
   * internet: the socket opened, the server replied, and it said no. Sending
   * that to NeedsInternetScreen would have a shop owner checking a router that
   * is working perfectly while the actual fault — a password, a grant, a schema
   * name, all of them fields of one cp2_site_databases row — goes unmentioned.
   *
   * So a refusal takes the diagnostic screen on EVERY build, till included, and
   * only the wording below changes with it. */
  const refused = isSiteDbRefusal(err)

  /* Read on the server from the baked build mode, not from the client. Same
     check as the layouts' own `isDesktop`; it is repeated here rather than
     passed in so that both call sites cannot drift into different answers. */
  if (process.env.APP_MODE === 'desktop' && !refused) {
    return <NeedsInternetScreen firstRun={isStoreDetailsUnavailable(err)} />
  }

  const chain = describeErrorChain(err)
  /* The cookie, not the database — see connectionActions.ts. It is only used to
     name the account in the footer, and an unnamed footer is the right outcome
     if there is no readable session. */
  const session = await getSession()

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <Card className="w-full max-w-2xl">
        <div className="flex flex-col gap-5 p-6">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-pill bg-danger-soft text-danger-ink">
              <Icons.StatusError size={24} />
            </span>
            <div>
              <h1 className="text-lg font-bold text-ink">
                {refused
                  ? 'The database wouldn’t accept these details'
                  : 'Couldn’t reach the database'}
              </h1>
              <p className="mt-1 text-sm text-muted">
                {refused
                  ? 'The server answered and turned the connection away. This is what it said.'
                  : 'The server could not open this site’s data. This is the error it returned.'}
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
            {/* Two different faults want two different first moves. Offering the
                host-override advice for a denied login sends someone editing an
                address that is demonstrably correct — the server at that address
                is the one that just answered. */}
            {refused ? (
              <p className="text-sm">
                The address is right — something answered on it. What was rejected is one of{' '}
                <code className="font-mono">db_username</code>,{' '}
                <code className="font-mono">db_password_enc</code> or{' '}
                <code className="font-mono">database_name</code> on this site&rsquo;s row in{' '}
                <code className="font-mono">cp2_site_databases</code>, or the grant behind
                them. A password stored against a <em>different</em>{' '}
                <code className="font-mono">ENCRYPTION_KEY</code> decrypts to nonsense and
                fails here in exactly this way.
              </p>
            ) : (
              <p className="text-sm">
                A connection error at this point is usually the address rather than the
                credentials. Site databases store <code className="font-mono">localhost</code>,
                meaning localhost <em>of the database server</em> — set{' '}
                <code className="font-mono">SITE_DB_HOST_OVERRIDE</code> in the server&rsquo;s{' '}
                <code className="font-mono">.env</code> when that is a different machine. It
                overrides the stored value for every site, so a corrected row is ignored while
                it is set. The control database is <code className="font-mono">DB_HOST</code>.
              </p>
            )}
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

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-sm text-muted">
              {session?.email ? (
                <>
                  Signed in as{' '}
                  <span className="font-medium text-ink-2">{session.email}</span>
                </>
              ) : (
                'Signed in'
              )}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <ButtonLink href="/select-site" variant="secondary" size="sm">
                <Icons.Store size={16} />
                Choose another store
              </ButtonLink>
              {/* A form POST rather than a link: signing out changes something,
                  and /api/auth/signout only answers POST. Quiet text so it does
                  not compete with Try again above, which is still the first
                  thing to do — same treatment as the site picker's own. */}
              <form action="/api/auth/signout" method="post">
                <button
                  data-kit-ok
                  type="submit"
                  className="text-sm text-muted transition hover:text-ink"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
