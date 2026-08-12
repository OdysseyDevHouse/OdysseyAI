'use client'

import { useMemo, useTransition } from 'react'
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
export function useProductColumns(storeColumns: string[]) {
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
  storeColumns,
  canSetColumns,
}: {
  storeColumns: string[]
  canSetColumns: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const { visible, pickable, prefs } = useProductColumns(storeColumns)

  function saveForStore(next: Set<string>) {
    startTransition(async () => {
      const result = await setListColumnsAction(
        'products',
        [...next],
        PRODUCT_COLUMNS.map((c) => c.id),
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // The device set is cleared too, so the store's new choice is what this
      // screen shows rather than an override from before it changed.
      prefs.reset()
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
