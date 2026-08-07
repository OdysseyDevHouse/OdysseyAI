'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, ConfirmModal, Icons, Menu, MenuItem, MenuSeparator, useToast } from '@/components/ui'
import {
  billNowAction,
  setContractActiveAction,
  setAutoSendAction,
  deleteContractAction,
} from '../actions'

/**
 * The contract's own actions.
 *
 * "Bill now" is the primary when something is due — it is the whole reason
 * somebody opens a contract mid-month. Everything else lives in a menu, because
 * pausing, switching automation and deleting are rare and destructive-adjacent,
 * and a row of five buttons makes none of them findable.
 */
export function ContractActions({
  contractId,
  name,
  isActive,
  autoSend,
  due,
  canAutoSend,
}: {
  contractId: number
  name: string
  isActive: boolean
  autoSend: boolean
  due: boolean
  canAutoSend: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [confirmDelete, setConfirmDelete] = useState(false)

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  return (
    <>
      {due ? (
        <Button onClick={() => run(() => billNowAction(contractId))} disabled={pending}>
          <Icons.Receipt size={15} />
          {pending ? 'Billing…' : 'Bill now'}
        </Button>
      ) : null}

      <Menu label={<Icons.MoreHorizontal size={15} />} variant="secondary" align="right">
        {!due ? (
          <MenuItem onClick={() => run(() => billNowAction(contractId))}>
            <Icons.Receipt size={15} />
            Bill now
          </MenuItem>
        ) : null}

        {canAutoSend ? (
          <MenuItem onClick={() => run(() => setAutoSendAction(contractId, !autoSend))}>
            <Icons.Send size={15} />
            {autoSend ? 'Stop sending automatically' : 'Send automatically'}
          </MenuItem>
        ) : null}

        <MenuItem onClick={() => run(() => setContractActiveAction(contractId, !isActive))}>
          {isActive ? <Icons.Pause size={15} /> : <Icons.Play size={15} />}
          {isActive ? 'Pause this contract' : 'Resume this contract'}
        </MenuItem>

        <MenuSeparator />

        <MenuItem tone="danger" onClick={() => setConfirmDelete(true)}>
          <Icons.Trash size={15} />
          Delete contract
        </MenuItem>
      </Menu>

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete “${name}”?`}
        // Says exactly what survives. "Are you sure?" makes someone guess
        // whether their posted invoices are about to disappear.
        message="The contract stops billing and its schedule is removed. Every invoice it has already raised is kept — those are posted tax documents and are not affected."
        confirmLabel="Delete contract"
        tone="danger"
        onConfirm={() => {
          setConfirmDelete(false)
          startTransition(async () => {
            const result = await deleteContractAction(contractId)
            if (result.ok) {
              toast.success(result.message)
              router.push('/sales/contracts')
              router.refresh()
            } else {
              toast.error(result.error)
            }
          })
        }}
      />
    </>
  )
}
