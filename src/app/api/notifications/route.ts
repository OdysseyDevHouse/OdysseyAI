import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from '@/lib/site/notifications'

/**
 * The bell's data. An API route rather than a server action for the same
 * reason as the search palette: the bell polls on an interval from a client
 * shell component, which is a plain HTTP fetch lifecycle.
 *
 * Deliberately NOT in proxy.ts PUBLIC_PREFIXES — the proxy keeps it behind
 * the session, and requireSiteUser() resolves who is asking per request. What
 * each person sees is decided inside the lib from their own CapabilitySet, so
 * this route cannot become a way to read around permissions.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { site, user, capabilities } = await requireSiteUser()
  const mode = request.nextUrl.searchParams.get('mode')

  const count = await unreadCount(site.id, user.id, capabilities)
  if (mode === 'count') return NextResponse.json({ count })

  const items = await listNotifications(site.id, user.id, capabilities, { limit: 15 })
  return NextResponse.json({
    count,
    items: items.map((n) => ({
      id: n.id,
      event: n.event,
      title: n.title,
      body: n.body,
      href: n.href,
      createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : String(n.createdAt),
      read: n.readAt !== null,
    })),
  })
}

export async function POST(request: NextRequest) {
  const { site, user, capabilities } = await requireSiteUser()
  const body = (await request.json().catch(() => null)) as
    | { action?: string; id?: number }
    | null

  if (body?.action === 'read' && typeof body.id === 'number') {
    await markRead(site.id, user.id, body.id)
    return NextResponse.json({ ok: true })
  }
  if (body?.action === 'read_all') {
    await markAllRead(site.id, user.id, capabilities)
    return NextResponse.json({ ok: true })
  }
  return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 })
}
