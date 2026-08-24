'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button, Card, Icons } from '@/components/ui'
import { deviceId } from '@/lib/deviceId'
import { checkDeviceAction } from '@/app/(pos)/pos/deviceActions'
import type { DeviceState } from '@/lib/control/deviceMessages'

/**
 * On the DESKTOP build, the licence gates the whole application.
 *
 * ── WHY THE BACK OFFICE TOO, AND NOT JUST THE TILL ─────────────────────────
 *
 * A browser is a way of reaching a shop's data from anywhere — a manager on a
 * laptop, an owner at home — so licensing it per device would charge for
 * something that has no fixed device. The desktop app is the opposite: it is an
 * installation, sitting on one machine in one shop, and that machine IS the
 * thing being sold. So the whole install is licensed, not just the till screen
 * inside it.
 *
 * The web build is untouched by this. There, only /pos is licensed and the back
 * office stays open to any browser — which is what makes a laptop useful.
 *
 * ── THE ONE DOOR LEFT OPEN, AND WHY IT MUST BE ─────────────────────────────
 *
 * Linking a machine to a licence happens in Setup → Tills, which is itself a
 * back-office screen. Gate that too and a fresh install can never be licensed
 * from itself: it would show a blocked screen naming a device number, with the
 * only remedy on a machine somebody would have to go and find. So Setup → Tills
 * stays reachable, and everything else waits behind the licence.
 */

/** Reachable on an unlicensed desktop install, so it can license itself. */
const BOOTSTRAP_PATHS = ['/setup/terminals']

export default function DesktopLicenceGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [licence, setLicence] = useState<DeviceState | undefined>(undefined)
  const [serial, setSerial] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    const id = deviceId()
    setSerial(id)

    /* No identifier at all — a locked-down profile where storage is refused.
       Allowed through, the same decision the till and the sale path make: a
       machine that cannot identify itself is a support problem, not a reason to
       stop a shop working. */
    if (!id) {
      setLicence({ status: 'licensed', terminalId: null, name: '', trialEndsOn: null })
      return
    }

    void checkDeviceAction(id)
      .then((state) => {
        if (!cancelled) setLicence(state)
      })
      .catch(() => {
        /* Cannot reach the control database. Trade on — the same trade every
           other licence check in this app makes, and for the same reason: a shop
           stopped by a licence server hiccup is a far worse failure than a few
           minutes of unverified use. */
        if (!cancelled) {
          setLicence({ status: 'licensed', terminalId: null, name: '', trialEndsOn: null })
        }
      })

    return () => {
      cancelled = true
    }
  }, [nonce])

  // Always reachable, so a new install can be licensed from itself.
  if (BOOTSTRAP_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return <>{children}</>
  }

  /* Not asked yet. Render the app rather than a blank: the check takes a moment,
     and flashing a "not licensed" screen at a perfectly licensed shop on every
     single page load would be worse than the moment of trust. Anything the user
     does in that window is still refused server-side by the sale path. */
  if (licence === undefined || licence.status === 'licensed') return <>{children}</>

  return <DesktopBlocked message={licence.message} serial={serial} onRetry={() => setNonce((n) => n + 1)} />
}

function DesktopBlocked({
  message,
  serial,
  onRetry,
}: {
  message: string
  serial: string | null
  onRetry: () => void
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas p-6">
      <Card>
        <div className="flex max-w-lg flex-col items-center gap-4 p-6 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-pill bg-warning-soft text-warning-ink">
            <Icons.StatusWarning size={28} />
          </span>

          <div>
            <h1 className="text-lg font-bold text-ink">This installation is not licensed</h1>
            <p className="mt-2 text-sm text-muted">{message}</p>
          </div>

          {/* The device number is what support asks for, and on a desktop till it
              is the only way to identify the machine — so it is shown here rather
              than only on a screen this person cannot reach. */}
          {serial && (
            <div className="w-full rounded-control border border-border bg-surface-2 px-4 py-3">
              <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                Device number
              </span>
              <code className="mt-1 block select-all break-all text-[13px] text-ink">{serial}</code>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="secondary" size="touch" onClick={onRetry}>
              <Icons.Refresh size={18} />
              Check again
            </Button>
            {/* The one door left open. A supervisor signs in here and links this
                machine, which is the only way a fresh install becomes usable. */}
            <Button
              variant="primary"
              size="touch"
              onClick={() => (window.location.href = '/setup/terminals')}
            >
              <Icons.ArrowRight size={18} />
              Set up this machine
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
