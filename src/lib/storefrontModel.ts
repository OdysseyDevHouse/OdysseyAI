/**
 * The storefront layout MODEL — shared by the server and the browser.
 *
 * Deliberately free of `server-only` and of any database import, because the
 * page builder runs in the browser and needs the same normalisation, caps and
 * validation the server applies. Importing this from a client component must
 * not drag the database layer into the bundle — which is exactly what happened
 * when these lived alongside the queries.
 *
 * The reading and writing half lives in storefrontLayout.ts.
 */


/**
 * The storefront's front page: an ordered list of sections, plus the theme.
 *
 * ── WHY SECTIONS RATHER THAN FIXED BLOCKS ────────────────────────────────
 *
 * A shop wants two product rows with different rules — "On special" and "New
 * this week" — or none at all. Fixed blocks force every shop into one page
 * shape; instances let a butchery and a bookshop each build the page they
 * actually want out of the same four pieces.
 *
 * ── EVERY KIND RENDERS NOTHING WHEN EMPTY ────────────────────────────────
 *
 * A products section with no matches draws no heading, no frame, nothing. That
 * property is what lets an owner switch everything on to see what it does
 * without producing a page of empty headings.
 *
 * ── NORMALISATION RUNS ON WRITE ──────────────────────────────────────────
 *
 * A draft is posted by a browser and is therefore untrusted. `normaliseSections`
 * is applied when SAVING, not merely when rendering: caps, unknown kinds and
 * junk fields are dealt with before anything is stored, so a hand-crafted
 * payload cannot put 10 000 sections in a row that later has to be read.
 */

export const SECTION_KINDS = ['hero', 'categories', 'products', 'cards'] as const
export type SectionKind = (typeof SECTION_KINDS)[number]

/**
 * How a product section decides what to show.
 *
 * Anything unrecognised reads as 'manual', which fails CLOSED: an unknown rule
 * then shows only what was explicitly picked — usually nothing — rather than
 * spilling the whole catalogue onto the landing page.
 */
export const PRODUCT_SOURCES = ['manual', 'department', 'newest'] as const
export type ProductSource = (typeof PRODUCT_SOURCES)[number]

export type InfoCard = { icon: string; heading: string; text: string }

export type HomeSection = {
  /**
   * Stable identity — NOT the array index and NOT the title. It is the drag
   * key, the React key and the inspector's selection: keying on the title
   * would collide the moment two sections share one, and keying on the index
   * would remount every section on every reorder.
   */
  id: string
  kind: SectionKind
  /** The heading a shopper sees. Empty renders no heading at all. */
  title: string
  enabled: boolean
  /** products: how the row is filled. */
  source?: ProductSource
  /** products + source 'department'. */
  departmentId?: number | null
  /** products + source 'manual'. */
  productIds?: number[]
  /** products/categories: 0 means "as many as fit". */
  maxItems?: number
  /** cards only. */
  cards?: InfoCard[]
}

/** Hard caps, enforced on WRITE. A draft is untrusted. */
export const MAX_SECTIONS = 20
export const MAX_SECTION_ITEMS = 24
export const MAX_SECTION_CARDS = 12

export const SECTION_LABEL: Record<SectionKind, string> = {
  hero: 'Welcome banner',
  categories: 'Shop by department',
  products: 'A row of products',
  cards: 'Info cards',
}

export const SECTION_HINT: Record<SectionKind, string> = {
  hero: 'Your headline and a line under it.',
  categories: 'Tiles linking to each department you publish.',
  products: 'Pick the products yourself, or let a rule fill the row.',
  cards: 'Your own tiles — delivery info, opening hours, anything.',
}

export const SOURCE_LABEL: Record<ProductSource, string> = {
  manual: 'Products I pick',
  department: 'Everything in a department',
  newest: 'Newest products',
}

/**
 * The page a store starts with.
 *
 * Deliberately a piece of CONTENT rather than a mapping over the kind list:
 * the whole point of instances is that there is no canonical set of sections
 * to derive a starter page from.
 */
export function defaultSections(): HomeSection[] {
  return [
    { id: 'hero', kind: 'hero', title: '', enabled: true },
    { id: 'departments', kind: 'categories', title: 'Shop by department', enabled: true, maxItems: 0 },
    {
      id: 'newest',
      kind: 'products',
      title: 'New in',
      enabled: true,
      source: 'newest',
      maxItems: 8,
      productIds: [],
    },
  ]
}

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * Coerce whatever arrived into the exact shape we store.
 *
 * Key order matters as well as content: the builder decides whether it has
 * unsaved changes by comparing JSON, so the browser's copy and the server's
 * must serialise identically. Spreading the input would preserve whatever key
 * order it happened to have and show a permanent "unsaved changes" that no
 * amount of saving clears.
 */
export function normaliseSections(input: unknown): HomeSection[] {
  const known = new Set<string>(SECTION_KINDS)
  const list = Array.isArray(input) ? input : []
  const out: HomeSection[] = []
  const seenIds = new Set<string>()

  for (const raw of list) {
    if (out.length >= MAX_SECTIONS) break
    if (!raw || typeof raw !== 'object') continue

    const s = raw as Record<string, unknown>
    const kind = String(s.kind ?? '')
    // A kind this build cannot draw never reaches the preview or the shop.
    if (!known.has(kind)) continue

    // Duplicate ids would make two sections share a React key and a drag
    // handle, so the later one is re-identified rather than dropped.
    let id = String(s.id ?? '').slice(0, 40) || `s-${out.length}`
    while (seenIds.has(id)) id = `${id}-${out.length}`
    seenIds.add(id)

    const section: HomeSection = {
      id,
      kind: kind as SectionKind,
      title: String(s.title ?? '').slice(0, 80),
      enabled: s.enabled !== false,
    }

    if (kind === 'products') {
      const source = String(s.source ?? 'manual')
      section.source = (PRODUCT_SOURCES as readonly string[]).includes(source)
        ? (source as ProductSource)
        : 'manual'
      // Same reasoning as productIds: an unusable value becomes "no
      // department" rather than department 1.
      const dept = typeof s.departmentId === 'number' ? s.departmentId : Number(s.departmentId)
      section.departmentId = Number.isInteger(dept) && dept > 0 ? dept : null
      // DISCARD junk rather than clamping it. Clamping would turn 'abc' and
      // -5 into id 1 — inventing a reference to a real product nobody picked,
      // several times over. An id is an identity, not a quantity.
      section.productIds = Array.isArray(s.productIds)
        ? [
            ...new Set(
              s.productIds
                .map((v) => (typeof v === 'number' ? v : Number(v)))
                .filter((v) => Number.isInteger(v) && v > 0),
            ),
          ].slice(0, MAX_SECTION_ITEMS)
        : []
      section.maxItems = clampInt(s.maxItems, 0, MAX_SECTION_ITEMS, 8)
    }

    if (kind === 'categories') {
      section.maxItems = clampInt(s.maxItems, 0, MAX_SECTION_ITEMS, 0)
    }

    if (kind === 'cards') {
      section.cards = (Array.isArray(s.cards) ? s.cards : [])
        .slice(0, MAX_SECTION_CARDS)
        .map((c) => {
          const card = (c ?? {}) as Record<string, unknown>
          return {
            icon: String(card.icon ?? '').slice(0, 40),
            heading: String(card.heading ?? '').slice(0, 60),
            text: String(card.text ?? '').slice(0, 200),
          }
        })
    }

    out.push(section)
  }

  return out
}

/* ── Theme ────────────────────────────────────────────────────────────────── */

export type StorefrontTheme = {
  brandColour: string
  productLayout: 'grid' | 'list'
  heroHeadline: string
  heroSubtext: string
  footerAbout: string
  footerHours: string
  socialFacebook: string
  socialInstagram: string
  socialWhatsapp: string
}

/**
 * A colour we are willing to inject into a page.
 *
 * Strict hex only. This value ends up inside a style attribute on a public
 * page, so anything that is not unmistakably a colour is replaced with the
 * default rather than trusted — `red; background: url(…)` must never survive.
 */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
export const DEFAULT_BRAND_COLOUR = '#2f6fed'

export function safeColour(value: unknown): string {
  const raw = String(value ?? '').trim()
  return HEX.test(raw) ? raw : DEFAULT_BRAND_COLOUR
}

/**
 * A link we are willing to render.
 *
 * http/https only: a `javascript:` URL in a footer link would be stored XSS on
 * a page that takes payments.
 */
export function safeUrl(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

type Row = Record<string, unknown>

export function readTheme(row: Row): StorefrontTheme {
  return {
    brandColour: safeColour(row.brand_colour),
    productLayout: String(row.product_layout) === 'list' ? 'list' : 'grid',
    heroHeadline: String(row.hero_headline ?? ''),
    heroSubtext: String(row.hero_subtext ?? ''),
    footerAbout: String(row.footer_about ?? ''),
    footerHours: String(row.footer_hours ?? ''),
    socialFacebook: safeUrl(row.social_facebook),
    socialInstagram: safeUrl(row.social_instagram),
    socialWhatsapp: String(row.social_whatsapp ?? '').replace(/[^\d+]/g, '').slice(0, 20),
  }
}

