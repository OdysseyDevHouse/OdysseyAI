'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Combobox,
  Field,
  FileInput,
  Icons,
  Modal,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TH,
  useToast,
  type BadgeTone,
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { MatchKind, ScannedHeader, ScannedLine } from '@/lib/import/documentScan'
import { rememberSupplierCodeAction, scanDocumentAction } from './documentScanActions'

/**
 * Turning a supplier's PDF into document lines.
 *
 * ── WHY THIS IS NOT LineImportDialog WITH A PDF OPTION ───────────────────
 *
 * Because the two have a different shape of failure, and that shape is the
 * whole design.
 *
 * A spreadsheet import either finds a product code or it does not: the file
 * SAYS "ABC-1234", and if that is not in the catalogue there is nothing to
 * discuss — it goes on the problems list and the buyer fixes the file. That is
 * why LineImportDialog can be a file box and a table of complaints.
 *
 * A scan is not like that. Every line here is a real line on a real delivery
 * that is standing at the door NOW, and "not recognised" does not mean the row
 * is wrong — it means WE have not been told what the supplier calls it yet.
 * Telling the buyer to go and fix the PDF is not an option. So the unmatched
 * lines are the working surface of this dialog rather than an error report:
 * each one gets a product picker, and resolving it teaches the system the
 * supplier's code so the next delivery matches by itself.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
 *
 * Post anything, same as its sibling. It hands lines to the screen that opened
 * it and stops. The buyer checks the costs against the invoice in their hand —
 * which is the check that matters here, because these figures were READ off a
 * page rather than typed by a person — and presses the button they always
 * press. See the header of documentScan.ts for why the model never gets to
 * name a product.
 */

/** How much a match is to be trusted, said out loud rather than implied. */
const MATCH_LABEL: Record<MatchKind, string> = {
  supplier_code: 'Their code',
  code: 'Our code',
  barcode: 'Barcode',
  description: 'By name',
  none: 'Not matched',
}

const MATCH_TONE: Record<MatchKind, BadgeTone> = {
  supplier_code: 'success',
  code: 'success',
  barcode: 'success',
  // A name match is a guess worth showing and not worth trusting — see the
  // header of documentScan.ts. It wears warning so it reads as "check me".
  description: 'warning',
  none: 'neutral',
}

/** What the screen receives. Deliberately the shape ReceiveScreen already maps. */
export type ScannedDraft = {
  productId: number
  code: string
  description: string
  productType: string
  qty: number
  unitCostExcl: number | null
  discountPct: number | null
}

export function DocumentScanDialog({
  open,
  onClose,
  onLines,
  onHeader,
  supplierId,
  searchProducts,
  noun = 'lines',
}: {
  open: boolean
  onClose: () => void
  /** Handed the resolved lines. The screen maps them into its own row shape. */
  onLines: (lines: ScannedDraft[]) => void
  /**
   * What the document said about itself — their number, date and total.
   * Optional because an order screen has nowhere to put an invoice number.
   */
  onHeader?: (header: ScannedHeader) => void
  /** The supplier already chosen on screen. Narrows code matching when set. */
  supplierId: number | null
  /** The screen's own product search, so this dialog owns no data access. */
  searchProducts: (term: string) => Promise<TillProduct[]>
  noun?: string
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<ScannedLine[]>([])
  const [header, setHeader] = useState<ScannedHeader | null>(null)
  const [filename, setFilename] = useState('')
  /** Products the buyer picked for unmatched lines, keyed by line number. */
  const [fixes, setFixes] = useState<Record<number, TillProduct>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  async function choose(file: File | null) {
    if (!file) return
    setBusy(true)
    try {
      const result = await scanDocumentAction({
        filename: file.name,
        base64: toBase64(await file.arrayBuffer()),
        supplierId,
      })

      if (!result.ok) {
        toast.error(result.error)
        // A file input keeps its selection, so re-choosing a corrected file of
        // the same name would fire no change event without this.
        if (fileRef.current) fileRef.current.value = ''
        return
      }

      setFilename(file.name)
      setLines(result.lines)
      setHeader(result.header)
      setFixes({})

      if (result.unmatched > 0) {
        toast.info(
          `${result.matched} of ${result.lines.length} matched. ${result.unmatched} need a product.`,
        )
      } else {
        toast.success(`${result.matched} ${result.matched === 1 ? 'line' : 'lines'} read`)
      }
    } finally {
      setBusy(false)
    }
  }

  /** A line's product: what was matched, or what the buyer picked instead. */
  function productFor(line: ScannedLine) {
    const fix = fixes[line.line]
    if (fix) {
      return {
        productId: fix.id,
        code: fix.code,
        description: fix.description,
        productType: fix.productType,
      }
    }
    if (line.productId === null) return null
    return {
      productId: line.productId,
      code: line.code ?? '',
      description: line.description ?? '',
      productType: line.productType ?? 'stock',
    }
  }

  const ready = lines.filter((l) => productFor(l) !== null)
  const outstanding = lines.length - ready.length

  function add() {
    const drafts: ScannedDraft[] = []
    for (const line of lines) {
      const product = productFor(line)
      if (!product) continue
      drafts.push({
        ...product,
        qty: line.qty,
        unitCostExcl: line.unitCostExcl,
        discountPct: line.discountPct,
      })
    }

    // Teach the catalogue what the buyer just taught us. Deliberately not
    // awaited: the delivery is at the door, and a slow write of a convenience
    // mapping must not stand between them and their grid.
    if (supplierId) {
      for (const line of lines) {
        const fix = fixes[line.line]
        if (fix && line.reference) {
          void rememberSupplierCodeAction({
            supplierId,
            productId: fix.id,
            supplierCode: line.reference,
          })
        }
      }
    }

    onLines(drafts)
    if (header) onHeader?.(header)
    toast.success(`${drafts.length} ${drafts.length === 1 ? 'line' : 'lines'} added`)
    reset()
    onClose()
  }

  function reset() {
    setLines([])
    setHeader(null)
    setFilename('')
    setFixes({})
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title="Read a supplier document"
      description="A PDF invoice, delivery note or quote. Nothing is posted — the lines land in the grid for you to check against the paperwork."
      size="xl"
      /* An unbounded scanned-lines table, checked against the paper invoice in
         somebody's hand. The more of it on screen at once, the better. */
      bodyGrows
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || ready.length === 0} onClick={add}>
            <Icons.Plus size={15} />
            Add {ready.length > 0 ? `${ready.length} ${ready.length === 1 ? 'line' : 'lines'}` : noun}
          </Button>
        </>
      }
    >
      <Field
        label="Document"
        hint={
          filename
            ? `${lines.length} line${lines.length === 1 ? '' : 's'} read from ${filename}`
            : 'Their invoice, delivery note or quote, as a PDF. Reading it takes a few seconds.'
        }
      >
        <FileInput
          ref={fileRef}
          accept=".pdf"
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
      </Field>

      {busy && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted">
          <Icons.Spinner size={15} className="animate-spin" />
          Reading the document…
        </p>
      )}

      {header && <HeaderSummary header={header} />}

      {outstanding > 0 && (
        <div className="mt-4">
          <Callout
            tone="warning"
            title={`${outstanding} line${outstanding === 1 ? '' : 's'} need${outstanding === 1 ? 's' : ''} a product`}
          >
            Pick what each one is and it will be added with the rest. We will remember the
            supplier&rsquo;s code, so the next delivery matches on its own.
          </Callout>
        </div>
      )}

      {lines.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-card border border-border">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={`${TABLE_TH} w-14`}>#</th>
                <th className={TABLE_TH}>On their document</th>
                <th className={TABLE_TH}>Product</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC} w-24`}>Qty</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC} w-28`}>Unit cost</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <ScanRow
                  key={line.line}
                  line={line}
                  picked={fixes[line.line] ?? null}
                  onPick={(product) =>
                    setFixes((current) => ({ ...current, [line.line]: product }))
                  }
                  searchProducts={searchProducts}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lines.length > 0 && (
        <p className="mt-3 text-sm text-muted">
          Costs and quantities were read off the page. Check them against the document before
          posting — especially any line marked &ldquo;{MATCH_LABEL.description}&rdquo;.
        </p>
      )}
    </Modal>
  )
}

/**
 * What the document says about itself.
 *
 * Shown rather than silently applied: their invoice number and total are about
 * to fill in fields the buyer is accountable for, and a figure that appeared
 * without being seen is a figure nobody checks. The GRV's own tie-out then does
 * the arithmetic — this is just the handover.
 */
function HeaderSummary({ header }: { header: ScannedHeader }) {
  const facts: { label: string; value: string }[] = []
  if (header.supplierName) facts.push({ label: 'Supplier', value: header.supplierName })
  if (header.documentNumber) facts.push({ label: 'Their number', value: header.documentNumber })
  if (header.documentDate) facts.push({ label: 'Dated', value: header.documentDate })
  if (header.totalIncl !== null) {
    facts.push({ label: 'Their total', value: formatMoney(header.totalIncl) })
  }
  if (facts.length === 0) return null

  return (
    <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 rounded-card bg-surface-2 px-4 py-3">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt className="text-xs text-muted">{fact.label}</dt>
          <dd className="text-sm font-medium text-ink">{fact.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * One scanned line.
 *
 * A matched line shows what it matched and how. An unmatched one turns its
 * product cell into a search box — in place, so the buyer works down the table
 * in the order the delivery note is written rather than hunting between a
 * problems list and a grid.
 */
function ScanRow({
  line,
  picked,
  onPick,
  searchProducts,
}: {
  line: ScannedLine
  picked: TillProduct | null
  onPick: (product: TillProduct) => void
  searchProducts: (term: string) => Promise<TillProduct[]>
}) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TillProduct[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (query.trim().length < 2) {
      setOptions([])
      return
    }
    const timer = setTimeout(() => {
      setSearching(true)
      searchProducts(query)
        .then(setOptions)
        .finally(() => setSearching(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [query, searchProducts])

  const resolved = picked
    ? { code: picked.code, description: picked.description }
    : line.productId !== null
      ? { code: line.code ?? '', description: line.description ?? '' }
      : null

  const comboOptions: ComboboxOption<TillProduct>[] = options.map((product) => ({
    value: String(product.id),
    label: product.description,
    hint: product.code,
    data: product,
  }))

  return (
    <tr className={TABLE_ROW}>
      <td className={`${TABLE_TD} text-muted`}>{line.line}</td>
      <td className={TABLE_TD}>
        <div className="text-ink-2">{line.scannedDescription || '—'}</div>
        {line.reference && <div className="text-xs text-muted">{line.reference}</div>}
      </td>
      <td className={TABLE_TD}>
        {resolved ? (
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <div className="truncate text-ink">{resolved.description}</div>
              <div className="text-xs text-muted">{resolved.code}</div>
            </div>
            <Badge tone={picked ? 'brand' : MATCH_TONE[line.matchKind]}>
              {picked ? 'You picked' : MATCH_LABEL[line.matchKind]}
            </Badge>
          </div>
        ) : (
          <Combobox
            options={comboOptions}
            query={query}
            onQueryChange={setQuery}
            onSelect={(option) => {
              if (option.data) onPick(option.data)
              setQuery('')
              setOptions([])
            }}
            loading={searching}
            placeholder="Search for this product…"
            emptyText={query.trim().length < 2 ? 'Type at least two characters' : 'No matches'}
          />
        )}
        {line.packNote && <div className="mt-1 text-xs text-warning-ink">{line.packNote}</div>}
      </td>
      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
        {line.qty > 0 ? (
          formatQty(line.qty)
        ) : (
          <span className="text-danger-ink">—</span>
        )}
      </td>
      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
        {line.unitCostExcl === null ? (
          <span className="text-muted">—</span>
        ) : (
          formatMoney(line.unitCostExcl)
        )}
      </td>
    </tr>
  )
}

/** Bytes to base64 without blowing the stack on a large PDF. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
