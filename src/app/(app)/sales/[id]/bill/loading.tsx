import { Skeleton, TableSkeleton } from '@/components/ui'

/**
 * Holds the printable bill's shape while the document loads.
 *
 * Its own file because this route has NO page chrome — no PageHeader, no Card —
 * so the /sales/[id] skeleton it would otherwise inherit draws a header and a
 * full-width table over what is actually a narrow centred slip.
 *
 * `max-w-[26rem]` and `p-6` mirror BillSlip's own wrapper.
 */
export default function Loading() {
  return (
    <div className="px-6 py-6">
      <Skeleton className="h-control w-28" />
      <article aria-hidden className="mx-auto mt-4 w-full max-w-[26rem] bg-surface p-6">
        <div className="border-b border-border pb-4">
          {/* Centred, as the real slip's header is. */}
          <Skeleton className="mx-auto h-6 w-40" />
          <Skeleton className="mx-auto mt-2 h-4 w-28" />
          <Skeleton className="mx-auto mt-3 h-5 w-32" />
        </div>
        <TableSkeleton columns={3} rows={5} />
        <div className="mt-4 flex justify-between border-t border-border pt-4">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-24" />
        </div>
      </article>
    </div>
  )
}
