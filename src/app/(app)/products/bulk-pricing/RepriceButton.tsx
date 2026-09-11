'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icons, useToast } from '@/components/ui'
import type { RepriceTarget } from '@/app/(app)/setup/pricing/RepriceModal'
import type { EndingDirection } from '@/lib/repricing'
import RepriceModal from '@/app/(app)/setup/pricing/RepriceModal'

/**
 * The catalogue-wide bulk reprice, offered from Bulk edit pricing.
 *
 * The modal itself lives with Setup → Pricing, which owns the reprice actions;
 * this is only the trigger. The two screens are the two halves of the same job
 * and a buyer repricing a department should not have to know that one of them
 * is filed under Setup.
 *
 * ── WHY THIS IS NOT "Apply a rule" ────────────────────────────────────────
 * They look alike and do different things, which is exactly why both are here:
 *
 *   · Apply a rule — runs over the rows you TICKED, lands as pending edits you
 *     can read and adjust before saving. It lives in the selection bar because
 *     a selection is what it needs.
 *   · Bulk reprice — sweeps a whole PRICE TYPE across the catalogue, planned
 *     and written server-side, previewed as counts rather than rows. It lives
 *     in the toolbar because it ignores the selection and the page entirely.
 *
 * Putting this one in the toolbar rather than beside the other keeps that
 * difference visible: the thing that ignores your selection is not sitting in
 * the bar that reports it.
 *
 * A Client Component so the page holding it stays a Server Component.
 */
export default function RepriceButton({
  structures,
  departments,
  brands,
  defaultEndingDirection,
}: {
  structures: RepriceTarget[]
  departments: { id: number; name: string }[]
  brands: { id: number; name: string }[]
  defaultEndingDirection: EndingDirection
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const toast = useToast()

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Icons.Tag size={16} />
        Bulk reprice
      </Button>

      <RepriceModal
        open={open}
        onClose={() => setOpen(false)}
        structures={structures}
        departments={departments}
        brands={brands}
        defaultEndingDirection={defaultEndingDirection}
        onDone={(result) => {
          if (result.ok) {
            toast.success(result.message)
            setOpen(false)
            /* Refresh rather than patch the grid: the reprice may have written
               rows this page is not showing, and the ones it IS showing now
               hold stale prices. */
            router.refresh()
          } else {
            toast.error(result.error)
          }
        }}
      />
    </>
  )
}
