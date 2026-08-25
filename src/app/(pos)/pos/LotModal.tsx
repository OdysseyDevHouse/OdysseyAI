'use client'

import { useEffect, useState } from 'react'
import { Badge, Button, Field, Input, Modal } from '@/components/ui'
import type { TillLot } from '@/lib/site/batches'
import type { TillProduct } from '@/lib/site/tillSearch'

/**
 * The lot prompt for a batch-tracked item whose lot the scan did not carry (234).
 *
 * The WeighModal pattern, for the same reason: a GS1 barcode arrives with the
 * lot embedded and skips this entirely. Everything else — a tile, a search
 * result, a typed code, a plain EAN-13 — has none, and booking it against the
 * earliest expiry is a guess about which pack the customer is holding.
 *
 * ── WHY THE FEFO LOT IS PRESELECTED ──────────────────────────────────────
 *
 * The list arrives in the server's own FEFO order, so the first row IS the lot
 * that would have been chosen anyway. Preselecting it makes the common case one
 * tap — confirm what the shelf rotation already implies — rather than making a
 * clerk read a list to reach the same answer. Somebody who took a different
 * carton picks it; that is the whole feature, and it costs them one more tap.
 *
 * ── WHY EXPIRED LOTS ARE SHOWN ───────────────────────────────────────────
 *
 * Because they may genuinely be on the shelf, and the till will sell them
 * (allocateFefoTx draws on expired stock rather than stopping trade over a date
 * typed at a receiving door). Hiding one here would leave a clerk holding a
 * carton they cannot name — so it is listed, flagged, and sellable.
 *
 * ── AND WHY "TYPE IT" EXISTS ─────────────────────────────────────────────
 *
 * A delivery that skipped the receiving desk has stock on the shelf and no lot
 * on file. Refusing would stop the shop selling it; the typed number is still
 * recorded, and the server reports it as unplaceable rather than losing it.
 * Offline this is the ONLY option — no lot table ships to the till.
 */
export function LotModal({
  product,
  lots,
  loading,
  offline,
  strict,
  returning = false,
  onConfirm,
  onCancel,
}: {
  product: TillProduct
  /** Open lots at this till's location, earliest expiry first. */
  lots: TillLot[]
  loading: boolean
  /** No list could be fetched — the till is offline. Type-only. */
  offline: boolean
  /** The shop refuses a sale with no lot. Changes what Cancel means, not the UI. */
  strict: boolean
  /**
   * Goods coming BACK rather than going out (236).
   *
   * Changes the words and the default, not the mechanism. Nothing is
   * preselected on a return: the pack is in the customer's hand with its own
   * number on it, and the lot due to sell next is no kind of guess about which
   * carton somebody bought a fortnight ago.
   */
  returning?: boolean
  onConfirm: (batchNo: string) => void
  onCancel: () => void
}) {
  const [picked, setPicked] = useState<string>('')
  const [typed, setTyped] = useState('')
  const [typing, setTyping] = useState(false)

  /*
   * A fresh product means a fresh answer — never inherit the last item's lot.
   * Preselect the first row, which is the FEFO pick, once the list lands.
   */
  useEffect(() => {
    // Nothing preselected on a RETURN — see `returning`. On a sale the first
    // row IS the FEFO answer, so preselecting makes the common case one tap.
    setPicked(returning ? '' : (lots[0]?.batchNo ?? ''))
    setTyped('')
    setTyping(lots.length === 0)
  }, [product.id, lots, returning])

  const chosen = typing ? typed.trim() : picked
  const valid = chosen.length > 0

  return (
    <Modal
      open
      onClose={onCancel}
      title={returning ? `Lot coming back — ${product.description}` : `Lot for ${product.description}`}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {offline
            ? 'No lot list while offline — key the number printed on the pack.'
            : returning
              ? 'Which lot is on the pack being handed back? Read it off the label.'
              : 'Which lot is this coming from? The first is the one due to sell next.'}
        </p>

        {loading ? (
          <p className="text-sm text-faint">Reading the lots…</p>
        ) : (
          <>
            {lots.length > 0 && (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {lots.map((lot) => (
                  <label
                    key={lot.batchNo}
                    /* Not a kit component: a selectable multi-line row with a
                       badge and a right-aligned quantity, which Radio's own
                       inline label cannot express. */
                    data-kit-ok
                    className={`flex cursor-pointer items-center gap-3 rounded-control border px-3 py-2 ${
                      !typing && picked === lot.batchNo
                        ? 'border-brand bg-brand-soft'
                        : 'border-border bg-surface hover:bg-surface-2'
                    }`}
                  >
                    <input
                      type="radio"
                      name="lot"
                      className="size-4 cursor-pointer border-border-strong"
                      checked={!typing && picked === lot.batchNo}
                      onChange={() => {
                        setTyping(false)
                        setPicked(lot.batchNo)
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {lot.batchNo}
                      </span>
                      <span className="block text-xs text-muted">
                        {lot.expiryDate ? `Expires ${lot.expiryDate}` : 'No expiry date'}
                      </span>
                    </span>
                    {lot.expired && <Badge tone="danger">Expired</Badge>}
                    <span className="numeric text-sm text-ink-2">{lot.qtyRemaining}</span>
                  </label>
                ))}
              </div>
            )}

            {lots.length > 0 && (
              <label
                /* Same reason as above — a row that both selects and reveals. */
                data-kit-ok
                className="flex cursor-pointer items-center gap-3 rounded-control border border-border px-3 py-2 text-sm text-ink hover:bg-surface-2"
              >
                <input
                  type="radio"
                  name="lot"
                  className="size-4 cursor-pointer border-border-strong"
                  checked={typing}
                  onChange={() => setTyping(true)}
                />
                Another lot — type it
              </label>
            )}

            {typing && (
              <Field
                label="Lot number"
                hint="As printed on the pack. It is recorded even if it is not on file here."
              >
                <Input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && typed.trim()) onConfirm(typed.trim())
                  }}
                />
              </Field>
            )}
          </>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="success" disabled={!valid} onClick={() => onConfirm(chosen)}>
            {returning ? 'Add the return' : 'Add to sale'}
          </Button>
        </div>

        {strict && !returning && (
          <p className="text-xs text-muted">
            This shop records the lot on every sale — cancelling leaves the item off.
          </p>
        )}
      </div>
    </Modal>
  )
}
