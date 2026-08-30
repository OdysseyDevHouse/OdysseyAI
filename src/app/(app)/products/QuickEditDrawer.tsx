'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  ButtonLink,
  CurrencyInput,
  Drawer,
  Field,
  Input,
  Select,
  useToast,
} from '@/components/ui'
import { quickEditProductAction } from './actions'

/** What the panel needs about the row it was opened on. */
export type QuickEditTarget = {
  id: number
  code: string
  description: string
  barcode: string | null
  departmentId: number | null
  /** Excluding tax — what the cost box edits, on the last-cost basis. */
  lastCost: number
  /** Including tax, from the default price structure. */
  priceIncl: number
  /** A variant group: a heading, not a product. No cost or price of its own. */
  isParent: boolean
  /** More than one price structure carries a price for this product. */
  hasOtherPrices: boolean
}

/**
 * The products list's quick edit — a panel that slides in over the list so a
 * wrong name or price can be fixed without leaving it.
 *
 * ── WHY A PANEL AND NOT THE PRODUCT SCREEN ───────────────────────────────
 *
 * The full editor is seven tabs, because a product is a large thing. Most
 * corrections are not: a description typed wrong, a price that moved, a
 * product filed under the wrong department. Sending those through a page load,
 * seven tabs and a redirect back to a list that has to rebuild its filters is
 * the reason people fix them in a spreadsheet instead.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * It posts only the fields it shows, through `quickEditProductAction`, which
 * writes only the columns it is given. It does NOT go through the product
 * form's save: that reads a whole product out of its FormData, so six fields
 * posted through it would clear the prices, recipe lines and supplier links
 * this panel never rendered.
 *
 * The kit's Drawer says a drawer is not a place to hide a form. It is right
 * about a form of any size — this one is six fields with a footer that says
 * what it will do, and the full editor is one click away in the header for
 * everything it cannot express.
 */
export default function QuickEditDrawer({
  target,
  onClose,
  departments,
  showCost,
  costBasis,
  editSuffix,
}: {
  /** The row being edited; null closes the panel. */
  target: QuickEditTarget | null
  onClose: () => void
  departments: { id: number; label: string }[]
  /** Resolved on the server from `products.cost` — a role without it sees no cost. */
  showCost: boolean
  costBasis: 'last' | 'average'
  editSuffix: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [saving, startSaving] = useTransition()

  /* Seeded from the row and re-seeded whenever the panel is opened on a
     different one. The Drawer remounts its BODY on open (it keys on `open`),
     but this state lives out here in the parent, which never unmounts — so
     without this effect the second product opened would show the first one's
     half-typed values. */
  const [description, setDescription] = useState('')
  /* Shown but never edited — see the field below. Still state rather than read
     straight off `target`, so it re-seeds with the rest when the panel is
     opened on a different row. */
  const [code, setCode] = useState('')
  const [barcode, setBarcode] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [cost, setCost] = useState<number | ''>('')
  const [price, setPrice] = useState<number | ''>('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    setDescription(target.description)
    setCode(target.code)
    setBarcode(target.barcode ?? '')
    setDepartmentId(target.departmentId === null ? '' : String(target.departmentId))
    setCost(target.lastCost)
    setPrice(target.priceIncl)
    setError(null)
  }, [target])

  /* A variant group has no cost or price — the list already renders both as a
     dash for these rows, and the action refuses them outright. */
  const money = target !== null && !target.isParent
  /* Average cost is a consequence of purchases and cannot be typed in — the
     same rule the full editor's pricing panel states. On that basis the box
     would take a number and move nothing, which is worse than not offering it. */
  const costEditable = showCost && costBasis === 'last'

  function save() {
    if (!target) return
    setError(null)

    startSaving(async () => {
      /* No `code`: the field is read-only, so sending it would ask the action
         to re-check a code nobody changed — and put a field this panel does
         not edit into the set of things it writes. */
      const result = await quickEditProductAction(target.id, {
        description,
        barcode: barcode.trim() || null,
        departmentId: departmentId === '' ? null : Number(departmentId),
        ...(money && costEditable && cost !== '' ? { lastCost: Number(cost) } : {}),
        ...(money && price !== '' ? { priceIncl: Number(price) } : {}),
      })

      if (!result.ok) {
        /* Kept IN the panel rather than thrown at a toast: the message is about
           a field the user is looking at, and a toast would take it away while
           they were still fixing it. */
        setError(result.error)
        return
      }

      toast.success(`Saved ${description.trim() || target.code}`)
      onClose()
      router.refresh()
    })
  }

  return (
    <Drawer
      open={target !== null}
      onClose={onClose}
      title="Quick edit"
      description={target ? target.code : undefined}
      size="sm"
      /* Half-typed work: a stray click on the list behind must not lose it. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {target && (
        <div className="flex flex-col gap-4">
          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              autoFocus
            />
          </Field>

          {/* Read-only. A product code is its identity — it is on labels, order
              lines and every document already printed — so changing one is a
              deliberate act that belongs on the full product, not a box you
              can land in while fixing a price. Shown rather than hidden
              because it is how you know which product this panel is on. */}
          {/* readOnly, not disabled: the kit paints the two identically (see
              CONTROL in styles.ts) but a disabled input is dropped from the
              form and left out of tab order, and this one is still worth
              reaching and copying. */}
          <Field label="Product code">
            <Input value={code} readOnly />
          </Field>

          <Field label="Barcode">
            <Input
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="None"
            />
          </Field>

          <Field label="Department">
            <Select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
            >
              <option value="">No department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>

          {/* Money, for the rows that have any. A variant group is a heading:
              its cost and price columns are zeros meaning "not applicable", so
              offering boxes for them would invite a figure nobody can act on. */}
          {money && (
            <>
              {showCost && (
                <Field
                  label={costBasis === 'last' ? 'Last cost (excl.)' : 'Average cost (excl.)'}
                  hint={
                    costEditable
                      ? undefined
                      : 'Average cost comes from what you have paid, so it cannot be typed in.'
                  }
                >
                  <CurrencyInput
                    value={cost}
                    onChange={(e) =>
                      setCost(e.target.value === '' ? '' : Number(e.target.value))
                    }
                    disabled={!costEditable}
                  />
                </Field>
              )}

              <Field
                label="Selling price (incl.)"
                hint={
                  target.hasOtherPrices
                    ? 'The default price list. This product is priced on others too — those are unchanged.'
                    : undefined
                }
              >
                <CurrencyInput
                  value={price}
                  onChange={(e) =>
                    setPrice(e.target.value === '' ? '' : Number(e.target.value))
                  }
                />
              </Field>
            </>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          {/* Everything this panel cannot express is one click away, rather
              than a field the panel pretends not to have. */}
          <ButtonLink
            href={`/products/${target.id}${editSuffix}`}
            variant="secondary"
            className="mt-1"
          >
            Open the full product
          </ButtonLink>
        </div>
      )}
    </Drawer>
  )
}
