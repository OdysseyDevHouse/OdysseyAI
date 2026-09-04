'use client'

import { useRef, useState } from 'react'
import { Menu, MenuItem, MenuSeparator, ConfirmModal, RenameCodeModal } from '@/components/ui'
import { Archive, ArchiveRestore, Trash, Hash } from '@/components/ui/icons'
import { archiveProductAction, deleteProductAction, renameProductCodeAction } from '../actions'

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
  code,
  canDelete,
  canRenameCode,
  renameError = null,
  returnTo = null,
}: {
  productId: number
  /**
   * The list this product was opened from, so archiving or deleting returns to
   * it rather than to the bare catalogue. Null when it was reached directly.
   */
  returnTo?: string | null
  isArchived: boolean
  /** The product's description, repeated back in the delete confirm. */
  name: string
  /** The current stock code — the "from" side of the rename dialog. */
  code: string
  /** `products.delete`. The action enforces it too — this only hides the item. */
  canDelete: boolean
  /** `products.rename_code`. Enforced in the action; this only hides the item. */
  canRenameCode: boolean
  /**
   * A refusal from a rename that already round-tripped — "already in use".
   * Arrives as a URL param so the dialog REOPENS holding the message; without
   * it the refusal would land as a banner behind a dialog the user had just
   * watched close, reading as though the rename had worked.
   */
  renameError?: string | null
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [renaming, setRenaming] = useState(Boolean(renameError))
  const deleteForm = useRef<HTMLFormElement>(null)
  const renameForm = useRef<HTMLFormElement>(null)
  const renameCode = useRef<HTMLInputElement>(null)

  return (
    <>
      <Menu label="Actions" variant="ghost">
        <form action={archiveProductAction}>
          <input type="hidden" name="id" value={productId} />
          <input type="hidden" name="archived" value={isArchived ? '0' : '1'} />
          {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
          <MenuItem type="submit">
            {isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
            {isArchived ? 'Restore' : 'Archive'}
          </MenuItem>
        </form>
        {canRenameCode && (
          <MenuItem onClick={() => setRenaming(true)}>
            <Hash size={15} />
            Rename stock code
          </MenuItem>
        )}
        {canDelete && (
          <>
            <MenuSeparator />
            <MenuItem tone="danger" onClick={() => setConfirmingDelete(true)}>
              <Trash size={15} />
              Delete
            </MenuItem>
          </>
        )}
      </Menu>

      {/* Submitted by the confirm below — never directly. */}
      <form ref={deleteForm} action={deleteProductAction} className="hidden">
        <input type="hidden" name="id" value={productId} />
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      </form>

      {/* Likewise: the dialog writes the new code into this input and submits
          it. A server action needs a form, and the dialog cannot supply one —
          it renders into a <dialog> outside this subtree. */}
      <form ref={renameForm} action={renameProductCodeAction} className="hidden">
        <input type="hidden" name="id" value={productId} />
        <input type="hidden" name="code" ref={renameCode} />
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      </form>

      <RenameCodeModal
        open={renaming}
        onClose={() => setRenaming(false)}
        onSubmit={(next) => {
          if (!renameCode.current) return
          renameCode.current.value = next
          renameForm.current?.requestSubmit()
        }}
        title="Rename stock code"
        label="New stock code"
        currentCode={code}
        recordName={name}
        maxLength={48}
        error={renameError}
        note={
          <>
            Past invoices, orders and stock movements keep{' '}
            <span className="numeric font-medium">{code}</span>, so history stays readable. Shelf
            labels and barcodes showing the old code need reprinting, and tills pick the change up
            on their next catalogue sync.
          </>
        }
      />

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
