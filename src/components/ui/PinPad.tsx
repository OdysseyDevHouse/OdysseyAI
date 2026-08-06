'use client'

import { useEffect, useState } from 'react'
import { Button } from './Button'
import * as Icons from './icons'

/**
 * A numeric keypad for entering a PIN.
 *
 * Big targets because the hardware is a touchscreen at counter height, often
 * used by someone holding something in their other hand. The physical keyboard
 * works too — a till with a keyboard is just as common — so digits, Backspace
 * and Enter are bound as well.
 *
 * The entered PIN is shown as dots, never digits: the customer is standing on
 * the other side of the screen.
 */
export function PinPad({
  length = 4,
  onSubmit,
  onCancel,
  error,
  busy = false,
  submitLabel = 'Sign in',
}: {
  /** Digits before it submits itself. Six-digit PINs need an explicit Enter. */
  length?: number
  onSubmit: (pin: string) => void
  onCancel?: () => void
  error?: string | null
  busy?: boolean
  submitLabel?: string
}) {
  const [pin, setPin] = useState('')

  // Clearing on a failed attempt is what makes a second try possible without
  // the user having to work out how much of the old entry survived.
  useEffect(() => {
    if (error) setPin('')
  }, [error])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (busy) return
      if (event.key >= '0' && event.key <= '9') {
        setPin((current) => (current.length >= 6 ? current : current + event.key))
      } else if (event.key === 'Backspace') {
        setPin((current) => current.slice(0, -1))
      } else if (event.key === 'Enter') {
        setPin((current) => {
          if (current.length >= 4) onSubmit(current)
          return current
        })
      } else if (event.key === 'Escape' && onCancel) {
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onSubmit, onCancel])

  // A four-digit PIN submits on the fourth digit; a six-digit one cannot, since
  // there is no way to tell "done" from "halfway" until Enter.
  useEffect(() => {
    if (length === 4 && pin.length === 4 && !busy) onSubmit(pin)
  }, [pin, length, busy, onSubmit])

  const press = (digit: string) => setPin((current) => (current.length >= 6 ? current : current + digit))

  return (
    <div className="flex w-full max-w-xs flex-col gap-5">
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-control items-center justify-center gap-2.5" aria-live="polite">
          {Array.from({ length: Math.max(length, pin.length) }).map((_, i) => (
            <span
              key={i}
              className={`size-3 rounded-full transition ${
                i < pin.length ? 'bg-brand' : 'bg-surface-2 ring-1 ring-border'
              }`}
            />
          ))}
        </div>
        {error && <p className="text-center text-sm text-danger">{error}</p>}
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <Button
            key={digit}
            variant="secondary"
            onClick={() => press(digit)}
            disabled={busy}
            className="h-14 text-lg font-medium"
          >
            {digit}
          </Button>
        ))}

        <Button
          variant="ghost"
          onClick={() => setPin('')}
          disabled={busy || !pin}
          className="h-14"
          aria-label="Clear"
        >
          Clear
        </Button>
        <Button
          variant="secondary"
          onClick={() => press('0')}
          disabled={busy}
          className="h-14 text-lg font-medium"
        >
          0
        </Button>
        <Button
          variant="ghost"
          onClick={() => setPin((current) => current.slice(0, -1))}
          disabled={busy || !pin}
          className="h-14"
          aria-label="Backspace"
        >
          <Icons.ChevronLeft size={20} />
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {/* Always rendered, not only for six-digit PINs: a four-digit PIN
            submits itself, but a visible confirm is what tells a first-time
            user the keypad is finished rather than stuck. */}
        <Button
          variant="primary"
          onClick={() => onSubmit(pin)}
          disabled={busy || pin.length < 4}
          className="h-control"
        >
          {busy ? 'Checking…' : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
