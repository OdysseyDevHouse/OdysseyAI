'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from './icons'
import { buttonClass, type ButtonVariant } from './styles'

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
  className = '',
}: {
  label: ReactNode
  children: ReactNode
  variant?: ButtonVariant
  /** Which edge the panel lines up with. 'right' suits toolbar buttons. */
  align?: 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent) {
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
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={buttonClass({ variant })}
      >
        {label}
        <ChevronDown size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          /* Close on any activation inside, so callers never have to thread a
             setOpen down to each item. */
          onClick={() => setOpen(false)}
          className={`absolute z-20 mt-1.5 min-w-44 rounded-control border border-border bg-surface p-1 shadow-pop ${
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
  tone = 'default',
  disabled = false,
}: {
  children: ReactNode
  onClick?: () => void
  /** 'danger' for destructive entries — always put them last. */
  tone?: 'default' | 'danger'
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-sm transition disabled:pointer-events-none disabled:text-faint ${
        tone === 'danger' ? 'text-danger hover:bg-danger-soft' : 'text-ink-2 hover:bg-surface-2'
      }`}
    >
      {children}
    </button>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-border" />
}
