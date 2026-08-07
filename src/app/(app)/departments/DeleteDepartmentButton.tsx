'use client'

import { useRef, useState } from 'react'
import { Button, ConfirmModal } from '@/components/ui'
import { Trash } from '@/components/ui/icons'
import { deleteDepartmentAction } from './actions'

/**
 * Delete, behind a confirm. The action itself still refuses when children or
 * products depend on the department — `blocked` only saves the round trip and
 * explains why the button is off.
 */
export default function DeleteDepartmentButton({
  id,
  name,
  blocked,
}: {
  id: number
  /** Repeated back in the confirm, so the user reads what they are deleting. */
  name: string
  blocked: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const form = useRef<HTMLFormElement>(null)

  return (
    <>
      {/* Submitted by the confirm below — never directly. */}
      <form ref={form} action={deleteDepartmentAction} className="hidden">
        <input type="hidden" name="id" value={id} />
      </form>

      <Button
        type="button"
        variant="danger-ghost"
        disabled={blocked}
        title={
          blocked ? 'Still has sub-departments or products assigned' : 'Delete this department'
        }
        onClick={() => setConfirming(true)}
      >
        <Trash size={15} />
        Delete
      </Button>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => form.current?.requestSubmit()}
        title="Delete department"
        message={
          <>
            Delete <span className="font-medium text-ink">{name}</span>? This cannot be undone.
          </>
        }
        confirmLabel="Delete department"
      />
    </>
  )
}
