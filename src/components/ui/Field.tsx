'use client'

import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { ChevronDown } from './icons'
import { SetupText } from './SetupText'
import {
  CONTROL,
  CONTROL_H,
  CONTROL_H_TOUCH,
  CONTROL_INVALID as INVALID,
  CONTROL_QUIET_FOCUS,
  FIELD_LABEL,
} from './styles'

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
          <label htmlFor={id} className={FIELD_LABEL}>
            {label}
          </label>
        )}
        {children}
        {/* Through SetupText: a field's hint and its error both point at a
            settings screen often enough to be worth linking — "needs an SMS
            provider under Setup → Text messages" is a dead end otherwise. */}
        {message && (
          <p id={messageId} className={`mt-1.5 text-xs ${error ? 'text-danger' : 'text-muted'}`}>
            <SetupText>{message}</SetupText>
          </p>
        )}
      </div>
    </FieldContext.Provider>
  )
}

/**
 * A field whose label sits BESIDE the control rather than above it, inside its
 * own bordered card.
 *
 * For the till, where a dialog is a row of equal-weight cards and a stacked
 * label would leave the control floating with nothing framing it. The label is
 * a fixed-content column on the left, the control takes the rest — so two of
 * these side by side line their controls up even when one label is longer.
 *
 * Back-office forms keep `Field`: a column of stacked labels is faster to scan
 * down, and that is what every edit screen is.
 */
export function InlineField({
  label,
  icon,
  htmlFor,
  children,
  className = '',
}: {
  label: string
  /** Small leading glyph, sized 16 by the caller. */
  icon?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  const generatedId = useId()
  const id = htmlFor ?? generatedId

  return (
    <FieldContext.Provider value={{ id, invalid: false }}>
      <div
        className={`flex items-center gap-3 rounded-card border border-border bg-surface p-3 ${className}`}
      >
        <label
          htmlFor={id}
          className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-ink-2"
        >
          {icon && <span className="text-muted">{icon}</span>}
          {label}
        </label>
        <div className="min-w-0 flex-1">{children}</div>
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
  /**
   * For the rare field that HOLDS focus by design (the till's scan box): a calm
   * 1px half-strength focus line instead of the full 2px brand edge, which would
   * otherwise glow all shift long. Never removes the indication entirely.
   */
  quietFocus?: boolean
  className?: string
}

export function Input({
  icon,
  invalid,
  size = 'md',
  quietFocus = false,
  className = '',
  id,
  ...rest
}: InputProps) {
  const wiring = useFieldWiring(id, invalid)

  /*
   * LAYOUT CLASSES BELONG ON THE OUTER ELEMENT.
   *
   * With an icon this renders a positioning wrapper around the input, so a
   * caller writing `className="flex-1"` — the ordinary way to make a search box
   * fill a toolbar — was styling the inner <input> while the WRAPPER stayed at
   * its content width. The field then sat stubbornly narrow in a wide row and no
   * amount of flex on the parent could fix it, because the flex item was the
   * wrapper, not the thing carrying the class.
   *
   * So the classes that describe how this sits among its siblings are peeled off
   * and applied to whichever element is actually outermost; everything else
   * (colours, padding, text) stays on the input where it belongs.
   */
  const outerClasses: string[] = []
  const innerClasses: string[] = []
  for (const cls of className.split(/\s+/).filter(Boolean)) {
    ;(LAYOUT_CLASS.test(cls) ? outerClasses : innerClasses).push(cls)
  }
  const inner = innerClasses.join(' ')
  const outer = outerClasses.join(' ')
  const width = icon ? 'w-full' : outer

  const input = (
    <input
      id={wiring.id}
      aria-invalid={wiring.invalid || undefined}
      aria-describedby={wiring.describedBy}
      className={`${skin(width)} ${size === 'touch' ? CONTROL_H_TOUCH : CONTROL_H} ${
        /* The glyph is inset further at till size so it clears the wider box
           without crowding the text. */
        icon ? (size === 'touch' ? 'pl-11' : 'pl-9') : ''
      } ${wiring.invalid ? INVALID : quietFocus ? CONTROL_QUIET_FOCUS : ''} ${width} ${inner}`}
      {...rest}
    />
  )

  if (!icon) return input

  return (
    <div className={`relative ${outer}`}>
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
 * Classes that position an element among its siblings rather than paint it.
 *
 * Matched conservatively — anything not listed stays on the input, so an unknown
 * utility can only ever behave as it did before this split existed.
 */
const LAYOUT_CLASS =
  /^(flex-\d|flex-auto|flex-initial|flex-none|grow|grow-0|shrink|shrink-0|basis-|w-|min-w-|max-w-|col-span-|self-|order-)/

/**
 * CONTROL, minus its `w-full`, when the caller has named a width of its own.
 *
 * A CONTROL WIDTH CANNOT SIMPLY BE APPENDED. `CONTROL` opens with `w-full`, and
 * Tailwind decides between two width utilities by STYLESHEET order, not by the
 * order they appear in the class attribute — `.w-full` is emitted after every
 * `.w-<n>`, so it wins every time. A `w-28` passed to a price box therefore did
 * nothing: the box stretched to fill its flex row and squeezed the item name
 * beside it down to nothing (the specials price table, where five of them sat
 * in a row). Both widths cannot live on the element, so the base one gives way
 * to the specific one.
 *
 * Callers that want the full width say nothing and keep it.
 */
function skin(width: string) {
  return /(^|\s)w-/.test(width) ? CONTROL.replace('w-full ', '') : CONTROL
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
 * Would this text carry more decimals than the field allows?
 *
 * Only ever answers about the DECIMALS. Everything else a half-typed number
 * legitimately looks like has to pass through untouched, or the field becomes
 * impossible to type in rather than merely limited:
 *
 *   ""      nothing yet          "-"     a minus, before any digit
 *   "1."    the point just typed  ".5"   leading point, no zero
 *
 * A trailing point is allowed even at precision 0. Refusing it would be right
 * in principle and awful in practice — the operator would press "." on a
 * whole-unit product, see nothing happen, and press it again. It resolves
 * itself: any DIGIT after that point is refused by this same function, and
 * blur formats the stray point away.
 *
 * Non-numeric text is not this function's business either; it says no-opinion
 * and lets the caller's own parsing reject it.
 */
function tooManyDecimals(text: string, precision: number): boolean {
  const point = text.indexOf('.')
  if (point === -1) return false
  return text.length - point - 1 > precision
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
 *
 * ── PRECISION IS ALSO A LIMIT ON WHAT MAY BE TYPED ───────────────────────
 *
 * A keystroke that would take the number past `precision` decimals is REFUSED
 * — the caret does not move and nothing is echoed to the caller.
 *
 * Rounding on blur is not enough on its own, and the difference is not
 * cosmetic. A product allowing 3 decimals, typed as 3.4556, blurred to 3.456:
 * the operator typed a 5 and the box shows a 6. It is arithmetically correct
 * and it reads as the till changing the number — and on a screen where the
 * quantity is what gets charged for, a figure nobody typed is worse than a
 * keystroke that never landed. Refusing at the key press means what is on
 * screen is always what was typed.
 *
 * Blur-time rounding STAYS, for the inputs a person did not type: a scale
 * weighing 1.2345kg of a two-decimal product has not made a mistake to be
 * corrected (see roundQty), and a caller writing a computed value in is not
 * typing either.
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

  /*
   * CONTROLLED-NESS IS DECIDED ONCE, BY THE CALLER.
   *
   * Read from the FIRST render and kept, because React treats an input that
   * gains a `value` as switching from uncontrolled to controlled and warns —
   * and this component used to do exactly that to itself. An uncontrolled
   * caller (`defaultValue`, no `value`) rendered `value={undefined}`, then
   * focus set `editing` to a string and `shown` became defined: the input
   * flipped mid-life on a plain click, with no prop having changed.
   *
   * A ref rather than state because it must not cause a render, and must not
   * follow a caller that starts passing `value` later — the DOM node's mode is
   * fixed when it mounts, so tracking anything else would only move the warning.
   */
  const controlled = useRef(value !== undefined).current

  /*
   * A `value` the FIELD did not type wins over the editing buffer.
   *
   * The buffer exists so formatting cannot fight the caret mid-keystroke, and
   * it is cleared on blur. But a value can also change from OUTSIDE while the
   * field still has focus — a calculator dialog writing its result back, a
   * sibling cell recomputing this one — and the buffer was masking it: the box
   * went on showing the old number while everything derived from it moved.
   * Measured on the recipe panel's quantity cell, not theorised.
   *
   * Comparing against the value we last echoed to a caller is what separates
   * the two cases. Typing sets `echoed` in onChange, so the buffer survives its
   * own keystrokes; anything else leaves them unequal and the buffer stands
   * down.
   */
  const echoed = useRef<string | null>(null)
  // Read-only during render — the ref is only written in the event handlers
  // below, so a double render under StrictMode cannot change what this decides.
  const external = editing !== null && echoed.current !== format(value)

  /*
   * The editing buffer feeds the CONTROLLED path only.
   *
   * An uncontrolled input already holds what is typed — that is what
   * uncontrolled means — so feeding `editing` back would both flip the mode and
   * fight the DOM for the caret. It is still tracked: onChange callers get
   * their value either way, and onBlur clears it in both modes.
   */
  const shown = controlled ? (external ? format(value) : (editing ?? format(value))) : undefined

  return (
    <Input
      type="text"
      inputMode="decimal"
      /*
        NO BROWSER HISTORY ON A MONEY BOX.

        Chrome offers previously-typed values on any text input it recognises,
        which on a cash-up drops a list of old figures over the very field being
        counted — and the top of that list is one tap from being accepted as
        this shift's declaration. A number chosen from a dropdown of past counts
        is not a count.

        `autoComplete` alone is not enough: Chrome ignores "off" on fields it
        thinks it recognises, so the other three go with it. `data-1p-ignore`
        and `data-lpignore` keep 1Password and LastPass icons out of the box.

        Before `...rest`, so a caller that genuinely wants a suggestion list can
        still pass its own `autoComplete`.
      */
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      value={shown}
      defaultValue={controlled ? undefined : format(defaultValue)}
      onFocus={(e) => {
        setEditing(e.target.value)
        // What is on screen right now IS this field's own value, so an external
        // write is anything that differs from it later.
        echoed.current = e.target.value
        selectOnFocus(e)
        onFocus?.(e)
      }}
      onChange={(e) => {
        // Accept a typed comma, hand callers a plain "1.5".
        const next = e.target.value.replace(',', '.')

        /*
         * Too many decimals: refuse the keystroke outright.
         *
         * Put back what the field held and restore the caret, because simply
         * returning leaves the DOM node showing the rejected character — this
         * is an uncontrolled input as far as React is concerned while it has
         * focus, so the node keeps whatever was typed into it unless it is
         * written back by hand.
         *
         * The caret is set to where it was BEFORE the key: refusing a
         * character typed in the middle of a number must not throw the cursor
         * to the end, or correcting "1.2345" to "12.345" becomes impossible.
         *
         * `precision === 0` participates: a whole-unit product refuses the
         * decimal point itself, which is the same rule with nothing after it.
         */
        if (precision !== undefined && tooManyDecimals(next, precision)) {
          /* What the box held before this key. `editing` is set on focus and
             on every accepted keystroke, so it is the truth here; the other
             two are only reached if a caller drives this field without ever
             focusing it. */
          const kept = editing ?? (controlled ? format(value) : '')
          const caret = (e.target.selectionStart ?? kept.length) - 1
          e.target.value = kept
          const at = Math.max(0, Math.min(caret, kept.length))
          e.target.setSelectionRange(at, at)
          return
        }

        setEditing(next)
        // Remember what the caller is about to be told, so the value coming
        // back is recognised as this field's own rather than someone else's.
        echoed.current = format(next)
        if (onChange) {
          e.target.value = next
          onChange(e)
        }
      }}
      onBlur={(e) => {
        setEditing(null)
        echoed.current = null
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
    /* EMPTY STAYS EMPTY. Number('') is 0, so without this an empty box renders
       "0.00" — which on a cash-up is the difference between "counted, and there
       was nothing" and "not counted yet". A caller wanting a zero passes 0. */
    if (raw === '' || raw === null || raw === undefined) return ''
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'))
    return Number.isFinite(n) ? n.toFixed(precision) : ''
  }

  // Controlled while blurred, free-form while focused.
  const [editing, setEditing] = useState<string | null>(null)

  // Fixed at mount, exactly as in NumberInput above — see the note there for
  // why an uncontrolled box must never be handed `editing`.
  const controlled = useRef(value !== undefined).current
  const shown = controlled ? (editing ?? format(value)) : undefined

  return (
    <Input
      type="text"
      inputMode="decimal"
      /*
        NO BROWSER HISTORY ON A MONEY BOX.

        Chrome offers previously-typed values on any text input it recognises,
        which on a cash-up drops a list of old figures over the very field being
        counted — and the top of that list is one tap from being accepted as
        this shift's declaration. A number chosen from a dropdown of past counts
        is not a count.

        `autoComplete` alone is not enough: Chrome ignores "off" on fields it
        thinks it recognises, so the other three go with it. `data-1p-ignore`
        and `data-lpignore` keep 1Password and LastPass icons out of the box.

        Before `...rest`, so a caller that genuinely wants a suggestion list can
        still pass its own `autoComplete`.
      */
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      value={shown}
      defaultValue={controlled ? undefined : format(defaultValue)}
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
      className={`${skin(className)} resize-y py-2 ${wiring.invalid ? INVALID : ''} ${className}`}
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
      className={`${skin(className)} resize-y py-2 font-mono text-xs leading-relaxed ${wiring.invalid ? INVALID : ''} ${className}`}
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
        placeholder="#1890cd"
        aria-describedby={wiring.describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={`${CONTROL} ${CONTROL_H} w-32`}
      />
    </div>
  )
}
