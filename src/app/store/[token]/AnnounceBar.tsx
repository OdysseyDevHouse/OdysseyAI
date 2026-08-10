import Link from 'next/link'

/**
 * The strip above the masthead — "Free delivery over R500".
 *
 * ── CHROME, NOT A SECTION ────────────────────────────────────────────────
 *
 * It belongs on every page of the shop, and a section lives on one page. Built
 * as a section it would have to be added to each page and, worse, removed from
 * each when the offer ends — which is how a shop ends up still promising free
 * delivery in February.
 *
 * ── NOT DISMISSIBLE ──────────────────────────────────────────────────────
 *
 * Deliberately, and for the opposite reason to the preview bar. A dismiss
 * button needs somewhere to remember the dismissal, and the only place is the
 * shopper's browser — so it would come back for the same person on their phone
 * and stay gone on their laptop long after the text had changed. The owner's
 * control over how long it shows is the DATES, which the shop can reason about
 * and the shopper cannot accidentally defeat.
 *
 * A server component: no state, no handlers, so it costs nothing in the bundle
 * every shopper downloads.
 */
export default function AnnounceBar({ text, href }: { text: string; href: string }) {
  const inner = <span className="text-sm font-medium">{text}</span>

  return (
    <div
      /* The shop's own colour, at full strength — this is the one band on the
         page that is meant to be noticed before anything else. `text-white`
         rather than a token because the brand colour is validated to be a
         mid-weight that holds white text; see BRAND_SWATCHES. */
      className="bg-brand px-4 py-2 text-center text-white"
    >
      {href ? (
        // Validated by safeLinkTarget before it was ever stored, so this is an
        // http(s) URL or an in-shop path and nothing else.
        <Link href={href} className="underline underline-offset-2 hover:no-underline">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </div>
  )
}
