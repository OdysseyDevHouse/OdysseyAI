'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button, Callout, Field, Input, Modal, Select } from '@/components/ui'
import {
  BARCODE_PREFIXES,
  generateEan13,
  isInStorePrefix,
} from '@/lib/barcodeGenerate'

/**
 * Minting a barcode for a product that arrived without one — a loose line, a
 * repacked item, anything the shop sells that GS1 never issued a number for.
 *
 * Prefix and product code, exactly as the legacy screen asked for them, so a
 * shop moving across mints the same numbers it always has and its existing
 * shelf labels keep scanning. What it produces is a real EAN-13 with a check
 * digit, which the legacy screen's bare concatenation was not — see
 * `generateEan13`.
 *
 * The preview updates as you type and is the point of the dialog: the user is
 * about to put this number on a label, and "Generate" that hands back a code
 * only after you commit is a dialog you have to open twice to trust.
 */
export default function GenerateBarcodeModal({
  open,
  onClose,
  onGenerated,
  productCode,
  currentBarcode,
}: {
  open: boolean
  onClose: () => void
  /** Given the finished barcode. The caller decides where it lands. */
  onGenerated: (barcode: string) => void
  /** The product's own code, which is what a shop almost always numbers by. */
  productCode: string
  /** Shown as a warning when generating would overwrite a code already there. */
  currentBarcode: string
}) {
  const [prefix, setPrefix] = useState(BARCODE_PREFIXES[0])
  const [code, setCode] = useState('')

  /* Re-seed on each open rather than once: the product code can change under
     this dialog (it is a live field on the form behind it), and a stale seed
     would mint a barcode for a code the product no longer has. */
  useEffect(() => {
    if (!open) return
    setPrefix(BARCODE_PREFIXES[0])
    setCode(productCode.replace(/\D/g, ''))
  }, [open, productCode])

  const result = useMemo(() => generateEan13(prefix, code), [prefix, code])

  function accept() {
    if (!result.ok) return
    onGenerated(result.barcode)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate barcode"
      description="Builds an in-store EAN-13 from a prefix and this product's code."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={accept} disabled={!result.ok}>
            Use this barcode
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Prefix"
            hint={
              isInStorePrefix(prefix)
                ? 'Reserved for in-store use — can never clash with a supplier’s code.'
                : 'A real GS1 range. Only for products you will never buy in.'
            }
          >
            <Select value={prefix} onChange={(e) => setPrefix(e.target.value)}>
              {BARCODE_PREFIXES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Product code" hint="Digits only. Zero-padded to fit.">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              maxLength={11}
              autoComplete="off"
              placeholder="e.g. 5159"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  accept()
                }
              }}
            />
          </Field>
        </div>

        {/* The preview. A bordered plate rather than a line of text: this is
            the thing being made, and it should look like an artefact. */}
        <div className="rounded-card border border-border bg-surface-2 px-4 py-3.5 text-center">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">
            {result.ok ? 'This barcode' : 'Not yet a barcode'}
          </p>
          <p
            className={`numeric mt-1 text-2xl tracking-[0.18em] ${
              result.ok ? 'text-ink' : 'text-faint'
            }`}
          >
            {result.ok ? result.barcode : '—'}
          </p>
          {!result.ok && <p className="mt-1.5 text-xs text-danger">{result.error}</p>}
        </div>

        {result.ok && currentBarcode.trim() && currentBarcode.trim() !== result.barcode && (
          <Callout tone="warning" title="This replaces the barcode on file">
            The product currently scans as{' '}
            <span className="numeric font-medium">{currentBarcode.trim()}</span>. Using this one
            puts the new code in the Barcode field — nothing is saved until you save the product,
            and the old code stops working once you do.
          </Callout>
        )}
      </div>
    </Modal>
  )
}
