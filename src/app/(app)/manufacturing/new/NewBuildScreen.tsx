'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Combobox,
  EmptyState,
  Field,
  Icons,
  Input,
  NumberInput,
  PageBody,
  Select,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_NUMERIC,
  TABLE_TD,
  TABLE_TH,
  Textarea,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import { postBuildAction, previewBuildAction, searchManufacturableAction } from '../actions'

type LocationOption = { id: number; code: string; name: string; isMain: boolean }
type Pick = { id: number; code: string; description: string }

type PreviewComponent = {
  productId: number
  code: string
  description: string
  qtyPerUnit: number
  qtyRequired: number
  unitCostExcl: number
  lineCostExcl: number
  available: number
  shortBy: number
}

type Preview = {
  productId: number
  code: string
  description: string
  qty: number
  components: PreviewComponent[]
  componentCost: number
  unitCostExcl: number
  buildable: number
  shortages: PreviewComponent[]
}

type Overhead = { key: string; description: string; amountExcl: number }

/**
 * Capturing a build.
 *
 * The screen answers three questions at once, because they are the three a
 * person actually has while standing there: what will this consume, is there
 * enough, and what will the finished item cost.
 *
 * All three come from previewBuild() on the server — the same function the post
 * path uses to decide what to consume — so the panel a user reads and the check
 * that refuses the post can never disagree. Recomputing the arithmetic here
 * would be faster and would eventually drift.
 *
 * The shortfall is the load-bearing part. A build that would overdraw is
 * refused at post, so a screen that lets someone type it and only finds out
 * afterwards is a screen people learn to distrust.
 */
export default function NewBuildScreen({ locations }: { locations: LocationOption[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const mainId = locations.find((l) => l.isMain)?.id ?? locations[0]?.id ?? 0

  const [product, setProduct] = useState<Pick | null>(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<Pick[]>([])
  const [searching, setSearching] = useState(false)

  const [qty, setQty] = useState(1)
  const [fromLocationId, setFromLocationId] = useState(mainId)
  const [toLocationId, setToLocationId] = useState(mainId)
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [overheads, setOverheads] = useState<Overhead[]>([])

  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)

  // ── The picker ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const found = await searchManufacturableAction(query)
        if (!cancelled) setOptions(found)
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  // ── The live preview ─────────────────────────────────────────────────────
  // Debounced, because it runs on every keystroke in the quantity box and each
  // run resolves a recipe tree on the server.
  useEffect(() => {
    if (!product || qty <= 0) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    setLoadingPreview(true)
    const timer = setTimeout(async () => {
      try {
        const result = await previewBuildAction(product.id, qty, fromLocationId)
        if (cancelled) return
        if (result.ok) {
          setPreview(result.preview as Preview)
          setPreviewError(null)
        } else {
          setPreview(null)
          setPreviewError(result.error)
        }
      } finally {
        if (!cancelled) setLoadingPreview(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [product, qty, fromLocationId])

  const overheadTotal = overheads.reduce((sum, o) => sum + (Number.isFinite(o.amountExcl) ? o.amountExcl : 0), 0)
  const componentCost = preview?.componentCost ?? 0
  const madeUnitCost = qty > 0 ? (componentCost + overheadTotal) / qty : 0
  const hasShortage = (preview?.shortages.length ?? 0) > 0

  const comboOptions: ComboboxOption<Pick>[] = options.map((p) => ({
    value: String(p.id),
    label: p.description,
    hint: p.code,
    data: p,
  }))

  function post() {
    if (!product) return
    start(async () => {
      const result = await postBuildAction({
        productId: product.id,
        qty,
        fromLocationId,
        toLocationId,
        reference: reference.trim() || null,
        note: note.trim() || null,
        overheads: overheads
          .filter((o) => o.description.trim())
          .map((o) => ({ description: o.description, amountExcl: o.amountExcl })),
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`Built ${formatQty(qty)} — ${result.documentNumber}`)
      router.push(`/manufacturing/${result.id}`)
    })
  }

  return (
    <PageBody>
      <Card>
        <CardHeader title="What are you making?" description="Only recipe products marked as made in batches can be built." />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Product">
              {product ? (
                <div className="flex items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-3 h-control">
                  <span className="truncate">
                    <span className="text-ink">{product.description}</span>
                    <span className="ml-2 text-xs text-muted">{product.code}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label="Choose a different product"
                    onClick={() => {
                      setProduct(null)
                      setQuery('')
                    }}
                  >
                    <Icons.Close size={15} />
                  </Button>
                </div>
              ) : (
                <Combobox
                  options={comboOptions}
                  query={query}
                  onQueryChange={setQuery}
                  loading={searching}
                  autoFocus
                  placeholder="Search products made in batches…"
                  emptyText="No products are made in batches"
                  onSelect={(o) => {
                    if (o.data) setProduct(o.data)
                  }}
                />
              )}
            </Field>

            <Field
              label="How many"
              hint={
                preview
                  ? `The ingredients on hand allow ${formatQty(preview.buildable)}.`
                  : undefined
              }
            >
              <div className="flex gap-2">
                <NumberInput
                  value={qty}
                  onChange={(e) => setQty(Number(e.target.value) || 0)}
                  min={0}
                  step={1}
                  className="flex-1"
                />
                {/* "Make as much bread as the flour allows" is the actual
                    instruction in a bakery. Making someone work it out by hand
                    is how the module gets bypassed. */}
                <Button
                  variant="secondary"
                  onClick={() => preview && setQty(Math.floor(preview.buildable))}
                  disabled={!preview || preview.buildable < 1}
                >
                  Build max
                </Button>
              </div>
            </Field>

            <Field label="Ingredients from" hint="The location the components come off.">
              <Select
                value={String(fromLocationId)}
                onChange={(e) => setFromLocationId(Number(e.target.value))}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} — {l.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Finished goods into" hint="Usually the same place. A central bakery is the exception.">
              <Select
                value={String(toLocationId)}
                onChange={(e) => setToLocationId(Number(e.target.value))}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code} — {l.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </CardBody>
      </Card>

      {previewError && (
        <Card>
          <CardBody>
            <EmptyState
              title="This recipe cannot be built yet"
              hint={previewError}
              icon={<Icons.StatusWarning size={22} />}
            />
          </CardBody>
        </Card>
      )}

      {preview && (
        <Card>
          <CardHeader
            title="What it will use"
            description={
              hasShortage
                ? 'Some ingredients are short. A build cannot take stock that is not there.'
                : 'Taken off the shelf when this build posts.'
            }
            action={
              hasShortage ? (
                <Badge tone="danger">{preview.shortages.length} short</Badge>
              ) : (
                <Badge tone="success">Enough on hand</Badge>
              )
            }
          />
          <CardBody>
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Ingredient</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Per one</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Needs</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>On hand</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {preview.components.map((c) => (
                  <tr key={c.productId}>
                    <td className={TABLE_TD}>
                      <span className="flex flex-col">
                        <span className="text-ink">{c.description}</span>
                        <span className="text-xs text-muted">{c.code}</span>
                      </span>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} numeric`}>{formatQty(c.qtyPerUnit)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} numeric`}>{formatQty(c.qtyRequired)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} numeric`}>
                      {c.shortBy > 0 ? (
                        <span className="text-danger">
                          {formatQty(c.available)} — {formatQty(c.shortBy)} short
                        </span>
                      ) : (
                        <span className="text-ink-2">{formatQty(c.available)}</span>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} numeric`}>{formatMoney(c.lineCostExcl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {product && (
        <Card>
          <CardHeader
            title="Extra costs"
            description="Labour, packaging, power. These add to what the finished item costs, and move no stock."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setOverheads((rows) => [
                    ...rows,
                    { key: `oh-${Date.now()}-${rows.length}`, description: '', amountExcl: 0 },
                  ])
                }
              >
                <Icons.Plus size={15} />
                Add a cost
              </Button>
            }
          />
          {overheads.length > 0 && (
            <CardBody>
              <div className="flex flex-col gap-2">
                {overheads.map((o) => (
                  /* A grid rather than a flex row: the description input is
                     w-full from the shared CONTROL skin, and flex-1 on a
                     w-full child collapses it to nothing. */
                  <div key={o.key} className="grid grid-cols-[1fr_10rem_auto] items-center gap-2">
                    <Input
                      value={o.description}
                      placeholder="What was it — baker hour, packaging…"
                      onChange={(e) =>
                        setOverheads((rows) =>
                          rows.map((r) => (r.key === o.key ? { ...r, description: e.target.value } : r)),
                        )
                      }
                    />
                    <NumberInput
                      value={o.amountExcl}
                      min={0}
                      precision={2}
                      onChange={(e) =>
                        setOverheads((rows) =>
                          rows.map((r) =>
                            r.key === o.key ? { ...r, amountExcl: Number(e.target.value) || 0 } : r,
                          ),
                        )
                      }
                    />
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label="Remove this cost"
                      onClick={() => setOverheads((rows) => rows.filter((r) => r.key !== o.key))}
                    >
                      <Icons.Trash size={15} />
                    </Button>
                  </div>
                ))}
              </div>
            </CardBody>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="Finish" />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Reference" hint="Optional — a batch number, a shift.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
            </Field>
            <Field label="Note">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={400} />
            </Field>
          </div>

          {preview && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface-2 px-4 py-3">
              <div className="flex flex-col">
                <span className="text-xs text-muted">Ingredients</span>
                <span className="numeric text-ink">{formatMoney(componentCost)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted">Extra costs</span>
                <span className="numeric text-ink">{formatMoney(overheadTotal)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted">Cost of one</span>
                <span className="numeric text-ink">{formatMoney(madeUnitCost)}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted">Total</span>
                <span className="numeric text-ink">{formatMoney(componentCost + overheadTotal)}</span>
              </div>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => router.push('/manufacturing')} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={post}
              disabled={pending || !product || qty <= 0 || !preview || hasShortage || loadingPreview}
            >
              {pending ? 'Building…' : `Build ${qty > 0 ? formatQty(qty) : ''}`}
            </Button>
          </div>
        </CardBody>
      </Card>
    </PageBody>
  )
}
