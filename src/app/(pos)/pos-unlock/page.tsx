import UnlockScreen from './UnlockScreen'

export const dynamic = 'force-dynamic'

/**
 * The till's way back in.
 *
 * ── PUBLIC, AND IT HAS TO BE ──────────────────────────────────────────────
 *
 * The visitor has no session — that is the entire situation this screen exists for
 * — so it cannot be gated. What makes that acceptable is that it reads NOTHING:
 * no site name, no operator list, no product, not even a count. It renders a PIN
 * pad and a sentence. Every fact it could show would be a fact leaked to whoever
 * opened the URL.
 *
 * The action behind it resolves the site from the machine's own terminal claim
 * rather than from anything typed here, so an unclaimed device is refused before a
 * single PIN is compared. See actions.ts.
 */
export default function PosUnlockPage() {
  return <UnlockScreen />
}
