'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  CategoryTile,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  Skeleton,
  TouchRow,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type { TillProduct } from '@/lib/site/tillSearch'
import { searchProductsAction } from '@/app/(app)/sales/actions'
import { priceCheckAction, type PriceCheckResult } from './actions'

/**
 * What something costs, on every price type the shop keeps.
 *
 * ── WHY THIS IS NOT "JUST SEARCH ABOVE" ───────────────────────────────────
 *
 * The price-check key used to say so — it printed "search for the product
 * above, the tile shows its price" and did nothing else. That answered a
 * different question from the one being asked. The tile shows ONE figure: the
 * price on whichever structure the till is currently sitting on. The question at
 * the counter is almost always comparative — "what would this be on trade?",
 * "what do I pay on my account?" — and the old answer made the cashier switch
 * the till's price type to find out, which changes what the NEXT scan rings up.
 * Checking a price should not be able to mis-price a sale.
 *
 * ── WHY IT CAN ADD TO THE SLIP ────────────────────────────────────────────
 *
 * Because the honest end of a price check is usually "fine, I'll take it". Made
 * to close the dialog and find the product a second time, a cashier will instead
 * ring it up on the till's own price type and hand-correct the line — which is a
 * price override, wears an override badge, and needs a right they may not hold.
 * Adding from here rings it at the price the customer was just quoted, through
 * the same `add()` every tile and scanner uses, so specials, questions, scale
 * items and serial numbers behave exactly as they always do.
 *
 * The line is added at that structure's price WITHOUT switching the till onto
 * it. One item quoted on trade is one line, not a change of mode — see
 * PriceTypeModal for the distinction, which this deliberately respects.
 */
export function PriceCheckModal({
  open,
  priceStructureId,
  terminalId,
  onClose,
  onAdd,
}: {
  open: boolean
  /** What the till is on, so the search finds products the ordinary way. */
  priceStructureId: number | null
  terminalId: number | null
  onClose: () => void
  /**
   * Rings the product up at the chosen price type.
   *
   * The shell owns this: it holds `add()`, and every check that guards a line —
   * offline blocks, weighing, gift cards, instructions — lives behind it.
   */
  onAdd: (productId: number, structureId: number) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TillProduct[]>([])
  const [searching, setSearching] = useState(false)
  /** The product being looked at. Null means the search list is showing. */
  const [checked, setChecked] = useState<PriceCheckResult | null>(null)
  const [loading, start] = useTransition()

  // Cleared each time it opens: the last customer's enquiry is not this one's.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setChecked(null)
  }, [open])

  /* Debounced at 180ms and silent under two characters, the same as every other
     type-ahead on this screen. */
  useEffect(() => {
    if (!open || checked || query.trim().length < 2) {
      setResults([])
      return
    }
    const timer = setTimeout(() => {
      setSearching(true)
      searchProductsAction(query, priceStructureId, terminalId)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 180)
    return () => clearTimeout(timer)
  }, [open, query, checked, priceStructureId, terminalId])

  function check(product: TillProduct) {
    start(async () => {
      const result = await priceCheckAction(product.id, terminalId).catch(() => null)
      /* Null means the product answered on no structure at all — deleted between
         the search and the tap. Staying on the list is the useful response;
         an empty detail pane would just have to be backed out of. */
      if (result) setChecked(result)
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Price check"
      description="What something costs on each of the shop's price types. Nothing is added until you say so."
      size="lg"
      /* The body grows and the RESULTS LIST scrolls inside it. On a till the
         search box above must stay put while the rows scroll past — with the
         default cap the whole body scrolled as one and took the field the
         cashier was typing into with it. */
      bodyPins
      footer={
        checked ? (
          <>
            {/* Back to the list, not out of the dialog. A cashier checking one
                price is usually about to check another — the customer has a
                basket of questions, not one. */}
            <Button
              variant="secondary"
              size="touch"
              onClick={() => setChecked(null)}
            >
              <Icons.ArrowLeft size={18} />
              Find another
            </Button>
            <Button variant="ghost" size="touch" onClick={onClose}>
              Close
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="touch" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {checked ? (
        <CheckedProduct
          result={checked}
          onAdd={(structureId) => {
            onAdd(checked.productId, structureId)
            onClose()
          }}
        />
      ) : (
        <div className="flex min-h-0 flex-col gap-3">
          <Field label="Find a product">
            <Input
              size="touch"
              autoFocus
              icon={<Icons.Search size={18} />}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Scan, or type a code or description"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          {(searching || loading) && results.length === 0 && (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-touch w-full rounded-card" />
              ))}
            </div>
          )}

          {!searching && !loading && results.length === 0 && (
            <EmptyState
              icon={<Icons.Search size={26} />}
              title={query.trim().length >= 2 ? 'Nothing matches that' : 'What are you looking for?'}
              hint={
                query.trim().length >= 2
                  ? 'Try the product code, or fewer words of the description.'
                  : 'Scan the item, or type a couple of letters of its name.'
              }
            />
          )}

          {results.length > 0 && (
            <div className="till-pane flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {results.map((product) => (
                <TouchRow
                  key={product.id}
                  icon={<CategoryTile icon={<Icons.Tag size={20} />} tone="sky" size="lg" />}
                  title={product.description}
                  subtitle={product.code}
                  onClick={() => check(product)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/**
 * One product, and the shop's whole price ladder for it.
 *
 * The prices are the loudest thing on this pane, because they are the only
 * reason anybody opened it. The code, the stock and the name are the context
 * that confirms it is the right product.
 */
function CheckedProduct({
  result,
  onAdd,
}: {
  result: PriceCheckResult
  onAdd: (structureId: number) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* ── What was found ──────────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <CategoryTile icon={<Icons.Tag size={22} />} tone="sky" size="lg" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-lg font-semibold leading-tight text-ink">
            {result.description}
          </span>
          <span className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <span className="numeric">{result.code}</span>
            {/* Stock as a STATE, not a figure in the same grey as everything
                else: "none left" is the answer that changes what the cashier
                says next, and it should not have to be read digit by digit. */}
            {result.availableQty > 0 ? (
              <Badge tone="success">{formatQty(result.availableQty)} available</Badge>
            ) : (
              <Badge tone="danger" solid>
                None available
              </Badge>
            )}
          </span>
        </div>
      </div>

      {/* ── The ladder ──────────────────────────────────────────────────── */}
      {result.askPriceAtSale ? (
        /* An open-price item has no ladder to show. Saying so beats printing a
           column of R0.00, which reads as "free" rather than "you decide". */
        <EmptyState
          icon={<Icons.Tag size={26} />}
          title="This one is priced at the till"
          hint="It has no set price — the amount is typed in when it is rung up."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {result.prices.map((price) => (
            <div
              key={price.structureId}
              className="flex items-center gap-3 rounded-card border border-border bg-surface px-4 py-3"
            >
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">
                {price.structureName}
              </span>

              {price.unpriced ? (
                /* No row for this structure. NOT rendered as R0.00 and not
                   addable: a missing price is a gap in the product file, and
                   selling against it is how a fridge goes out for nothing. */
                <Badge tone="warning">Not priced</Badge>
              ) : (
                <>
                  <span className="numeric shrink-0 text-lg font-bold text-ink">
                    {formatMoney(price.priceIncl)}
                  </span>
                  {/* One per row, and all of them secondary. There is no single
                      "right" price type here — which one applies is the thing
                      the cashier is deciding — so promoting one to primary
                      would be the screen guessing on their behalf. */}
                  <Button
                    variant="secondary"
                    size="touch"
                    className="shrink-0"
                    onClick={() => onAdd(price.structureId)}
                  >
                    <Icons.Plus size={18} />
                    Add to slip
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
