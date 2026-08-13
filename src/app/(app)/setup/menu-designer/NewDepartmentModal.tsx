'use client'

import { useState } from 'react'
import { Button, Field, Icons, Input, Modal, SwatchPicker } from '@/components/ui'

/**
 * Creates an empty department at the level being browsed.
 *
 * Name and colour only. Everything else a department has — code, sort order,
 * pictures, re-parenting — lives on its full record, because this modal exists
 * to keep an arrangement moving: an owner mid-drag wants somewhere to put the
 * next twelve products, not a form.
 */
export function NewDepartmentModal({
  open,
  parentName,
  onClose,
  onCreate,
}: {
  open: boolean
  /** The department it will sit under, or null at the top level. */
  parentName: string | null
  onClose: () => void
  /** Resolves false when the server refused, so the modal can stay open. */
  onCreate: (input: { name: string; color: string | null }) => Promise<boolean>
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [seenOpen, setSeenOpen] = useState(open)

  // Re-seeded on each opening, so a cancelled attempt does not prefill the next.
  if (seenOpen !== open) {
    setSeenOpen(open)
    if (open) {
      setName('')
      setColor(null)
      setBusy(false)
    }
  }

  const trimmed = name.trim()

  async function submit() {
    if (!trimmed || busy) return
    setBusy(true)
    const ok = await onCreate({ name: trimmed, color })
    setBusy(false)
    if (!ok) return
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={parentName ? `New department inside ${parentName}` : 'New top-level department'}
      description={
        parentName
          ? 'It appears inside this one on the till. Drag products into it once it exists.'
          : 'It appears on the till’s top level. Drag products into it once it exists.'
      }
      size="sm"
      /* Holds half-typed work — a stray backdrop click must not discard it. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || trimmed.length === 0}>
            <Icons.Plus size={15} />
            {busy ? 'Creating…' : 'Create department'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoFocus
            placeholder={parentName ? 'e.g. Soft drinks' : 'e.g. Drinks'}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2">Colour</span>
          <SwatchPicker value={color} onChange={setColor} size="sm" disabled={busy} />
        </div>
      </div>
    </Modal>
  )
}
