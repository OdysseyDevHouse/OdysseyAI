'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import {
  PinPad,
  TextLink,
  Icons,
  PosSignInArt,
  type PosSignInSpecial,
} from '@/components/ui'
import { tillSignInAction } from './pinActions'
import {
  signInOffline,
  startOfflineSession,
  canSignInOffline,
  type OfflineSession,
} from '@/lib/posOffline/signInOffline'
import { ensureWindowId } from '@/lib/windowSession'

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
  backdropUrl = '',
  logoUrl = '',
  specials = [],
  onOfflineSignIn,
}: {
  siteId: number
  siteName: string
  /**
   * The shop's own picture behind the showcase half, or '' for the brand
   * gradient. Resolved by the server page — see lib/site/posSignInArt.
   */
  backdropUrl?: string
  /** The shop's logo, or '' to fall back to the Odyssey wordmark. */
  logoUrl?: string
  /**
   * What the showcase cycles through. Empty is the ordinary case and the
   * panel simply omits the section — see PosSignInArt.
   */
  specials?: PosSignInSpecial[]
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
        /* Minted HERE rather than on mount, so the id exists before the token
           that must carry it. `ensureWindowId` is idempotent — a tab that
           already has one keeps it — so signing out and back in on the same tab
           reuses the id rather than churning it. */
        const result = await tillSignInAction(pin, ensureWindowId())
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
    /*
     * TWO HALVES: a showcase the customer sees, and the pad the cashier uses.
     *
     * The showcase is `hidden lg:flex` inside PosSignInArt, so this collapses to
     * the pad alone on a narrow screen. That is not a fallback — a 1024px counter
     * display shows both, and a small hand-held till has no customer-facing side
     * to speak of, so giving half its width to a photograph would shrink the only
     * thing on the screen anybody has to hit.
     */
    <div className="flex flex-1 gap-4 p-4">
      {/* No wrapper: the panel hides itself below `lg` and fills its half
          above it, so a div doing either of those here would be saying it
          twice — and the two said it differently, which is how the showcase
          ended up a narrow strip with a dead gap beside it. */}
      <PosSignInArt backdropUrl={backdropUrl} logoUrl={logoUrl} specials={specials} />

      {/*
        The sign-in half.

        A fixed 560px beside a flexible showcase, rather than the two sharing the
        width evenly. The pad has ONE correct size — it is sized by the finger,
        not by the display — so every pixel past what it needs belongs to the
        picture. On a very wide counter screen an even split would leave the pad
        marooned in the middle of its own half.
      */}
      {/* A FIXED half, not a flexible one. The pad has one correct size — it is
          sized by the finger, not by the display — so every pixel past what it
          needs belongs to the picture beside it. `lg:w-[560px]` with `lg:grow-0`
          so the width is a ceiling as well as a floor: `w-full` alone let the
          pad's own `w-fit` content push this half out to most of the screen. */}
      <div className="flex w-full shrink-0 flex-col items-center justify-center gap-6 p-2 lg:w-[560px] lg:grow-0">
        {/* The way out, top-right of its own half — matching where a window's
            close affordance lives, and out of the pad's way. It used to sit
            below the card with the clock; on the split screen that put the exit
            at the bottom of the one column somebody is reaching into. */}
        <div className="flex w-full justify-end">
          <TextLink
            href="/dashboard"
            className="inline-flex items-center gap-1 text-[13px] font-semibold"
          >
            <Icons.ChevronLeft size={15} />
            Back to Back Office
          </TextLink>
        </div>

        {/*
          NO CARD around the pad any more.

          The whole half is already a surface with the showcase beside it, and a
          bordered card floating inside it was the double frame — a box drawn on
          a box. The pad's own keys carry the structure; see the measurements in
          the old card comment for why sizing it by anything but the pad went
          wrong twice.
        */}
        <div className="flex w-fit flex-col items-center">
          {/* The wordmark, above the pad rather than above the whole screen.
              The customer-facing half now carries the SHOP's identity, so ours
              belongs over the part the staff use. */}
          <Image
            src="/logo-full.png"
            alt="Odyssey Point of Sale"
            width={1109}
            height={304}
            className="logo-plate mb-6 h-14 w-auto object-contain"
            priority
            unoptimized
          />

          {/* A tinted lock disc, so the heading has something to sit under and
              the column has a top. Same idiom as the kit's empty states. */}
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-soft text-brand">
            <Icons.Lock size={20} />
          </span>

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
            <div className="mt-3 flex max-w-[510px] items-start gap-2 text-[12px] text-muted">
              <Icons.Offline size={15} className="mt-0.5 shrink-0" />
              <p>
                This till needs a connection to sign in. Each person should enter their
                PIN once while online so it works offline afterwards.
              </p>
            </div>
          )}
        </div>

        {/* The shop and the clock, quiet, at the foot of the column. The one
            fact a cashier checks against the till before starting a shift. */}
        <div className="flex flex-col items-center gap-1">
          <p className="text-[13px] text-muted">{siteName}</p>
          <TillClock />
        </div>
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
