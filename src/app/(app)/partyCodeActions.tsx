'use client'

import { useRef, useState } from 'react'
import { Menu, MenuItem, RenameCodeModal } from '@/components/ui'
import { Hash } from '@/components/ui/icons'

/**
 * The Actions menu on a customer or supplier — currently just the rename.
 *
 * One component for both because the two records ask exactly the same thing of
 * it, and the only difference is the noun. Products get their own
 * (products/[id]/ProductActions.tsx) because theirs also carries archive and
 * delete, and because a stock code rename travels to sibling stores where a
 * party code does not.
 *
 * The party forms keep Delete in their own row rather than a menu, so this sits
 * in the page header on its own.
 */
export default function PartyCodeActions({
  action,
  id,
  code,
  name,
  noun,
  maxLength = 32,
  renameError = null,
  returnTo = null,
}: {
  /** The server action that performs the rename. */
  action: (form: FormData) => void
  id: number
  code: string
  /** The account or supplier name, so the dialog says which record this is. */
  name: string
  /** 'customer' or 'supplier' — the only thing that differs between the two. */
  noun: 'customer' | 'supplier'
  maxLength?: number
  /** A refusal that already round-tripped; reopens the dialog holding it. */
  renameError?: string | null
  returnTo?: string | null
}) {
  const [renaming, setRenaming] = useState(Boolean(renameError))
  const form = useRef<HTMLFormElement>(null)
  const codeInput = useRef<HTMLInputElement>(null)

  const label = noun === 'customer' ? 'Customer code' : 'Supplier code'

  return (
    <>
      <Menu label="Actions" variant="ghost">
        <MenuItem onClick={() => setRenaming(true)}>
          <Hash size={15} />
          Rename {noun} code
        </MenuItem>
      </Menu>

      {/* Submitted by the dialog, never directly — see ProductActions for why
          the form cannot live inside it. */}
      <form ref={form} action={action} className="hidden">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="code" ref={codeInput} />
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      </form>

      <RenameCodeModal
        open={renaming}
        onClose={() => setRenaming(false)}
        onSubmit={(next) => {
          if (!codeInput.current) return
          codeInput.current.value = next
          form.current?.requestSubmit()
        }}
        title={`Rename ${noun} code`}
        label={`New ${label.toLowerCase()}`}
        currentCode={code}
        recordName={name}
        maxLength={maxLength}
        error={renameError}
        note={
          <>
            Statements, invoices and orders already issued keep{' '}
            <span className="numeric font-medium">{code}</span> — renaming does not restate a
            document that has already been sent.
          </>
        }
      />
    </>
  )
}
