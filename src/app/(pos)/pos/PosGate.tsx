'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import {
  PinPad,
  ButtonLink,
  Card,
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
  backdropUrl = '',
  logoUrl = '',
  specials = [],
  onOfflineSignIn,
}: {
  siteId: number
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
     *
     * ── ALL THE SPACING IS ON THIS ELEMENT ───────────────────────────────────
     *
     * `p-8` is the screen's edge and `gap-8` is the middle, and both can be read
     * off the class list rather than added up. It used to be split between here
     * and the column below, which made it neither: the column's own padding
     * added to this one's on the outer side and to the gap on the inner, so the
     * picture sat 16px off the glass while the pad sat 32px off it.
     *
     * ── AND BOTH HALVES ARE NOW FIXED, SO THE PAIR IS CENTRED ─────────────────
     *
     * Neither side grows any more — the showcase is 574 wide and so is the card.
     * Something has to take up the slack on a wide counter screen, and centring
     * the pair is the only answer that keeps them looking like two halves of one
     * thing rather than a block shoved against the left edge.
     *
     * ── WHY THE CENTRING AND THE ROW ARE TWO ELEMENTS ─────────────────────────
     *
     * Because the pad column is TALLER than the card inside it — the way out sits
     * beneath the card, so the column is 706 + 24 + 40 = 770 while the showcase is
     * 706. One element doing both jobs centred a 706 pane against a 770 column and
     * dropped the picture 32px below the card it is supposed to sit beside.
     *
     * So: this element centres the block on the screen, and the row inside it
     * aligns the two panes by their TOPS. The button then hangs below the card
     * without having any say in where the picture sits.
     */
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex w-full items-start justify-center gap-8">
        {/* No wrapper: the panel hides itself below `lg` and states its own
            574×706 above it, so a div doing either of those here would be saying
            it twice — and the two said it differently, which is how the showcase
            once ended up a narrow strip with a dead gap beside it. */}
        <PosSignInArt backdropUrl={backdropUrl} logoUrl={logoUrl} specials={specials} />

        {/*
          The sign-in half.

          A fixed 560px beside a flexible showcase, rather than the two sharing the
          width evenly. The pad has ONE correct size — it is sized by the finger,
          not by the display — so every pixel past what it needs belongs to the
          picture. On a very wide counter screen an even split would leave the pad
          marooned in the middle of its own half.
        */}
        {/* 574px, the same as the showcase — and the same as the card inside it,
            which is the PIN pad's 510 plus its own padding. The pad has one correct
            size, sized by the finger rather than by the display, and stating that
            width here rather than letting the card's `w-fit` set it is what keeps
            the button below centred on the card rather than on the column.

            It was 560 while the card had no padding of its own, which left the card
            14px wider than the half containing it. */}
        {/* `justify-center` on the column, centring the PAIR — the card and the
            way out beneath it now read as one stack, so one rule for both is the
            honest description. It was one rule per child while the exit was pinned
            to the top of the half.

            In flow, with a gap, rather than either of them positioned absolutely:
            on a short counter screen the two must push each other rather than
            overlap, and an absolutely placed exit let a tall pad slide underneath
            it. */}
        <div className="flex w-full max-w-full shrink-0 flex-col items-center gap-6 lg:w-[574px]">
          {/*
            A CARD around the pad.

            The half it sits in is `bg-canvas` — the till shell's grey — so this
            lifts the one part of the screen a cashier touches onto white, the way
            every other block of content in the product sits on a surface. The
            kit's own `Card`, not a hand-rolled box, so its radius, border and
            shadow move when the kit's do.

            `w-fit` stays on it rather than moving inside: the card is sized by the
            PAD, which has one correct width. Sizing it by anything but the pad
            went wrong twice before — a percentage width left the keys marooned in
            a card far wider than they were. The vertical centring is the column's
            now, not this element's, because there are two things to centre.
          */}
          <Card className="w-fit">
            <div className="flex flex-col items-center p-8">
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
                <div className="mt-4 flex max-w-[510px] items-center gap-3 text-[12.5px] text-muted">
                  {/* On a tinted disc, the same idiom as the lock above it. A 15px
                      glyph loose beside three lines of grey text read as a bullet
                      point; this is the one standing condition on the screen that a
                      manager has to notice and act on before the queue arrives.

                      `Wifi` rather than `Offline`: the till is not offline right now
                      — it is being told it will not COPE with being offline, because
                      nobody here has signed in while connected yet. */}
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                    <Icons.Wifi size={20} />
                  </span>
                  <p className="leading-relaxed">
                    This till needs a connection to sign in. Each person should enter their
                    PIN once while online so it works offline afterwards.
                  </p>
                </div>
              )}
            </div>
          </Card>

          {/* The way out, UNDER the card and centred on it — the last thing in the
              column rather than the first. A cashier standing at this screen is
              here to sign in; the exit is the rarer act, and reading order should
              put the thing somebody came to do above the thing they occasionally
              want instead.

              A BUTTON rather than a text link, and `contrast` rather than any of
              the blues. This is a touch screen — a 13px underlined link is not a
              target a finger can take — and it is the only control on the half
              besides the pad, so it has to be found without being hunted for. The
              blues are all spoken for: the confirm key, the lock disc and the
              showcase beside it. Dark-on-light (and light-on-dark under a
              cashier's dark theme) is the one register nothing else here uses.

              The chevron points RIGHT, following the words rather than leading
              them — this is a departure to another place, not a step back through
              a screen the cashier came from. Landmark is the back office as an
              institution, matching the sidebar's own mark for it. */}
          <ButtonLink href="/dashboard" variant="contrast">
            <Icons.Landmark size={17} />
            Back to Back Office
            <Icons.ChevronRight size={16} />
          </ButtonLink>
        </div>
      </div>
    </div>
  )
}
