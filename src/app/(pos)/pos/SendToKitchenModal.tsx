'use client'

import { useState } from 'react'
import { Badge, Button, Icons, Modal, TouchRow } from '@/components/ui'
import type { KitchenSendOption, KitchenScope } from './kitchenActions'

/**
 * Choosing what to fire.
 *
 * ── THE THREE-COURSE PROBLEM ─────────────────────────────────────────────
 *
 * A table orders starters, mains and dessert in one sitting. All of it is on
 * the tab; none of it should hit the pass at once. The waiter releases each
 * course as the kitchen needs it — so the question this modal asks is not
 * "send?" but "send WHAT?".
 *
 * Two granularities, because those are the two a waiter actually thinks in:
 * a whole COURSE ("fire the starters"), or one ITEM ("that steak now, it's a
 * child's plate"). Anything finer would be a spreadsheet; anything coarser
 * would be the button that already exists.
 *
 * Only OUTSTANDING items appear. A course already fired is not offered —
 * showing it would invite a waiter to send it twice and then wonder why the
 * kitchen was annoyed.
 */
export default function SendToKitchenModal({
  options,
  pending,
  onSend,
  onClose,
}: {
  options: KitchenSendOption[]
  pending: boolean
  onSend: (scope: KitchenScope | undefined) => void
  onClose: () => void
}) {
  /* Which individual lines are ticked. Empty means nobody has narrowed
     anything, and the primary action stays "send everything" — the common
     case, and the one that should need the fewest taps. */
  const [picked, setPicked] = useState<Set<number>>(new Set())

  function toggleLine(lineId: number) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(lineId)) next.delete(lineId)
      else next.add(lineId)
      return next
    })
  }

  function toggleGroup(option: KitchenSendOption) {
    const ids = option.lines.map((l) => l.lineId)
    const allOn = ids.every((id) => picked.has(id))
    setPicked((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (allOn) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const total = options.reduce((sum, o) => sum + o.lines.length, 0)

  return (
    <Modal
      open
      onClose={onClose}
      title="Send to kitchen"
      description="Only what the kitchen has not seen yet. Tick a course or single items, or send everything."
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {picked.size > 0 ? (
            <Button
              variant="success"
              disabled={pending}
              onClick={() => onSend({ lineIds: [...picked] })}
            >
              <Icons.Printer size={16} />
              Send {picked.size} item{picked.size === 1 ? '' : 's'}
            </Button>
          ) : (
            <Button variant="success" disabled={pending} onClick={() => onSend(undefined)}>
              <Icons.Printer size={16} />
              Send everything ({total})
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {options.map((option) => {
          const ids = option.lines.map((l) => l.lineId)
          const allOn = ids.every((id) => picked.has(id))
          return (
            <div key={option.group || '__none__'} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                {/* An ungrouped remainder is labelled as what it is rather than
                    left blank — a heading nobody set is still a real pile of
                    food, and "Other items" is what a waiter would call it. */}
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {option.group || 'Other items'}
                </span>
                <Button variant="ghost" size="sm" onClick={() => toggleGroup(option)}>
                  {allOn ? 'Clear course' : 'Whole course'}
                </Button>
              </div>
              {option.lines.map((line) => (
                <TouchRow
                  key={line.lineId}
                  tone={picked.has(line.lineId) ? 'active' : 'default'}
                  showChevron={false}
                  onClick={() => toggleLine(line.lineId)}
                  icon={
                    picked.has(line.lineId) ? (
                      <Icons.Checked size={20} />
                    ) : (
                      <Icons.Unchecked size={20} />
                    )
                  }
                  title={line.description}
                  trailing={<Badge tone="neutral">{line.qty}</Badge>}
                />
              ))}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
