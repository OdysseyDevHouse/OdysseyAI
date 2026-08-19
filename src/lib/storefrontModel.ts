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

import {
  DEFAULT_AUTOPLAY_SECONDS,
  DEFAULT_CONSENT_TEXT,
  MAX_AUTOPLAY_SECONDS,
  MIN_AUTOPLAY_SECONDS,
  COLUMN_CHILD_KINDS,
  MAX_COLUMN_CHILDREN,
  SECTION_CATALOG,
  SECTION_KINDS,
  type SectionBackground,
  type SectionPadding,
  type SectionWidth,
  type ColumnGap,
  type ColumnStack,
  kindsFor as catalogKindsFor,
  MAX_SECTIONS,
  MAX_SECTION_CARDS,
  MAX_SECTION_ITEMS,
  MAX_SECTION_TEXT,
  PRODUCT_SOURCES,
  SPACE_SIZES,
  SPLIT_SIDES,
  type SectionDef,
  type SectionField,
} from './storefront/catalog'

/**
 * The section kinds. Declared in the catalog and re-exported here, so the
 * dependency runs one way only — see the note in storefront/catalog.ts.
 */
export { SECTION_KINDS } from './storefront/catalog'
export {
  SECTION_BACKGROUNDS,
  SECTION_PADDINGS,
  SECTION_WIDTHS,
  type SectionBackground,
  type SectionPadding,
  type SectionWidth,
  type ColumnGap,
  type ColumnStack,
} from './storefront/catalog'
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
export { PRODUCT_SOURCES } from './storefront/catalog'
export type ProductSource = (typeof PRODUCT_SOURCES)[number]

/**
 * The two rules that only mean anything on a PRODUCT page.
 *
 * Both are relative to "the product being looked at", which no other page has.
 * Offered on a front page they would resolve to nothing and the owner would
 * have no way to know why — so the builder hides them everywhere else, the
 * same way `kindsFor` hides the welcome banner off the home page.
 */
export const PRODUCT_PAGE_SOURCES: readonly ProductSource[] = ['together', 'sameDepartment']

/**
 * `sameDepartment` reads as "the department in hand" on BOTH kinds of page.
 *
 * On a product page that is the department the product sits in. On a department
 * page it is the department the page is attached to — which makes it the one
 * rule a department page can carry that survives being copied to another
 * department. Choosing `department` and picking Toys hard-codes Toys; the same
 * row built this way follows whichever page it lands on.
 *
 * 'together' stays product-only: "often bought with this" has no meaning when
 * there is no single "this".
 */
export function sourcesFor(pageKind: PageKind): readonly ProductSource[] {
  if (pageKind === 'product') return PRODUCT_SOURCES
  if (pageKind === 'department') return PRODUCT_SOURCES.filter((s) => s !== 'together')
  return PRODUCT_SOURCES.filter((s) => !PRODUCT_PAGE_SOURCES.includes(s))
}

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

/**
 * Rich text, as a TREE rather than as HTML.
 *
 * ── WHY NOT JUST STORE HTML ──────────────────────────────────────────────
 *
 * The plain `text` kind renders with `whitespace-pre-line` precisely because a
 * rich editor means pasted markup on a page that takes payments — that
 * reasoning is right and this does not abandon it. What it does is remove the
 * need for the choice.
 *
 * Nothing here is HTML. A block names one of six shapes and a span carries
 * plain text plus flags; the renderer is a switch that can only emit <h2>,
 * <h3>, <p>, <ul>/<li> and <strong>/<em>/<span>/<a>. There is no branch that
 * renders a tag name from data, so there is no input — however hostile — that
 * can produce one. Sanitising HTML is a thing you can get wrong; not having
 * HTML is not.
 *
 * ── THAT HOLDS FOR ALIGNMENT AND COLOUR TOO ──────────────────────────────
 *
 * Both are named choices validated against a fixed list, never values. The
 * renderer maps a name to a full class string it wrote itself; nothing an
 * owner types becomes a class, a style attribute or a colour. A `style="…"`
 * field would be the same mistake as storing HTML wearing a different hat —
 * `expression()` and `url(javascript:…)` are why CSS is not a safe thing to
 * accept either.
 *
 * `href` remains the one span property that reaches an attribute, and it still
 * goes through `safeLinkTarget`.
 */
export const RICH_BLOCK_TYPES = ['h2', 'h3', 'p', 'small', 'ul', 'ol'] as const
export type RichBlockType = (typeof RICH_BLOCK_TYPES)[number]

/**
 * How a line sits in its column.
 *
 * Per BLOCK rather than per section, because the thing an owner actually wants
 * is a centred heading over left-aligned paragraphs — one alignment for the
 * whole piece would make that impossible. Absent reads as 'left', so every
 * piece of writing saved before this existed keeps looking exactly as it did.
 *
 * 'justify' is deliberately not offered: justified text in a narrow column
 * opens rivers of whitespace, and the column here is `max-w-prose`.
 */
export const RICH_ALIGNS = ['left', 'center', 'right'] as const
export type RichAlign = (typeof RICH_ALIGNS)[number]

/**
 * What colour a span is, as a NAMED ROLE rather than a value.
 *
 * ── WHY NOT A COLOUR PICKER ──────────────────────────────────────────────
 *
 * The same reasoning `SECTION_TONES` gives, and it applies harder to text: a
 * free hex field is how a shop ends up with pale grey on white that nobody can
 * read, or a red that fights the brand on every other screen. These names map
 * to the theme's own tokens, so they stay legible in light AND dark — which a
 * stored `#333333` cannot do, because it is the same colour on both.
 *
 * It also means a shop that changes its brand colour changes its writing with
 * it, rather than leaving last season's blue hard-coded on the about page.
 *
 * 'default' is the absence of a choice, not a colour — it renders as the body
 * text colour the section already uses.
 */
export const RICH_COLOURS = ['default', 'brand', 'muted', 'success', 'warning', 'danger'] as const
export type RichColour = (typeof RICH_COLOURS)[number]

export type RichSpan = {
  text: string
  bold?: boolean
  italic?: boolean
  /**
   * The role this span's colour plays. Absent reads as 'default' — see
   * RICH_COLOURS on why this is a name and never a value.
   */
  colour?: RichColour
  /** Validated by safeLinkTarget. Empty means this span is not a link. */
  href?: string
}

export type RichBlock = {
  type: RichBlockType
  /**
   * For the paragraph-ish types, the spans of one paragraph. For 'ul' and
   * 'ol', each ITEM is its own block — a list is consecutive blocks of the
   * same type, not a block holding items.
   *
   * Flat rather than nested because the alternative is a tree with two depths
   * to normalise and two ways to be malformed, to express something the
   * renderer can reconstruct by grouping. See `groupRichBlocks`.
   *
   * SEVERAL spans is the normal case, not the exception: "call us on 021 555
   * 0000" with only the number bold is three spans. The editor splits and
   * re-joins them as the owner selects text; see `applyToSelection`.
   */
  spans: RichSpan[]
  /** How this line sits. Absent reads as 'left'. */
  align?: RichAlign
}

/**
 * What the tick box says when the owner has not written their own.
 *
 * A default rather than an empty field, because a sign-up form with no consent
 * line is the one thing this section must never be — see 071. It is plain, it
 * says who is emailing and why, and it says the way out.
 */
export { DEFAULT_CONSENT_TEXT } from './storefront/catalog'

/** One quote from a customer, written by the shop. */
export type Testimonial = {
  id: string
  quote: string
  author: string
  /** Where they are from, or what they bought. Optional. */
  detail: string
}

/**
 * Where a video comes from.
 *
 * An id and a provider, never an embed snippet. A shop pasting YouTube's
 * "copy embed code" hands over an <iframe> with attributes we would then have
 * to parse and vet — and the whole reason the rich-text kind stores a tree is
 * that vetting markup is a thing you can get wrong. The renderer builds the
 * iframe itself from a known-good URL template.
 */
export const VIDEO_PROVIDERS = ['youtube', 'vimeo'] as const
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number]

/**
 * How tall a spacer is.
 *
 * Three named steps, not a pixel field. A number box invites 7px, which does
 * nothing anybody can see, and 400px, which is a broken-looking page. The
 * names map to the same spacing scale the rest of the shop uses.
 */
export { SPACE_SIZES } from './storefront/catalog'
export type SpaceSize = (typeof SPACE_SIZES)[number]

/** Which side the picture sits on in a split section. */
export { SPLIT_SIDES } from './storefront/catalog'
export type SplitSide = (typeof SPLIT_SIDES)[number]

/**
 * One picture in a rotating banner.
 *
 * ── THE SAME FIELDS A BANNER SECTION HAS ─────────────────────────────────
 *
 * Deliberately, and named identically: a slide IS a banner, and the carousel
 * is a banner section that holds several. Keeping the shapes aligned is what
 * lets `BannerFace` draw both from one component — a slide with its own
 * vocabulary would have meant a second renderer, and a second renderer is a
 * second set of rules about scrims and buttons to keep in step.
 *
 * `heading` rather than `title` is the one difference, because `title` on a
 * section is the heading ABOVE it while these words sit OVER the picture.
 * Calling both `title` is how the two would get wired to the wrong one.
 */
export type BannerSlide = {
  /**
   * Stable identity, for the same reasons a section has one: it is the React
   * key and the drag key in the slide editor. Indexes remount every slide
   * below the one that moved.
   */
  id: string
  /** An id into `storefront_images`, NOT a path — see HomeSection.imageId. */
  imageId: number | null
  imageAlt: string
  heading: string
  bodyText: string
  buttonLabel: string
  linkUrl: string
}

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
  /**
   * The band this section sits on, how much room it takes, and how wide.
   *
   * Roles rather than colours — see SECTION_BACKGROUNDS. Absent reads as the
   * default on each, so every layout saved before these existed keeps looking
   * exactly as it did.
   */
  background?: SectionBackground
  padding?: SectionPadding
  width?: SectionWidth
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
  /** carousel: the pictures it rotates through, in order. */
  slides?: BannerSlide[]
  /**
   * carousel: seconds each slide is held before the next one.
   *
   * 0 means DO NOT rotate on its own — the shopper moves it with the arrows
   * and dots. That is a real choice, not an off switch: motion nobody asked
   * for is the standing complaint about carousels, and a shop with two slides
   * may well want both reachable without either moving under a reader's eye.
   *
   * Stored in whole seconds because that is what the owner is asked for; the
   * renderer converts. Milliseconds in the model would put a unit conversion
   * between the field and the value, which is where an off-by-1000 lives.
   */
  autoplaySeconds?: number
  /** text: the paragraph itself. */
  text?: string
  /** text: how the paragraph is aligned. */
  align?: 'left' | 'center'
  /** richtext: the blocks. Never HTML — see RichBlock. */
  blocks?: RichBlock[]
  /**
   * reviews: the lowest star rating worth putting on a page.
   *
   * A floor rather than "show everything approved". Approving a review means
   * "this is real", not "this is an advertisement" — see
   * `recentApprovedReviews` on why conflating the two would push shops to
   * reject honest criticism.
   */
  minRating?: number
  /**
   * countdown: the special this counts down to, or null for a typed date.
   *
   * Bound to a special by preference because a special has a real end and the
   * row disappears with it. A typed date is offered for shops not using
   * specials, and it is the version that can outlive the thing it advertises.
   */
  specialId?: number | null
  /** countdown: the moment it counts to, as local wall-clock text. */
  endsAt?: string
  /** countdown: what to say once it has passed. Empty hides the section. */
  finishedText?: string
  /** testimonial: the quotes. */
  quotes?: Testimonial[]
  /** logos: the pictures, from the same library banners use. */
  logoImageIds?: number[]
  /** video: where it comes from and which one. */
  videoProvider?: VideoProvider
  videoId?: string
  /** map: what to show, and where "directions" goes. */
  addressText?: string
  mapUrl?: string
  /** spacer: how much room. */
  size?: SpaceSize
  /**
   * signup: the wording beside the tick box.
   *
   * Stored ON THE SECTION and copied onto every subscriber row at the moment
   * they agree — see 071. An owner who reworders this changes what FUTURE
   * subscribers consented to, and the rows already written keep the words that
   * were actually on screen when each of them ticked it.
   */
  consentText?: string
  /** signup: what it says once they have signed up. */
  thanksText?: string
  /** split: the picture beside the words, and which side it sits on. */
  side?: SplitSide
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
  /**
   * columns: how many, how far apart, and when they stack.
   *
   * Only ever set on kind `columns`.
   */
  columnCount?: number
  columnGap?: ColumnGap
  columnStack?: ColumnStack
  /**
   * columns: what is IN each column, in order.
   *
   * ── ONE LEVEL, AND THE TYPE CANNOT SAY SO ────────────────────────────
   *
   * `HomeSection[][]` permits a column holding another `columns` section,
   * because the type is recursive even though the feature is not. The depth
   * rule lives in `normaliseSections`, which refuses a child of kind
   * `columns` BEFORE it recurses — so there is no path to a third level
   * however a payload is shaped, and no counter that can be got wrong.
   *
   * A child is an ordinary section in every other respect: it has its own id,
   * its own schedule, its own band. That is what keeps the publish diff, the
   * version history and the drag layer working on it unchanged.
   */
  columns?: HomeSection[][]
}

/** Hard caps, enforced on WRITE. A draft is untrusted. */
export { MAX_SECTIONS } from './storefront/catalog'
export { MAX_SECTION_ITEMS } from './storefront/catalog'
export { MAX_SECTION_CARDS } from './storefront/catalog'
/** A paragraph, not an essay — the front page is a shop window. */
export { MAX_SECTION_TEXT } from './storefront/catalog'
/**
 * How many pictures one rotating banner may hold.
 *
 * Low on purpose. Every slide past the first is one a shopper will probably
 * never see — they scroll before it comes round — while costing a full-width
 * image on the shop's slowest page. Eight is already generous; the cap exists
 * so a page cannot be made to hold fifty.
 */
export const MAX_SLIDES = 8
/**
 * The slowest and fastest rotation an owner may set, in seconds.
 *
 * Four at the bottom because anything quicker is unreadable — a shopper who
 * has to finish a sentence cannot, and one who uses the arrows loses their
 * place. Thirty at the top because beyond that the second slide may as well
 * not exist. 0 sits outside the range and means "do not rotate".
 */
export {
  MIN_AUTOPLAY_SECONDS,
  MAX_AUTOPLAY_SECONDS,
  DEFAULT_AUTOPLAY_SECONDS,
} from './storefront/catalog'
/** Blocks in one piece of formatted writing, and characters in one span. */
export const MAX_RICH_BLOCKS = 60
export const MAX_RICH_SPANS = 20
export const MAX_SPAN_TEXT = 600
/** Quotes in one testimonial section, and logos in one strip. */
export const MAX_QUOTES = 12
export const MAX_LOGOS = 16

/**
 * The palette label and its one-line hint, per kind.
 *
 * Derived from SECTION_CATALOG rather than restated here: two lists of the
 * same nineteen strings is one list that goes stale, and the stale copy is
 * whichever one the next person does not open.
 */
export const SECTION_LABEL: Record<SectionKind, string> = Object.fromEntries(
  SECTION_KINDS.map((kind) => [kind, SECTION_CATALOG[kind].label]),
) as Record<SectionKind, string>

export const SECTION_HINT: Record<SectionKind, string> = Object.fromEntries(
  SECTION_KINDS.map((kind) => [kind, SECTION_CATALOG[kind].hint]),
) as Record<SectionKind, string>

export const SOURCE_LABEL: Record<ProductSource, string> = {
  manual: 'Products I pick',
  department: 'Everything in a department',
  newest: 'Newest products',
  special: 'Whatever is on special',
  popular: 'Best sellers',
  together: 'Often bought with this',
  sameDepartment: 'More from the same department',
}

/** What each rule does, spelled out where the owner chooses it. */
export const SOURCE_HINT: Record<ProductSource, string> = {
  manual: 'The row shows exactly what you choose, in your order.',
  department: 'Everything published in one department.',
  newest: 'The products you added most recently.',
  special: 'Fills itself from your live specials, and empties when they end.',
  popular: 'What has sold most over the last 90 days.',
  together:
    'Worked out from real baskets over the last 90 days. Empty until this product has sold alongside something.',
  sameDepartment: 'Other products from whichever department this one is in.',
}

/**
 * The label and hint for one rule, on the page actually being edited.
 *
 * `sameDepartment` is the only rule that means two different things: on a
 * product page it is "the department this product is in", on a department page
 * it is "this department". One wording covering both would be vague on both,
 * and the owner is choosing here — this is the moment the words have to be
 * exact.
 */
export function describeSource(
  source: ProductSource,
  pageKind: PageKind,
): { label: string; hint: string } {
  if (source === 'sameDepartment' && pageKind === 'department') {
    return {
      label: 'Everything in this department',
      hint: 'Follows the department this page is attached to, so the row stays right if you build the same page for another department.',
    }
  }
  return { label: SOURCE_LABEL[source], hint: SOURCE_HINT[source] }
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
    key: 'showcase',
    name: 'Rotating pictures',
    hint: 'Several banners turning at the top — for a shop with promotions to show.',
    sections: [
      /*
       * Three EMPTY slides, deliberately.
       *
       * A preset cannot know which pictures a shop has, and inventing slides
       * with no pictures would produce a section that draws nothing — the very
       * thing the publish warning exists to catch. Empty slides make the shape
       * of the thing obvious in the builder ("oh, three pictures go here")
       * while the placeholder says exactly what to do next.
       */
      {
        kind: 'carousel',
        title: '',
        enabled: true,
        autoplaySeconds: DEFAULT_AUTOPLAY_SECONDS,
        slides: [
          { id: 'a', imageId: null, imageAlt: '', heading: '', bodyText: '', buttonLabel: 'Shop now', linkUrl: '' },
          { id: 'b', imageId: null, imageAlt: '', heading: '', bodyText: '', buttonLabel: '', linkUrl: '' },
          { id: 'c', imageId: null, imageAlt: '', heading: '', bodyText: '', buttonLabel: '', linkUrl: '' },
        ],
      },
      { kind: 'categories', title: 'Shop by department', enabled: true, maxItems: 0 },
      {
        kind: 'products',
        title: 'This week’s specials',
        enabled: true,
        source: 'special',
        maxItems: 8,
        tone: 'tinted',
      },
      { kind: 'products', title: 'New in', enabled: true, source: 'newest', maxItems: 8 },
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
    key: 'trust',
    name: 'Win them over',
    hint: 'Proof first — real reviews, then who you are. For a shop nobody knows yet.',
    sections: [
      { kind: 'hero', title: '', enabled: true, tone: 'tinted' },
      { kind: 'products', title: 'New in', enabled: true, source: 'newest', maxItems: 8 },
      /*
       * The reviews row is deliberately in a preset even though it starts
       * empty for a new shop — which is exactly the shop that picks this one.
       * It fills itself as reviews are approved, and having the slot already
       * on the page is how an owner discovers the feature exists.
       */
      { kind: 'reviews', title: 'What customers say', enabled: true, maxItems: 6, minRating: 4 },
      {
        kind: 'split',
        title: 'Our story',
        enabled: true,
        side: 'left',
        bodyText: 'Say a little about your shop here — how long you have been going, what you are known for.',
        buttonLabel: '',
        linkUrl: '',
      },
      {
        kind: 'signup',
        title: 'Keep in touch',
        enabled: true,
        tone: 'tinted',
        bodyText: 'News, offers and what is fresh — straight to your inbox.',
        buttonLabel: 'Sign up',
        consentText: DEFAULT_CONSENT_TEXT,
      },
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

/* ── Rich text ────────────────────────────────────────────────────────────── */

/**
 * Consecutive list items folded into one list, everything else left alone.
 *
 * The model stores each `ul`/`ol` item as its own block — see RichBlock on why
 * flat beats nested — so the renderer needs the runs back to wrap them in a
 * single <ul>. Doing it here rather than in the markup means the builder's
 * preview and the shop group identically, which is the whole bargain.
 */
export function groupRichBlocks(
  blocks: RichBlock[],
): { type: RichBlockType; align: RichAlign; items: RichBlock[] }[] {
  const out: { type: RichBlockType; align: RichAlign; items: RichBlock[] }[] = []
  for (const block of blocks) {
    const align = block.align ?? 'left'
    const last = out[out.length - 1]
    const isList = block.type === 'ul' || block.type === 'ol'
    /*
     * Alignment breaks a run as surely as a change of type does.
     *
     * A <ul> carries its alignment once, on the list — so folding a centred
     * item in beside left-aligned ones would have to drop one of the two
     * choices, and the owner would see their centring silently ignored. A run
     * that changes alignment becomes two lists, which is what was asked for.
     */
    if (isList && last && last.type === block.type && last.align === align) {
      last.items.push(block)
      continue
    }
    out.push({ type: block.type, align, items: [block] })
  }
  return out
}

/** Do two spans differ in any way other than their text? */
export function sameRichFormatting(a: RichSpan, b: RichSpan): boolean {
  return (
    (a.bold === true) === (b.bold === true) &&
    (a.italic === true) === (b.italic === true) &&
    (a.colour ?? 'default') === (b.colour ?? 'default') &&
    (a.href ?? '') === (b.href ?? '')
  )
}

/**
 * Neighbouring spans that look identical, folded back into one. Empty spans go.
 *
 * ── WHY THIS IS NOT COSMETIC ─────────────────────────────────────────────
 *
 * Formatting a SELECTION splits a span into up to three. Bold a word, un-bold
 * it, bold it again and the block accumulates fragments that render
 * identically — and `MAX_RICH_SPANS` is 20, enforced by truncation. Without
 * this, an afternoon of ordinary editing silently drops the end of a
 * paragraph, which is the worst kind of data loss: invisible until published.
 *
 * It also keeps the "unsaved changes" check honest. The builder compares JSON,
 * so two spellings of the same paragraph would read as an edit that no amount
 * of saving clears — the same trap `normaliseSections` documents about key
 * order.
 *
 * Runs on WRITE as well as in the editor, because a draft is untrusted and a
 * hand-made payload can arrive pre-fragmented.
 */
export function mergeAdjacentSpans(block: RichBlock): RichBlock {
  const out: RichSpan[] = []
  for (const span of block.spans) {
    // A zero-length span is invisible but still counts against the cap.
    if (span.text === '') continue
    const last = out[out.length - 1]
    if (last && sameRichFormatting(last, span)) {
      last.text = `${last.text}${span.text}`.slice(0, MAX_SPAN_TEXT)
      continue
    }
    out.push({ ...span })
  }
  /*
   * One empty span rather than none for a block that has been emptied: the
   * editor reads `spans[0]` for the textarea's value, and a block with no
   * spans at all would render an uncontrolled input. `richBlockHasText` still
   * reports it as empty, so it never reaches the shop.
   */
  return { ...block, spans: out.length ? out : [{ text: '' }] }
}

/**
 * Apply a formatting change to ONE RANGE of a block's text.
 *
 * ── WHY THE MODEL AND NOT THE EDITOR ─────────────────────────────────────
 *
 * This is the whole of selection formatting, and it is fiddly in the way that
 * off-by-one bugs love: three-way splits, ranges that span several spans,
 * ranges that land exactly on a boundary. Living here it can be tested against
 * plain data, with no textarea and no browser — which is the difference
 * between "it looked right when I clicked it" and knowing.
 *
 * `from` and `to` are offsets into the block's PLAIN TEXT — what
 * `richBlockText` returns, and exactly what a textarea reports for its
 * selection. That is the contract: the editor never has to know how the text
 * is divided into spans, and this never has to know about the DOM.
 *
 * A collapsed range (from === to) is a no-op rather than an error: it is what
 * a click with no drag produces, and the editor calls this on every toolbar
 * press.
 */
export function applyToSelection(
  block: RichBlock,
  from: number,
  to: number,
  changes: Partial<Omit<RichSpan, 'text'>>,
): RichBlock {
  const start = Math.max(0, Math.min(from, to))
  const end = Math.min(richBlockText(block).length, Math.max(from, to))
  if (start >= end) return block

  const out: RichSpan[] = []
  let cursor = 0

  for (const span of block.spans) {
    const spanStart = cursor
    const spanEnd = cursor + span.text.length
    cursor = spanEnd

    // Entirely outside the selection — kept exactly as it was.
    if (spanEnd <= start || spanStart >= end) {
      out.push(span)
      continue
    }

    /*
     * Split into up to three: the part before the selection, the selected
     * part with the change applied, and the part after. Either end may be
     * empty when the selection lines up with a boundary, and mergeAdjacentSpans
     * drops those — which is why this does not need to check.
     */
    const localStart = Math.max(0, start - spanStart)
    const localEnd = Math.min(span.text.length, end - spanStart)

    out.push({ ...span, text: span.text.slice(0, localStart) })
    out.push({ ...span, ...changes, text: span.text.slice(localStart, localEnd) })
    out.push({ ...span, text: span.text.slice(localEnd) })
  }

  return mergeAdjacentSpans({ ...block, spans: out })
}

/**
 * Replace a block's whole text, keeping the formatting that still applies.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────
 *
 * The editor is a plain textarea over a block that may hold several formatted
 * spans. Typing gives back one flat string with no idea which parts were bold
 * — so the naive `spans: [{ text }]` throws away every piece of formatting in
 * the paragraph the moment the owner fixes a typo. That is not a limitation an
 * owner would report; it is one they would just find infuriating.
 *
 * So the common edit is handled precisely: text inserted or removed in ONE
 * place, which is what typing, pasting and deleting a selection all are. The
 * unchanged head and tail keep their spans and the change is absorbed by
 * whichever span it landed in.
 *
 * The head/tail scan compares CODE UNITS, so an emoji or an accented character
 * edited mid-paragraph can in principle shift a boundary by one unit. The
 * result is still valid — every span keeps its flags and the text is exactly
 * what was typed — so the worst case is one character taking its neighbour's
 * formatting, not corruption.
 */
export function replaceBlockText(block: RichBlock, text: string): RichBlock {
  const before = richBlockText(block)
  if (text === before) return block

  // Cleared entirely — nothing to carry over, and one empty span is the shape
  // the editor expects.
  if (text === '') return { ...block, spans: [{ text: '' }] }

  // How much of the start and end survived untouched.
  let head = 0
  const maxHead = Math.min(before.length, text.length)
  while (head < maxHead && before[head] === text[head]) head++

  let tail = 0
  const maxTail = Math.min(before.length, text.length) - head
  while (tail < maxTail && before[before.length - 1 - tail] === text[text.length - 1 - tail]) tail++

  const removedEnd = before.length - tail
  const inserted = text.slice(head, text.length - tail)

  const out: RichSpan[] = []
  let cursor = 0
  let placed = false

  for (const span of block.spans) {
    const spanStart = cursor
    const spanEnd = cursor + span.text.length
    cursor = spanEnd

    const keptStart = span.text.slice(0, Math.max(0, Math.min(span.text.length, head - spanStart)))
    const keptEnd = span.text.slice(
      Math.max(0, Math.min(span.text.length, removedEnd - spanStart)),
    )

    /*
     * The inserted text joins the FIRST span the change touches, so typing at
     * the end of a bold word extends the bold rather than starting a plain
     * run — which is what every editor does and what a writer expects.
     */
    const takesInsert = !placed && spanEnd >= head
    if (takesInsert) placed = true

    const merged = `${keptStart}${takesInsert ? inserted : ''}${keptEnd}`
    if (merged !== '') out.push({ ...span, text: merged })
  }

  // Every span was dropped — the change replaced the lot — so the new text
  // becomes one span carrying the first span's formatting.
  if (!placed || out.length === 0) {
    return { ...block, spans: [{ ...(block.spans[0] ?? {}), text }] }
  }

  return mergeAdjacentSpans({ ...block, spans: out })
}

/** Does this rich block carry any words at all? */
export function richBlockHasText(block: RichBlock): boolean {
  return block.spans.some((s) => s.text.trim() !== '')
}

/** The plain words of a rich block — for a summary row, never for rendering. */
export function richBlockText(block: RichBlock): string {
  return block.spans.map((s) => s.text).join('')
}

/* ── Countdown ────────────────────────────────────────────────────────────── */

/**
 * Now, as the same local wall-clock text a countdown's deadline is stored in.
 *
 * 'YYYY-MM-DDTHH:mm' compares correctly as a string, which is how the specials
 * engine already decides whether a special is running — see 057's note on why
 * these are not DATETIME columns. Comparing text keeps the shop on ITS OWN
 * clock: a sale ending at 5pm ends at 5pm where the shop is, not at some UTC
 * boundary a timezone away.
 */
export function wallClockNow(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  )
}

/**
 * A deadline we are willing to store: 'YYYY-MM-DDTHH:mm', or ''.
 *
 * Shape-checked and existence-checked, exactly as `safeDate` is, and for the
 * same reason — '2026-02-31T10:00' matches the pattern and is not a moment.
 */
export function safeDateTime(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return ''
  const parsed = new Date(`${raw}:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== raw ? '' : raw
}

/* ── Would a section draw anything? ───────────────────────────────────────── */

/**
 * What a section needs before it can draw: whatever the server resolved for it.
 *
 * Structurally the same as the storefront's `SectionContent`, restated here
 * without importing it — that type lives in a component file that pulls in
 * next/link, and this module must stay free of anything a plain script or a
 * server-only context cannot load.
 */
export type SectionFill = {
  section: HomeSection
  products?: unknown[]
  departments?: unknown[]
  image?: unknown
  /**
   * carousel: the resolved picture for each slide, keyed by image id.
   *
   * A MAP rather than an array parallel to `slides`, because a slide whose
   * picture was deleted has to resolve to nothing without shifting every slide
   * after it — which is exactly what a positional array does the moment one
   * entry is dropped.
   */
  slideImages?: Map<number, unknown>
  /** reviews: the approved reviews the server resolved for this section. */
  reviews?: unknown[]
  /**
   * logos: the pictures that still resolve, keyed by id.
   *
   * A map for the same reason a carousel's is: a logo whose picture was
   * deleted has to vanish without shifting the ones after it, which is exactly
   * what a positional array does when one entry drops.
   */
  logoImages?: Map<number, unknown>
}

/**
 * The slides that would actually draw, with their pictures.
 *
 * ── ONE DEFINITION, THREE CALLERS ────────────────────────────────────────
 *
 * The shop rotates these, `sectionIsEmpty` counts them, and the builder's
 * placeholder explains why there are none. Stating "a slide needs a picture
 * that still resolves" three times is how the shop ends up rotating through a
 * blank frame that the builder swore was fine.
 *
 * A slide whose picture was deleted is DROPPED, not drawn empty: the carousel
 * then rotates through what is left, which is the same forgiving behaviour a
 * single banner has when its picture goes — see storefrontImages.
 */
export function liveSlides<T>(
  section: Pick<HomeSection, 'slides'>,
  images: Map<number, T> | undefined,
): { slide: BannerSlide; image: T }[] {
  const out: { slide: BannerSlide; image: T }[] = []
  for (const slide of section.slides ?? []) {
    if (!slide.imageId) continue
    const image = images?.get(slide.imageId)
    if (image === undefined || image === null) continue
    out.push({ slide, image })
  }
  return out
}

/**
 * Would this section draw anything at all?
 *
 * ── ONE RULE, FOUR CALLERS ───────────────────────────────────────────────
 *
 * The shop renders by it, the builder's placeholder is keyed off it, the shop
 * page decides whether to fall back to the catalogue with it, and the
 * pre-publish warning counts with it.
 *
 * It used to be four separate statements of the same idea — and a mirror is
 * correct only until someone adds a kind and updates one copy, with a silent
 * failure: a shopper sees an empty heading, or an owner is told their page is
 * broken when it is fine.
 *
 * ── AND WHY IT IS HERE ───────────────────────────────────────────────────
 *
 * In the model rather than beside the markup, because the publish summary has
 * to ask the question WITHOUT rendering — counting dead sections by drawing a
 * whole storefront would be absurd — and because a test must be able to import
 * it without dragging next/link into a react-server script.
 */
export function sectionIsEmpty(fill: SectionFill, theme: StorefrontTheme): boolean {
  const def = SECTION_CATALOG[fill.section.kind]
  // A kind this build cannot draw. Normalisation drops these before they are
  // ever stored, so reaching here means something is very wrong — "empty" is
  // the safe answer either way.
  if (!def) return true
  return def.isEmpty({
    section: fill.section,
    products: fill.products,
    departments: fill.departments,
    image: fill.image,
    slideImages: fill.slideImages,
    reviews: fill.reviews,
    logoImages: fill.logoImages,
    heroHeadline: theme.heroHeadline,
    heroSubtext: theme.heroSubtext,
    // Passed as thunks rather than values so a kind that does not ask pays
    // nothing — liveSlides walks every slide, and eighteen kinds never need it.
    liveSlideCount: () => liveSlides(fill.section, fill.slideImages).length,
    hasRichText: () => (fill.section.blocks ?? []).some(richBlockHasText),
    now: wallClockNow,
  })
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
 * Every section on a page, including the ones inside a column.
 *
 * ── WHY THIS IS NOT OPTIONAL ─────────────────────────────────────────────
 *
 * A child of a column is an ordinary section: it has an id, a schedule, a
 * picture that may have no description. Anything that walks a page and does
 * NOT walk into columns is silently wrong about half of it — the publish
 * warning misses an undescribed banner, and the change summary reports a page
 * as unedited when a column’s contents moved.
 *
 * Both of those were true when the columns block first landed, which is why
 * this exists rather than each caller nesting its own loop.
 *
 * One level, because that is all there is — `normaliseSections` refuses a
 * column inside a column before it recurses.
 */
export function flattenSections(sections: HomeSection[]): HomeSection[] {
  const out: HomeSection[] = []
  for (const section of sections) {
    out.push(section)
    for (const column of section.columns ?? []) out.push(...column)
  }
  return out
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
  /*
   * Flattened, so a change inside a column is a change to the page.
   *
   * Comparing only the top level reported a page as unedited when a column’s
   * contents had moved — the one summary an owner reads before publishing,
   * quietly wrong about the part they had just been working on.
   */
  const before = new Map(flattenSections(published).map((s) => [s.id, s]))
  const after = new Map(flattenSections(draft).map((s) => [s.id, s]))
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

  for (const section of flattenSections(draft)) {
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
  /*
   * A carousel's slides as ONE line rather than a field-by-field breakdown.
   *
   * "pictures" covers a slide added, removed, reordered or reworded, because
   * to the owner reading the summary those are all "I changed the banners" —
   * and enumerating six slides' worth of differences would bury the rest of
   * the page's changes under one section's detail.
   */
  if (differs('slides')) names.push('pictures')
  if (differs('autoplaySeconds')) names.push('how fast it turns')
  if (differs('align')) names.push('alignment')
  if (differs('blocks')) names.push('the writing')
  if (differs('minRating')) names.push('which reviews')
  if (differs('specialId') || differs('endsAt')) names.push('the deadline')
  if (differs('finishedText')) names.push('what it says when it ends')
  if (differs('quotes')) names.push('quotes')
  if (differs('logoImageIds')) names.push('logos')
  if (differs('videoProvider') || differs('videoId')) names.push('the video')
  if (differs('addressText') || differs('mapUrl')) names.push('the address')
  if (differs('size')) names.push('the gap')
  if (differs('side')) names.push('which side')
  if (differs('showFrom') || differs('showUntil')) names.push('when it shows')

  return names.join(', ')
}

const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * Apply one declared field to the section being built.
 *
 * One coercion per field TYPE, rather than one branch per section kind. That
 * is the whole point: there is no per-kind branch left that could forget a
 * field, write it in the wrong order, or coerce it differently from the way
 * the same field is coerced on another kind.
 */
function applyField(
  section: HomeSection,
  field: SectionField,
  s: Record<string, unknown>,
): void {
  const raw = s[field.key]
  const target = section as Record<string, unknown>

  switch (field.type) {
    case 'text':
      target[field.key] = String(raw ?? '').slice(0, field.max)
      return
    case 'textOrDefault':
      target[field.key] = String(raw ?? '').slice(0, field.max) || field.fallback
      return
    case 'link':
      target[field.key] = safeLinkTarget(raw).slice(0, field.max)
      return
    case 'url':
      target[field.key] = safeUrl(raw).slice(0, field.max)
      return
    case 'idChars':
      target[field.key] = String(raw ?? '')
        .trim()
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, field.max)
      return
    case 'int':
      target[field.key] = clampInt(raw, field.min, field.max, field.fallback)
      return
    case 'ref': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      target[field.key] = Number.isInteger(n) && n > 0 ? n : null
      return
    }
    case 'refList':
      target[field.key] = Array.isArray(raw)
        ? [
            ...new Set(
              raw
                .map((v) => (typeof v === 'number' ? v : Number(v)))
                .filter((v) => Number.isInteger(v) && v > 0),
            ),
          ].slice(0, field.max)
        : []
      return
    case 'choice': {
      const value = String(raw ?? field.fallback)
      target[field.key] = field.of.includes(value) ? value : field.fallback
      return
    }
    case 'choiceOrNull': {
      const value = String(raw ?? '')
      target[field.key] = field.of.includes(value) ? value : null
      return
    }
    case 'date':
      target[field.key] = safeDate(raw)
      return
    case 'dateTime':
      target[field.key] = safeDateTime(raw)
      return
  }
}

/**
 * Coerce whatever arrived into the exact shape we store.
 *
 * Key order matters as well as content: the builder decides whether it has
 * unsaved changes by comparing JSON, so the browser's copy and the server's
 * must serialise identically. Spreading the input would preserve whatever key
 * order it happened to have and show a permanent "unsaved changes" that no
 * amount of saving clears.
 *
 * ── WHY THE FIELDS ARE WALKED, NOT BRANCHED ─────────────────────────────
 *
 * This used to be sixteen `if (kind === …)` blocks. The order a field was
 * written in was then a property of where somebody happened to type it, and
 * the failure was silent in both directions: a field written on one kind and
 * not another produced the permanent unsaved-changes badge, and a field nobody
 * remembered to coerce reached storage untouched. Walking the declared list
 * makes the order a stated fact and leaves no branch to forget.
 *
 * The list-shaped values keep their own code below: a carousel's slides, rich
 * text's block tree, quotes, logos and cards each need per-item de-duplication
 * and their own rules, and a field type expressive enough to describe them
 * would be a worse language than the code it replaced.
 */
export function normaliseSections(input: unknown): HomeSection[] {
  /*
   * ── ONE BUDGET, SHARED BY EVERY LEVEL ─────────────────────────────────
   *
   * `MAX_SECTIONS` has to bound the PAGE, not each level of it. A per-level
   * cap would let a payload hold 20 columns x 3 columns x 4 children = 240
   * sections and satisfy every check on the way in. The budget is passed
   * down and spent by children as well as by top-level sections.
   */
  const budget = { left: MAX_SECTIONS }
  const seenIds = new Set<string>()
  return walk(input, budget, seenIds, false)
}

/**
 * One level of sections.
 *
 * `inColumn` is the depth rule and the whole of it: a child of a column may
 * not itself be a column, checked BEFORE anything recurses. There is no
 * counter to get wrong and no payload shape that reaches a third level.
 */
function walk(
  input: unknown,
  budget: { left: number },
  seenIds: Set<string>,
  inColumn: boolean,
): HomeSection[] {
  const list = Array.isArray(input) ? input : []
  const out: HomeSection[] = []


  for (const raw of list) {
    if (budget.left <= 0) break
    if (!raw || typeof raw !== 'object') continue

    const s = raw as Record<string, unknown>
    const kind = String(s.kind ?? '')
    // A kind this build cannot draw never reaches the preview or the shop.
    const def = (SECTION_CATALOG as Record<string, SectionDef | undefined>)[kind]
    if (!def) continue

    /*
     * Inside a column, only what belongs there.
     *
     * `columns` is absent from COLUMN_CHILD_KINDS, so this is the depth cap —
     * structural rather than counted. The rest of the list is a separate
     * judgement: a carousel in a third of a column looks fine in the builder
     * and reads as broken on a phone.
     */
    if (inColumn && !COLUMN_CHILD_KINDS.includes(kind as SectionKind)) continue

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

    // The declared fields, in the declared order.
    for (const field of def.fields) applyField(section, field, s)

    if (kind === 'carousel') {
      const seenSlideIds = new Set<string>()
      section.slides = (Array.isArray(s.slides) ? s.slides : [])
        .slice(0, MAX_SLIDES)
        .map((raw, index) => {
          const slide = (raw ?? {}) as Record<string, unknown>
          const image = typeof slide.imageId === 'number' ? slide.imageId : Number(slide.imageId)

          // Same reasoning as a section id: two slides sharing one would share
          // a React key and a drag handle in the editor.
          let id = String(slide.id ?? '').slice(0, 40) || `sl-${index}`
          while (seenSlideIds.has(id)) id = `${id}-${index}`
          seenSlideIds.add(id)

          return {
            id,
            imageId: Number.isInteger(image) && image > 0 ? image : null,
            imageAlt: String(slide.imageAlt ?? '').slice(0, 190),
            heading: String(slide.heading ?? '').slice(0, 80),
            bodyText: String(slide.bodyText ?? '').slice(0, 300),
            buttonLabel: String(slide.buttonLabel ?? '').slice(0, 40),
            // Through safeLinkTarget, exactly as a banner's is: this lands in
            // an href on a public page that takes payments, and a slide is no
            // less public for being one of several. The single-banner branch
            // is the precedent, and the reason this must not be a plain
            // String() — a `javascript:` link here would be stored XSS.
            linkUrl: safeLinkTarget(slide.linkUrl).slice(0, 300),
          }
        })

      /*
       * 0 is a real value — "do not rotate on its own" — so it cannot be
       * clamped into the range like an out-of-bounds number. Anything else
       * unusable becomes the default rather than 0, because silently switching
       * rotation OFF is the failure an owner would not spot: the shop looks
       * like a plain banner and nothing says why.
       */
      const seconds = Math.round(Number(s.autoplaySeconds))
      section.autoplaySeconds = !Number.isFinite(seconds)
        ? DEFAULT_AUTOPLAY_SECONDS
        : seconds <= 0
          ? 0
          : Math.min(Math.max(seconds, MIN_AUTOPLAY_SECONDS), MAX_AUTOPLAY_SECONDS)
    }

    if (kind === 'richtext') {
      /*
       * Every block's type is checked against the known list and every span is
       * reduced to text plus named flags. Nothing here can carry a tag name, a
       * class or a colour VALUE, so nothing downstream can render one — see
       * RichBlock.
       *
       * Alignment and colour are checked the same way and fall back to the
       * neutral choice, which fails SAFE in the way that matters: an
       * unrecognised colour renders as ordinary body text, never as something
       * invisible against the background.
       */
      section.blocks = (Array.isArray(s.blocks) ? s.blocks : [])
        .slice(0, MAX_RICH_BLOCKS)
        .map((raw) => {
          const block = (raw ?? {}) as Record<string, unknown>
          const type = String(block.type ?? 'p')
          const align = String(block.align ?? 'left')
          return {
            type: (RICH_BLOCK_TYPES as readonly string[]).includes(type)
              ? (type as RichBlockType)
              : 'p',
            /*
             * MERGED FIRST, CAPPED SECOND.
             *
             * The other way round loses words: a paragraph that arrives as 40
             * identical fragments — which ordinary editing produces, and which
             * merges down to one span — would be truncated to 20 and lose its
             * second half before anything looked at whether the pieces were
             * distinct. The cap exists to bound how many DIFFERENT runs of
             * formatting one paragraph holds, and that question can only be
             * answered after merging.
             */
            spans: mergeAdjacentSpans({
              type: 'p',
              spans: (Array.isArray(block.spans) ? block.spans : [])
                // A generous bound before the merge, so a hostile payload of a
                // million fragments is not walked in full.
                .slice(0, MAX_RICH_BLOCKS * MAX_RICH_SPANS)
                .map((rawSpan) => {
                  const span = (rawSpan ?? {}) as Record<string, unknown>
                  const href = safeLinkTarget(span.href).slice(0, 300)
                  const colour = String(span.colour ?? 'default')
                  return {
                    text: String(span.text ?? '').slice(0, MAX_SPAN_TEXT),
                    bold: span.bold === true,
                    italic: span.italic === true,
                    // Written unconditionally so the key order is stable — see
                    // this function's header on why that matters.
                    colour: (RICH_COLOURS as readonly string[]).includes(colour)
                      ? (colour as RichColour)
                      : 'default',
                    href,
                  }
                }),
            }).spans.slice(0, MAX_RICH_SPANS),
            align: (RICH_ALIGNS as readonly string[]).includes(align)
              ? (align as RichAlign)
              : 'left',
          }
        })
    }

    if (kind === 'testimonial') {
      const seenQuoteIds = new Set<string>()
      section.quotes = (Array.isArray(s.quotes) ? s.quotes : [])
        .slice(0, MAX_QUOTES)
        .map((raw, index) => {
          const quote = (raw ?? {}) as Record<string, unknown>
          // Same identity reasoning as a slide: this is the React key and the
          // reorder key, and two sharing one would move the wrong quote.
          let id = String(quote.id ?? '').slice(0, 40) || `q-${index}`
          while (seenQuoteIds.has(id)) id = `${id}-${index}`
          seenQuoteIds.add(id)
          return {
            id,
            quote: String(quote.quote ?? '').slice(0, 400),
            author: String(quote.author ?? '').slice(0, 80),
            detail: String(quote.detail ?? '').slice(0, 80),
          }
        })
    }

    if (kind === 'logos') {
      // Same rule as productIds: junk is DISCARDED rather than clamped, since
      // clamping would invent a reference to picture 1 that nobody chose.
      section.logoImageIds = Array.isArray(s.logoImageIds)
        ? [
            ...new Set(
              s.logoImageIds
                .map((v) => (typeof v === 'number' ? v : Number(v)))
                .filter((v) => Number.isInteger(v) && v > 0),
            ),
          ].slice(0, MAX_LOGOS)
        : []
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

    budget.left--
    if (kind === 'columns') {
      const wanted = clampInt(s.columnCount, 2, 3, 2)
      const raw = Array.isArray(s.columns) ? s.columns : []
      /*
       * Exactly `columnCount` columns, however many arrived.
       *
       * A stored layout can disagree with itself — somebody set three columns,
       * filled them, then went back to two — and the renderer maps over what
       * is here. Padding and trimming to the declared count means the two can
       * never disagree at render time, and the trimmed column’s contents are
       * lost on save rather than silently kept and invisible.
       */
      section.columns = Array.from({ length: wanted }, (_, n) =>
        walk(raw[n], budget, seenIds, true).slice(0, MAX_COLUMN_CHILDREN),
      )
    }


    out.push(section)
  }

  return out
}

/* ── What is wrong with this page ─────────────────────────────────────────── */

/**
 * A problem worth mentioning before a page goes live.
 *
 * ── WHY THESE ARE WARNINGS AND NEVER REFUSALS ────────────────────────────
 *
 * A publish that can be blocked is a publish somebody will be blocked BY at
 * the worst moment — correcting a wrong price at nine on a Saturday, with a
 * checker insisting a decorative picture needs a description first. The owner
 * knows things this cannot: that the banner is purely decorative, that the
 * heading duplicates one above it on purpose.
 *
 * So this counts and says. The publish button stays enabled either way.
 */
export type PageWarning = {
  /** What is wrong, in the owner's words. */
  label: string
  /** How many sections have it. Rolled up so ten banners are one line. */
  count: number
}

/**
 * Everything worth saying about a page before it is published.
 *
 * ── ALT TEXT LEADS, BECAUSE IT IS THE ONE NOBODY CATCHES ─────────────────
 *
 * The builder already warns per banner, but only while that banner is
 * selected — so a page built over an afternoon can easily reach Publish with
 * three undescribed pictures nobody has looked at since. This is the moment it
 * matters, and it is the only accessibility failure on a shop page that is
 * both common and completely invisible to the person who caused it.
 */
export function pageWarnings(sections: HomeSection[]): PageWarning[] {
  let missingAlt = 0
  let emptyLinks = 0

  // Into columns as well — see flattenSections.
  for (const section of flattenSections(sections)) {
    // Hidden sections are not a problem yet. Warning about a section nobody
    // will see turns the check into noise, and noise is what stops it being
    // read on the day it matters.
    if (!section.enabled) continue

    if ((section.kind === 'banner' || section.kind === 'split') && section.imageId) {
      if (!(section.imageAlt ?? '').trim()) missingAlt++
    }
    for (const slide of section.slides ?? []) {
      if (slide.imageId && !slide.imageAlt.trim()) missingAlt++
    }

    // A button with a label and nowhere to go. Not accessibility, but the same
    // kind of mistake: invisible in the builder, obvious to a shopper who taps
    // it. Cheap to check while we are already walking the page.
    if ((section.buttonLabel ?? '').trim() && !(section.linkUrl ?? '').trim()) emptyLinks++
    for (const slide of section.slides ?? []) {
      if (slide.buttonLabel.trim() && !slide.linkUrl.trim()) emptyLinks++
    }
  }

  const out: PageWarning[] = []
  if (missingAlt > 0) {
    out.push({
      label:
        missingAlt === 1
          ? '1 picture has no description'
          : `${missingAlt} pictures have no description`,
      count: missingAlt,
    })
  }
  if (emptyLinks > 0) {
    out.push({
      label:
        emptyLinks === 1
          ? '1 button has nowhere to go'
          : `${emptyLinks} buttons have nowhere to go`,
      count: emptyLinks,
    })
  }
  return out
}

/* ── Pages ────────────────────────────────────────────────────────────────── */

/**
 * The three kinds of page a shop can have.
 *
 * They differ in what they are ATTACHED to, not in what they are: all three
 * hold an ordered list of sections and all three have a draft. See
 * 070_storefront_pages.sql.
 */
export const PAGE_KINDS = ['home', 'standard', 'department', 'product', 'collection'] as const
export type PageKind = (typeof PAGE_KINDS)[number]

/**
 * The section kinds worth offering on a given page.
 *
 * ── WHY 'hero' IS FRONT-PAGE ONLY ────────────────────────────────────────
 *
 * The welcome banner has no words of its own: it renders `heroHeadline` and
 * `heroSubtext` from the THEME, which is the shop's one front-page greeting.
 * Added to a Delivery page it draws that same greeting a second time, or —
 * for a shop that never wrote one — draws nothing at all and reports itself
 * empty. Neither is a section anybody meant to add.
 *
 * Everything else works anywhere, deliberately. A product row on a Returns
 * page is odd but it is not broken, and a builder that second-guesses which
 * blocks "belong" on which page is one that gets in the way.
 *
 * One definition because three menus ask — the canvas toolbar, the
 * between-sections insert point, and the empty-state menu in the inspector.
 */
export function kindsFor(pageKind: PageKind): readonly SectionKind[] {
  return catalogKindsFor(pageKind)
}

/**
 * Slugs the shop's own routes already answer to.
 *
 * A page at /page/checkout would be unreachable — the real checkout wins — so
 * an owner who names one that is owed an explanation rather than a page that
 * silently never appears. 'home' is reserved because the front page owns it.
 *
 * Only the FIRST path segment matters: these pages live under /page/<slug>,
 * so the collision is with a sibling of that prefix, not with every route in
 * the app.
 */
export const RESERVED_SLUGS = [
  'home',
  'page',
  'c',
  'p',
  // Collections live at /k/<slug> — see 189 on why the letter is short.
  'k',
  'cart',
  'checkout',
  'done',
  'account',
  'wishlist',
  'search',
  'api',
] as const

/**
 * A slug we are willing to put in a URL.
 *
 * Lowercase letters, digits and single hyphens. Deliberately narrow: this
 * lands in a path segment, and anything needing encoding produces a link that
 * looks broken when pasted into WhatsApp — which is how most of these are
 * shared.
 *
 * Returns '' for anything unusable, which the caller treats as "ask again"
 * rather than storing. Unlike a colour or a date, there is no safe default to
 * fall back to: inventing a slug would give the owner a page at an address
 * they never chose and cannot guess.
 */
export function safeSlug(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // A trailing hyphen can survive the slice above when the 60th character
    // lands mid-separator.
    .replace(/-+$/, '')
}

/**
 * Why this slug cannot be used, or '' when it can.
 *
 * A sentence rather than a boolean, because every caller of this needs to SAY
 * something — and three screens inventing their own wording for "that one is
 * taken" is how the same rule ends up explained three different ways.
 */
export function slugProblem(slug: string, taken: readonly string[] = []): string {
  if (!slug) return 'Give the page a web address — letters and numbers.'
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) {
    return `“${slug}” is used by the shop itself. Try something else.`
  }
  if (taken.includes(slug)) return 'Another page already uses that address.'
  return ''
}

/* ── Theme ────────────────────────────────────────────────────────────────── */

/**
 * The typefaces a shop may choose from.
 *
 * ── A KEY, NOT A FONT NAME ───────────────────────────────────────────────
 *
 * Each entry names a font loaded by `next/font/google`, which downloads the
 * files AT BUILD TIME and serves them from this origin — so a shopper's
 * browser never contacts a third party, and the shop's own font choice cannot
 * become a privacy leak or a CSP exception. Storing the family name instead
 * would put an arbitrary string into a stylesheet and invite exactly that.
 *
 * ── AND WHY THE LIST IS SHORT ────────────────────────────────────────────
 *
 * Every extra face is a font file on the shop's slowest page. Five is enough
 * to make two shops look genuinely different — which is the whole point — and
 * each has been picked for the property that actually matters at body size: a
 * real bold, a full Latin subset, and legible numerals for prices.
 *
 * 'system' is the default and costs nothing: it is the font the device already
 * has, so it paints instantly and is what every existing shop uses.
 */
export const FONT_KEYS = ['system', 'inter', 'lora', 'poppins', 'source-serif'] as const
export type FontKey = (typeof FONT_KEYS)[number]

export const FONT_LABEL: Record<FontKey, string> = {
  system: 'Your device’s own',
  inter: 'Inter — clean and modern',
  lora: 'Lora — warm and traditional',
  poppins: 'Poppins — friendly and round',
  'source-serif': 'Source Serif — editorial',
}

export function safeFontKey(value: unknown): FontKey {
  const raw = String(value ?? '')
  return (FONT_KEYS as readonly string[]).includes(raw) ? (raw as FontKey) : 'system'
}

export type StorefrontTheme = {
  brandColour: string
  productLayout: 'grid' | 'list'
  /** Which curated typeface the shop uses. See FONT_KEYS. */
  fontKey: FontKey
  /**
   * The picture a shared link shows, as an id into `storefront_images`.
   *
   * The shop-wide fallback beneath each page's own. Null means no image at
   * all, which is what every shop has today — and is exactly the gap that
   * makes a storefront link look broken when pasted into WhatsApp.
   */
  shareImageId: number | null
  /** Whether search engines may index the shop. Off by default — see 077. */
  allowIndexing: boolean
  /** The strip above the masthead. Empty hides it. */
  announceText: string
  announceLink: string
  announceFrom: string
  announceUntil: string
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

/* ── Is the shop's colour readable? ───────────────────────────────────────── */

/**
 * A hex colour's three channels, 0–255. Handles the #abc short form.
 *
 * Assumes `safeColour` has already run — anything reaching here is a valid hex,
 * because that is the only shape the database can hold.
 */
function channels(hex: string): [number, number, number] {
  const raw = hex.replace('#', '')
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

/**
 * Relative luminance, per WCAG 2.1.
 *
 * The gamma expansion is not decoration: a naive average of the channels calls
 * pure yellow dark and pure blue light, which is backwards, and would pass
 * exactly the colours this check exists to catch.
 */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The WCAG contrast ratio between two colours, 1 (identical) to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [light, dark] = la > lb ? [la, lb] : [lb, la]
  return (light + 0.05) / (dark + 0.05)
}

/**
 * WCAG AA for normal text. 3.0 is the large-text threshold, and using it here
 * would pass colours that are unreadable in the places that matter most — a
 * button label and a link are both normal text.
 */
const AA = 4.5

/**
 * What is wrong with this brand colour, or '' when nothing is.
 *
 * ── TWO FAILURES, AND THEY PULL IN OPPOSITE DIRECTIONS ───────────────────
 *
 * The storefront uses the brand colour two ways, and a colour can be wrong for
 * either without being wrong for both:
 *
 *   WHITE ON BRAND — every primary button, the announcement strip, the basket
 *   count. A pale colour makes those labels invisible, and the owner cannot fix
 *   it by other means because they do not choose the text colour.
 *
 *   BRAND ON WHITE — every link, every "Get directions", the footer's social
 *   links. A pale colour fails here too, and a very dark one is fine.
 *
 * So a pale colour breaks both and a mid-weight breaks neither, which is why
 * BRAND_SWATCHES are all mid-weight. This exists for the shop that types its
 * own — the case those swatches cannot cover.
 *
 * ── IT WARNS; IT DOES NOT REFUSE ─────────────────────────────────────────
 *
 * Same reasoning as the publish check. A shop's brand colour is the shop's,
 * and a checker that rejected the actual hex from their signwriting would be
 * wrong about which of the two of us knows more. It says what will happen and
 * lets them decide.
 */
export function brandColourProblem(colour: string): string {
  const hex = safeColour(colour)
  const onWhite = contrastRatio(hex, '#ffffff')

  // Both readings come from the same ratio: white-on-brand and brand-on-white
  // are the same pair of colours, so one number answers both questions. What
  // differs is what a failure MEANS, which is what the message has to say.
  if (onWhite >= AA) return ''

  // A colour light enough to fail against white is light — so the button
  // labels are the visible casualty, and that is the one to lead with.
  return 'Button labels and links may be hard to read on this colour.'
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

/**
 * Is the announcement strip showing today?
 *
 * The same inclusive-both-ends rule `isScheduledNow` applies to a section, and
 * shared with it deliberately — two ways of deciding "is this in season" would
 * eventually disagree, and the one that governs a promotional strip is the one
 * an owner would notice being wrong.
 *
 * Text with no dates is always on. No text is never on, whatever the dates say.
 */
export function announcementShowing(theme: StorefrontTheme, asAt: string = shopToday()): boolean {
  if (!theme.announceText.trim()) return false
  return isScheduledNow({ showFrom: theme.announceFrom, showUntil: theme.announceUntil }, asAt)
}

export function readTheme(row: Row): StorefrontTheme {
  const logo = Number(row.logo_image_id)
  const share = Number(row.share_image_id)
  return {
    brandColour: safeColour(row.brand_colour),
    productLayout: String(row.product_layout) === 'list' ? 'list' : 'grid',
    fontKey: safeFontKey(row.font_key),
    shareImageId: Number.isInteger(share) && share > 0 ? share : null,
    allowIndexing: !!row.allow_indexing,
    announceText: String(row.announce_text ?? ''),
    announceLink: safeLinkTarget(row.announce_link),
    announceFrom: safeDate(row.announce_from),
    announceUntil: safeDate(row.announce_until),
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

