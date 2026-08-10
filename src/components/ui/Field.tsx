'use client'

import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { ChevronDown } from './icons'
import { CONTROL, CONTROL_H, CONTROL_H_TOUCH, CONTROL_INVALID as INVALID } from './styles'

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

/**
 * Read the wiring, letting an explicit prop at the call site win.
 *
 * Exported so a control in its own file — Slider — is wired to a surrounding
 * `Field` exactly as the ones in here are. It must not grow a second copy of
 * FieldContext: two contexts means a Field-wrapped control reads the wrong one,
 * gets no id, and its label quietly stops pointing at anything.
 */
export function useFieldWiring(explicitId?: string, explicitInvalid?: boolean) {
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

/**
 * `touch` is for the till and nowhere else — see --spacing-touch in globals.css.
 *
 * It lives on Input rather than on each caller because NumberInput and
 * CurrencyInput both render through here, so the till's quantity and price
 * fields get it without either of them knowing about touch sizing.
 */
export type ControlSize = 'md' | 'touch'

type InputProps = Omit<ComponentProps<'input'>, 'className' | 'size'> & {
  /** Leading glyph inside the control, e.g. <Search size={16} />. */
  icon?: ReactNode
  invalid?: boolean
  size?: ControlSize
  className?: string
}

export function Input({ icon, invalid, size = 'md', className = '', id, ...rest }: InputProps) {
  const wiring = useFieldWiring(id, invalid)
  const input = (
    <input
      id={wiring.id}
      aria-invalid={wiring.invalid || undefined}
      aria-describedby={wiring.describedBy}
      className={`${CONTROL} ${size === 'touch' ? CONTROL_H_TOUCH : CONTROL_H} ${
        /* The glyph is inset further at till size so it clears the wider box
           without crowding the text. */
        icon ? (size === 'touch' ? 'pl-11' : 'pl-9') : ''
      } ${wiring.invalid ? INVALID : ''} ${className}`}
      {...rest}
    />
  )

  if (!icon) return input

  return (
    <div className="relative">
      <span
        className={`pointer-events-none absolute inset-y-0 flex items-center text-faint ${
          size === 'touch' ? 'left-4' : 'left-3'
        }`}
      >
        {icon}
      </span>
      {input}
    </div>
  )
}

/**
 * Selects the whole value on focus.
 *
 * Numeric fields are almost always replaced rather than edited in place, so
 * landing in one should let you type the new figure straight away. requestAnimationFrame
 * because a click sets the caret AFTER focus fires — selecting synchronously
 * would immediately be undone by the click itself.
 */
function selectOnFocus(event: React.FocusEvent<HTMLInputElement>) {
  const input = event.currentTarget
  requestAnimationFrame(() => input.select())
}

/**
 * Numbers — quantities, counts, percentages.
 *
 * Like CurrencyInput this is a text input rather than type="number", for the
 * same reason: a number input renders through the browser's locale, so 0.00
 * appears as "0,00" on an en-ZA machine. Percentages sit beside prices on the
 * pricing screen, and one showing a comma while its neighbour shows a full stop
 * reads as a bug.
 *
 * `precision` fixes the decimals shown when blurred. Leave it undefined for
 * whole quantities, which should not gain trailing zeroes.
 */
export function NumberInput({
  className = '',
  value,
  defaultValue,
  onChange,
  onFocus,
  onBlur,
  precision,
  ...rest
}: Omit<InputProps, 'type'> & { precision?: number }) {
  const format = (raw: unknown) => {
    if (raw === '' || raw === null || raw === undefined) return ''
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'))
    if (!Number.isFinite(n)) return ''
    return precision === undefined ? String(n) : n.toFixed(precision)
  }

  // Controlled while blurred, free-form while focused — formatting per keystroke
  // would fight the caret.
  const [editing, setEditing] = useState<string | null>(null)
  const shown = editing ?? (value !== undefined ? format(value) : undefined)

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={shown}
      defaultValue={value === undefined ? format(defaultValue) : undefined}
      onFocus={(e) => {
        setEditing(e.target.value)
        selectOnFocus(e)
        onFocus?.(e)
      }}
      onChange={(e) => {
        // Accept a typed comma, hand callers a plain "1.5".
        const next = e.target.value.replace(',', '.')
        setEditing(next)
        if (onChange) {
          e.target.value = next
          onChange(e)
        }
      }}
      onBlur={(e) => {
        setEditing(null)
        onBlur?.(e)
      }}
      className={`numeric text-right ${className}`}
      {...rest}
    />
  )
}

/**
 * Money. Right-aligned tabular figures, always shown to `precision` decimals.
 *
 * Deliberately NOT `type="number"`. A number input renders its value through
 * the browser's locale, so the same 0.00 shows as "0,00" in en-ZA and "0.00" in
 * en-US — the app would then look different per machine, and a screenshot of it
 * could never be trusted. A text input with inputMode="decimal" still raises
 * the numeric keypad on mobile but leaves the rendering to us.
 *
 * Editing is kept literal: whatever is typed stays on screen while the field
 * has focus, and it is only normalised to `precision` decimals on blur. Doing
 * it per keystroke would fight the caret — typing "1.5" would become "1.50"
 * mid-entry and push the cursor to the end.
 */
export function CurrencyInput({
  className = '',
  value,
  defaultValue,
  onChange,
  onBlur,
  onFocus,
  precision = 2,
  ...rest
}: Omit<InputProps, 'type'> & { precision?: number }) {
  const format = (raw: unknown) => {
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(',', '.'))
    return Number.isFinite(n) ? n.toFixed(precision) : ''
  }

  // Controlled while blurred, free-form while focused.
  const [editing, setEditing] = useState<string | null>(null)
  const shown = editing ?? (value !== undefined ? format(value) : undefined)

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={shown}
      defaultValue={value === undefined ? format(defaultValue) : undefined}
      onFocus={(e) => {
        setEditing(e.target.value)
        selectOnFocus(e)
        onFocus?.(e)
      }}
      onChange={(e) => {
        // Accept a comma as the decimal separator — the ZA keyboard offers it —
        // but hand callers a plain "1.5" they can Number() without surprises.
        const next = e.target.value.replace(',', '.')
        setEditing(next)
        if (onChange) {
          e.target.value = next
          onChange(e)
        }
      }}
      onBlur={(e) => {
        setEditing(null)
        onBlur?.(e)
      }}
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

/**
 * A textarea for CODE rather than prose — markup, a snippet, a template.
 *
 * A variant of Textarea rather than a `className` at the call site, per the
 * kit's rule that controls are not restyled where they are used. Three things
 * differ, and each is about reading code rather than sentences:
 *
 *   a monospace face, so indentation and tag nesting line up;
 *   no spellcheck, because every tag name is a misspelling;
 *   no autocorrect or capitalisation, which would rewrite the markup as typed.
 */
export function CodeArea({
  invalid,
  className = '',
  rows = 8,
  id,
  ...rest
}: Omit<ComponentProps<'textarea'>, 'className'> & { invalid?: boolean; className?: string }) {
  const wiring = useFieldWiring(id, invalid)
  return (
    <textarea
      id={wiring.id}
      rows={rows}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      aria-invalid={wiring.invalid || undefined}
      aria-describedby={wiring.describedBy}
      className={`${CONTROL} resize-y py-2 font-mono text-xs leading-relaxed ${wiring.invalid ? INVALID : ''} ${className}`}
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
  ariaLabel,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  hint?: string
  disabled?: boolean
  id?: string
  /**
   * Accessible name for a switch with no visible label — a cell in a grid
   * where the row and column already say what it means to a sighted user, but
   * a screen reader would otherwise announce a bare "switch".
   */
  ariaLabel?: string
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={ariaLabel ?? label}
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
  indeterminate = false,
  ...rest
}: Omit<ComponentProps<'input'>, 'type' | 'className'> & {
  label?: ReactNode
  className?: string
  /**
   * The "some, but not all" dash — a select-all box over a partial selection.
   *
   * Needs a ref because `indeterminate` is a DOM property with no matching HTML
   * attribute: React will not set it from a prop, so writing it at the call
   * site would mean reaching into the DOM from every table.
   */
  indeterminate?: boolean
}) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 text-sm text-ink ${className}`}>
      <input
        ref={(el) => {
          if (el) el.indeterminate = indeterminate
        }}
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

/**
 * ColourInput — a colour, picked or typed.
 *
 * Both halves, always: the swatch opens the OS picker (which is what people
 * reach for), and the hex field is how a brand colour actually arrives —
 * copied out of a style guide or an email from a designer. Offering only the
 * picker means hunting for a known value by eye.
 *
 * Emits the hex string, so callers never deal with the native input's quirks.
 * Validation belongs at the boundary that stores it — a colour that reaches a
 * public page must be checked server-side however it was entered.
 */
export function ColourInput({
  value,
  onChange,
  id,
  disabled,
  className = '',
}: {
  /** A #rrggbb string. */
  value: string
  onChange: (next: string) => void
  id?: string
  disabled?: boolean
  className?: string
}) {
  const wiring = useFieldWiring(id, false)
  // The native swatch rejects anything that is not #rrggbb, and a rejected
  // value makes it silently show black. Fall back while a hex is half-typed.
  const swatchValue = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <input
        type="color"
        value={swatchValue}
        disabled={disabled}
        aria-label="Pick a colour"
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL_H} w-14 shrink-0 cursor-pointer rounded-control border border-border-strong bg-surface p-1 disabled:cursor-not-allowed disabled:opacity-50`}
      />
      <input
        id={wiring.id}
        value={value}
        disabled={disabled}
        spellCheck={false}
        placeholder="#2f6fed"
        aria-describedby={wiring.describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL} ${CONTROL_H} w-32`}
      />
    </div>
  )
}
