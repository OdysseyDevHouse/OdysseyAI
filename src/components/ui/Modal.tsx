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
  titleMedia,
  subheader,
  children,
  footer,
  size = 'md',
  bodyFills = false,
  bodyTall = false,
  bodyPins = false,
  bodyGrows = false,
  closeOnBackdrop = true,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** One line under the title. Longer explanations belong in the body. */
  description?: string
  /**
   * A thumbnail to the LEFT of the title — a product picture, a category tile.
   *
   * Deliberately not a free-form header: the title and close button keep their
   * positions, so every dialog in the app still reads the same way. Size it
   * yourself; the header is laid out for roughly a 48px square.
   */
  titleMedia?: ReactNode
  /**
   * A strip between the header and the scrolling body — a step indicator, a
   * filter row. Stays PUT while the body scrolls, which is the whole point:
   * it is there to say where you are, and that is useless if it scrolls away.
   */
  subheader?: ReactNode
  children?: ReactNode
  /** Action row. Omit for a purely informational dialog. */
  footer?: ReactNode
  size?: ModalSize
  /**
   * Give the body a FIXED tall height and let it scroll itself, instead of the
   * default "as tall as it needs, up to 60vh".
   *
   * For a dialog whose body is a layout rather than a document — side-by-side
   * panels that each scroll on their own. The default cap scrolls the whole body
   * as one, which on two panels means dragging one out of view to read the other.
   * Rare on purpose: most dialogs should grow to fit their content.
   */
  bodyFills?: boolean
  /**
   * A taller body, for a bodyFills dialog that also carries a fixed bar.
   *
   * 70vh is right when the whole height belongs to the content. A dialog with a
   * pinned toolbar spends a fixed ~250px of it on touch-size keys, and what is
   * left of 70vh is not enough to read the content above them. Opt-in rather
   * than raised for everyone: a short dialog stretched to 85vh is a lot of empty
   * panel.
   */
  bodyTall?: boolean
  /**
   * A body that GROWS TO FIT but caps, and whose children do the scrolling.
   *
   * For a dialog with something that must never scroll away — a keypad, a fixed
   * action row — above content that might. Lay the body out as
   * `flex-1 overflow-y-auto` for the part that may scroll and `shrink-0` for the
   * part that is pinned.
   *
   * The till's tender pad is the case this exists for. Its keypad and tender
   * keys must stay put while the figures above them scroll, and neither
   * existing mode does that: the default cap scrolls the whole body as one, so
   * the overflow lands on the keypad; `bodyFills` pins the row but fixes the
   * body at 70vh, which on a tall screen leaves a lake of empty panel between
   * the two halves.
   */
  bodyPins?: boolean
  /**
   * A body that GROWS WITH THE WINDOW — it takes whatever height the viewport
   * has left, rather than stopping at the default 60vh.
   *
   * For a long FORM, which is the case the default cap gets wrong. 60vh is a
   * sensible ceiling for a dialog that asks a question, but on a tall screen it
   * makes a long form read through a letterbox with empty desktop above and
   * below it. Unlike `bodyFills` this does not FIX a height — a short form
   * still renders short, so the panel only grows when its content earns it.
   *
   * The specials form is the case this exists for: a dozen sections whose
   * shape changes with the kind of promotion.
   */
  bodyGrows?: boolean
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
      {/* `shrink-0` throughout the chrome: the panel is a flex column now, so
          without it a tall body squeezes the header and footer instead of
          being capped by them. */}
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {titleMedia}
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
        </div>
        <Button variant="bare" size="sm" iconOnly aria-label="Close" onClick={onClose}>
          <Close size={16} />
        </Button>
      </div>

      {subheader && (
        <div className="shrink-0 border-b border-border bg-surface-2 px-5 py-3">{subheader}</div>
      )}

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
        <div
          key={open ? 'open' : 'closed'}
          className={`px-5 py-4 text-sm text-ink-2 ${
            bodyPins
              ? /* Grows to fit, up to a cap, and its CHILDREN scroll. The middle
                   ground between the two below: `bodyFills` would leave a tall
                   screen with a fixed 70vh body and a lake of empty panel above
                   its pinned row, while the default cap scrolls the pinned row
                   away with everything else.

                   72vh, not 78: the panel also carries a header and a footer,
                   and at 78vh on a 1366x768 till the footer's own button landed
                   one pixel below the fold — which is a button nobody can press
                   to finish a sale. */
                'flex max-h-[72vh] min-h-0 flex-col'
              : bodyFills
                ? /* The body owns the height and its children do the scrolling. `min-h-0`
                     because a flex child will not shrink below its content without it —
                     the panes would grow past the panel instead of overflowing.

                     `flex-1` and NOT a fixed `h-[82vh]`: the panel is a bounded
                     flex column, so the body takes exactly what the header and
                     footer leave. Sized as a fraction of the VIEWPORT it did
                     not — 82vh plus ~9rem of chrome overflows the panel's own
                     ceiling, and the panel grew a second scrollbar beside the
                     pane that was already scrolling. That is the cash-up's two
                     scrollbars.

                     The vh figure survives as the flex BASIS, not a min-height:
                     this mode is for a dialog that is a workspace, and one with
                     little in it should still open at a workspace's size rather
                     than collapsing to a strip. A basis is the size the body
                     ASKS for — it still shrinks to whatever the panel's ceiling
                     leaves, where a min-height would win against that ceiling
                     and put the second scrollbar straight back on a short
                     screen. `min-h-0` for the same reason it was always here:
                     the panes overflow inside themselves instead of growing. */
                  `flex min-h-0 flex-col ${bodyTall ? 'basis-[82vh]' : 'basis-[70vh]'} grow shrink`
                : /* `bodyGrows` swaps the default ceiling for one that reserves
                     the header, the footer and the panel's own margin, and
                     nothing more — so the body ends where the WINDOW does
                     rather than at an arbitrary fraction of it. Still a max
                     rather than a height, so a short form is a short dialog.

                     `dvh`, not `vh`: on a phone the browser chrome comes and
                     goes, and `vh` measures the tallest state — a footer sized
                     against it sits under the address bar, which is where the
                     save button lives. */
                  /* `shrink-0` on the bodyGrows branch, and it is load-bearing.
                     The panel is a flex column, so a plain block child STRETCHES
                     to fill it — measured: with the content 664px tall the body
                     still reported 696px and the panel stayed at its 846px cap,
                     so a short form was drawn as a full-height dialog with a
                     band of empty panel under the last field. `shrink-0` keeps
                     it at its content height, and `max-h` still caps it, so a
                     long form scrolls exactly as before. */
                  `overflow-y-auto ${
                    bodyGrows ? 'shrink-0 max-h-[calc(100dvh-13rem)]' : 'max-h-[60vh]'
                  }`
          }`}
        >
          {children}
        </div>
      )}

      {/*
        `flex-wrap` because every Button is `shrink-0 whitespace-nowrap` — a row
        of them cannot narrow, so without wrapping an action row that outgrows
        the panel simply overflows it and the leftmost button is clipped by the
        panel edge. That is exactly how the till's Sale-complete dialog broke,
        with five touch-size keys in an `sm` panel. Wrapping keeps the primary
        action — last in the row, and so on the bottom line — reachable at any
        width, which is the property that matters on a small till.
      */}
      {footer && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3.5">
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
