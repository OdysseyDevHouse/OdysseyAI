'use client'

import { createContext, useContext, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ColumnPicker, useToast } from '@/components/ui'
import { useColumnPrefs } from '@/lib/useColumnPrefs'
import { setListColumnsAction } from '../listColumnActions'
import { PRODUCT_COLUMNS } from './columns'

/**
 * Resolving which columns the products list shows.
 *
 * Two layers, answering different questions. The STORE's set says which columns
 * this business uses at all (list_columns, see 109); the DEVICE set says how
 * many of them fit on the screen in front of you (localStorage). So the store's
 * choice is the default handed to useColumnPrefs, and Reset lands there rather
 * than on a hardcoded list.
 *
 * A column the store has switched off cannot be switched back on per device —
 * the picker is fed the store's set, so its options are already the store's.
 * That is what "hidden for the whole store" has to mean, or hiding a column
 * would only be a suggestion.
 */
function resolveProductColumns(storeColumns: string[]) {
  const pickable = useMemo(
    () => PRODUCT_COLUMNS.filter((c) => storeColumns.includes(c.id) || c.locked),
    [storeColumns],
  )
  const prefs = useColumnPrefs(
    'odyssey.products.columns',
    storeColumns,
    pickable.map((c) => c.id),
  )

  // Locked columns are always in: the picker shows them ticked and disabled,
  // and a stored set from before one was locked would otherwise drop it.
  const visible = useMemo(() => {
    const next = new Set(prefs.visible)
    for (const c of PRODUCT_COLUMNS) if (c.locked) next.add(c.id)
    return next
  }, [prefs.visible])

  return { visible, pickable, prefs }
}

type ProductColumns = ReturnType<typeof resolveProductColumns>

const ProductColumnsContext = createContext<ProductColumns | null>(null)

/**
 * One column state, shared by the toolbar button and the table.
 *
 * ── WHY A CONTEXT AND NOT JUST THE HOOK ───────────────────────────────────
 *
 * Both used to call `useProductColumns(storeColumns)` directly, under a comment
 * saying it was "the same hook ... so the control and the table cannot
 * disagree". That is the one thing calling a hook twice does NOT give you: the
 * same code, two independent `useState`s. Ticking a column updated the button's
 * copy and the table went on rendering its own, so the new column appeared only
 * after a reload rebuilt both from the same props — which is exactly how it was
 * reported ("you must refresh the page before it shows").
 *
 * The button and the table are siblings on the page — the toolbar's action slot
 * and the card below it — so there is no parent to lift the state into short of
 * the page itself, which is a server component and cannot hold it. A provider
 * around both is what makes them one state.
 */
export function ProductColumnsProvider({
  storeColumns,
  children,
}: {
  storeColumns: string[]
  children: React.ReactNode
}) {
  const value = resolveProductColumns(storeColumns)
  return <ProductColumnsContext.Provider value={value}>{children}</ProductColumnsContext.Provider>
}

/**
 * The shared column state.
 *
 * Throws without a provider rather than quietly falling back to an instance of
 * its own. A fallback is what the bug looked like: two components each holding
 * a private copy, disagreeing in silence, and presenting as "you must refresh
 * the page". A screen that forgets the provider should fail where the mistake
 * is, not render a table whose Columns button does nothing.
 */
export function useProductColumns(): ProductColumns {
  const shared = useContext(ProductColumnsContext)
  if (!shared) {
    throw new Error('useProductColumns needs a <ProductColumnsProvider> above it.')
  }
  return shared
}

/**
 * The Columns control, for the TableToolbar's `actions` slot.
 *
 * It lives in the toolbar — right-aligned, beside the other things you do to
 * the list — rather than in a strip of its own between toolbar and table. It
 * sat in a hand-rolled strip first and looked it: space above and none below,
 * its right edge out of line with the card underneath. TableToolbar exists to
 * stop exactly that, and using its slot is what keeps the rhythm.
 *
 * ── TWO AUDIENCES, ONE CONTROL ───────────────────────────────────────────
 *
 * Someone who may set the store up picks from the WHOLE catalogue and their
 * choice is saved for everybody. Someone who may not picks from what the store
 * already shows, and it stays on their device. The difference is which list the
 * picker is fed and where the answer goes.
 */
export default function ProductColumnsButton({
  canSetColumns,
}: {
  canSetColumns: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const { visible, pickable, prefs } = useProductColumns()

  function saveForStore(next: Set<string>) {
    /* ── SHOWN NOW, NOT WHEN THE SERVER ANSWERS ───────────────────────────
     *
     * The tick has to move on the click that caused it. This used to do the
     * round trip first and then `prefs.reset()`, which lands on `storeColumns`
     * — the prop as it was BEFORE the save — so the box went back to unticked
     * and only came right when `router.refresh()` re-rendered the page with
     * the new prop. To anyone using it that is a checkbox that needs clicking
     * twice, which is how it was reported.
     *
     * So the device set carries the choice immediately. That is not a
     * throwaway optimistic value: this set is what the table reads, so writing
     * it is what puts the column on screen. The refresh below then re-lands
     * the same answer from the server as the new store default. */
    prefs.setVisible(next)

    startTransition(async () => {
      const result = await setListColumnsAction(
        'products',
        [...next],
        PRODUCT_COLUMNS.map((c) => c.id),
      )
      if (!result.ok) {
        /* Put back what the store actually has, so a refusal does not leave
           the screen showing a layout nobody saved. reset() is right here and
           not on the success path: nothing was saved, so the unrefreshed
           `storeColumns` prop IS the current truth. */
        prefs.reset()
        toast.error(result.error)
        return
      }
      /* ── AND NOT reset() HERE ─────────────────────────────────────────
       *
       * The obvious next line is `prefs.reset()`, to drop the device override
       * now the store holds the same set. It is wrong, and visibly so: reset
       * lands on `fallback`, memoised from the `storeColumns` PROP, which is
       * still the pre-save value until the refresh below repaints. So the
       * column would come on, go off, and come back — an on-off-on flicker in
       * place of the double-click.
       *
       * Clearing the stored override WITHOUT touching the live set gets both:
       * the screen keeps showing what was just chosen, and the next load reads
       * the store's copy rather than a private one that would then ignore a
       * change somebody else made. */
      prefs.forget()
      toast.success('Columns saved for the store')
      router.refresh()
    })
  }

  return canSetColumns ? (
    <ColumnPicker
      columns={PRODUCT_COLUMNS}
      visible={visible}
      onChange={saveForStore}
      label={pending ? 'Saving…' : 'Columns'}
    />
  ) : (
    <ColumnPicker
      columns={pickable}
      visible={visible}
      onChange={prefs.setVisible}
      onReset={prefs.reset}
    />
  )
}
