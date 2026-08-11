import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * The old Documents screen, now the invoice register at /sales/invoicing.
 *
 * The two lists were the same table under two addresses — see the header
 * comment in ./invoicing/page.tsx for why they merged. This redirect stays
 * because /sales is on printed references, bookmarks, the quick-key runner and
 * a dozen `revalidatePath('/sales')` calls; deleting it would turn all of those
 * into a 404 to save one file.
 *
 * Note /sales/[id] is NOT affected — a document's own screen still lives there.
 */
export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; from?: string; to?: string; page?: string }>
}) {
  const params = await searchParams

  /*
   * Carry the query across, because a search or a date range is the user's
   * work and should survive the move. Status is the exception: the old screen
   * listed only finalised documents, so its statuses do not mean the same
   * thing as the new slices — anyone arriving with one gets "All", which is
   * the slice that certainly contains what they were looking at.
   */
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.from) query.set('from', params.from)
  if (params.to) query.set('to', params.to)
  if (params.status) query.set('status', 'all')

  const qs = query.toString()
  redirect(qs ? `/sales/invoicing?${qs}` : '/sales/invoicing?status=all')
}
