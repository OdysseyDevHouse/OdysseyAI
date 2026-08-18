'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'
import ModuleMenu, { type TillModule } from '@/app/(pos)/pos/ModuleMenu'

/**
 * The till's module menu, on the Style Guide.
 *
 * Here for the same reason GatePreview and SplitPreview are: the POS sits behind a
 * clerk PIN, so without this the only way to look at the menu is to be standing at a
 * till. Nothing here touches a document — the buttons report what they WOULD do.
 *
 * ── WHAT THIS ONE IS ACTUALLY FOR ─────────────────────────────────────────
 *
 * The menu stopped being a plain list of destinations. Most rows now carry a PAIR of
 * buttons, because "quotes" is two opposite jobs — write a new one, or find an old
 * one — and the two do opposite things to whatever is on the screen behind: New
 * clears the basket (and asks first when there is something to lose), List lays a
 * dialog over the top and touches nothing.
 *
 * That distinction is invisible in a screenshot and is the whole design, so the
 * readout below names which of the two was pressed. Lay-bys deliberately keep the
 * single row: a lay-by is not something the basket becomes.
 *
 * The menu is `position: fixed`, so it is shown open against the page rather than
 * boxed like the gate — a fixed panel inside a bordered div would escape it anyway.
 */
export function ModuleMenuPreview() {
  const [open, setOpen] = useState(false)
  /** Which module the basket is currently writing — drives the ticked row. */
  const [current, setCurrent] = useState<TillModule>('sale')
  const [note, setNote] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">
        Open it, then press either button on a card. The readout says which act ran —
        on a real till “New” clears the basket and “List” leaves it alone, which is the
        difference the two buttons exist to make.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open the module menu
        </Button>
        {/* The tick follows the basket's doc type on a real till. Switched here so the
            "already on this one" row — no chevron, brand tick — can be looked at. */}
        <span className="text-[13px] text-muted">Pretend the basket is:</span>
        {(['sale', 'quotes', 'orders'] as const).map((m) => (
          <Button
            key={m}
            variant={current === m ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => setCurrent(m)}
          >
            {m}
          </Button>
        ))}
      </div>

      {note && (
        <div className="rounded-card border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink">
          {note}{' '}
          <Button variant="ghost" size="sm" onClick={() => setNote(null)}>
            Clear
          </Button>
        </div>
      )}

      <ModuleMenu
        open={open}
        current={current}
        available={['sale', 'quotes', 'orders', 'laybys']}
        /* Stand-ins for the shell's own two. The panel's foot is part of what
           this preview is for — it is the only place outside a live till where
           the drawer can be looked at end to end. */
        operatorName="Tiaan Smith"
        terminalLabel="TILL001 • till 01"
        onPick={(m) => {
          setCurrent(m === 'laybys' ? current : m)
          setNote(
            m === 'laybys'
              ? 'Lay-bys picked — opens the list, basket untouched.'
              : `New ${m}: the shell clears the basket, asking first if it has lines.`,
          )
        }}
        onOpenList={(m) => {
          /* The real shell closes the menu here only when the list actually opens —
             offline it refuses and leaves the menu standing. Closed unconditionally
             in the preview, which has no connection to be without. */
          setOpen(false)
          setNote(`${m} list: opens over the till, basket untouched.`)
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}
