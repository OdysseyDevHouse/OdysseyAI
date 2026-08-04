'use client'

import {
  createContext,
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
 */

type ToastTone = 'success' | 'error' | 'info'
type Toast = { id: number; tone: ToastTone; message: string }

const SHOW_MS: Record<ToastTone, number> = { success: 4000, info: 4000, error: 8000 }

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

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed right-5 bottom-5 z-50 flex w-80 flex-col gap-2"
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
