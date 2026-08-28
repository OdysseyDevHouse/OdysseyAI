'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { PinPad, ButtonLink, Icons, PosSignInArt, type PosSignInSpecial } from '@/components/ui'
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
  siteName = '',
  backdropUrl = '',
  logoUrl = '',
  specials = [],
  onOfflineSignIn,
}: {
  siteId: number
  /**
   * The shop's name, for the greeting on the showcase half.
   *
   * Already on the session's site as `displayName` and relayed down by
   * PosEntry, rather than fetched here: the gate is a client component and this
   * screen stands between a cashier and the till at 07:00, so a round trip to
   * learn the name of the shop the till already belongs to is a round trip
   * somebody waits through.
   */
  siteName?: string
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
     * TWO HALVES OF ONE CARD: a showcase the customer sees, and the pad the
     * cashier uses.
     *
     * The showcase is `hidden lg:flex` inside PosSignInArt, so this collapses to
     * the pad alone on a narrow screen. That is not a fallback — a 1024px counter
     * display shows both, and a small hand-held till has no customer-facing side
     * to speak of, so giving half its width to a photograph would shrink the only
     * thing on the screen anybody has to hit.
     *
     * ── ONE CARD NOW, NOT TWO PANES WITH A GAP ──────────────────────────
     *
     * The picture and the pad used to be two rounded cards with 32px of till
     * shell showing between them, which read as two unrelated things that
     * happened to be side by side. They are one object: the shop on the left,
     * the way in on the right, and the seam between them is where the dark
     * stops and the white starts rather than a gutter.
     *
     * So the rounding, the shadow and the clipping all live HERE, on the
     * container, and neither half carries any of its own. `items-stretch` is
     * what makes the seam run the full height — the halves state the same 706px
     * and would line up anyway, but a stretch means a later change to one of
     * them cannot leave a notch in the other.
     *
     * `overflow-hidden` is doing real work and not just tidiness: the showcase
     * paints an absolutely-positioned photograph across its whole pane, and
     * without the clip that photograph squares off the two left corners the
     * radius here is trying to round.
     */
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-full items-stretch overflow-hidden rounded-card shadow-card">
        {/* No wrapper: the panel hides itself below `lg` and states its own
            width and height above it, so a div doing either of those here would
            be saying it twice — and the two said it differently, which is how the
            showcase once ended up a narrow strip with a dead gap beside it. */}
        <PosSignInArt
          backdropUrl={backdropUrl}
          logoUrl={logoUrl}
          siteName={siteName}
          specials={specials}
        />

        {/*
          The sign-in half.

          574px, which is the PIN pad's 510 plus its own padding. The pad has ONE
          correct size — it is sized by the finger, not by the display — so every
          pixel past what it needs belongs to the picture. On a very wide counter
          screen an even split would leave the pad marooned in the middle of its
          own half.

          `bg-surface` rather than the till shell's `bg-canvas`: this is the part
          a cashier touches, and it sits on white the way every other block of
          content in the product does. It is not the kit's `Card` any more,
          because the card is now the container above — this is one half of it,
          and a Card inside a Card would draw a second border down the seam.

          The stack is CENTRED in the half rather than starting at the top. The
          pad is the whole reason the screen exists, and hanging it from the top
          with the slack at the foot left it sitting high against the greeting
          opposite.
        */}
        <div className="flex h-[706px] max-h-full w-[574px] max-w-full shrink-0 flex-col items-center justify-center bg-surface px-8 py-10">
          {/* No Odyssey wordmark over this half any more. It sat above the
              heading when the customer-facing side carried no words of its own;
              the greeting opposite now names the shop, and our own mark facing
              the cashier as well made two brands on one card. The wordmark is
              still the fallback on the showcase for a shop with no logo. */}
          <h2 className="text-[22px] font-extrabold tracking-tight text-ink">Clerk sign-in</h2>
          <p className="mt-1.5 text-[13px] text-muted">Enter your 4-digit PIN to open the till</p>

          {/* `display="dots"` rather than the pad's default entry box. The two
              lines above already say what to type, and the box carried an
              "Enter PIN" prompt that repeated them — see PinPad. */}
          <div className="mt-7">
            <PinPad
              wide
              display="dots"
              submitLabel="Open till"
              onSubmit={submit}
              error={error}
              busy={pending}
              rejectedAt={rejects}
            />
          </div>

          {/* Said only when it is FALSE and known.
              A till that cannot sign anybody in without the network is one somebody
              needs to fix before the line drops, not after — and while it is true
              there is nothing useful to announce. */}
          {offlineReady === false && (
            <div className="mt-6 flex max-w-[510px] items-center gap-3 text-[12.5px] text-muted">
              {/* On a tinted disc. A 15px glyph loose beside three lines of grey
                  text read as a bullet point; this is the one standing condition
                  on the screen that a manager has to notice and act on before the
                  queue arrives.

                  `Wifi` rather than `Offline`: the till is not offline right now
                  — it is being told it will not COPE with being offline, because
                  nobody here has signed in while connected yet. */}
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                <Icons.Wifi size={20} />
              </span>
              <p className="leading-relaxed">
                This till needs a connection to sign in. Each person should enter their PIN
                once while online so it works offline afterwards.
              </p>
            </div>
          )}

          {/* ── The footer ──────────────────────────────────────────────── */}
          {/* Both of the things somebody does when the pad is NOT what they
              wanted, kept together and kept quiet. Neither competes with the
              keys above: a cashier standing here is here to sign in. */}
          <div className="mt-7 flex flex-col items-center gap-2.5">
            {/* The answer to the commonest reason a PIN fails, said before
                anybody has to ask. Deliberately NOT a control — there is nothing
                for the person at the till to press, and a button here would
                promise a self-service reset the product does not offer. */}
            <p className="flex items-center gap-1.5 text-[12.5px] text-muted">
              <Icons.Lock size={13} className="shrink-0" />
              Forgot your PIN? Ask a manager to reset it.
            </p>

            {/* The way out, and the only one — without it the till is a dead end
                and the back office is reachable only by typing a URL.

                A BUTTON rather than a text link even at this size: this is a
                touch screen, and a 13px underlined link is not a target a finger
                can take. `ghost` and `sm` keep it quiet enough not to compete
                with the pad, which is what it was doing as a full-size dark
                button under a card of its own.

                The chevron points RIGHT, following the words rather than leading
                them — this is a departure to another place, not a step back
                through a screen the cashier came from. Landmark is the back
                office as an institution, matching the sidebar's own mark for it. */}
            <ButtonLink href="/dashboard" variant="ghost" size="sm">
              <Icons.Landmark size={15} />
              Back to Back Office
              <Icons.ChevronRight size={14} />
            </ButtonLink>
          </div>
        </div>
      </div>
    </div>
  )
}
