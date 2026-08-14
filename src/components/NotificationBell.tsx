'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell } from '@/components/ui/icons'
import { Button, TextLink } from '@/components/ui'

/**
 * The bell — unread count and the recent feed, in the top bar.
 *
 * Freshness is polling, honestly: there is no socket infrastructure in this
 * app, so the count refetches on navigation and once a minute while the tab
 * is visible. The list itself is fetched lazily when the panel opens.
 *
 * Not the kit Menu, deliberately: Menu closes on any click inside, which
 * would dismiss the panel the moment somebody presses "Mark all read".
 */

type Item = {
  id: number
  event: string
  title: string
  body: string | null
  href: string | null
  createdAt: string
  read: boolean
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

export default function NotificationBell({ initialCount }: { initialCount: number }) {
  const [count, setCount] = useState(initialCount)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Item[] | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const pathname = usePathname()
  const router = useRouter()

  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?mode=count')
      if (!res.ok) return
      const data = (await res.json()) as { count: number }
      setCount(data.count)
    } catch {
      // A failed poll keeps the last count — never an error surface.
    }
  }, [])

  // On navigation, and once a minute while the tab is actually being looked at.
  useEffect(() => {
    void refreshCount()
  }, [pathname, refreshCount])
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void refreshCount()
    }
    const timer = setInterval(tick, 60_000)
    return () => clearInterval(timer)
  }, [refreshCount])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const openPanel = async () => {
    const next = !open
    setOpen(next)
    if (!next) return
    try {
      const res = await fetch('/api/notifications')
      if (!res.ok) return
      const data = (await res.json()) as { count: number; items: Item[] }
      setCount(data.count)
      setItems(data.items)
    } catch {
      setItems([])
    }
  }

  const markAllRead = async () => {
    setCount(0)
    setItems((prev) => prev?.map((i) => ({ ...i, read: true })) ?? prev)
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'read_all' }),
    }).catch(() => undefined)
  }

  const openItem = async (item: Item) => {
    setOpen(false)
    if (!item.read) {
      setCount((c) => Math.max(0, c - 1))
      await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'read', id: item.id }),
      }).catch(() => undefined)
    }
    if (item.href) router.push(item.href)
  }

  return (
    <div ref={panelRef} className="relative">
      <div className="relative">
        <Button
          variant="bare"
          iconOnly
          title="Notifications"
          aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
          onClick={() => void openPanel()}
        >
          <Bell size={18} />
        </Button>
        {count > 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-pill bg-danger px-1 text-[10px] font-semibold leading-none text-white"
          >
            {count > 9 ? '9+' : count}
          </span>
        )}
      </div>

      {open && (
        <div className="absolute right-0 z-50 mt-1.5 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold text-ink">Notifications</span>
            {count > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
                Mark all read
              </Button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items === null ? (
              <p className="px-3 py-6 text-center text-sm text-muted">Loading…</p>
            ) : items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted">You are up to date.</p>
            ) : (
              items.map((item) => (
                /* A multi-line selectable row, not a labelled action — the kit
                   Button's padding and single-line layout cannot express it. */
                <button
                  data-kit-ok
                  key={item.id}
                  type="button"
                  onClick={() => void openItem(item)}
                  className="flex w-full items-start gap-2.5 border-b border-border px-3 py-2.5 text-left transition hover:bg-surface-2"
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 size-2 shrink-0 rounded-pill ${item.read ? 'bg-border' : 'bg-brand'}`}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{item.title}</span>
                    {item.body && (
                      <span className="block truncate text-xs text-muted">{item.body}</span>
                    )}
                    <span className="block text-xs text-faint">{timeAgo(item.createdAt)}</span>
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-border px-3 py-2 text-center text-sm">
            <TextLink href="/notifications" onClick={() => setOpen(false)}>
              See all notifications
            </TextLink>
          </div>
        </div>
      )}
    </div>
  )
}
