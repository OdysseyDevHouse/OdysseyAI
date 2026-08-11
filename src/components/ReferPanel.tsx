'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Badge,
  Button,
  Combobox,
  EmptyState,
  Field,
  Input,
  NumberInput,
  Select,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import { Trash } from '@/components/ui/icons'
import type { ReferMethod } from '@/lib/site/productComposition'
import type { ChainRung } from '@/lib/site/referRange'
import type { ProductPick } from '@/lib/site/products'
import { searchProductsAction } from '@/app/(app)/products/pickerActions'
import {
  addReferRungAction,
  removeReferRungAction,
} from '@/app/(app)/products/referRangeActions'

/**
 * The pack sizes a product is sold in, and how they draw on each other.
 *
 * ── THE PANEL EDITS A CHAIN, NOT A FIELD ─────────────────────────────────
 *
 * A refer code is one rung of a ladder — single ← six-pack ← case — and the
 * ladder is one thing even though it is three products. So this shows the
 * WHOLE chain whichever rung you opened, with the current one marked, and lets
 * a pack size be added on top without navigating to a different product to do
 * it. That navigation was the thing that made refer codes tedious to set up.
 *
 * ── WHY IT SAVES ITSELF ──────────────────────────────────────────────────
 *
 * Adding a pack size CREATES A PRODUCT. That cannot wait for the form's Save
 * button, and it must not be undone by an unrelated field failing validation —
 * the same reasoning VariantsPanel and SerialsPanel are built on. Every action
 * returns the re-read chain rather than patching local state, so the panel and
 * the database cannot disagree after a partial failure.
 *
 * Pack sizes are typed in BASE UNITS — a case is "24", not "4 six-packs" —
 * because that is the only sane thing to type. The stored factor is relative
 * to the rung below and is derived server-side. See 103_refer_methods.sql.
 */

const money = (n: number) =>
  n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const METHOD_HINT: Record<ReferMethod, string> = {
  subtract:
    'Only the base product holds stock. Every pack size sells off that one pile.',
  normal:
    'Each pack size holds its own stock, and a larger pack is broken open when a smaller one runs out.',
}

export default function ReferPanel({
  productId,
  initialChain,
  autoCode = false,
  onOpenWizard,
}: {
  /** The product whose screen this is. */
  productId: number | null
  /** The whole ladder, bottom rung first. Empty when nothing is linked yet. */
  initialChain: ChainRung[]
  /** Whether a blank product code will be numbered automatically. */
  autoCode?: boolean
  onOpenWizard?: () => void
}) {
  const toast = useToast()
  const [busy, startAction] = useTransition()
  const [chain, setChain] = useState<ChainRung[]>(initialChain)

  // The new rung.
  const [existing, setExisting] = useState<ProductPick | null>(null)
  const [code, setCode] = useState('')
  const [description, setDescription] = useState('')
  const [packSize, setPackSize] = useState(0)
  const [method, setMethod] = useState<ReferMethod>(
    (chain.find((r) => r.method)?.method ?? 'subtract') as ReferMethod,
  )
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ProductPick[]>([])
  const [searching, startSearch] = useTransition()

  const top = chain.length ? chain[chain.length - 1] : null
  const base = chain.length ? chain[0] : null

  function search(next: string) {
    setQuery(next)
    startSearch(async () => {
      setResults(await searchProductsAction(next, productId ?? undefined))
    })
  }

  const options: ComboboxOption<ProductPick>[] = results.map((p) => ({
    value: String(p.id),
    label: p.description,
    hint: p.code,
    trailing: `${p.stockOnHand.toLocaleString('en-ZA')} on hand`,
    data: p,
  }))

  function reset() {
    setExisting(null)
    setCode('')
    setDescription('')
    setPackSize(0)
    setQuery('')
    setResults([])
  }

  function add() {
    if (!top || !productId) return
    startAction(async () => {
      const result = await addReferRungAction(
        {
          belowId: top.productId,
          productId: existing?.id ?? null,
          code,
          description,
          packSize,
          method,
        },
        productId,
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setChain(result.chain)
      reset()
      toast.success('Pack size added')
    })
  }

  function remove(rung: ChainRung) {
    if (!productId) return
    startAction(async () => {
      const result = await removeReferRungAction(rung.productId, productId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setChain(result.chain)
      toast.success(`${rung.description} unlinked`)
    })
  }

  // Nothing linked yet: the chain has to start somewhere, and starting it means
  // saying what one of these IS. That is still the wizard's job — it creates
  // the base and the packs together — so this points at it rather than
  // half-doing it.
  if (chain.length < 2) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <EmptyState
          title="No pack sizes set up yet"
          hint="A refer product is one rung of a ladder — a six-pack that draws on a single, a case that draws on the six-pack. Build the ladder to set up how they draw on each other."
          action={
            onOpenWizard && (
              <Button type="button" variant="primary" size="sm" onClick={onOpenWizard}>
                Build a pack range
              </Button>
            )
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <p className="text-sm text-muted">
        Every pack size this is sold in, smallest first. Each one draws on the size below it, and{' '}
        <span className="text-ink">{base?.description}</span> is what the whole ladder is counted
        in.
      </p>

      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TABLE_TH}>Product</th>
              <th className={TABLE_TH}>Code</th>
              <th className={`${TABLE_TH} text-right`}>Draws on</th>
              <th className={`${TABLE_TH} text-right`}>Pack size</th>
              <th className={`${TABLE_TH} text-right`}>On hand</th>
              <th className={`${TABLE_TH} text-right`}>Cost</th>
              <th className={TABLE_TH} aria-label="Unlink" />
            </tr>
          </thead>
          <tbody>
            {chain.map((rung, index) => (
              <tr key={rung.productId} className="border-b border-border">
                <td className={TABLE_TD}>
                  <span className="flex items-center gap-2">
                    {rung.isCurrent ? (
                      <span className="font-medium text-ink">{rung.description}</span>
                    ) : (
                      <Link
                        href={`/products/${rung.productId}`}
                        className="text-brand hover:underline"
                      >
                        {rung.description}
                      </Link>
                    )}
                    {rung.isCurrent && <Badge tone="brand">This product</Badge>}
                    {index === 0 && <Badge tone="neutral">Base</Badge>}
                  </span>
                </td>
                <td className={TABLE_TD}>{rung.code}</td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {index === 0 ? (
                    <span className="text-muted">—</span>
                  ) : (
                    `${rung.factor.toLocaleString('en-ZA')} × ${chain[index - 1].description}`
                  )}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {rung.packSize.toLocaleString('en-ZA')}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {rung.stockOnHand.toLocaleString('en-ZA')}
                </td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{money(rung.averageCost)}</td>
                <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                  {index > 0 && (
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      disabled={busy}
                      aria-label={`Unlink ${rung.description}`}
                      onClick={() => remove(rung)}
                    >
                      <Trash size={15} />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* A fork: something draws on a rung without being part of the ladder
          above it. Named rather than hidden — the walk up can only follow one
          branch, and a pack the user cannot see is a pack they cannot fix. */}
      {chain.some((r) => r.alsoDrawnOnBy.length > 0) && (
        <div className="flex flex-col gap-2 rounded-card border border-warning bg-warning-soft p-4">
          <span className="text-sm font-medium text-ink">Not part of this ladder</span>
          {chain.flatMap((rung) =>
            rung.alsoDrawnOnBy.map((other) => (
              <p key={other.productId} className="text-sm text-ink-2">
                <Link href={`/products/${other.productId}`} className="text-brand hover:underline">
                  {other.description}
                </Link>{' '}
                ({other.code}) also draws on {rung.description} at{' '}
                <span className="numeric">{other.factor.toLocaleString('en-ZA')}</span> each. Two
                packs drawing on the same one is allowed, but only this ladder is shown above.
              </p>
            )),
          )}
        </div>
      )}

      {/* ── Adding one more, on top ─────────────────────────────────────── */}
      <div className="flex flex-col gap-4 rounded-card border border-border p-4">
        <div>
          <span className="text-sm font-medium text-ink">Add a bigger pack size</span>
          <p className="text-sm text-muted">
            It sits on top of {top?.description}. Search for a product that already exists, or leave
            the search empty and type a code to create one.
          </p>
        </div>

        <div className="max-w-md">
          <Combobox
            options={options}
            query={query}
            onQueryChange={search}
            onSelect={(option) => {
              if (!option.data) return
              setExisting(option.data)
              setDescription(option.data.description)
              setQuery('')
              setResults([])
            }}
            loading={searching}
            placeholder="Search an existing product, or leave empty to create one…"
            emptyText="No products match — type a code below to create one"
          />
        </div>

        {existing && (
          <p className="text-sm text-muted">
            Linking <span className="text-ink">{existing.description}</span> ({existing.code}).{' '}
            <button
              type="button"
              className="text-brand hover:underline"
              onClick={() => {
                setExisting(null)
                setDescription('')
              }}
            >
              Create a new product instead
            </button>
          </p>
        )}

        <div className="flex flex-wrap items-end gap-3">
          {!existing && (
            <>
              <Field label="Product code" className="w-44">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={autoCode ? 'Auto' : 'Required'}
                  aria-label="New pack product code"
                />
              </Field>
              <Field label="Description" className="w-56">
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={`${base?.description ?? 'Product'} × ${packSize || '?'}`}
                  aria-label="New pack description"
                />
              </Field>
            </>
          )}

          <Field
            label="Pack size"
            hint={`How many ${base?.description ?? 'base units'} are in one`}
            className="w-40"
          >
            <NumberInput
              value={packSize || ''}
              onChange={(e) => setPackSize(Number(e.target.value))}
              aria-label="New pack size"
            />
          </Field>

          <Field label="Refer method" hint={METHOD_HINT[method]} className="min-w-[20rem] flex-1">
            <Select
              value={method}
              onChange={(e) => setMethod(e.target.value as ReferMethod)}
              aria-label="Refer method for the new pack"
            >
              <option value="subtract">Subtract pack — only the base holds stock</option>
              <option value="normal">Normal refers — this pack holds its own stock</option>
            </Select>
          </Field>

          <Button
            type="button"
            variant="primary"
            size="sm"
            className="mb-1"
            disabled={busy || packSize <= 0 || (!existing && !code.trim() && !autoCode)}
            onClick={add}
          >
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </div>

        {top && packSize > 0 && packSize % (top.packSize || 1) === 0 && packSize > top.packSize && (
          <p className="text-sm text-muted">
            Stored as{' '}
            <span className="numeric text-ink">{packSize / (top.packSize || 1)}</span> ×{' '}
            {top.description}, so {packSize} {base?.description} in total.
          </p>
        )}
      </div>
    </div>
  )
}
