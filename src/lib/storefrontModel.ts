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

export const SECTION_KINDS = [
  'hero',
  'banner',
  'categories',
  'products',
  'cards',
  'text',
] as const
export type SectionKind = (typeof SECTION_KINDS)[number]

/**
 * How a product section decides what to show.
 *
 * Anything unrecognised reads as 'manual', which fails CLOSED: an unknown rule
 * then shows only what was explicitly picked — usually nothing — rather than
 * spilling the whole catalogue onto the landing page.
 *
 * 'special' and 'popular' are RULES over data the shop already keeps — live
 * specials and sales history — so a "This week's deals" row maintains itself.
 * Hand-picking that row means re-picking it every time a special starts or
 * ends, which is how a front page ends up advertising last month's prices.
 */
export const PRODUCT_SOURCES = ['manual', 'department', 'newest', 'special', 'popular'] as const
export type ProductSource = (typeof PRODUCT_SOURCES)[number]

/**
 * A section's background treatment.
 *
 * Deliberately two named tones rather than a free colour: the point is visual
 * RHYTHM — alternating bands so a page reads as several things rather than one
 * long scroll — and a per-section colour picker produces a page that fights
 * the shop's own palette. 'tinted' is mixed from the store's brand colour, so
 * it stays in key whatever that colour is.
 */
export const SECTION_TONES = ['plain', 'tinted'] as const
export type SectionTone = (typeof SECTION_TONES)[number]

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
  /**
   * The band this section sits on. Absent reads as 'plain', so every layout
   * saved before tones existed keeps looking exactly as it did.
   */
  tone?: SectionTone
  /** products: how the row is filled. */
  source?: ProductSource
  /** products + source 'department'. */
  departmentId?: number | null
  /** products + source 'manual'. */
  productIds?: number[]
  /** products/categories: 0 means "as many as fit". */
  maxItems?: number
  /**
   * products: draw THIS row as a grid or a list, overriding the shop-wide
   * choice. Absent means "follow the shop", which is the default and what
   * every existing layout does.
   *
   * Worth having because the two rules want different shapes: a specials row
   * is a shop window and wants tiles, while "everything in Groceries" below it
   * is a list somebody scans.
   */
  layout?: 'grid' | 'list' | null
  /** cards only. */
  cards?: InfoCard[]
  /**
   * banner: the uploaded picture, or null while one is being chosen.
   *
   * An id into `storefront_images`, NOT a path. The bytes are served by a
   * route that re-checks the store is open and the image belongs to it, so a
   * stored path would be a URL nobody validates.
   */
  imageId?: number | null
  /** banner: what a screen reader says instead of seeing it. */
  imageAlt?: string
  /** banner: where clicking it goes. Empty means the banner is not a link. */
  linkUrl?: string
  /** banner: the words drawn over the picture. */
  bodyText?: string
  /** banner: the button drawn over the picture. Empty draws no button. */
  buttonLabel?: string
  /** text: the paragraph itself. */
  text?: string
  /** text: how the paragraph is aligned. */
  align?: 'left' | 'center'
  /**
   * Show this section from / until this date, as plain YYYY-MM-DD text.
   *
   * ── WHY DATES AND NOT A SWITCH ───────────────────────────────────────
   *
   * "Put the Christmas banner up on the 1st and take it down on the 26th" is
   * something an owner decides once, in November. A manual switch means being
   * at a computer on both days — and the day it gets forgotten is Boxing Day,
   * with the shop still wishing everyone a merry Christmas.
   *
   * ── TEXT, COMPARED AS TEXT ───────────────────────────────────────────
   *
   * 'YYYY-MM-DD' sorts correctly as a string, so the window is evaluated by
   * comparing text and never by parsing. That is deliberate and it is the same
   * decision `liveSpecials` documents: parsing drags the timezone problem back
   * in, and these windows once broke exactly that way. A shop keeps ITS OWN
   * calendar day — the 26th ends when it ends where the shop is, not at some
   * UTC boundary.
   *
   * Empty means unbounded on that side, so a section with neither is simply
   * always on — which is every section that existed before scheduling did.
   */
  showFrom?: string
  showUntil?: string
}

/** Hard caps, enforced on WRITE. A draft is untrusted. */
export const MAX_SECTIONS = 20
export const MAX_SECTION_ITEMS = 24
export const MAX_SECTION_CARDS = 12
/** A paragraph, not an essay — the front page is a shop window. */
export const MAX_SECTION_TEXT = 1200

export const SECTION_LABEL: Record<SectionKind, string> = {
  hero: 'Welcome banner',
  banner: 'Picture banner',
  categories: 'Shop by department',
  products: 'A row of products',
  cards: 'Info cards',
  text: 'A paragraph',
}

export const SECTION_HINT: Record<SectionKind, string> = {
  hero: 'Your headline and a line under it.',
  banner: 'A photograph across the page, with words over it.',
  categories: 'Tiles linking to each department you publish.',
  products: 'Pick the products yourself, or let a rule fill the row.',
  cards: 'Your own tiles — delivery info, opening hours, anything.',
  text: 'A note to shoppers — delivery days, a holiday message.',
}

export const SOURCE_LABEL: Record<ProductSource, string> = {
  manual: 'Products I pick',
  department: 'Everything in a department',
  newest: 'Newest products',
  special: 'Whatever is on special',
  popular: 'Best sellers',
}

/** What each rule does, spelled out where the owner chooses it. */
export const SOURCE_HINT: Record<ProductSource, string> = {
  manual: 'The row shows exactly what you choose, in your order.',
  department: 'Everything published in one department.',
  newest: 'The products you added most recently.',
  special: 'Fills itself from your live specials, and empties when they end.',
  popular: 'What has sold most over the last 90 days.',
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

/**
 * Ready-made pages, as starting points.
 *
 * ── WHY THESE EXIST ──────────────────────────────────────────────────────
 *
 * The blank-page problem is real: an owner who has never built a web page is
 * handed an empty canvas and an "Add a section" menu, and the honest answer to
 * "what should go here?" is a shape they have never seen. A preset is that
 * shape, already arranged — and because everything in it is an ordinary
 * section, the next thing they do is drag one, which is the skill they
 * actually need.
 *
 * Applying one REPLACES the page rather than appending, which is why the
 * builder puts it behind a confirmation and why undo covers it.
 *
 * The ids are generated on apply, not written here: two presets applied in one
 * session would otherwise collide, and id is the drag key.
 */
export type PagePreset = {
  key: string
  name: string
  /** What kind of shop this suits, in the owner's terms. */
  hint: string
  sections: Omit<HomeSection, 'id'>[]
}

export const PAGE_PRESETS: PagePreset[] = [
  {
    key: 'classic',
    name: 'The classic shop',
    hint: 'A welcome, your departments, then what is new.',
    sections: [
      { kind: 'hero', title: '', enabled: true, tone: 'tinted' },
      { kind: 'categories', title: 'Shop by department', enabled: true, maxItems: 0 },
      { kind: 'products', title: 'New in', enabled: true, source: 'newest', maxItems: 8 },
      {
        kind: 'cards',
        title: '',
        enabled: true,
        tone: 'tinted',
        cards: [
          { icon: '🚚', heading: 'Delivery', text: 'Tell shoppers where you deliver and when.' },
          { icon: '🕘', heading: 'Opening hours', text: 'When they can find you.' },
          { icon: '💳', heading: 'Payment', text: 'What you accept.' },
        ],
      },
    ],
  },
  {
    key: 'deals',
    name: 'Deals first',
    hint: 'Specials at the top — for a shop that runs promotions.',
    sections: [
      { kind: 'hero', title: '', enabled: true, tone: 'tinted' },
      {
        kind: 'products',
        title: 'This week’s specials',
        enabled: true,
        source: 'special',
        maxItems: 8,
        layout: 'grid',
      },
      { kind: 'categories', title: 'Shop by department', enabled: true, maxItems: 0 },
      {
        kind: 'products',
        title: 'Best sellers',
        enabled: true,
        source: 'popular',
        maxItems: 8,
        tone: 'tinted',
      },
    ],
  },
  {
    key: 'simple',
    name: 'Keep it simple',
    hint: 'A welcome and your products. Nothing else.',
    sections: [
      { kind: 'hero', title: '', enabled: true },
      { kind: 'products', title: '', enabled: true, source: 'newest', maxItems: 12 },
    ],
  },
  {
    key: 'story',
    name: 'Tell them who you are',
    hint: 'A picture and a few words before the products.',
    sections: [
      { kind: 'banner', title: '', enabled: true, bodyText: '', buttonLabel: 'Shop now' },
      {
        kind: 'text',
        title: 'About us',
        enabled: true,
        align: 'center',
        text: 'Say a little about your shop here — how long you have been going, what you are known for.',
      },
      { kind: 'categories', title: 'Shop by department', enabled: true, maxItems: 0, tone: 'tinted' },
      { kind: 'products', title: 'Our products', enabled: true, source: 'newest', maxItems: 8 },
    ],
  },
]

/**
 * A date we are willing to store, as plain YYYY-MM-DD text.
 *
 * Shape-checked AND existence-checked: '2026-02-31' matches the pattern and is
 * not a day, and a window bounded by a date that never arrives is a section
 * that silently never appears. Round-tripping through Date and comparing the
 * text back is the cheapest way to reject it without inventing a calendar.
 *
 * Anything else becomes '' — no bound — because failing OPEN is right here.
 * A junk date that hid a section would be invisible; one that shows it is not.
 */
export function safeDate(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return ''
  // Parsed as UTC deliberately — this is a pure shape check on text that is
  // never itself compared as a moment, so no local-timezone shift can creep in.
  const parsed = new Date(`${raw}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? '' : raw
}

/**
 * Today where the SHOP is, as the same text the windows are stored in.
 *
 * Local, not UTC: a shop taking its Christmas banner down on the 26th means
 * the 26th on its own wall calendar. Reading a UTC date would take it down
 * hours early or late depending on which side of the line the shop sits.
 *
 * Same reasoning, and the same shape, as `wallClockNow` in site/specials.ts.
 */
export function shopToday(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Is this section inside its scheduled window today?
 *
 * Inclusive at BOTH ends: "show until the 25th" means the 25th is a day it
 * shows. An owner writing a date means that whole day — exclusive bounds are
 * how a banner disappears a day before anyone expected.
 *
 * Says nothing about `enabled`. The two are different questions: `enabled` is
 * "do I want this at all", the window is "when". A disabled section stays
 * hidden whatever its dates say, and the shop checks both.
 */
export function isScheduledNow(
  section: Pick<HomeSection, 'showFrom' | 'showUntil'>,
  asAt: string = shopToday(),
): boolean {
  const from = section.showFrom?.trim() ?? ''
  const until = section.showUntil?.trim() ?? ''
  if (from && asAt < from) return false
  if (until && asAt > until) return false
  return true
}

/* ── What publishing would change ─────────────────────────────────────────── */

/**
 * One line of "here is what shoppers will see change".
 *
 * `label` is the section as a person would name it, not its id — an id means
 * nothing to the owner reading this.
 */
export type LayoutChange = {
  kind: 'added' | 'removed' | 'moved' | 'edited' | 'shown' | 'hidden'
  label: string
  /** A few words on what specifically changed. Empty when the kind says it. */
  detail?: string
}

/** How a person would refer to this section. */
export function sectionName(section: HomeSection): string {
  return section.title.trim() || SECTION_LABEL[section.kind]
}

/**
 * What publishing this draft would actually change for shoppers.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Publish moves the live shop, and until now it did so with no summary at all.
 * On a page of twenty sections, an owner who spent an afternoon editing has no
 * way to check that the one thing they meant to change is the only thing that
 * did — and no way to notice that they left a section switched off at lunchtime
 * and never switched it back.
 *
 * ── IT COMPARES BY ID, NOT BY POSITION ───────────────────────────────────
 *
 * Position is the thing that changes most often. Diffing positionally would
 * report a section dragged from the bottom to the top as "every section
 * edited", which is noise that makes the whole summary worthless.
 *
 * ── SHOWN AND HIDDEN ARE THEIR OWN KINDS ─────────────────────────────────
 *
 * Rolled into "edited" they would be invisible, and they are the two changes
 * with the largest effect on what a shopper sees: a section appearing or
 * vanishing entirely. They earn their own words.
 */
export function describeLayoutChanges(
  published: HomeSection[],
  draft: HomeSection[],
): LayoutChange[] {
  const before = new Map(published.map((s) => [s.id, s]))
  const after = new Map(draft.map((s) => [s.id, s]))
  const changes: LayoutChange[] = []

  /*
   * ── A REPLACED PAGE IS NOT TWENTY ADDITIONS AND TWENTY REMOVALS ───────
   *
   * Applying a ready-made page builds every section fresh, so every id
   * changes even where the section is, to a reader, obviously the same one.
   * Reported literally that produces "New: Welcome banner" directly above
   * "Removed: Welcome banner", which is accurate and tells the owner nothing.
   *
   * So an addition and a removal that share a kind AND a name are collapsed
   * into whatever actually differs between them — usually nothing, in which
   * case neither is worth a line at all.
   *
   * Matched on kind+name rather than name alone: two sections can legitimately
   * share a blank title, and "Welcome banner" the hero is not "Welcome banner"
   * the picture banner.
   */
  const gone = published.filter((s) => !after.has(s.id))
  const fresh = draft.filter((s) => !before.has(s.id))
  const claimed = new Set<string>()

  for (const section of fresh) {
    const twin = gone.find(
      (g) =>
        !claimed.has(g.id) && g.kind === section.kind && sectionName(g) === sectionName(section),
    )
    if (!twin) {
      changes.push({ kind: 'added', label: sectionName(section) })
      continue
    }
    claimed.add(twin.id)
    // Same section by every measure a person cares about. Report only what
    // genuinely differs, and stay silent when nothing does.
    if (twin.enabled !== section.enabled) {
      changes.push({
        kind: section.enabled ? 'shown' : 'hidden',
        label: sectionName(section),
      })
    }
    const detail = changedFields(twin, section)
    if (detail) changes.push({ kind: 'edited', label: sectionName(section), detail })
  }

  for (const section of gone) {
    if (!claimed.has(section.id)) {
      changes.push({ kind: 'removed', label: sectionName(section) })
    }
  }

  for (const section of draft) {
    const was = before.get(section.id)
    if (!was) continue

    if (was.enabled !== section.enabled) {
      changes.push({
        kind: section.enabled ? 'shown' : 'hidden',
        label: sectionName(section),
      })
    }

    /*
     * Everything EXCEPT enabled, which is reported above and would otherwise
     * be counted twice. Compared as JSON over normalised sections, whose key
     * order is stable by construction — see normaliseSections.
     */
    const stripped = (s: HomeSection) => JSON.stringify({ ...s, enabled: true })
    if (stripped(was) !== stripped(section)) {
      changes.push({
        kind: 'edited',
        label: sectionName(section),
        detail: changedFields(was, section),
      })
    }
  }

  /*
   * Order, reported only for sections that still exist on BOTH sides.
   *
   * ── THE FEWEST SECTIONS THAT EXPLAIN THE REARRANGEMENT ────────────────
   *
   * Comparing positions pairwise reports every section a drag pushed past as
   * "moved" — dragging the last of three to the front reports three moves for
   * what a person did once, and a summary that overstates is one nobody
   * trusts.
   *
   * So: find the longest run that is already in the right relative order, and
   * report only the sections NOT in it. Those are exactly the ones that had to
   * be picked up, which is what the owner actually did. One drag, one line.
   *
   * Filtering to the common sections first is also load-bearing — otherwise
   * everything below an inserted section counts as displaced.
   */
  const commonBefore = published.filter((s) => after.has(s.id)).map((s) => s.id)
  const commonAfter = draft.filter((s) => before.has(s.id)).map((s) => s.id)
  const rank = new Map(commonBefore.map((id, i) => [id, i]))
  const stayed = longestIncreasingRun(commonAfter.map((id) => rank.get(id) ?? -1))

  for (const id of commonAfter) {
    if (stayed.has(rank.get(id) ?? -1)) continue
    const moved = after.get(id)
    if (moved) changes.push({ kind: 'moved', label: sectionName(moved) })
  }

  return changes
}

/**
 * Which values belong to the longest increasing subsequence — the ones that
 * never had to move.
 *
 * O(n log n) patience sorting. A page caps at 20 sections so a quadratic
 * version would also do, but this is the standard shape and no harder to read.
 */
function longestIncreasingRun(values: number[]): Set<number> {
  const tailIndex: number[] = []
  const previous = new Array<number>(values.length).fill(-1)

  for (let i = 0; i < values.length; i++) {
    let lo = 0
    let hi = tailIndex.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (values[tailIndex[mid]] < values[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[i] = tailIndex[lo - 1]
    tailIndex[lo] = i
    }

  const kept = new Set<number>()
  let cursor = tailIndex.length ? tailIndex[tailIndex.length - 1] : -1
  while (cursor !== -1) {
    kept.add(values[cursor])
    cursor = previous[cursor]
  }
  return kept
}

/** Which fields of a section actually differ, in the owner's words. */
function changedFields(was: HomeSection, now: HomeSection): string {
  const names: string[] = []
  const differs = (key: keyof HomeSection) =>
    JSON.stringify(was[key] ?? null) !== JSON.stringify(now[key] ?? null)

  if (differs('title')) names.push('heading')
  if (differs('tone')) names.push('background')
  if (differs('source')) names.push('what fills it')
  if (differs('departmentId')) names.push('department')
  if (differs('productIds')) names.push('the products in it')
  if (differs('maxItems')) names.push('how many')
  if (differs('layout')) names.push('how it looks')
  if (differs('cards')) names.push('cards')
  if (differs('imageId')) names.push('picture')
  if (differs('imageAlt')) names.push('picture description')
  if (differs('linkUrl') || differs('buttonLabel')) names.push('link')
  if (differs('bodyText') || differs('text')) names.push('words')
  if (differs('align')) names.push('alignment')
  if (differs('showFrom') || differs('showUntil')) names.push('when it shows')

  return names.join(', ')
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
      // Written for EVERY kind so the key order is identical whatever the
      // section is — see this function's header on why that matters.
      tone: String(s.tone) === 'tinted' ? 'tinted' : 'plain',
      // Anything that is not a plain YYYY-MM-DD becomes '' — "no bound" —
      // rather than being kept. A half-parsed date here would hide a section
      // the owner meant to show, which is the failure nobody notices.
      showFrom: safeDate(s.showFrom),
      showUntil: safeDate(s.showUntil),
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
      // Null is a real value here — "follow the shop" — so an unrecognised
      // layout becomes null rather than defaulting to a grid the owner never
      // chose.
      section.layout = s.layout === 'grid' || s.layout === 'list' ? s.layout : null
    }

    if (kind === 'categories') {
      section.maxItems = clampInt(s.maxItems, 0, MAX_SECTION_ITEMS, 0)
    }

    if (kind === 'banner') {
      const image = typeof s.imageId === 'number' ? s.imageId : Number(s.imageId)
      section.imageId = Number.isInteger(image) && image > 0 ? image : null
      section.imageAlt = String(s.imageAlt ?? '').slice(0, 190)
      // Through safeUrl: this lands in an href on a public page, so a
      // `javascript:` link here would be stored XSS on a shop that takes
      // payments. An in-shop path is allowed through separately — see
      // safeLinkTarget.
      section.linkUrl = safeLinkTarget(s.linkUrl).slice(0, 300)
      section.bodyText = String(s.bodyText ?? '').slice(0, 300)
      section.buttonLabel = String(s.buttonLabel ?? '').slice(0, 40)
    }

    if (kind === 'text') {
      section.text = String(s.text ?? '').slice(0, MAX_SECTION_TEXT)
      section.align = s.align === 'center' ? 'center' : 'left'
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
  /**
   * The shop's logo, from the same picture library the banners use.
   *
   * On the THEME rather than a section, because the masthead is on every page
   * — a logo that lived in the home-page layout would vanish the moment a
   * shopper opened a product. Null shows the shop's name as text, which is
   * what every existing shop keeps doing.
   */
  logoImageId: number | null
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

/**
 * Ready-made brand colours, so choosing one is a click rather than a colour
 * wheel.
 *
 * ── WHY THESE ARE HERE AND NOT TOKENS ────────────────────────────────────
 *
 * These are not the APP's colours — the app's live in globals.css and are
 * never written as hex outside it. This is a shop's own brand colour: a piece
 * of that store's DATA, stored in its settings row, validated by `safeColour`
 * above and injected into a public page. A design token cannot express it,
 * because the whole point is that every shop's is different.
 *
 * They live beside `safeColour` and `DEFAULT_BRAND_COLOUR` for that reason —
 * this file is already where storefront colour is decided.
 *
 * All mid-weight and all able to hold white text, which is the property the
 * storefront actually depends on: the brand colour ends up behind button
 * labels, and a pale one makes them unreadable. The free field stays, because
 * a shop with real brand colours must be able to type theirs.
 */
export const BRAND_SWATCHES = [
  DEFAULT_BRAND_COLOUR,
  '#0f766e',
  '#15803d',
  '#b45309',
  '#be123c',
  '#7c3aed',
  '#0369a1',
  '#334155',
] as const

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

/**
 * Where a banner is allowed to send a shopper.
 *
 * Wider than `safeUrl` because the common case is a link INSIDE the shop —
 * "shop the sale" pointing at a department — and those are relative paths that
 * `new URL()` cannot parse on its own.
 *
 * The rule for a relative path is deliberately narrow: it must start with a
 * single `/` and nothing else. That rejects `//evil.example`, which a browser
 * reads as a protocol-relative URL to another origin and would happily follow
 * — a banner that quietly points off-site is exactly the thing this guards.
 * Everything absolute still goes through safeUrl, so only http and https
 * survive.
 */
export function safeLinkTarget(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('/')) return raw.startsWith('//') ? '' : raw
  return safeUrl(raw)
}

type Row = Record<string, unknown>

export function readTheme(row: Row): StorefrontTheme {
  const logo = Number(row.logo_image_id)
  return {
    brandColour: safeColour(row.brand_colour),
    productLayout: String(row.product_layout) === 'list' ? 'list' : 'grid',
    logoImageId: Number.isInteger(logo) && logo > 0 ? logo : null,
    heroHeadline: String(row.hero_headline ?? ''),
    heroSubtext: String(row.hero_subtext ?? ''),
    footerAbout: String(row.footer_about ?? ''),
    footerHours: String(row.footer_hours ?? ''),
    socialFacebook: safeUrl(row.social_facebook),
    socialInstagram: safeUrl(row.social_instagram),
    socialWhatsapp: String(row.social_whatsapp ?? '').replace(/[^\d+]/g, '').slice(0, 20),
  }
}

