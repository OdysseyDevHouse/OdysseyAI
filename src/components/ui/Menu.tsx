'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from './icons'
import { buttonClass, type ButtonSize, type ButtonVariant } from './styles'

/**
 * Dropdown menu. Handles open/close, outside click, Escape and the aria wiring
 * so no screen has to re-implement any of it.
 *
 * For a menu of destructive-ish row actions, keep the trigger 'ghost'.
 */
export function Menu({
  label,
  children,
  variant = 'ghost',
  align = 'right',
  iconOnly = false,
  size = 'md',
  triggerLabel,
  keepOpen = false,
  className = '',
}: {
  label: ReactNode
  children: ReactNode
  variant?: ButtonVariant
  /** Which edge the panel lines up with. 'right' suits toolbar buttons. */
  align?: 'left' | 'right'
  /**
   * A square, chevron-less trigger — the kebab at the end of a table row. The
   * chevron is dropped with the text because it exists to say "this word opens
   * something"; a lone ⋮ already says that, and the arrow beside it just makes
   * the control wider in the one column with no room to spare.
   *
   * Pass `triggerLabel` with it: the button then has no text to announce.
   */
  iconOnly?: boolean
  /** 'sm' for an inline row action, matching the other controls in the row. */
  size?: ButtonSize
  /** Accessible name for the trigger. Required when `iconOnly`. */
  triggerLabel?: string
  /**
   * The panel holds SETTINGS rather than commands, so a click inside it must not
   * dismiss it — picking a column count and then toggling a switch is one visit
   * to the menu, not two.
   *
   * The default is right for a list of actions: tap an item, the thing happens,
   * the menu gets out of the way. Pass this only for a panel of controls the
   * user adjusts and then closes deliberately.
   */
  keepOpen?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent) {
      /* A native <select> draws its options as an OS popup, OUTSIDE the DOM — so
         a mousedown on "5 across" reports a target this root does not contain
         and reads as a click elsewhere on the page. Closing on it would shut the
         menu before the change landed, which is exactly what a user picking a
         value experiences as "the popup closed on me". While one of our own
         selects has focus, an outside mousedown is that popup and is ignored. */
      const focused = document.activeElement
      if (focused?.tagName === 'SELECT' && rootRef.current?.contains(focused)) return
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
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={buttonClass({ variant, size, iconOnly })}
      >
        {label}
        {!iconOnly && (
          <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          /* Close on any activation inside, so callers never have to thread a
             setOpen down to each item — unless the panel is a set of settings,
             which the user adjusts and then dismisses themselves. */
          onClick={keepOpen ? undefined : () => setOpen(false)}
          /* A CEILING, and the menu scrolls past it.
             A menu is usually a handful of actions, so this never showed —
             but a picker built from a catalogue is not: the advanced filter
             offers thirty-five fields, which drew a 1,582px panel running
             far below the fold with its last items unreachable. Capped here
             rather than at that call site, because any menu long enough to
             leave the window has the same problem. */
          className={`absolute z-20 mt-1.5 max-h-80 min-w-44 overflow-y-auto overscroll-contain rounded-control border border-border bg-surface p-1 shadow-pop ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  children,
  onClick,
  href,
  download,
  tone = 'default',
  disabled = false,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  /**
   * Renders the entry as a link. Needed for downloads — a PDF or an .xlsx comes
   * from a route handler, and only an anchor can hand the response to the
   * browser as a file.
   */
  href?: string
  download?: boolean
  /** 'danger' for destructive entries — always put them last. */
  tone?: 'default' | 'danger'
  disabled?: boolean
  /** 'submit' when the entry posts a surrounding form, e.g. sign out. */
  type?: 'button' | 'submit'
}) {
  const skin = `flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-sm transition disabled:pointer-events-none disabled:text-faint ${
    tone === 'danger' ? 'text-danger hover:bg-danger-soft' : 'text-ink-2 hover:bg-surface-2'
  }`

  if (href && !disabled) {
    // A plain <a>, not next/link: a download must hit the server rather than be
    // intercepted by the client router, which would try to render it as a page.
    return (
      <a href={href} download={download} role="menuitem" className={skin}>
        {children}
      </a>
    )
  }

  return (
    <button type={type} role="menuitem" disabled={disabled} onClick={onClick} className={skin}>
      {children}
    </button>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-border" />
}
