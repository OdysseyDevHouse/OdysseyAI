'use client'

import { Modal, Switch, Button } from '@/components/ui'
import { WIDGETS, type WidgetId } from './widgets'

/**
 * Show and hide widgets.
 *
 * A modal rather than the slide-out drawer the original used: the drawer was a
 * bespoke panel with its own backdrop, focus trap and escape handling, all of
 * which `Modal` already does correctly. One less thing to keep accessible.
 */
export function WidgetPanel({
  open,
  hidden,
  visible,
  onToggle,
  onClose,
  onReset,
}: {
  open: boolean
  hidden: WidgetId[]
  /**
   * The widgets this user could see at all. A switch for data their role does
   * not include would only ever turn on a box saying "not available", which is
   * a worse answer than not offering the switch.
   */
  visible: readonly WidgetId[]
  onToggle: (id: WidgetId) => void
  onClose: () => void
  onReset: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Widgets"
      description="Choose what this dashboard shows. Drag and resize them on the page itself."
      footer={
        <>
          <Button variant="ghost" onClick={onReset}>
            Reset to default
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <ul className="flex flex-col">
        {WIDGETS.filter((w) => visible.includes(w.id)).map((w) => (
          <li key={w.id}>
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-control px-2 py-2.5 hover:bg-surface-2">
              <span className="text-sm text-ink">{w.title}</span>
              <Switch checked={!hidden.includes(w.id)} onChange={() => onToggle(w.id)} />
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
