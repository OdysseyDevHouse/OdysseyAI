import { NextResponse } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { touchDevice, isValidDeviceId, type DeviceKind } from '@/lib/site/devices'

/**
 * "This machine exists, and somebody is using it."
 *
 * ── WHY A ROUTE AND NOT A SERVER ACTION ───────────────────────────────────
 *
 * It is fired from a mount effect on every back-office page load, and it must
 * be able to fail without anybody noticing. A server action that throws inside
 * a transition surfaces; this swallows everything and returns 200, because a
 * machine that cannot register itself must still be able to work — the only
 * thing it loses is a row in a setup list. Same reasoning as /api/pos/catalog.
 *
 * ── WHY BACK-OFFICE MACHINES NEED IT AT ALL ───────────────────────────────
 *
 * A till registers itself through the catalog feed, which already carries its
 * device id. An office PC never opens the till, so nothing would ever tell the
 * shop it exists — and it is exactly the machine that needs its own answer for
 * where an A4 invoice goes. Without this, Setup → Printing could only ever
 * configure tills.
 */
export const dynamic = 'force-dynamic'

const KINDS: readonly DeviceKind[] = ['desktop', 'browser', 'android', 'unknown']

export async function POST(request: Request) {
  /* Signed in, and signed in to THIS site. The device id is a parameter and
     never a credential, so the session is what says which shop's table this
     row may be written to. */
  const { site } = await requireSiteUser()

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const deviceId = String(body.deviceId ?? '')
  if (!isValidDeviceId(deviceId)) return NextResponse.json({ ok: false }, { status: 400 })

  const kind = String(body.kind ?? 'unknown') as DeviceKind

  await touchDevice(site.id, {
    deviceId,
    label: String(body.label ?? ''),
    kind: KINDS.includes(kind) ? kind : 'unknown',
    platform: String(body.platform ?? ''),
    appRole: String(body.appRole ?? ''),
  })

  return NextResponse.json({ ok: true })
}
