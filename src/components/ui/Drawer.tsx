'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Button'
import { Close } from './icons'
import { DRAWER_PANEL, DRAWER_SIZE, type DrawerSize } from './styles'

/**
 * A panel that slides in from the edge of the screen.
 *
 * The same native <dialog> as <Modal> — focus trapping, the inert background,
 * Escape and the top layer all come free — but anchored to an edge and full
 * height rather than centred. Reach for it instead of a Modal when the content
 * is a LIST TO PICK FROM rather than a question: a tall column of choices reads
 * far better down the side of the screen than as a centred box that has to
 * scroll internally, and the screen underneath stays visible so the choice
 * keeps its context.
 *
 * A drawer is not a place to hide a form. If the thing needs Cancel/Save, it is
 * a Modal.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  side = 'right',
  size = 'md',
  children,
  footer,
  closeOnBackdrop = true,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** One line under the title. */
  description?: string
  /** 'right' is the default — the edge a back-office user's hand is already at. */
  side?: 'right' | 'left'
  size?: DrawerSize
  children?: ReactNode
  /**
   * A pinned action row at the foot. Often unnecessary: a drawer whose items
   * commit on click needs nothing but the close button in its header.
   */
  footer?: ReactNode
  /** Off for a drawer holding half-typed work, where a stray click would lose it. */
  closeOnBackdrop?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    // showModal() throws if it is already open, and close() on an already-closed
    // dialog fires a spurious cancel — so check before doing either.
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    // Escape closes natively, but the parent still holds `open` and would render
    // it straight back. Intercept and let the parent drive.
    function onCancel(event: Event) {
      event.preventDefault()
      onClose()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => dialog.removeEventListener('cancel', onCancel)
  }, [onClose])

  return (
    <dialog
      ref={ref}
      className={`${DRAWER_PANEL} ${DRAWER_SIZE[size]} ${
        side === 'right'
          ? 'ml-auto mr-0 rounded-l-card drawer-from-right'
          : 'ml-0 mr-auto rounded-r-card drawer-from-left'
      }`}
      onClick={(event) => {
        // A click landing on the dialog element itself is a backdrop click: the
        // panel's own content sits in children, which stop it there.
        if (closeOnBackdrop && event.target === ref.current) onClose()
      }}
    >
      {/* The panel is a column: header and footer stay put, the body scrolls.
          `min-h-0` because a flex child will not shrink below its content
          without it, and the body would grow past the panel instead. */}
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          <Button variant="bare" size="sm" iconOnly aria-label="Close" onClick={onClose}>
            <Close size={16} />
          </Button>
        </div>

        {/*
          Keyed on `open` so the contents REMOUNT every time the drawer is
          opened — a <dialog> is never unmounted, only shown and hidden, so
          without this key anything typed or scrolled inside is inherited by
          the next person to open it. Same reasoning as <Modal>.
        */}
        <div
          key={open ? 'open' : 'closed'}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-ink-2"
        >
          {children}
        </div>

        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  )
}
