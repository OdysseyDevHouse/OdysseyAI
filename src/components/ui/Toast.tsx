'use client'

import {
  createContext,
  useEffect,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Close, StatusError, StatusInfo, StatusSuccess } from './icons'

/**
 * Toasts — the standard outcome message for any action (saved, sent, failed).
 *
 * Every mutation should end in one, so the user is never left guessing whether
 * something took. Errors linger longer than successes because they usually
 * carry something the user has to read.
 *
 * ── WHY THE CONTAINER IS A POPOVER ─────────────────────────────────────────
 *
 * <Modal> and <Drawer> are native <dialog>s opened with showModal(), which puts
 * them in the browser's TOP LAYER. Nothing painted normally can sit above that
 * — the top layer is above the entire page, so no z-index wins. This container
 * was `fixed … z-50`, which put every toast raised by a dialog BEHIND its
 * backdrop: dimmed, greyed and easy to miss entirely.
 *
 * That failure lands hardest exactly where it hurts most. A dialog raises a
 * toast when a save is REFUSED, so the one sentence explaining why the button
 * did nothing was the hardest thing on screen to read, while the form sat there
 * looking as though it had simply ignored the click.
 *
 * A popover joins the same top layer, so it stacks against dialogs rather than
 * beneath them. Within that layer the most recently shown element wins, and a
 * toast is always shown after whatever dialog is already open — so it lands
 * above one modal, above a modal stacked on a modal, and above a Drawer.
 *
 * `popover="manual"` and never `"auto"`: an auto popover is part of the
 * light-dismiss group, so opening one closes the others and any click would
 * dismiss it. Manual means this container opens once and stays, which is what
 * a message the user has to READ needs.
 */

type ToastTone = 'success' | 'error' | 'info'
type Toast = { id: number; tone: ToastTone; message: string }

/* Five seconds for good news, eight for bad. A success has done its whole job
   the moment it is read, so it takes itself away; an error usually carries
   something the user has to act on, so it lingers. TransientCallout uses the
   same five, which keeps the inline banner and the toast in step. */
const SHOW_MS: Record<ToastTone, number> = { success: 5000, info: 5000, error: 8000 }

type ToastApi = {
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast() needs a <ToastProvider> above it — see (app)/layout.tsx')
  return api
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  const trayRef = useRef<HTMLDivElement>(null)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++
      setToasts((current) => [...current, { id, tone, message }])
      setTimeout(() => dismiss(id), SHOW_MS[tone])
    },
    [dismiss]
  )

  // Memoised so consumers don't re-render every time a toast comes and goes.
  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message),
    }),
    [push]
  )

  /* Shown only while there is something to show.
   *
   * A popover in the top layer covers its corner of the screen even when empty,
   * and `pointer-events-none` on the container is not enough on its own: an
   * empty box that is still "open" keeps the browser treating this as an active
   * top-layer element. Toggling it means the page below is untouched whenever
   * no toast is up.
   *
   * Re-shown on every change rather than only on the first toast: a dialog
   * opened AFTER a toast was raised would otherwise be the newer top-layer
   * element and cover it. Calling showPopover() again moves this back to the
   * front, which is what keeps a lingering error visible when the user opens
   * something else while reading it. */
  useEffect(() => {
    const el = trayRef.current
    if (!el) return
    /* Guarded: showPopover() throws if it is already open, hidePopover() if it
       is already closed — and both throw if the element is not connected. A
       browser without popover support lands in the catch and keeps the plain
       fixed positioning, which is the OLD behaviour rather than a broken one. */
    try {
      if (!toasts.length) {
        if (el.matches(':popover-open')) el.hidePopover()
        return
      }
      /* Closed and re-opened, NOT just opened when closed.
         Order inside the top layer is the order things were SHOWN, so a tray
         opened by an earlier toast sits UNDER a dialog opened after it — which
         is the whole bug, since the toast that matters most is the one a dialog
         raises when it refuses to save. Re-showing moves the tray back to the
         front. Measured: without the hide, elementFromPoint over the toast
         returned the DIALOG. */
      if (el.matches(':popover-open')) el.hidePopover()
      el.showPopover()
    } catch {
      /* See above — the fixed fallback still paints, just not above a dialog. */
    }
  }, [toasts])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        ref={trayRef}
        popover="manual"
        aria-live="polite"
        aria-atomic="false"
        /* `toast-tray` carries what Tailwind cannot express here: a popover is
           display:none until shown, and the UA gives it a border, padding and a
           background that would draw a box around the stack. See globals.css —
           the positioning below is the no-popover fallback, and an open popover
           lands in the same place, so the two agree either way. */
        className="toast-tray pointer-events-none fixed right-5 bottom-5 z-50 w-80 flex-col gap-2"
      >
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const TONE_STYLE: Record<ToastTone, { icon: ReactNode; accent: string }> = {
  success: { icon: <StatusSuccess size={18} />, accent: 'text-success' },
  error: { icon: <StatusError size={18} />, accent: 'text-danger' },
  info: { icon: <StatusInfo size={18} />, accent: 'text-brand' },
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { icon, accent } = TONE_STYLE[toast.tone]
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto flex items-start gap-3 rounded-card border border-border bg-surface p-3.5 shadow-pop"
    >
      <span className={`mt-px shrink-0 ${accent}`}>{icon}</span>
      <p className="min-w-0 flex-1 text-sm text-ink">{toast.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-faint transition hover:text-ink"
      >
        <Close size={16} />
      </button>
    </div>
  )
}
