// A storefront route must not resolve its own shop.
//
//   node scripts/check-storefront-routing.mjs [file...]
//
// ── WHAT THIS CATCHES, AND WHY IT IS WORTH A SCRIPT ────────────────────────
//
// A chain runs ONE storefront across several shops. The catalogue comes from
// head office and the stock, prices and orders come from the branch the shopper
// chose — so a route that does
//
//   const siteId = await verifyPublicStoreToken(token)
//   const context = await storefrontContext(siteId)
//
// is correct for a single shop and quietly wrong for a chain: it reads the
// TOKEN's site and never asks which branch was picked. The home page then shows
// head office's stock under a bar that says "Shopping at Claremont".
//
// This was found four separate times by accident before anybody counted, and
// the count was 22. It is invisible one file at a time and obvious across all
// of them, which is exactly the shape of bug that comes back — so it gets a
// check rather than a memo.
//
// The fix at every call site is `resolveStorefront(token)` from lib/storeRouting.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STORE_DIR = path.join(root, 'src', 'app', 'store')

/*
 * Routes that legitimately resolve the token's own site.
 *
 * These read data that is not a branch's to have: a customer account (sessions
 * are per-site by design — signing in at one branch is a different account at
 * the next), a sitemap of the catalogue, a shop's own images, a gift card
 * balance. Listed one by one WITH a reason, so the list cannot quietly become
 * "everything somebody did not want to fix".
 */
const ALLOWED = new Map([
  ['account/actions.ts', 'customer sessions are per-site by design'],
  ['account/addresses/actions.ts', 'the address book belongs to one shop’s customer'],
  ['account/addresses/page.tsx', 'the address book belongs to one shop’s customer'],
  ['account/forgot/page.tsx', 'a password reset is for one shop’s account'],
  ['account/invoice/[documentId]/route.ts', 'an invoice belongs to the shop that raised it'],
  ['account/page.tsx', 'customer sessions are per-site by design'],
  ['account/reset/[resetToken]/page.tsx', 'a password reset is for one shop’s account'],
  ['account/statement/page.tsx', 'a statement is one shop’s ledger'],
  ['account/statement/pdf/route.ts', 'a statement is one shop’s ledger'],
  ['basket/[recover]/page.tsx', 'the saved basket names the shop that saved it'],
  ['basket/[recover]/stop/page.tsx', 'the saved basket names the shop that saved it'],
  ['done/page.tsx', 'the order already exists and names its own shop'],
  ['gift-card/actions.ts', 'a gift card is one shop’s liability'],
  ['gift-card/page.tsx', 'a gift card is one shop’s liability'],
  ['o/[track]/page.tsx', 'the tracked order names the shop packing it'],
  ['p/[productId]/notifyActions.ts', 'a back-in-stock request is against one shop'],
  ['page/[slug]/page.tsx', 'CMS pages are the catalogue’s, and the token resolves to it'],
  ['sitemap.xml/route.ts', 'the sitemap lists the catalogue, not a branch'],
])

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => path.resolve(root, f))
  : await walk(STORE_DIR)

const problems = []
for (const file of files) {
  if (!file.startsWith(STORE_DIR)) continue
  const source = await readFile(file, 'utf8')

  // The signature: a context built from a bare site id.
  if (!/storefrontContext\(\s*siteId\s*\)/.test(source)) continue

  const rel = path
    .relative(STORE_DIR, file)
    .split(path.sep)
    .slice(1) // drop the [token] segment
    .join('/')

  if (ALLOWED.has(rel)) continue
  problems.push(rel)
}

if (problems.length === 0) {
  console.log('Storefront routing: every route resolves through resolveStorefront.')
  process.exit(0)
}

console.error('Storefront routing — these resolve their own shop and will be wrong for a chain:\n')
for (const p of problems) console.error(`  src/app/store/[token]/${p}`)
console.error(
  '\nUse `resolveStorefront(token)` from @/lib/storeRouting, which returns the\n' +
    'catalogue and the chosen branch. If the route genuinely belongs to one shop\n' +
    '(a customer account, a gift card, an order already placed), add it to ALLOWED\n' +
    `in ${path.relative(root, fileURLToPath(import.meta.url))} with the reason.`,
)
process.exit(1)
