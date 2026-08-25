'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Button,
  Field,
  Input,
  Modal,
  NumberInput,
  Select,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD_INPUT,
  TABLE_TH,
  useToast,
} from '@/components/ui'
import { Trash } from '@/components/ui/icons'
import { PACK_DESCRIPTIONS } from '@/lib/productProperties'
import { addVat, markupPercent, removeVat, sellExclFromMarkup } from '@/lib/pricing'
import type { ReferMethod } from '@/lib/site/productComposition'
import { createReferRangeAction } from '@/app/(app)/products/referRangeActions'

/**
 * Building a pack range in one dialog — single, six-pack, case.
 *
 * A refer code is never set up alone, so this is the shape the job actually
 * has: one row per pack size, chained bottom to top. The arithmetic that turns
 * absolute pack sizes into the chain's relative factors lives in
 * referRange.ts and is shown live under the table, because a chain that reads
 * wrong here is a chain that sells wrong later.
 *
 * Row 1 may be a product that already exists — the common case is not three
 * new products but "I already sell the single, now add a six-pack". When it
 * is, its inputs are locked and only the rows above it get created.
 */

const money = (n: number) =>
  n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const METHOD_HINT: Record<ReferMethod, string> = {
  normal:
    'Each pack size holds its own stock. Receiving 10 cases gives you 10 cases, and selling a single breaks one open.',
  subtract:
    'Only the base product holds stock. Receiving 10 cases of 24 gives you 240 singles, and every pack size sells off that one pile.',
}

/** A sensible ladder for a new range, so the table is never blank. */
const DEFAULT_SIZES = [1, 6, 12, 24, 48, 96]

type Row = {
  key: string
  /** Set when this rung already exists — its inputs are then read-only. */
  productId: number | null
  description: string
  code: string
  barcode: string
  packSize: number
  packDescription: string
  costExcl: number
  sellIncl: number
  supplierCode: string
}

function blankRow(index: number, base: string): Row {
  return {
    key: `r${index}-${base}`,
    productId: null,
    description: '',
    code: '',
    barcode: '',
    packSize: DEFAULT_SIZES[index] ?? 0,
    packDescription: index === 0 ? 'None' : 'Pack',
    costExcl: 0,
    sellIncl: 0,
    supplierCode: '',
  }
}

export default function ReferWizard({
  open,
  onClose,
  vatPercent,
  autoCode = false,
  supplierId,
  base,
  groupMethod = null,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  /** The selling VAT rate, so markup and the inclusive price agree. */
  vatPercent: number
  /**
   * Whether the site numbers products automatically.
   *
   * Without it a blank code is refused by the server, so the placeholder must
   * not promise "Auto" — being told a required field was optional only once
   * the whole dialog is filled in is the worst moment to find out.
   */
  autoCode?: boolean
  /** Where the per-row supplier codes get written, if there is one. */
  supplierId?: number | null
  /**
   * The product this was opened from, used as rung 1 when it already exists.
   * Everything on it is inherited by the rows the wizard creates.
   */
  base?: {
    productId: number | null
    description: string
    code: string
    barcode: string
    costExcl: number
    sellIncl: number
    departmentId: number | null
    brandId: number | null
    purchaseVatRateId: number | null
    sellingVatRateId: number | null
  } | null
  /**
   * The method the base product's ladder is ALREADY on, if it is linked.
   *
   * The method belongs to the whole group of linked products, so a range built
   * on top of an existing ladder joins that ladder's method rather than
   * choosing one — the server enforces this either way (see
   * setReferGroupMethod). Passing it here means the dropdown shows what will
   * actually be used instead of an option that gets quietly overruled.
   */
  groupMethod?: ReferMethod | null
  onCreated?: (productIds: number[]) => void
}) {
  const stamp = useMemo(() => Math.random().toString(36).slice(2, 7), [])
  const [method, setMethod] = useState<ReferMethod>(groupMethod ?? 'normal')
  const [rows, setRows] = useState<Row[]>(() => {
    const first = blankRow(0, stamp)
    if (base) {
      first.productId = base.productId
      first.description = base.description
      first.code = base.code
      first.barcode = base.barcode
      first.costExcl = base.costExcl
      first.sellIncl = base.sellIncl
    }
    return [first, { ...blankRow(1, stamp), description: '' }, blankRow(2, stamp)]
  })
  const [saving, startSave] = useTransition()
  const toast = useToast()

  const patch = (key: string, next: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...next } : r)))

  const addRow = () =>
    setRows((current) =>
      current.length >= 6 ? current : [...current, blankRow(current.length, stamp)],
    )

  const removeRow = (key: string) =>
    setRows((current) => (current.length <= 2 ? current : current.filter((r) => r.key !== key)))

  /*
   * The chain, derived exactly the way the server derives it. Each rung's
   * factor is against the one below, so 12 sitting above 6 is a factor of 2.
   * Shown rather than hidden because a range that reads wrong here is a range
   * that breaks down wrong at the till.
   */
  const chain = useMemo(() => {
    const parts: string[] = []
    let problem: string | null = null

    const base = rows[0]?.description.trim()

    // The same fallback the submit uses, so the chain reads as the names the
    // products will actually be created with rather than "Line 2".
    const nameOf = (i: number) =>
      rows[i].description.trim() || (i === 0 ? 'Line 1' : `${base || 'Product'} × ${rows[i].packSize || '?'}`)

    for (let i = 0; i < rows.length; i++) {
      const size = rows[i].packSize
      const label = nameOf(i)

      if (!Number.isFinite(size) || size <= 0) {
        problem ??= `Line ${i + 1} needs a pack size of more than zero.`
        continue
      }
      if (i === 0) {
        parts.push(label)
        continue
      }

      const below = rows[i - 1].packSize
      if (size <= below) {
        problem ??= `Pack sizes must get bigger going down — line ${i + 1} is ${size}, which is not more than ${below}.`
        continue
      }
      const factor = size / below
      if (Math.abs(factor - Math.round(factor)) > 0.0005) {
        problem ??= `${size} is not a whole number of ${below}s, so line ${i + 1} cannot be broken down.`
        continue
      }
      // The factor is what gets STORED, and the pack size is what was typed.
      // Showing both is the point: 12 above a 6 is stored as 2, not 12.
      parts.push(`${label} = ${Math.round(factor)} × ${nameOf(i - 1)}, so ${size} in total`)
    }

    // The base rung names every row above it, so it cannot be blank.
    if (!rows[0]?.description.trim()) {
      problem ??= 'The first line needs a description — the pack sizes above it are named from it.'
    }

    // Caught here rather than by the server, which would only say so after the
    // whole dialog had been filled in.
    if (!autoCode) {
      const missing = rows.findIndex((r) => !r.productId && !r.code.trim())
      if (missing >= 0) {
        problem ??= `Line ${missing + 1} needs a product code. This site does not number products automatically.`
      }
    }

    return { text: parts.join('   ←   '), problem }
  }, [rows, autoCode])

  /** Fill empty prices down by pack size, leaving anything typed alone. */
  const fillPrices = () => {
    const anchor = rows.find((r) => r.sellIncl > 0)
    if (!anchor || anchor.packSize <= 0) {
      toast.info('Type a price on one line first, and the rest fill in by pack size.')
      return
    }
    const perUnit = anchor.sellIncl / anchor.packSize
    const anchorCost = anchor.costExcl / anchor.packSize

    setRows((current) =>
      current.map((r) => ({
        ...r,
        sellIncl: r.sellIncl > 0 ? r.sellIncl : Math.round(perUnit * r.packSize * 100) / 100,
        costExcl: r.costExcl > 0 ? r.costExcl : Math.round(anchorCost * r.packSize * 10000) / 10000,
      })),
    )
  }

  function submit() {
    startSave(async () => {
      const result = await createReferRangeAction({
        method,
        supplierId: supplierId ?? null,
        inherit: base
          ? {
              departmentId: base.departmentId,
              brandId: base.brandId,
              purchaseVatRateId: base.purchaseVatRateId,
              sellingVatRateId: base.sellingVatRateId,
            }
          : undefined,
        rows: rows.map((r, i) => ({
          productId: r.productId,
          // An untouched row takes the name its placeholder was offering, so
          // "Beer × 6" does not have to be typed to be accepted.
          description:
            r.description.trim() ||
            (i === 0 ? '' : `${rows[0].description.trim()} × ${r.packSize}`),
          code: r.code,
          barcode: r.barcode,
          packSize: r.packSize,
          packDescription: r.packDescription,
          costExcl: r.costExcl,
          supplierCode: r.supplierCode,
          supplierPackSize: r.packSize,
        })),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        result.created === 1 ? '1 product created and linked' : `${result.created} products created and linked`,
      )
      onCreated?.(result.productIds)
      onClose()
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Refer code wizard"
      description="Set up how each pack size refers to the one below it, then create the linked products."
      size="xl"
      /* The generated-rows table grows with the number of pack sizes, and it is
         what the person is checking before the products are created. */
      bodyGrows
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="primary" onClick={submit} disabled={saving || !!chain.problem}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start gap-4">
          <Field
            label="Refer method"
            hint={
              groupMethod
                ? `${METHOD_HINT[method]} Set on the Refer tab — the whole ladder shares one method.`
                : METHOD_HINT[method]
            }
            className="min-w-[22rem] flex-1"
          >
            <Select
              value={method}
              onChange={(e) => setMethod(e.target.value as ReferMethod)}
              // Locked once the base is already linked: these rows join a
              // ladder that has a method, and the server would overrule any
              // other choice made here.
              disabled={!!groupMethod}
              aria-label="Refer method"
            >
              <option value="normal">Normal refers — every pack holds its own stock</option>
              <option value="subtract">Subtract pack — only the base holds stock</option>
            </Select>
          </Field>

          <div className="flex items-end gap-2 pb-1">
            <Button type="button" variant="ghost" size="sm" onClick={fillPrices}>
              Fill prices down
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={addRow} disabled={rows.length >= 6}>
              Add pack size
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={`${TABLE_TH} w-[16%]`}>Description</th>
                <th className={`${TABLE_TH} w-[11%]`}>Product code</th>
                <th className={`${TABLE_TH} w-[13%]`}>Barcode</th>
                <th className={`${TABLE_TH} w-[8%] text-right`}>Pack size</th>
                <th className={`${TABLE_TH} w-[11%]`}>Pack desc.</th>
                <th className={`${TABLE_TH} w-[10%] text-right`}>Excl. cost</th>
                <th className={`${TABLE_TH} w-[9%] text-right`}>Markup %</th>
                <th className={`${TABLE_TH} w-[10%] text-right`}>Incl. selling</th>
                <th className={`${TABLE_TH} w-[11%]`}>Supplier code</th>
                <th className={`${TABLE_TH} w-[1%]`} aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const sellExcl = removeVat(row.sellIncl, vatPercent)
                // Blank until BOTH sides exist. A cost with no price yet is
                // -100% markup, which is arithmetically true and useless to
                // read on a row nobody has finished typing.
                const markup =
                  row.costExcl > 0 && row.sellIncl > 0
                    ? Math.round(markupPercent(row.costExcl, sellExcl) * 100) / 100
                    : null
                const locked = row.productId !== null

                return (
                  <tr key={row.key} className="border-b border-border">
                    <td className={TABLE_TD_INPUT}>
                      <Input
                        value={row.description}
                        onChange={(e) => patch(row.key, { description: e.target.value })}
                        readOnly={locked}
                        // Suggests the name this rung would get, built off the
                        // base and its own pack size — "Beer 340ml × 6".
                        placeholder={
                          index === 0
                            ? 'Single'
                            : `${rows[0].description.trim() || 'Product'} × ${row.packSize || '?'}`
                        }
                        aria-label={`Description line ${index + 1}`}
                      />
                    </td>
                    <td className={TABLE_TD_INPUT}>
                      <Input
                        value={row.code}
                        onChange={(e) => patch(row.key, { code: e.target.value })}
                        readOnly={locked}
                        placeholder={autoCode ? 'Auto' : 'Required'}
                        aria-label={`Product code line ${index + 1}`}
                      />
                    </td>
                    <td className={TABLE_TD_INPUT}>
                      <Input
                        value={row.barcode}
                        onChange={(e) => patch(row.key, { barcode: e.target.value })}
                        readOnly={locked}
                        aria-label={`Barcode line ${index + 1}`}
                      />
                    </td>
                    <td className={TABLE_TD_INPUT}>
                      <NumberInput
                        value={row.packSize}
                        onChange={(e) => patch(row.key, { packSize: Number(e.target.value) })}
                        aria-label={`Pack size line ${index + 1}`}
                      />
                    </td>
                    <td className={TABLE_TD_INPUT}>
                      <Select
                        value={row.packDescription}
                        onChange={(e) => patch(row.key, { packDescription: e.target.value })}
                        disabled={locked}
                        aria-label={`Pack description line ${index + 1}`}
                      >
                        {PACK_DESCRIPTIONS.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className={TABLE_TD_INPUT}>
                      <NumberInput
                        value={row.costExcl}
                        onChange={(e) => patch(row.key, { costExcl: Number(e.target.value) })}
                        aria-label={`Cost line ${index + 1}`}
                      />
                    </td>
                    <td className={TABLE_TD_INPUT}>
                      <NumberInput
                        value={markup ?? ''}
                        onChange={(e) =>
                          patch(row.key, {
                            sellIncl:
                              Math.round(
                                addVat(sellExclFromMarkup(row.costExcl, Number(e.target.value)), vatPercent) * 100,
                              ) / 100,
                          })
                        }
                        aria-label={`Markup line ${index + 1}`}
                      />
                    </td>
                    <td className={TABLE_TD_INPUT}>
                      <NumberInput
                        value={row.sellIncl}
                        onChange={(e) => patch(row.key, { sellIncl: Number(e.target.value) })}
                        aria-label={`Selling price line ${index + 1}`}
                      />
                    </td>
                    <td className={TABLE_TD_INPUT}>
                      <Input
                        value={row.supplierCode}
                        onChange={(e) => patch(row.key, { supplierCode: e.target.value })}
                        aria-label={`Supplier code line ${index + 1}`}
                      />
                    </td>
                    <td className={`${TABLE_TD_INPUT} ${TABLE_NUMERIC}`}>
                      {rows.length > 2 && !locked && (
                        <Button
                          type="button"
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Remove line ${index + 1}`}
                          onClick={() => removeRow(row.key)}
                        >
                          <Trash size={15} />
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* The chain as the server will store it. A range that reads wrong
            here is a range that breaks down wrong at the till. */}
        {chain.problem ? (
          <p className="text-sm text-danger">{chain.problem}</p>
        ) : (
          <p className="text-sm text-muted">
            <span className="text-ink">{chain.text}</span>
          </p>
        )}

        <p className="text-sm text-muted">
          Cost is VAT-exclusive; selling is VAT-inclusive (the till&rsquo;s retail price). Markup and
          selling update each other off the cost.{' '}
          {autoCode
            ? 'Leave a product code blank to have it numbered automatically.'
            : 'Every new line needs its own product code.'}{' '}
          Refine everything afterwards on each product&rsquo;s Edit screen.
        </p>

        {rows.some((r) => r.productId !== null) && (
          <p className="text-sm text-muted">
            The first line is the product you opened this from, so it is left as it is — only the
            pack sizes above it are created.
          </p>
        )}
      </div>
    </Modal>
  )
}
