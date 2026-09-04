'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { Field, Input } from './Field'
import { Callout } from './Callout'

/**
 * Renaming a record's code — a stock code, a customer code, a supplier code.
 *
 * A kit component rather than three copies because all three screens ask the
 * same question and owe the same warning, and because the thing that makes
 * this dialog safe is the part most easily left out of a copy: it shows the
 * OLD code beside the field, so the user can see what they are changing from
 * rather than trusting the box they are typing over.
 *
 * Deliberately not a ConfirmModal with an input bolted on. A confirm asks
 * yes/no about something already decided; this collects the new value, can be
 * refused by the server (the code is unique), and has to render that refusal
 * without losing what was typed.
 */
export function RenameCodeModal({
  open,
  onClose,
  onSubmit,
  title,
  label,
  currentCode,
  recordName,
  maxLength,
  note,
  busy = false,
  error = null,
}: {
  open: boolean
  onClose: () => void
  /** Given the trimmed new code. The caller owns the server round-trip. */
  onSubmit: (code: string) => void
  title: string
  /** "Stock code", "Customer code" — the field's own label. */
  label: string
  currentCode: string
  /** The description or name, shown so the user knows which record this is. */
  recordName: string
  maxLength: number
  /** What this rename will and will not touch. Differs per record type. */
  note: ReactNode
  busy?: boolean
  /** A refusal from the server — "already in use". Keeps what was typed. */
  error?: string | null
}) {
  const [code, setCode] = useState(currentCode)
  const inputRef = useRef<HTMLInputElement>(null)

  /* Re-seed each time it opens, so a cancelled edit does not persist into the
     next one. Keyed on `open` rather than `currentCode`: re-seeding whenever
     the prop changed would wipe the field the moment a successful rename
     flowed back down. */
  useEffect(() => {
    if (open) setCode(currentCode)
  }, [open, currentCode])

  // Select it rather than just focusing: the field is pre-filled with the old
  // code, and the common case is typing a new one over it entirely.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.select())
  }, [open])

  const trimmed = code.trim()
  const unchanged = trimmed === currentCode
  const submit = () => {
    if (!trimmed || unchanged || busy) return
    onSubmit(trimmed)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !trimmed || unchanged}>
            {busy ? 'Renaming…' : 'Rename code'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          <span className="font-medium text-ink">{recordName}</span> is currently{' '}
          <span className="numeric font-medium text-ink">{currentCode}</span>.
        </p>

        {error && <Callout tone="danger">{error}</Callout>}

        <Field label={label}>
          <Input
            ref={inputRef}
            value={code}
            maxLength={maxLength}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
            /* Enter submits, because a one-field dialog that ignores Enter
               feels broken. Guarded by the same rule as the button. */
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
          />
        </Field>

        <Callout tone="warning" title="What this changes">
          {note}
        </Callout>
      </div>
    </Modal>
  )
}
