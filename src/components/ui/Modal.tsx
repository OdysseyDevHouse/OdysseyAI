'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Button'
import { Close } from './icons'
import { MODAL_PANEL, MODAL_SIZE, type ModalSize } from './styles'

/**
 * Modal dialog, built on the native <dialog> element.
 *
 * Native rather than a portal-and-overlay of our own: showModal() gives focus
 * trapping, the inert background, Escape-to-close and the top layer for free,
 * and the top layer is the only way to be certain the panel paints above a
 * sticky toolbar or an open Menu without a z-index arms race.
 *
 * Confirming something destructive? Use <ConfirmModal> — it already has the
 * button order and tone right.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** One line under the title. Longer explanations belong in the body. */
  description?: string
  children?: ReactNode
  /** Action row. Omit for a purely informational dialog. */
  footer?: ReactNode
  size?: ModalSize
  /** Off for a dialog holding half-typed work, where a stray click would lose it. */
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

    // Escape closes the dialog natively, but the parent still holds `open` and
    // would render it straight back. Intercept and let the parent drive.
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
      /* The dialog element is the panel itself, so the backdrop is styled via
         ::backdrop in globals.css rather than an extra wrapper div. */
      className={`${MODAL_PANEL} ${MODAL_SIZE[size]}`}
      onClick={(event) => {
        // A click that lands on the dialog element itself is a backdrop click:
        // the panel's own content sits in children, which stop it there.
        if (closeOnBackdrop && event.target === ref.current) onClose()
      }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        <Button variant="bare" size="sm" iconOnly aria-label="Close" onClick={onClose}>
          <Close size={16} />
        </Button>
      </div>

      {/*
        Keyed on `open` so the contents REMOUNT every time the dialog is
        opened. A <dialog> is never unmounted — showModal()/close() only toggle
        visibility — so without this key a form inside keeps whatever was last
        typed or selected, and the next person to open it silently inherits it.
        That shipped a real bug: a ledger posting modal remembered "Invoice"
        from a previous use and a payment was posted as a debit.

        A modal that must preserve work across closes should hold that state in
        its parent, where it survives the remount.
      */}
      {children && (
        <div key={open ? 'open' : 'closed'} className="max-h-[60vh] overflow-y-auto px-5 py-4 text-sm text-ink-2">
          {children}
        </div>
      )}

      {footer && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          {footer}
        </div>
      )}
    </dialog>
  )
}

/**
 * The "are you sure?" dialog.
 *
 * Exists because this repo currently confirms destructive actions on a separate
 * page, and because the details that make a confirm safe — destructive action
 * on the right, cancel focused first, the noun repeated back — should be
 * decided once rather than per screen.
 */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 'danger' for anything that destroys or reverses. 'primary' to just proceed. */
  tone?: 'danger' | 'primary'
  /** Disables both buttons while the action runs, so it cannot be fired twice. */
  busy?: boolean
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      /* A misplaced click must not confirm-by-dismissal on a destructive
         prompt; make the user answer it. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      {message}
    </Modal>
  )
}
