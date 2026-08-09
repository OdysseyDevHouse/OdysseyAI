'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, PinPad, Button, Icons } from '@/components/ui'
import { tillSignInAction } from '@/app/(app)/sales/new/pinActions'
import {
  signInOffline,
  startOfflineSession,
  canSignInOffline,
  type OfflineSession,
} from '@/lib/posOffline/signInOffline'

/**
 * The PIN prompt in front of the touch till.
 *
 * Reuses `tillSignInAction` while there is a network rather than getting its own:
 * there is one answer to "who is standing at this till", it is a bcrypt check
 * against `users.pin_hash`, and a second copy is a second place for the lockout
 * rules and the site check to drift.
 *
 * ── AND ONE MORE PATH, WHICH IS THE WHOLE POINT ───────────────────────────
 *
 * A till that has been offline overnight opens to this screen with no connection.
 * Without a local check the shop cannot start trading at all — the outbox is
 * unreachable, the basket is unreachable, and nobody at a counter at 07:00 can fix
 * it. So a failed or unreachable server check falls through to `signInOffline`,
 * which derives a PBKDF2 verifier from the PIN and compares it against what this
 * device holds.
 *
 * The fallback is deliberately NOT tried first. While the server is reachable it is
 * the better authority — it knows about a PIN changed five minutes ago on another
 * machine, and the local verifiers are only as fresh as the last catalog.
 */
export default function PosGate({
  siteId,
  siteName,
  onOfflineSignIn,
}: {
  siteId: number
  siteName: string
  /**
   * Called when somebody signed in against this device's own verifiers.
   *
   * A callback rather than a `router.refresh()` because the resulting session is in
   * IndexedDB and the server cannot see it — so the client has to carry the fact
   * upwards. The online path needs no equivalent: it mints a real cookie, and
   * re-rendering the server component is what picks that up.
   */
  onOfflineSignIn: (session: OfflineSession) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [offlineReady, setOfflineReady] = useState<boolean | null>(null)
  const router = useRouter()

  /* Whether an offline sign-in is even possible here, so the screen can say so
     BEFORE somebody types a correct PIN and has it refused. Resolved after mount
     because it reads IndexedDB. */
  useEffect(() => {
    let cancelled = false
    void canSignInOffline(siteId).then((ready) => {
      if (!cancelled) setOfflineReady(ready)
    })
    return () => {
      cancelled = true
    }
  }, [siteId])

  function submit(pin: string) {
    setError(null)
    startTransition(async () => {
      /*
       * The server first, and a THROW is treated the same as a refusal to answer —
       * not the same as a refusal. A dead line, a 500 and a redirect all land here,
       * and every one of them means "ask the till itself" rather than "this PIN is
       * wrong".
       */
      try {
        const result = await tillSignInAction(pin)
        if (result.ok) {
          // The server component re-reads the till cookie and renders the basket.
          router.refresh()
          return
        }
        /*
         * A REAL refusal from the server is final.
         *
         * Falling back here would be the bug that matters: a PIN the server has just
         * revoked would still open the till, on a machine whose stored verifier has
         * not caught up yet. `clearPin` deletes those verifiers for exactly this
         * reason, but only the next catalog refresh delivers that deletion.
         */
        setError(result.error)
        return
      } catch {
        // Unreachable. Fall through.
      }

      const offline = await signInOffline(siteId, pin)
      if (!offline.ok) {
        setError(offline.error)
        return
      }
      const session = await startOfflineSession(siteId, offline.operator)
      /*
       * NOT `router.refresh()`.
       *
       * That re-runs the server component, which reads the till COOKIE — and there is
       * no server to mint one, so it would render this same gate again and the PIN
       * would appear to do nothing. The offline session lives in IndexedDB, which the
       * server cannot see, so the parent is told directly.
       */
      onOfflineSignIn(session)
    })
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-6 px-6 py-8">
          <div className="text-center">
            {/* Round because it is an identity mark, not a control — the same
                tinted-glyph idiom as SettingRow's icon tile. */}
            <div
              data-kit-ok
              className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full bg-brand-soft"
            >
              <Icons.KeyRound size={26} className="text-brand" />
            </div>
            <h2 className="text-xl font-semibold text-ink">Enter your PIN</h2>
            <p className="text-sm text-muted">{siteName}</p>
          </div>

          <PinPad onSubmit={submit} error={error} busy={pending} />

          {/* Said only when it is FALSE and known.
              A till that cannot sign anybody in without the network is one somebody
              needs to fix before the line drops, not after — and while it is true
              there is nothing useful to announce. */}
          {offlineReady === false && (
            <p className="text-center text-xs text-muted">
              This till needs a connection to sign in. Each person should enter their
              PIN once while online so it works offline afterwards.
            </p>
          )}

          {/* The way out. A till with no exit is a machine somebody has to
              restart to get back to the back office. */}
          <Button variant="ghost" size="sm" onClick={() => router.push('/dashboard')}>
            Back to the back office
          </Button>
        </div>
      </Card>
    </div>
  )
}
