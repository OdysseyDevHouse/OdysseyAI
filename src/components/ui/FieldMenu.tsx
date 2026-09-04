'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from './icons'

/**
 * A field with a chevron button JOINED to its right edge, opening a menu of
 * things you can do to that field.
 *
 * ── WHY THIS AND NOT A BUTTON BESIDE THE INPUT ────────────────────────────
 *
 * A separate button says "here is another control"; a joined one says "these
 * belong to the box on the left". That distinction is the whole point on the
 * product screen, where the chevron's entries — the extra barcodes, the
 * generator — all act on the barcode being typed. Set an inch of gap between
 * them and the same two controls read as an unrelated pair.
 *
 * The two halves meet on ONE hairline: the input loses its right radius, the
 * button loses its left, and the button's left border is dropped so the input's
 * own edge is the seam. Anything else draws a 2px double line down the middle,
 * which is the tell of a split control that was assembled rather than designed.
 *
 * Wrap the control, don't replace it — the child is a real <Input>, so it keeps
 * the shared skin, the focus edge and the error state:
 *
 *   <Field label="Barcode">
 *     <FieldMenu triggerLabel="Barcode options">
 *       <Input name="barcode" />
 *       {(close) => <MenuItem onClick={() => { close(); doThing() }}>…</MenuItem>}
 *     </FieldMenu>
 *   </Field>
 */
export function FieldMenu({
  children,
  triggerLabel,
  disabled = false,
  className = '',
}: {
  /**
   * Two children, in order: the control itself (an <Input>, a <Select>), then a
   * function returning the menu's entries.
   *
   * The entries come from a FUNCTION rather than a node so each is handed a
   * `close` to call when picked — an entry that opens a dialog has to dismiss
   * this menu first, or the panel stays open UNDER the modal and is still
   * sitting there when it closes.
   */
  children: [ReactNode, (close: () => void) => ReactNode]
  /** Accessible name for the chevron — it has no text of its own. */
  triggerLabel: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`relative flex ${className}`}>
      {/* The control gives up its right corners to the seam. Reached through a
          wrapper rather than a prop on Input, so ANY control can sit here. */}
      <div className="min-w-0 flex-1 [&>*]:rounded-r-none">{children[0]}</div>

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        disabled={disabled}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        /* Not <Button>: this one is a HALF of a control rather than a control,
           so it needs the input's own border colour and height and none of the
           button sizes' radii. Wearing `secondary` here would put a brand-tinted
           block against a plain input and break the seam. */
        className={
          'inline-flex h-control w-9 shrink-0 items-center justify-center rounded-r-control ' +
          'border border-l-0 border-border-strong bg-surface-2 text-ink-2 transition ' +
          'hover:bg-brand-soft hover:text-brand ' +
          'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-faint'
        }
      >
        <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute top-full right-0 z-20 mt-1.5 max-h-80 min-w-52 overflow-y-auto overscroll-contain rounded-control border border-border bg-surface p-1 shadow-pop"
        >
          {children[1](() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
