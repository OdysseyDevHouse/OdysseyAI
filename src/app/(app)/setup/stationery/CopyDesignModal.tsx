'use client'

import { useEffect, useState } from 'react'
import { Button, Callout, Field, Input, Modal, Select } from '@/components/ui'

/**
 * "Copy this design" — to a new name, or onto another document.
 *
 * ── IT ASKS BEFORE IT ACTS, AND EXPLAINS AFTER ────────────────────────────
 *
 * A copy is not always a clean one. An invoice carries a VAT summary and
 * banking details that a delivery note must not, so copying between documents
 * quietly drops blocks — and a shop that is not told will assume the prices
 * came across, then find out from a customer.
 *
 * So the target is chosen deliberately rather than defaulted, and what the copy
 * actually did comes back as the action's message rather than a bare "done".
 * The server composes that sentence (describeCopy), because the server is what
 * knows what fell out.
 *
 * ── WHAT IS OFFERED DEPENDS ON THE DESIGN ─────────────────────────────────
 *
 * A slip and a page cannot become each other — a slip has no positions and a
 * page is nothing else — so the other medium is not in the list at all. A
 * design typed as HTML has no blocks to filter, so it can only be duplicated
 * where it stands; the list says so rather than offering targets that will be
 * refused.
 */
export default function CopyDesignModal({
  open,
  sourceName,
  sourceDocType,
  sourceFormat,
  docs,
  busy,
  onClose,
  onCopy,
}: {
  open: boolean
  sourceName: string
  sourceDocType: string
  sourceFormat: 'html' | 'slip' | 'blocks'
  docs: { key: string; label: string; medium: 'a4' | 'slip' }[]
  busy: boolean
  onClose: () => void
  onCopy: (targetDocType: string, name: string) => void
}) {
  const sourceMedium = docs.find((d) => d.key === sourceDocType)?.medium ?? 'a4'

  /*
   * Markup has no block structure to filter against another document's catalog,
   * so it stays where it is. Everything else may move within its own medium.
   */
  const movable = sourceFormat === 'blocks'
  const targets = movable ? docs.filter((d) => d.medium === sourceMedium) : docs.filter((d) => d.key === sourceDocType)

  const [target, setTarget] = useState(sourceDocType)
  const [name, setName] = useState('')

  /*
   * Reset each time it opens. A dialog that remembers the last copy would offer
   * to put this design on whatever document the previous one went to, which is
   * a mistake waiting for someone working quickly.
   */
  useEffect(() => {
    if (!open) return
    setTarget(sourceDocType)
    setName(`${sourceName} (copy)`)
  }, [open, sourceDocType, sourceName])

  const targetLabel = docs.find((d) => d.key === target)?.label ?? ''
  const movingDocument = target !== sourceDocType

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Copy this design"
      description={sourceName}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onCopy(target, name)} disabled={busy || !name.trim()}>
            {movingDocument ? `Copy to ${targetLabel}` : 'Duplicate'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Which document">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!movable}>
            {targets.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
                {d.key === sourceDocType ? ' (a duplicate)' : ''}
              </option>
            ))}
          </Select>
        </Field>

        {!movable && (
          <Callout tone="neutral">
            This design is written as HTML, so it can only be duplicated on its own document.
            Design it by dragging instead and it can be copied to any page document.
          </Callout>
        )}

        {/*
          Said BEFORE the copy, not only after. A shop about to put its invoice
          on a delivery note should know the shape of what is coming rather than
          discover it in a toast — and the exact list comes back from the server,
          which is the half that knows.
        */}
        {movingDocument && (
          <Callout tone="warning">
            Anything a {targetLabel.toLowerCase()} cannot carry is left behind — prices on a
            delivery note, banking details on an order. You will be told exactly what went.
          </Callout>
        )}

        <Field label="Call it">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My invoice design"
          />
        </Field>

        <p className="text-xs text-muted">
          The copy is saved but not used — nothing changes on paper until you choose
          &ldquo;Use this&rdquo;.
        </p>
      </div>
    </Modal>
  )
}
