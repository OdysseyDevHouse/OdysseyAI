import { NextResponse, type NextRequest } from 'next/server'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listCustomers } from '@/lib/site/customers'
import { listSuppliers } from '@/lib/site/suppliers'
import { listProducts } from '@/lib/site/products'
import { listDocuments } from '@/lib/site/salesDocuments'
import { formatMoney, formatQty } from '@/lib/decimals'

/**
 * The records behind the global search palette.
 *
 * ── AN API ROUTE, NOT A SERVER ACTION ─────────────────────────────────────
 *
 * The palette fetches on every keystroke and aborts the previous request when the
 * next one starts. That is a plain HTTP concern — an AbortController against a
 * fetch — and server actions are a Next-internal POST protocol that queues rather
 * than cancels, so a slow query would go on holding up the keystrokes behind it.
 *
 * ── PAGES ARE NOT HERE ────────────────────────────────────────────────────
 *
 * Screens, settings and reports are matched entirely in the browser from the nav
 * map (src/lib/pageSearch.ts). They are a fixed list of a hundred-odd strings the
 * client already holds, so a round trip would make the fastest half of the search
 * the slowest for no gain. This route answers only what lives in the database.
 *
 * ── EVERY SECTION IS GATED SEPARATELY ─────────────────────────────────────
 *
 * `requireSiteUser` rather than `siteIdForCapability`, because there is no single
 * capability that opens this: someone who may see products but not the debtors
 * book gets the product matches and no customer section at all. One capability
 * check per section is what keeps a global search from becoming a way to read
 * around permissions — and a directly typeable URL is exactly where that matters.
 */

export const dynamic = 'force-dynamic'

/**
 * Per section, not in total.
 *
 * Five is what fits on screen under a heading without the palette becoming a
 * list to scroll — the point is to recognise the record and press Enter, and
 * anything longer is what the section's own list screen is for. Each section
 * therefore also carries a link to see the rest.
 */
const PER_SECTION = 5

/**
 * Below this a search matches most of the shop and means nothing.
 *
 * Three, not two: these are LIKE '%term%' scans over tens of thousands of rows,
 * and a two-letter fragment appears somewhere in most of them — "ti" returned
 * "Adams Group" and "Classic Alpen Tin", which is noise dressed as results. The
 * palette applies the same floor before it asks; this is here because the URL is
 * typeable and the expensive query should not be reachable below it either.
 */
const MIN_TERM = 3

export type SearchHit = {
  /** Unique across the whole response — doubles as the React key. */
  key: string
  href: string
  label: string
  meta: string | null
  /** Right-aligned figure, usually money. Gets tabular figures. */
  trailing: string | null
}

export type SearchSection = {
  /** Matches the `kind` the client maps to an icon. */
  kind: 'customers' | 'products' | 'suppliers' | 'documents'
  heading: string
  hits: SearchHit[]
  /** Where "see all" goes, with the term already applied. */
  moreHref: string
}

export async function GET(request: NextRequest) {
  const { site, capabilities } = await requireSiteUser()
  const term = (request.nextUrl.searchParams.get('q') ?? '').trim()

  if (term.length < MIN_TERM) {
    return NextResponse.json({ sections: [] }, { headers: NO_STORE })
  }

  const q = encodeURIComponent(term)
  const allowed = (capability: Parameters<typeof can>[1]) => can(capabilities, capability)

  /*
   * Every section runs concurrently and NONE of them can fail the response.
   *
   * A site whose schema has drifted — a table sql/site/ has but this database has
   * not yet been migrated to — would otherwise take the whole palette down with
   * it, turning a missing section into a search box that appears broken. Each
   * section resolves to its own empty list instead, and the sections that DO
   * work still answer.
   */
  const sections = await Promise.all([
    allowed('customers.view')
      ? section('customers', 'Customers', `/customers?q=${q}`, async () => {
          const { items } = await listCustomers(site.id, { search: term, limit: PER_SECTION })
          return items.map((c) => ({
            key: `customer-${c.id}`,
            href: `/customers/${c.id}`,
            label: c.name,
            meta: [c.code, c.phone, c.city].filter(Boolean).join(' · ') || null,
            /* The balance, because "what do they owe" is the reason somebody
               looks a customer up mid-conversation. */
            trailing: c.balance ? formatMoney(c.balance) : null,
          }))
        })
      : null,
    allowed('products.view')
      ? section('products', 'Products', `/products?q=${q}`, async () => {
          const { items } = await listProducts(site.id, { search: term, limit: PER_SECTION })
          return items.map((p) => {
            const price = p.prices.find((pr) => pr.isDefault) ?? p.prices[0]
            return {
              key: `product-${p.id}`,
              href: `/products/${p.id}`,
              label: p.description,
              meta:
                [p.code, `${formatQty(p.stockOnHand)} on hand`]
                  .filter(Boolean)
                  .join(' · ') || null,
              trailing: price ? formatMoney(price.sellIncl) : null,
            }
          })
        })
      : null,
    allowed('suppliers.view')
      ? section('suppliers', 'Suppliers', `/suppliers?q=${q}`, async () => {
          const { items } = await listSuppliers(site.id, { search: term, limit: PER_SECTION })
          return items.map((s) => ({
            key: `supplier-${s.id}`,
            href: `/suppliers/${s.id}`,
            label: s.name,
            meta: [s.code, s.phone, s.city].filter(Boolean).join(' · ') || null,
            trailing: s.balance ? formatMoney(s.balance) : null,
          }))
        })
      : null,
    allowed('sales.view')
      ? section('documents', 'Documents', `/invoicing?status=all&q=${q}`, async () => {
          const { items } = await listDocuments(site.id, { search: term, limit: PER_SECTION })
          return items.map((d) => ({
            key: `document-${d.id}`,
            href: `/sales/${d.id}`,
            /* The number is the identity of a document — it is what is written on
               the piece of paper somebody is holding while they type. */
            label: d.documentNumber ?? `${d.docLabel} #${d.id}`,
            meta:
              [d.docLabel, d.customerName, d.documentDate].filter(Boolean).join(' · ') || null,
            trailing: formatMoney(d.totalIncl),
          }))
        })
      : null,
  ])

  return NextResponse.json(
    { sections: sections.filter((s): s is SearchSection => s !== null && s.hits.length > 0) },
    { headers: NO_STORE },
  )
}

/**
 * One section, which answers empty rather than throwing.
 *
 * See the note at the fan-out above: a drifted schema must cost its own section
 * and nothing else.
 */
async function section(
  kind: SearchSection['kind'],
  heading: string,
  moreHref: string,
  load: () => Promise<SearchHit[]>,
): Promise<SearchSection> {
  const hits = await load().catch(() => [])
  return { kind, heading, hits, moreHref }
}

/*
 * Never cached by anything in between. The results are per-site and per-permission,
 * and one served from a shared cache would hand another shop's customers to
 * whoever asked next.
 */
const NO_STORE = { 'Cache-Control': 'no-store, private' }
