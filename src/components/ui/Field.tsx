'use client'

import { createContext, useContext, useId, type ComponentProps, type ReactNode } from 'react'
import { ChevronDown } from './icons'
import { CONTROL, CONTROL_H, CONTROL_INVALID as INVALID } from './styles'

/**
 * Form controls — inputs, selects, switches, checkboxes, radios.
 *
 * Every single-line control wears ONE skin (`CONTROL` in styles.ts). Change it
 * there and every form in OdysseyAI updates: same height, same radius, same
 * border, same focus and error treatment. Never restyle an input at the call
 * site — add a variant here instead.
 */

/* ── Label + hint + error wrapper ────────────────────────────────────────── */

/* Field hands the control below it an id and its error state, so every label
   is actually wired to its input and every error is announced — without each
   call site having to remember to invent an id and thread it through. */
type FieldWiring = { id: string; describedBy?: string; invalid: boolean }
const FieldContext = createContext<FieldWiring | null>(null)

/** Read the wiring, letting an explicit prop at the call site win. */
function useFieldWiring(explicitId?: string, explicitInvalid?: boolean) {
  const field = useContext(FieldContext)
  return {
    id: explicitId ?? field?.id,
    describedBy: field?.describedBy,
    invalid: explicitInvalid ?? field?.invalid ?? false,
  }
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className = '',
}: {
  label?: string
  /** Helper text under the control. Hidden while an error is showing. */
  hint?: string
  /** Message shown in danger tone; also flips the control to its error skin. */
  error?: string
  /** Only needed when the control isn't one of ours. */
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  const generatedId = useId()
  const id = htmlFor ?? generatedId
  const messageId = `${id}-message`
  const message = error ?? hint

  return (
    <FieldContext.Provider
      value={{ id, describedBy: message ? messageId : undefined, invalid: Boolean(error) }}
    >
      <div className={className}>
        {label && (
          <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-2">
            {label}
          </label>
        )}
        {children}
        {message && (
          <p id={messageId} className={`mt-1.5 text-xs ${error ? 'text-danger' : 'text-muted'}`}>
            {message}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  )
}

/* ── Text-like inputs ────────────────────────────────────────────────────── */

type InputProps = Omit<ComponentProps<'input'>, 'className'> & {
  /** Leading glyph inside the control, e.g. <Search size={16} />. */
  icon?: ReactNode
  invalid?: boolean
  className?: string
}

export function Input({ icon, invalid, className = '', id, ...rest }: InputProps) {
  const wiring = useFieldWiring(id, invalid)
  const input = (
    <input
      id={wiring.id}
      aria-invalid={wiring.invalid || undefined}
      aria-describedby={wiring.describedBy}
      className={`${CONTROL} ${CONTROL_H} ${icon ? 'pl-9' : ''} ${
        wiring.invalid ? INVALID : ''
      } ${className}`}
      {...rest}
    />
  )

  if (!icon) return input

  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">
        {icon}
      </span>
      {input}
    </div>
  )
}

/** Whole numbers — quantities, counts. Right-aligned with tabular figures. */
export function NumberInput({ className = '', ...rest }: InputProps) {
  return <Input type="number" inputMode="numeric" className={`numeric text-right ${className}`} {...rest} />
}

/** Money. Right-aligned tabular figures and a 2-decimal step. */
export function CurrencyInput({ className = '', ...rest }: InputProps) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      step="0.01"
      className={`numeric text-right ${className}`}
      {...rest}
    />
  )
}

export function Textarea({
  invalid,
  className = '',
  rows = 3,
  id,
  ...rest
}: Omit<ComponentProps<'textarea'>, 'className'> & { invalid?: boolean; className?: string }) {
  const wiring = useFieldWiring(id, invalid)
  return (
    <textarea
      id={wiring.id}
      rows={rows}
      aria-invalid={wiring.invalid || undefined}
      aria-describedby={wiring.describedBy}
      className={`${CONTROL} resize-y py-2 ${wiring.invalid ? INVALID : ''} ${className}`}
      {...rest}
    />
  )
}

/* ── Select ──────────────────────────────────────────────────────────────── */

export function Select({
  icon,
  invalid,
  className = '',
  children,
  id,
  ...rest
}: Omit<ComponentProps<'select'>, 'className'> & {
  icon?: ReactNode
  invalid?: boolean
  className?: string
}) {
  const wiring = useFieldWiring(id, invalid)
  return (
    <div className="relative">
      {icon && (
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">
          {icon}
        </span>
      )}
      <select
        id={wiring.id}
        aria-invalid={wiring.invalid || undefined}
        aria-describedby={wiring.describedBy}
        /* appearance-none so the chevron below is the only one drawn — the
           native arrow differs per OS and breaks the alignment. */
        className={`${CONTROL} ${CONTROL_H} cursor-pointer appearance-none pr-9 ${
          icon ? 'pl-9' : ''
        } ${wiring.invalid ? INVALID : ''} ${className}`}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={16}
        className="pointer-events-none absolute inset-y-0 right-3 my-auto text-muted"
      />
    </div>
  )
}

/* ── Switch ──────────────────────────────────────────────────────────────── */

/** On/off setting — e.g. a feature flag. Use for settings, not for filters. */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  id,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  hint?: string
  disabled?: boolean
  id?: string
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-pill border border-transparent p-0.5 transition disabled:cursor-not-allowed disabled:opacity-50 ${
          checked ? 'bg-brand' : 'bg-border-strong'
        }`}
      >
        <span
          className={`size-4 rounded-pill bg-surface shadow-card transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
      {(label || hint) && (
        <div className="min-w-0">
          {/* Deliberately not a <label htmlFor>: a button IS a labelable
              element, so the label would forward its click to the switch and
              our own handler would toggle it straight back. */}
          {label && (
            <span
              className={`block text-sm font-medium text-ink ${disabled ? '' : 'cursor-pointer'}`}
              onClick={() => !disabled && onChange(!checked)}
            >
              {label}
            </span>
          )}
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
      )}
    </div>
  )
}

/* ── Checkbox / Radio ────────────────────────────────────────────────────── */

/* Native inputs on purpose: they carry keyboard and screen-reader behaviour
   for free, and globals.css already points accent-color at the brand token. */

export function Checkbox({
  label,
  className = '',
  id,
  ...rest
}: Omit<ComponentProps<'input'>, 'type' | 'className'> & { label?: ReactNode; className?: string }) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 text-sm text-ink ${className}`}>
      <input
        type="checkbox"
        id={id}
        className="size-4 cursor-pointer rounded-[4px] border-border-strong disabled:cursor-not-allowed"
        {...rest}
      />
      {label}
    </label>
  )
}

export function Radio({
  label,
  className = '',
  ...rest
}: Omit<ComponentProps<'input'>, 'type' | 'className'> & { label?: ReactNode; className?: string }) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 text-sm text-ink ${className}`}>
      <input
        type="radio"
        className="size-4 cursor-pointer border-border-strong disabled:cursor-not-allowed"
        {...rest}
      />
      {label}
    </label>
  )
}
