'use client'

import { useRef, useState } from 'react'
import { Button, ConfirmModal } from '@/components/ui'
import { Trash } from '@/components/ui/icons'
import { deleteInstructionAction } from './actions'

/**
 * Delete, behind a confirm. The action still refuses server-side when products
 * depend on the instruction — the confirm just stops an accidental click from
 * making the round trip at all.
 */
export default function DeleteInstructionButton({
  id,
  name,
  productCount,
}: {
  id: number
  /** Repeated back in the confirm, so the user reads what they are deleting. */
  name: string
  productCount: number
}) {
  const [confirming, setConfirming] = useState(false)
  const form = useRef<HTMLFormElement>(null)

  return (
    <>
      {/* Submitted by the confirm below — never directly. */}
      <form ref={form} action={deleteInstructionAction} className="hidden">
        <input type="hidden" name="id" value={id} />
      </form>

      <Button type="button" variant="danger-ghost" onClick={() => setConfirming(true)}>
        <Trash size={15} />
        Delete
      </Button>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => form.current?.requestSubmit()}
        title="Delete instruction"
        message={
          <>
            Delete <span className="font-medium text-ink">{name}</span>?{' '}
            {productCount > 0
              ? `It is still attached to ${productCount} product${productCount === 1 ? '' : 's'}, so the till would stop asking it.`
              : 'This cannot be undone.'}
          </>
        }
        confirmLabel="Delete instruction"
      />
    </>
  )
}
