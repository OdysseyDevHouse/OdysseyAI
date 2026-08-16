'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { Card, PinPad, TextLink, Icons } from '@/components/ui'
import { tillSignInAction } from './pinActions'
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

  /* Refusals so far, which is what shakes the pad.
     A COUNT rather than a flag: two wrong PINs in a row carry the same message,
     so `error` does not change between them and only this moving tells the pad
     a second attempt was refused. Every refusal goes through `refuse` below so
     neither the server path nor the offline one can set the message and forget
     the shake. */
  const [rejects, setRejects] = useState(0)
  function refuse(message: string) {
    setError(message)
    setRejects((n) => n + 1)
  }

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
        refuse(result.error)
        return
      } catch {
        // Unreachable. Fall through.
      }

      const offline = await signInOffline(siteId, pin)
      if (!offline.ok) {
        refuse(offline.error)
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
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      {/* The wordmark ABOVE the card, not inside it.
          This is the same front door as the back-office login, and a till standing
          unattended on a counter is the one screen in the product a customer sees
          from across the room. The logo is what it says at that distance. */}
      {/* The plate is the same fix the back-office login makes (see .logo in
          login.module.css): the wordmark in the artwork is dark navy, and on
          the till's dark canvas it all but disappears — on the ONE screen that
          is read from across the room. Light mode needs nothing, so the plate
          is dark-mode only. */}
      <Image
        src="/logo-full.png"
        alt="Odyssey Point of Sale"
        width={1109}
        height={304}
        className="logo-plate h-20 w-auto object-contain"
        priority
        unoptimized
      />

      <Card>
        {/* The card is sized by the PAD and nothing else.
            Two earlier attempts got this wrong and the measurements say why:
            w-fit alone resolved to the widest CHILD, and since the text has no
            width of its own a one-line paragraph stretched the card to 689px
            around a 510px pad — 130px of dead space down the right. Setting
            w-[510px] then overflowed the other way, because border-box counts
            the p-6 INSIDE that width and left the content box at 462px.
            w-fit with the text capped at the pad's width is what holds: the pad
            is the widest child at 510px, the paragraphs wrap to it rather than
            past it, and the padding sits outside on all four sides. */}
        <div className="w-fit p-6">
          <h2 className="mb-1 max-w-[510px] text-center text-[17px] font-bold text-ink">
            Clerk sign-in
          </h2>
          <p className="mb-4 max-w-[510px] text-center text-[12.5px] text-muted">
            Enter your PIN to open the till
          </p>

          <PinPad wide onSubmit={submit} error={error} busy={pending} rejectedAt={rejects} />

          {/* Said only when it is FALSE and known.
              A till that cannot sign anybody in without the network is one somebody
              needs to fix before the line drops, not after — and while it is true
              there is nothing useful to announce. */}
          {offlineReady === false && (
            <p className="mt-3 max-w-[510px] text-center text-[12px] text-muted">
              This till needs a connection to sign in. Each person should enter their
              PIN once while online so it works offline afterwards.
            </p>
          )}
        </div>
      </Card>

      {/* Both below the card, and quiet.
          The way out first — a till with no exit is a machine somebody has to
          restart to get back to the back office — then the clock, which is the
          one fact a cashier checks against the till before they start a shift.

          A LINK rather than a button: it navigates, and a bordered button down
          here would sit at the same visual weight as the keys it is trying not
          to compete with. */}
      <div className="flex flex-col items-center gap-3">
        <TextLink
          href="/dashboard"
          className="inline-flex items-center gap-1 text-[13px] font-semibold"
        >
          <Icons.ChevronLeft size={15} />
          Back to Back Office
        </TextLink>
        <p className="text-[13px] text-muted">{siteName}</p>
        <TillClock />
      </div>
    </div>
  )
}

/**
 * The date and time under the sign-in card.
 *
 * Rendered as nothing on the server and filled in after mount, deliberately.
 * The server's clock formatted into HTML is the server's SECOND, and by the time
 * the browser hydrates it is a different one — which React reports as a mismatch
 * on the one screen that is open all day. It also would not tick.
 *
 * A till sitting on a counter overnight has to still be right in the morning, so
 * this re-reads the clock every 30 seconds rather than trusting the value it was
 * first given.
 */
function TillClock() {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // Holds the line's height before the clock resolves, so the card above does
  // not jump a few pixels the moment it does.
  if (!now) return <p className="text-[13px] text-muted">&nbsp;</p>

  return (
    <p className="text-[13px] text-muted">
      {/* Explicit locale — the server and the browser disagree otherwise, and
          this is a South African till. */}
      {now.toLocaleDateString('en-ZA', { weekday: 'short', day: '2-digit', month: 'short' })}
      {' · '}
      {/* toTimeString rather than toLocaleTimeString: it is 24-hour with no
          locale in play, so the till reads the same on every machine. */}
      {now.toTimeString().slice(0, 5)}
    </p>
  )
}
