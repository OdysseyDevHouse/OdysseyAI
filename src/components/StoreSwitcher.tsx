'use client'

import { useEffect, useRef, useState } from 'react'
import { Store, ChevronDown, Check } from 'lucide-react'
import { selectSiteAction } from '@/app/select-site/actions'

export type SwitcherSite = {
  id: number
  displayName: string
  code: string
  role: string
  status: string
}

export default function StoreSwitcher({
  sites,
  currentId,
}: {
  sites: SwitcherSite[]
  currentId: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const current = sites.find((s) => s.id === currentId)

  // Close on outside click and on Escape — a dropdown that only closes by
  // re-clicking the trigger feels broken.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // One store means nothing to switch to — show it as a plain label.
  if (sites.length <= 1) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm">
        <Store size={15} className="shrink-0 text-muted" />
        <span className="max-w-48 truncate font-medium text-ink">
          {current?.displayName ?? 'No store'}
        </span>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm transition hover:bg-surface-2"
      >
        <Store size={15} className="shrink-0 text-muted" />
        <span className="max-w-48 truncate font-medium text-ink">
          {current?.displayName ?? 'Choose a store'}
        </span>
        <ChevronDown size={15} className="shrink-0 text-muted" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-72 overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
        >
          <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted">
            Switch store
          </div>
          <ul className="max-h-80 overflow-y-auto py-1">
            {sites.map((site) => {
              const active = site.id === currentId
              return (
                <li key={site.id}>
                  {/* A form per row rather than one form with a value: the
                      server action re-checks access for THIS user before it
                      writes the site into the session. */}
                  <form action={selectSiteAction}>
                    <input type="hidden" name="siteId" value={site.id} />
                    <button
                      type="submit"
                      role="menuitem"
                      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-surface-2 ${
                        active ? 'text-brand' : 'text-ink'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{site.displayName}</span>
                        <span className="block truncate text-xs text-muted">
                          {site.code}
                          {site.status === 'suspended' && ' · suspended'}
                        </span>
                      </span>
                      {active && <Check size={15} className="shrink-0" />}
                    </button>
                  </form>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
