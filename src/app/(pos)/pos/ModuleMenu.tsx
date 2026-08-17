'use client'

import { useEffect } from 'react'
import { Button, CategoryTile, Icons, TouchRow, type CategoryTone } from '@/components/ui'
import type { DraftDocType } from '@/lib/posOffline/draftOffline'

/**
 * Which screen the till is showing.
 *
 * `sale` is the till as it has always been — the basket, the catalogue, the
 * tender pad. The others are that SAME trading screen pointed at a different
 * kind of document.
 *
 * Deliberately NOT a fourth piece of state in the shell. Each module is a doc
 * type the basket already carries, and `MODULE_DOC_TYPES` below is the whole of
 * the translation. A separate "current module" variable would be a second
 * answer to a question `state.docType` already answers, and the two would drift
 * the first time anything set one without the other — a recovered draft, a
 * cleared return, an arrival from "New order".
 */
export type TillModule = 'sale' | 'quotes' | 'orders'

/**
 * The document each module writes.
 *
 * A credit sale has no module of its own on purpose: returning is a MODE the
 * till drops into from the refund key and comes back out of, not a place a
 * cashier navigates to and stands in.
 */
export const MODULE_DOC_TYPES: Record<TillModule, DraftDocType> = {
  sale: 'invoice',
  quotes: 'quote',
  orders: 'sales_order',
}

/**
 * What to call a module in a sentence.
 *
 * Not `DRAFT_DOC_LABELS`, which names the DOCUMENT. A cashier who taps "Point
 * of sale" and is then asked about "an invoice" has been asked about something
 * they did not press — and the first build of this asked exactly that, because
 * reusing the document labels was the obvious shortcut.
 *
 * Each entry carries its own article, so nothing has to guess between "a" and
 * "an" from a first letter. That guess is what produced "Start a invoice?".
 */
export const MODULE_PHRASES: Record<TillModule, string> = {
  sale: 'a sale',
  quotes: 'a quote',
  orders: 'an order',
}

/** The inverse, for reading the current module off the basket. */
export function moduleForDocType(docType: DraftDocType): TillModule {
  if (docType === 'quote') return 'quotes'
  if (docType === 'sales_order') return 'orders'
  /* An invoice AND a credit sale both land on the sale screen, because that is
     the screen both are rung up on. */
  return 'sale'
}

/**
 * The modules a shop can be shown, in the order they appear.
 *
 * Ordered by how often a counter reaches for them, not alphabetically: selling
 * is what a till is FOR, and everything else is something you go and do.
 *
 * NO LAY-BYS HERE YET. They are built — in the back office — but the till
 * cannot take a payment against one until the cash-up counts that money, and
 * lay-by takings are currently shown on the declaration while being left out of
 * the expected cash they are counted against. A row here now would be a button
 * that opens nothing, which is the exact complaint that started this work.
 */
export const MODULES: {
  key: TillModule
  label: string
  hint: string
  icon: keyof typeof Icons
  tone: CategoryTone
}[] = [
  /*
   * The hints are SHORT because TouchRow truncates on one line, and that is the
   * kit's decision rather than this screen's to overrule. The first draft wrote
   * a sentence each and the panel showed "Price something up for a custom…" —
   * a hint that stops before the useful half is worse than a brief one.
   */
  {
    key: 'sale',
    label: 'Point of sale',
    hint: 'Ring up and take the money',
    icon: 'ShoppingCart',
    tone: 'emerald',
  },
  {
    key: 'quotes',
    label: 'Quotes',
    hint: 'A price to think about',
    icon: 'FileText',
    tone: 'indigo',
  },
  {
    key: 'orders',
    label: 'Sales orders',
    hint: 'Promised now, delivered later',
    icon: 'ListOrdered',
    tone: 'sky',
  },
]

/**
 * The till's way between its modules.
 *
 * ── WHY A PANEL OVER THE SCREEN, NOT ANOTHER GATE ─────────────────────────
 *
 * The shell already switches between screens — the closed-till gate, the floor
 * gate, the trading columns — as one chain of conditions, and a fourth branch
 * there would have been the obvious place for this. It would also have
 * UNMOUNTED the basket every time somebody glanced at the list, which is the
 * one thing a till must never do: a counterhand six lines into a quote who taps
 * the menu to check something must find those six lines still there.
 *
 * So this lays over the top. The trading screen stays exactly where it was, and
 * switching modules changes what the basket MEANS rather than throwing it away.
 *
 * ── AND WHY THE ROWS ARE THIS BIG ─────────────────────────────────────────
 *
 * It is used with a finger, on a screen somebody is standing in front of. These
 * are `TouchRow`s — the same component the saved-sales and reprint lists use —
 * with the reason for each module written beside it, because the person picking
 * may never have opened the one they are about to.
 */
export default function ModuleMenu({
  open,
  current,
  available,
  onPick,
  onClose,
}: {
  open: boolean
  current: TillModule
  /**
   * Which modules this shop actually has.
   *
   * A hardware trade counter has no lay-bys; a restaurant has neither those nor
   * quotes. Listing a module a shop has switched off would teach somebody to
   * press a thing that then explains it is unavailable.
   */
  available: readonly TillModule[]
  onPick: (module: TillModule) => void
  onClose: () => void
}) {
  /* Escape closes it, like every other overlay in the till. A panel with no way
     out but a precise tap on the backdrop is one somebody gets stuck in. */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const shown = MODULES.filter((m) => available.includes(m.key))

  return (
    <>
      {/* The backdrop. A plain div rather than a Button: it is a 100%-of-screen
          dismiss target with no label and no focus stop of its own — the panel's
          own Close button and Escape are what make this reachable without a
          pointer, and a full-screen element in the tab order would be a trap. */}
      <div
        data-kit-ok
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 z-40 bg-ink/50"
      />

      <aside
        /* LEFT, not right. It is a way BACK to somewhere, and every other
           back-affordance in this app — the sidebar, the gate's return arrow —
           lives on that edge. */
        className="fixed inset-y-0 left-0 z-50 flex w-[340px] max-w-[85vw] flex-col border-r border-border bg-surface shadow-pop"
        aria-label="Till modules"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <span className="text-[15px] font-semibold text-ink">Go to</span>
          <Button variant="ghost" size="sm" iconOnly aria-label="Close" onClick={onClose}>
            <Icons.Close size={20} />
          </Button>
        </div>

        <nav className="till-pane flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {shown.map((m) => {
            const Icon = Icons[m.icon]
            const isCurrent = m.key === current
            return (
              <TouchRow
                key={m.key}
                icon={<CategoryTile icon={<Icon size={20} />} tone={m.tone} />}
                title={m.label}
                subtitle={m.hint}
                tone={isCurrent ? 'active' : 'default'}
                /* No chevron on the one you are already on — it would promise a
                   screen that is already showing. */
                showChevron={!isCurrent}
                trailing={
                  isCurrent ? <Icons.StatusSuccess size={18} className="text-brand" /> : undefined
                }
                onClick={() => {
                  /* Picking the module you are already on closes without
                     reloading. Somebody tapping it means "put the menu away",
                     and re-entering the screen would lose their place. */
                  if (!isCurrent) onPick(m.key)
                  onClose()
                }}
              />
            )
          })}
        </nav>
      </aside>
    </>
  )
}
