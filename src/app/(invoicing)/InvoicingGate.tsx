'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { Card, Icons, PinPad } from '@/components/ui'
import { counterSignInAction } from './pinActions'
import { ensureWindowId } from '@/lib/windowSession'

/**
 * The PIN prompt in front of the invoicing counter.
 *
 * ── WHY THE COUNTER GETS A GATE AT ALL ────────────────────────────────────
 *
 * Same reason the till has one. The browser session says which COMPANY's data
 * is open and lasts twelve hours; it does not say who is standing at the
 * counter, and a trade counter swaps that person several times a day. Without
 * this, every invoice typed here is attributed to whoever opened the browser
 * that morning — which is the till's original bug, on a screen that writes the
 * same documents.
 *
 * So this reuses the till's identity wholesale: the same `odyssey_till` cookie,
 * the same bcrypt check against `users.pin_hash`, the same `sales.till` gate.
 * A counter clerk who has signed in at the till is already signed in here, and
 * that is correct — it is one person, one shop, one PIN.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * No offline fallback. The till carries PBKDF2 verifiers in IndexedDB so a shop
 * with a dead server can still open in the morning; invoicing has a service
 * worker for its shell but no verifier store, so an offline PIN check here
 * would have nothing to check against. Rather than pretend, the gate needs the
 * line — and says so when it cannot reach it.
 */
export default function InvoicingGate({ siteName }: { siteName: string }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const router = useRouter()

  /* Refusals so far, which is what shakes the pad. A COUNT rather than a flag:
     two wrong PINs carry the same message, so `error` does not change between
     them and only this moving tells the pad a second attempt was refused. */
  const [rejects, setRejects] = useState(0)
  function refuse(message: string) {
    setError(message)
    setRejects((n) => n + 1)
  }

  function submit(pin: string) {
    setError(null)
    startTransition(async () => {
      try {
        /* This tab's id, minted before the token that must carry it — the
           counter session dies when this window does. See windowSession.ts. */
        const result = await counterSignInAction(pin, ensureWindowId())
        if (!result.ok) {
          refuse(result.error)
          return
        }
        /* The layout re-reads the till cookie on the server and renders the
           counter. Same mechanism the till uses after an online sign-in. */
        router.refresh()
      } catch {
        /* Unreachable server. Said plainly rather than as "wrong PIN", which
           would send somebody hunting for a typo in a correct number. */
        refuse('Cannot reach the server. Invoicing needs a connection to sign in.')
      }
    })
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      {/*
        THE MARK PLUS THE WINDOW'S OWN NAME, not `logo-full.png`.

        That artwork reads "POINT OF SALE" in the image itself, which is the
        wrong product on a counter that writes invoices — and it is a raster,
        so the words cannot be swapped. The icon carries the brand and the
        lockup beside it says which window this is, set exactly as the chrome
        behind this gate sets it, so signing in and being signed in agree.
      */}
      <span className="flex items-center gap-3">
        <Image
          src="/logo-icon.png"
          alt=""
          aria-hidden
          width={318}
          height={278}
          className="h-14 w-auto object-contain"
          priority
          unoptimized
        />
        <span className="wordmark-lockup text-3xl leading-none text-ink">
          Odyssey <span className="font-bold text-brand">Invoicing</span>
        </span>
      </span>

      <Card>
        {/* Sized by the PAD and nothing else — see PosGate for the measurements
            behind `w-fit` plus a capped text width. */}
        <div className="w-fit p-6">
          <h2 className="mb-1 max-w-[510px] text-center text-[17px] font-bold text-ink">
            Counter sign-in
          </h2>
          <p className="mb-4 max-w-[510px] text-center text-[12.5px] text-muted">
            Enter your PIN to open invoicing at {siteName}
          </p>

          <PinPad wide onSubmit={submit} error={error} busy={pending} rejectedAt={rejects} />

          {/*
            ── THE WAY OUT, AND WHY IT IS HERE ──────────────────────────────

            It used to sit in the counter's header, one tap from Save and in the
            corner a hand reaches for, on a screen that usually has a half-typed
            document on it. A control whose only job is to abandon that does not
            belong beside the controls that finish it.

            Here it is harmless and still findable: this screen is what an
            operator sees when they hand over, so somebody who wants the back
            office signs out first — which is the correct order anyway, since
            leaving the counter signed in is what the gate exists to prevent.

            A plain link, not a Button: it navigates, and it must read as the
            quiet second option beside the pad rather than compete with it.
          */}
          <div className="mt-4 flex justify-center border-t border-border pt-4">
            <Link
              href="/dashboard"
              data-kit-ok
              className="flex h-control items-center gap-2 rounded-control px-3 text-[13px] font-medium text-muted transition hover:bg-brand-soft hover:text-brand"
            >
              <Icons.ArrowLeft size={16} />
              Back to back office
            </Link>
          </div>
        </div>
      </Card>
    </div>
  )
}
