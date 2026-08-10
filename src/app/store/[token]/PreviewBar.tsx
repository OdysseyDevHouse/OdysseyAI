import Link from 'next/link'

/**
 * The strip that says "this is not what shoppers see".
 *
 * ── WHY IT IS LOUD, AND WHY IT IS NOT DISMISSIBLE ────────────────────────
 *
 * A preview renders at the real URL, in the real chrome, with the real
 * products. That is the point — and it is exactly why it must be impossible to
 * forget. An owner who checks a draft, gets distracted, and comes back to the
 * tab an hour later would otherwise have no way to tell they are looking at
 * something no customer can see, and would reasonably conclude the page is
 * already live.
 *
 * A dismiss button would defeat that, so there isn't one. It costs a band at
 * the top of a page nobody but the owner will ever load.
 *
 * A server component: it has no state and no handlers, so shipping it as one
 * keeps it out of the browser bundle every real shopper downloads.
 */
export default function PreviewBar({ builderHref }: { builderHref: string }) {
  return (
    <div className="border-b border-warning bg-warning px-4 py-2 text-center text-sm text-warning-ink">
      <span className="font-medium">You are previewing a draft.</span>{' '}
      <span>Shoppers still see the published page.</span>{' '}
      <Link href={builderHref} className="font-medium underline">
        Back to the builder
      </Link>
    </div>
  )
}
