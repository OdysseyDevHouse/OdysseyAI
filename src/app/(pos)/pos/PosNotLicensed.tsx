'use client'

import Image from 'next/image'
import { Button, Card, Icons } from '@/components/ui'

/**
 * The till, refused.
 *
 * ── WHY THIS IS A WHOLE SCREEN AND NOT A BANNER ────────────────────────────
 *
 * Because nothing on the till works without a licence, and a banner over a
 * working-looking till invites somebody to try ringing a sale up anyway — which
 * fails at the tender pad, in front of a customer, with a basket already built.
 * Refusing at the door costs one screen and saves that.
 *
 * ── WHAT IT HAS TO CONTAIN ─────────────────────────────────────────────────
 *
 * Whoever reads this cannot fix it. They are usually mid-service. So the screen
 * has exactly three jobs: say what is wrong in a sentence, show the device
 * number support will ask for, and offer the one door that is still open — the
 * back office, on this same machine, where a manager can release a licence or
 * find the phone number.
 */
export default function PosNotLicensed({
  message,
  serial,
  onRetry,
}: {
  /** The specific refusal, from `deviceLabelFor`. */
  message: string
  /** This machine's id. The one thing support needs to find the licence. */
  serial: string | null
  /** Re-ask the server — for the case where somebody just freed a licence. */
  onRetry: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <Image
        src="/logo-full.png"
        alt="Odyssey Point of Sale"
        width={1109}
        height={304}
        className="h-16 w-auto object-contain dark:rounded-card dark:bg-white dark:px-3 dark:py-2"
        priority
        unoptimized
      />

      <Card>
        <div className="flex max-w-lg flex-col items-center gap-4 p-6 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-pill bg-warning-soft text-warning-ink">
            <Icons.StatusWarning size={28} />
          </span>

          <div>
            <h1 className="text-lg font-bold text-ink">This device is not set up as a till</h1>
            <p className="mt-2 text-sm text-muted">{message}</p>
          </div>

          {/* WHAT HAPPENS NEXT, in the order it happens.
              The person reading this cannot fix it — they need a supervisor —
              so the screen's job is to make the request precise enough that the
              supervisor can act on it without a second trip. */}
          <ol className="w-full list-decimal space-y-1 rounded-control border border-border bg-surface-2 py-3 pl-8 pr-4 text-left text-[13px] text-ink-2">
            <li>Ask a supervisor to sign in to the back office.</li>
            <li>
              Open <span className="font-semibold text-ink">Setup → Tills</span>, on{' '}
              <span className="font-semibold text-ink">this machine</span>.
            </li>
            <li>
              Under <span className="font-semibold text-ink">Till licences</span>, choose{' '}
              <span className="font-semibold text-ink">Use this machine</span>.
            </li>
          </ol>

          {/* The device number, in a shape somebody can read down a phone line.
              Selectable rather than a button: a till with no licence may also
              have no clipboard permission, and "tap to copy" that silently does
              nothing is worse than plain text. */}
          {serial && (
            <div className="w-full rounded-control border border-border bg-surface-2 px-4 py-3">
              <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                Device number
              </span>
              <code className="mt-1 block select-all break-all text-[13px] text-ink">{serial}</code>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            {/* Somebody may have just released a licence in the back office on
                another machine. Re-asking is cheaper than explaining a reload. */}
            <Button variant="secondary" size="touch" onClick={onRetry}>
              <Icons.Refresh size={18} />
              Check again
            </Button>
            {/* The back office still works on this machine — deliberately. It is
                where a manager releases a spot, and locking them out of it would
                make this screen a dead end. */}
            <Button variant="ghost" size="touch" onClick={() => (window.location.href = '/dashboard')}>
              <Icons.ArrowRight size={18} />
              Back office
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
