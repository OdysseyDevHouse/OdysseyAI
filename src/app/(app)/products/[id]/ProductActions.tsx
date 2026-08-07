'use client'

import { useRef, useState } from 'react'
import { Menu, MenuItem, MenuSeparator, ConfirmModal } from '@/components/ui'
import { Archive, ArchiveRestore, Trash } from '@/components/ui/icons'
import { archiveProductAction, deleteProductAction } from '../actions'

/**
 * The secondary record actions, out of the form's action row and into the
 * header. Save is the one primary on this screen; archive and delete are
 * occasional acts and were competing with it for the same eye-line.
 *
 * Each action carries its own <form> because both are their own server actions
 * — they cannot nest inside the edit form (invalid HTML, the browser would
 * silently drop the inner form).
 */
export default function ProductActions({
  productId,
  isArchived,
  name,
}: {
  productId: number
  isArchived: boolean
  /** The product's description, repeated back in the delete confirm. */
  name: string
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteForm = useRef<HTMLFormElement>(null)

  return (
    <>
      <Menu label="Actions" variant="ghost">
        <form action={archiveProductAction}>
          <input type="hidden" name="id" value={productId} />
          <input type="hidden" name="archived" value={isArchived ? '0' : '1'} />
          <MenuItem type="submit">
            {isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            {isArchived ? 'Restore' : 'Archive'}
          </MenuItem>
        </form>
        <MenuSeparator />
        <MenuItem tone="danger" onClick={() => setConfirmingDelete(true)}>
          <Trash size={15} />
          Delete
        </MenuItem>
      </Menu>

      {/* Submitted by the confirm below — never directly. */}
      <form ref={deleteForm} action={deleteProductAction} className="hidden">
        <input type="hidden" name="id" value={productId} />
      </form>

      <ConfirmModal
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={() => deleteForm.current?.requestSubmit()}
        title="Delete product"
        message={
          <>
            Delete <span className="font-medium text-ink">{name}</span>? This cannot be undone —
            archive it instead if it may still appear in reports.
          </>
        }
        confirmLabel="Delete product"
      />
    </>
  )
}
