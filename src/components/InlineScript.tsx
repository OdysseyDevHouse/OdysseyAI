'use client'

/**
 * A blocking inline script that React will render without complaining.
 *
 * ── THE WARNING THIS EXISTS TO SILENCE ────────────────────────────────────
 *
 * A bare `<script>` anywhere in a rendered tree makes React log "Encountered a
 * script tag while rendering React component". It is not pedantry: a script
 * inserted through a DOM update never executes, so React is warning that the
 * thing almost certainly does nothing. On first load it DOES work — the script
 * is in the server HTML and the browser runs it while parsing — which is what
 * makes the warning easy to wave away and the underlying trap easy to fall into
 * on some later soft navigation.
 *
 * ── AND WHY THIS MUST BE `'use client'` ───────────────────────────────────
 *
 * The type switch below is the fix Next documents (see
 * `node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md`),
 * and it only works in a CLIENT component. React's check is
 * `isScriptDataBlock`, which suppresses the warning for any type that is not an
 * executable-JavaScript one — `text/plain` is silent, `text/javascript` warns.
 *
 * So the two renders need two different answers:
 *
 *   • on the SERVER, `text/javascript`, because the browser has to actually run
 *     it before the first paint — that is the whole point;
 *   • on the CLIENT, `text/plain`, so React sees an inert data block and stays
 *     quiet about a script it would never have executed anyway.
 *
 * `typeof window === 'undefined'` is what tells them apart, and in a SERVER
 * component that expression is evaluated on the server every single time — so
 * the `text/plain` branch is dead code and the tag is always executable. That
 * is why this file carries the `'use client'` directive and the root layout
 * does not inline the tag itself.
 *
 * ── WHAT IS AND IS NOT ESTABLISHED ────────────────────────────────────────
 *
 * The dead-branch reasoning above is certain. What was NOT reproduced is the
 * warning itself: `scripts/verify-theme-script.mjs` drives a real browser over
 * CDP, on a hard load and a soft navigation, and the console stayed clean
 * against the previous inline version as well as this one. So this is the
 * documented shape rather than a demonstrated cure, and if the warning returns,
 * that script is the place to reproduce it rather than the place that proves it
 * gone.
 *
 * `suppressHydrationWarning` covers the type attribute differing between the
 * two renders, which is deliberate rather than a mismatch to fix.
 */
export default function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
