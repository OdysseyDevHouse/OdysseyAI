'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Modal,
  Field,
  Input,
  Select,
  CurrencyInput,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { disposalResult } from '@/lib/assetModel'
import { disposeAssetAction } from '../actions'

/**
 * Disposing of an asset — sold, scrapped or written off.
 *
 * The profit or loss is shown as the proceeds are typed, because it is the
 * figure that surprises people: an asset depreciated over five years usually
 * sells for more than its book value, and that difference is income rather
 * than an error.
 */
export function DisposeButton({
  id,
  assetName,
  bookValue,
  bankAccounts,
}: {
  id: number
  assetName: string
  bookValue: number
  bankAccounts: { id: number; name: string }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)

  const [disposedOn, setDisposedOn] = useState(todayIso())
  const [proceeds, setProceeds] = useState(0)
  const [reason, setReason] = useState('')
  const [bankAccountId, setBankAccountId] = useState<number | null>(bankAccounts[0]?.id ?? null)

  // disposalResult takes cost and accumulated; passing book value with zero
  // accumulated gives the same answer and is what this screen has.
  const outcome = disposalResult(bookValue, 0, proceeds)

  return (
    <>
      <Button variant="danger-ghost" onClick={() => setOpen(true)}>
        Dispose
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={`Dispose of ${assetName}`}>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            The asset comes off the balance sheet at its book value of{' '}
            {formatMoney(bookValue)}, and stops depreciating. The difference between that and
            what it sold for is a profit or a loss.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Disposed on">
              <Input
                type="date"
                value={disposedOn}
                onChange={(e) => setDisposedOn(e.target.value)}
              />
            </Field>
            <Field label="Proceeds" hint="Zero if it was scrapped.">
              <CurrencyInput
                value={proceeds}
                onChange={(e) =>
                  setProceeds(Number(String(e.target.value).replace(',', '.')) || 0)
                }
              />
            </Field>
          </div>

          {proceeds > 0 && bankAccounts.length > 0 && (
            <Field label="Money received into">
              <Select
                value={String(bankAccountId ?? '')}
                onChange={(e) => setBankAccountId(Number(e.target.value) || null)}
              >
                {bankAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {/* The figure that surprises people, shown before they commit. */}
          <div className="rounded-control bg-surface-2 px-3 py-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Book value</span>
              <span className="numeric text-ink-2">{formatMoney(bookValue)}</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-muted">Proceeds</span>
              <span className="numeric text-ink-2">{formatMoney(proceeds)}</span>
            </div>
            <div className="mt-1 flex justify-between border-t border-border pt-1">
              <span className="font-medium text-ink">
                {outcome.isProfit ? 'Profit on sale' : 'Loss on sale'}
              </span>
              <span
                className={`numeric font-semibold ${outcome.isProfit ? 'text-success' : 'text-danger'}`}
              >
                {formatMoney(Math.abs(outcome.result))}
              </span>
            </div>
          </div>

          <Field label="Why is it being disposed of?">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Sold to a staff member"
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || !reason.trim() || !disposedOn}
              onClick={() =>
                startTransition(async () => {
                  const result = await disposeAssetAction(id, {
                    disposedOn,
                    proceeds,
                    reason: reason.trim(),
                    bankAccountId: proceeds > 0 ? bankAccountId : null,
                  })
                  if (result.ok) {
                    toast.success(result.message)
                    setOpen(false)
                    router.refresh()
                  } else {
                    toast.error(result.error)
                  }
                })
              }
            >
              Dispose
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
