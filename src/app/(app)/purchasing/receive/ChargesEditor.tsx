'use client'

import {
  Button,
  CurrencyInput,
  Icons,
  Input,
  NumberInput,
  Select,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_ROW,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_TH,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'

/**
 * What the delivery cost on top of the goods, and who billed it.
 *
 * Every row is apportioned into landed cost — the goods cost what they cost to
 * get onto the shelf, whoever sent the invoice. What the supplier column
 * decides is who gets CREDITED:
 *
 *   (blank)  — the goods supplier put it on the same invoice. The default,
 *              and exactly how the single "Delivery and charges" box behaved.
 *   a name   — a separate invoice, posted to that account, so it can be
 *              matched, aged and paid on its own terms.
 *
 * A table rather than a repeated field group because these are four short
 * values per row and a delivery rarely has more than two or three; stacked
 * fieldsets would take a screen's height to say what four columns say in a
 * line. Live inputs mean it wears the shared TABLE_* skin by hand, as the line
 * grid does.
 */

export type ChargeRow = {
  key: string
  supplierId: number | null
  description: string
  amountExcl: number
  vatRatePct: number
  theirInvoiceNo: string
}

export default function ChargesEditor({
  charges,
  suppliers,
  goodsSupplierName,
  defaultVatRate,
  onChange,
}: {
  charges: ChargeRow[]
  suppliers: { id: number; code: string; name: string }[]
  /** Shown as the blank option, so "who is billing this" is never a guess. */
  goodsSupplierName: string
  defaultVatRate: number
  onChange: (next: ChargeRow[]) => void
}) {
  function patch(key: string, changes: Partial<ChargeRow>) {
    onChange(charges.map((c) => (c.key === key ? { ...c, ...changes } : c)))
  }

  function add() {
    onChange([
      ...charges,
      {
        key: `charge-${Date.now()}`,
        supplierId: null,
        description: '',
        amountExcl: 0,
        vatRatePct: defaultVatRate,
        theirInvoiceNo: '',
      },
    ])
  }

  const total = charges.reduce((sum, c) => round(sum + c.amountExcl, 2), 0)

  return (
    <div className="flex flex-col gap-3">
      {charges.length > 0 && (
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th scope="col" className={TABLE_TH}>
                  What for
                </th>
                <th scope="col" className={`${TABLE_TH} w-48`}>
                  Billed by
                </th>
                <th scope="col" className={`${TABLE_TH} w-32 text-right`}>
                  Amount (excl.)
                </th>
                <th scope="col" className={`${TABLE_TH} w-20 text-right`}>
                  VAT %
                </th>
                <th scope="col" className={`${TABLE_TH} w-32`}>
                  Their invoice
                </th>
                <th scope="col" className={`${TABLE_TH} w-px`} />
              </tr>
            </thead>
            <tbody>
              {charges.map((charge) => (
                <tr key={charge.key} className={TABLE_ROW}>
                  <td className={`${TABLE_TD_INPUT}`}>
                    <Input
                      value={charge.description}
                      placeholder="Courier, duty, pallets…"
                      aria-label="What the charge is for"
                      onChange={(e) => patch(charge.key, { description: e.target.value })}
                    />
                  </td>
                  <td className={`${TABLE_TD_INPUT} w-48`}>
                    <Select
                      value={charge.supplierId === null ? '' : String(charge.supplierId)}
                      aria-label="Who billed this charge"
                      onChange={(e) =>
                        patch(charge.key, { supplierId: Number(e.target.value) || null })
                      }
                    >
                      <option value="">{goodsSupplierName || 'On the goods invoice'}</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} — {s.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className={`${TABLE_TD_INPUT} w-32`}>
                    <CurrencyInput
                      value={charge.amountExcl}
                      aria-label="Charge amount excluding VAT"
                      onChange={(e) =>
                        patch(charge.key, {
                          amountExcl: Number(String(e.target.value).replace(',', '.')) || 0,
                        })
                      }
                    />
                  </td>
                  <td className={`${TABLE_TD_INPUT} w-20`}>
                    <NumberInput
                      value={charge.vatRatePct}
                      precision={2}
                      aria-label="VAT rate on the charge"
                      onChange={(e) =>
                        patch(charge.key, {
                          vatRatePct: Number(String(e.target.value).replace(',', '.')) || 0,
                        })
                      }
                    />
                  </td>
                  <td className={`${TABLE_TD_INPUT} w-32`}>
                    <Input
                      value={charge.theirInvoiceNo}
                      aria-label="Their invoice number for this charge"
                      // Only meaningful for a separate invoice: a charge on the
                      // goods invoice already has that document's number.
                      disabled={charge.supplierId === null}
                      onChange={(e) => patch(charge.key, { theirInvoiceNo: e.target.value })}
                    />
                  </td>
                  <td className="px-4 py-1.5">
                    <Button
                      variant="bare"
                      size="sm"
                      iconOnly
                      aria-label={`Remove ${charge.description || 'this charge'}`}
                      onClick={() => onChange(charges.filter((c) => c.key !== charge.key))}
                    >
                      <Icons.Close size={15} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            {charges.length > 1 && (
              <tfoot>
                <tr>
                  <td className={TABLE_TD} colSpan={2}>
                    <span className="text-muted">Total charges</span>
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>{formatMoney(total)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      <div>
        <Button variant="ghost" size="sm" onClick={add}>
          <Icons.Plus size={15} />
          Add a charge
        </Button>
      </div>
    </div>
  )
}
