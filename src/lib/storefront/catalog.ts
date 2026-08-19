/**
 * The section CATALOG — what a section kind is, declared once.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * Adding a field to a section used to mean editing five places: the
 * `HomeSection` type, `normaliseSections`, `sectionIsEmpty`, `sectionBody` and
 * an inline `selected.kind === '…'` block in a four-thousand-line Builder. Four
 * of those are easy to forget and each has its own silent failure — a kind
 * missing from `sectionIsEmpty` renders an empty heading on a live shop, and a
 * field written in one normalisation branch but not another produces a
 * permanent "unsaved changes" that no amount of saving clears.
 *
 * This is the same answer `reportBuilder/catalog.ts` and `stationery/catalog.ts`
 * already give for their own domains: one declarative table that both the
 * editor and the server read, so the two cannot drift. A kind becomes an entry
 * here plus a renderer case, and nothing else.
 *
 * ── CLIENT-SAFE, DELIBERATELY ────────────────────────────────────────────
 *
 * No `server-only`, no database import — the builder runs in the browser and
 * needs the identical labels, defaults and (once step 2 lands) field lists the
 * server uses. Same rule as `storefrontModel.ts`, and for the same reason.
 *
 * ── WHY NOT A DISCRIMINATED UNION ────────────────────────────────────────
 *
 * The obvious next move is to give each kind its own payload type. It is the
 * wrong one. Sections are interchangeable in every code path EXCEPT rendering
 * and editing — that is precisely why drag-and-drop, version history, the
 * publish diff and `renderSection`'s uniform signature are as simple as they
 * are. A union would force narrowing at every one of those call sites before
 * touching `section.title`. The flat `HomeSection` stays; this table is the
 * discipline instead.
 */

import type {
  BannerSlide,
  HomeSection,
  PageKind,
  SectionKind,
  Testimonial,
} from '../storefrontModel'

/**
 * The kinds, and the two defaults that appear in a starting section.
 *
 * ── WHY THEY LIVE HERE AND NOT IN THE MODEL ─────────────────────────────
 *
 * The model imports this file. If this file imported RUNTIME values back
 * from the model the two would form a cycle, and a cycle between modules
 * that both build tables at import time is not a style problem — whichever
 * one node happens to load second reads `undefined` and throws before a
 * single line of the app runs. That failure is invisible to `tsc` and
 * depends on which file the entry point reached first, so it would surface
 * as one screen crashing and every test passing.
 *
 * So the catalog owns them, and the model re-exports them. Types are exempt
 * — `import type` is erased entirely and cannot form a runtime cycle.
 */
export const SECTION_KINDS = [
  'hero',
  'banner',
  'carousel',
  'split',
  'categories',
  'products',
  'reviews',
  'countdown',
  'recent',
  'cards',
  'text',
  'richtext',
  'signup',
  'testimonial',
  'logos',
  'video',
  'map',
  'divider',
  'spacer',
  'columns',
] as const

/**
 * The slowest and fastest rotation an owner may set, in seconds.
 *
 * Four at the bottom because anything quicker is unreadable — a shopper who
 * has to finish a sentence cannot, and one who uses the arrows loses their
 * place. Thirty at the top because beyond that the second slide may as well
 * not exist. 0 sits outside the range and means "do not rotate".
 */
export const MIN_AUTOPLAY_SECONDS = 4
export const MAX_AUTOPLAY_SECONDS = 30
export const DEFAULT_AUTOPLAY_SECONDS = 6

/**
 * The wording beside the sign-up tick box, when an owner has not written
 * their own. Copied onto every subscriber row at the moment they agree, so a
 * later edit never rewrites what somebody already consented to.
 */
export const DEFAULT_CONSENT_TEXT =
  'Yes, email me news and offers from this shop. I can unsubscribe at any time.'

/**
 * The icon a palette tile shows.
 *
 * Typed as a plain string rather than `keyof typeof Icons` on purpose: this
 * file must not import the icon set, which is a client component module. The
 * palette resolves the name, and a bad one is a missing tile rather than a
 * build that will not run — a trade worth making to keep the catalog free of
 * React.
 */
export type SectionIconName = string
/* ── The value sets and caps a field may name ───────────────────────────── */

/** Hard caps, enforced on WRITE. A draft is untrusted. */
export const MAX_SECTIONS = 20
export const MAX_SECTION_ITEMS = 24
export const MAX_SECTION_CARDS = 12
/** A paragraph, not an essay — the front page is a shop window. */
export const MAX_SECTION_TEXT = 1200

/** How a product row is filled. */
export const PRODUCT_SOURCES = [
  'manual',
  'department',
  'newest',
  'special',
  'popular',
  'together',
  'sameDepartment',
] as const

/** How much room a spacer leaves. */
export const SPACE_SIZES = ['small', 'medium', 'large'] as const

/** Which side the picture sits on in a split section. */
export const SPLIT_SIDES = ['left', 'right'] as const

/** How a paragraph lines up. */
export const TEXT_ALIGNS = ['left', 'center'] as const

/**
 * How ONE product row draws, overriding the shop-wide choice.
 *
 * Absent/null is a third answer — "follow the shop" — which is why the field
 * is a `choiceOrNull` and not a `choice` with a fallback.
 */
export const ROW_LAYOUTS = ['grid', 'list'] as const

/** Where a video is hosted. Never a URL — see the `idChars` field type. */
/**
 * How many columns a row may have, and how much may go in each.
 *
 * ── THE CAPS COMPOSE, DELIBERATELY ──────────────────────────────────────
 *
 * Children count against MAX_SECTIONS as well as against this, so a page
 * cannot hold 20 columns x 3 x 4 = 240 sections by nesting. `normaliseSections`
 * carries a running budget rather than applying a per-level cap, which is the
 * only version that actually bounds the total.
 */
export const COLUMN_COUNTS = [2, 3] as const
export const MAX_COLUMN_CHILDREN = 4

/** How much room between the columns. */
export const COLUMN_GAPS = ['tight', 'normal', 'loose'] as const
export type ColumnGap = (typeof COLUMN_GAPS)[number]

/** When the columns become rows. */
export const COLUMN_STACKS = ['phone', 'always'] as const
export type ColumnStack = (typeof COLUMN_STACKS)[number]

/**
 * What may go INSIDE a column.
 *
 * ── A WHITELIST, NOT "EVERYTHING MINUS COLUMNS" ─────────────────────────
 *
 * The absence of `columns` is what caps the depth, and it is checked before
 * recursion so there is no path to a third level however the payload is
 * shaped. But the list is shorter than that for a second reason: a carousel
 * in a third of a column is a mistake that looks fine in the builder and
 * reads as broken on a phone, and a department grid inside a column is a
 * second front page. Same reasoning `kindsFor` applies to a product page.
 *
 * `hero` is out because it draws the shop’s one front-page greeting, and
 * `recent` because it is browser-local and cannot be sized.
 */
export const COLUMN_CHILD_KINDS: readonly SectionKind[] = [
  'banner',
  'split',
  'products',
  'reviews',
  'cards',
  'text',
  'richtext',
  'signup',
  'testimonial',
  'logos',
  'video',
  'map',
  'divider',
  'spacer',
]

export const VIDEO_PROVIDERS = ['youtube', 'vimeo'] as const

/**
 * One stored field on a section, and how untrusted input becomes it.
 *
 * ── THIS IS THE WRITE BOUNDARY, NOT A FORM DESCRIPTION ──────────────────
 *
 * A draft is posted by a browser, so every field here says what survives
 * contact with a hostile payload: how long a string may be, what an integer
 * clamps to, which of a fixed set of words is acceptable, and which values
 * go through the URL validators. `normaliseSections` walks this list; there
 * is no branch it can forget, because there are no branches.
 *
 * ── ORDER IS PART OF THE CONTRACT ───────────────────────────────────────
 *
 * Fields are written in the order declared, because the builder decides
 * whether it has unsaved changes by comparing serialised JSON. Two objects
 * with identical values and different key order are "different", and the
 * symptom is an unsaved-changes badge that no amount of saving clears.
 * Declaring the order is what makes that impossible to get wrong by hand.
 */
/**
 * How a field is presented, when the generic inspector draws it.
 *
 * Optional throughout. A field is first a WRITE rule: several kinds keep a
 * hand-written inspector because their controls depend on each other, on the
 * page kind, or on live data, and those still declare their coercion here
 * without inventing a label for a control this file never draws.
 */
export type FieldUi = {
  label: string
  hint?: string
  placeholder?: string
  /** Textarea rows. Present means "draw a textarea", absent means a single line. */
  rows?: number
  /** For a choice: the words an owner reads, in the order they are offered. */
  options?: readonly { value: string; label: string }[]
  /** Narrow control, for a number nobody types four digits into. */
  narrow?: boolean
}

export type SectionField =
  /** Plain text, truncated. */
  | { key: FieldKey; type: 'text'; max: number; ui?: FieldUi }
  /**
   * A URL an owner typed, through `safeLinkTarget`.
   *
   * Never a plain string: this lands in an href on a public page that takes
   * payments, so a `javascript:` link here would be stored XSS. Getting this
   * right twice and wrong the third time is exactly what a declared type
   * prevents.
   */
  | { key: FieldKey; type: 'link'; max: number; ui?: FieldUi }
  /** A whole number, clamped into range. Junk becomes the fallback. */
  | { key: FieldKey; type: 'int'; min: number; max: number; fallback: number; ui?: FieldUi }
  /**
   * A reference to a row elsewhere — a picture, a department, a special.
   *
   * DISCARDED when unusable rather than clamped. Clamping would turn "abc"
   * and -5 into id 1, inventing a reference to a real row nobody chose. An
   * id is an identity, not a quantity.
   */
  | { key: FieldKey; type: 'ref'; ui?: FieldUi }
  /** One of a fixed set of words. Anything else becomes the fallback. */
  | { key: FieldKey; type: 'choice'; of: readonly string[]; fallback: string; ui?: FieldUi }
  /**
   * Like `choice`, but null is a real answer rather than a failure.
   *
   * A product row’s layout is the case: null means "follow the shop", so an
   * unrecognised value must become null and not a grid the owner never chose.
   */
  | { key: FieldKey; type: 'choiceOrNull'; of: readonly string[]; ui?: FieldUi }
  /** A wall-clock date, YYYY-MM-DD. Junk becomes ‘’ — no bound. */
  | { key: FieldKey; type: 'date'; ui?: FieldUi }
  /** A wall-clock moment, YYYY-MM-DDTHH:mm. Junk becomes ‘’ — no deadline. */
  | { key: FieldKey; type: 'dateTime'; ui?: FieldUi }
  /** Text that falls back to a default rather than to ‘’ when blank. */
  | { key: FieldKey; type: 'textOrDefault'; max: number; fallback: string; ui?: FieldUi }
  /** A list of row ids, de-duplicated, junk dropped rather than clamped. */
  | { key: FieldKey; type: 'refList'; max: number; ui?: FieldUi }
  /**
   * A URL that is by definition off-site, through `safeUrl`.
   *
   * Distinct from `link`: directions go to a mapping service, so a relative
   * path here would be a link to a page of the shop that does not exist.
   */
  | { key: FieldKey; type: 'url'; max: number; ui?: FieldUi }
  /**
   * An id, reduced to the characters an id can contain.
   *
   * This lands inside a URL the renderer builds, so the narrow character
   * class IS the validation — it makes "../", a query string and a second
   * host unrepresentable rather than something to strip. A pasted full URL is
   * reduced to its id by the inspector before it reaches here; anything still
   * carrying a slash at this point is not an id.
   */
  | { key: FieldKey; type: 'idChars'; max: number; ui?: FieldUi }

/** A key on HomeSection. Typed so a field cannot name one that does not exist. */
export type FieldKey = keyof HomeSection

/**
 * What answering "is this section empty?" needs.
 *
 * The resolved content (products, departments, pictures, reviews) plus the
 * few model helpers the answer depends on. Supplied by the caller so this
 * file stays free of any runtime import from the model — see isEmpty.
 */
export type EmptyContext = {
  section: HomeSection
  products?: unknown[]
  departments?: unknown[]
  image?: unknown
  slideImages?: Map<number, unknown>
  reviews?: unknown[]
  logoImages?: Map<number, unknown>
  /**
   * columns: whether every column resolved to nothing.
   *
   * Answered by the caller, because a column holds sections and each has its
   * own emptiness rule — a walk this file cannot do without the resolved
   * content for every child.
   */
  columnsEmpty?: boolean
  /** The shop’s theme — only the welcome banner reads it. */
  heroHeadline: string
  heroSubtext: string
  /** Model helpers, handed over rather than imported. */
  liveSlideCount: () => number
  hasRichText: () => boolean
  now: () => string
}

/**
 * One section kind, declared whole.
 *
 * Field lists arrive in step 2 of the catalog migration; this is deliberately
 * the half that changes no behaviour, so it can land against the existing test
 * suite untouched.
 */
export type SectionDef = {
  kind: SectionKind
  /** What the palette tile and the publish summary call it. */
  label: string
  /** The sentence under the label, in the owner's terms. */
  hint: string
  icon: SectionIconName
  /**
   * The page kinds this section may be added to.
   *
   * A list rather than a predicate so the reason lives beside the kind it
   * applies to — `kindsFor` used to hold four separate rules in one filter,
   * where a fifth would have been added to whichever branch was read first.
   */
  pages: readonly PageKind[]
  /**
   * A brand-new section of this kind, minus its id.
   *
   * The caller supplies the id, because generating one here would make this
   * impure and the builder needs its own counter to guarantee uniqueness
   * within a session.
   */
  defaults: (make: DefaultsHelpers) => Omit<HomeSection, 'id' | 'kind'>
  /**
   * The stored fields this kind writes, in the order they are written.
   *
   * `normaliseSections` walks exactly this list. A kind with no fields of
   * its own beyond the shared base declares an empty array — the base is
   * written for every kind regardless, so key order never depends on which
   * branch ran.
   *
   * Not every stored value appears here: the list-shaped ones (a carousel’s
   * slides, rich text’s block tree, quotes, cards) each need their own
   * de-duplication and per-item rules, and a field type expressive enough to
   * describe them would be a worse language than the code it replaced. Those
   * stay hand-written in `normaliseSections` and are named in `extras` so it
   * is visible here that they exist.
   */
  fields: readonly SectionField[]
  /**
   * Stored values this kind writes that `fields` cannot describe.
   *
   * Documentation, not behaviour — it exists so a reader of the catalog can
   * see that a carousel stores slides, without having to discover it in the
   * normaliser.
   */
  extras?: readonly string[]
  /**
   * Would a section of this kind draw anything at all?
   *
   * ── ONE RULE, FOUR CALLERS ────────────────────────────────────────────
   *
   * The shop renders by it, the builder’s placeholder is keyed off it, the
   * shop page decides whether to fall back to the catalogue with it, and the
   * pre-publish warning counts with it. It used to be four separate
   * statements of the same idea, and a mirror is correct only until someone
   * adds a kind and updates one copy — with a silent failure either way: a
   * shopper sees an empty heading, or an owner is told their page is broken
   * when it is fine.
   *
   * ── WHY THE HELPERS ARE PASSED IN ─────────────────────────────────────
   *
   * Answering takes `liveSlides`, `richBlockHasText`, `wallClockNow` and the
   * theme, all of which live in the model — and the model imports this file.
   * Importing them back would rebuild the cycle that once made whichever
   * module loaded second read `undefined` and throw before a line of the app
   * ran. So the model hands them over at the call, and the dependency still
   * runs one way.
   */
  isEmpty: (fill: EmptyContext) => boolean,
}

/**
 * The id-minting the defaults need.
 *
 * Passed in rather than imported so this file stays pure: a carousel starts
 * with two slides and each needs a unique id, but WHERE that uniqueness comes
 * from is the builder's problem, not the catalog's.
 */
export type DefaultsHelpers = {
  slide: () => BannerSlide
  quote: () => Testimonial
}

/** Every page kind. Spelled out so a new one is a compile error here. */
const ALL_PAGES: readonly PageKind[] = ['home', 'standard', 'department', 'product']

/**
 * Everywhere except the front page.
 *
 * The welcome banner has no words of its own — it draws `heroHeadline` and
 * `heroSubtext` from the theme, which is the shop's one front-page greeting.
 * On a Delivery page it repeats that greeting or, for a shop that never wrote
 * one, draws nothing and reports itself empty. Neither is a section anybody
 * meant to add.
 */
const HOME_ONLY: readonly PageKind[] = ['home']

/**
 * Home, standard and department — everything but a product page.
 *
 * A product page's sections sit BELOW the product itself, in the space for
 * "what else", so the blocks that belong there are the ones that relate to it.
 * A carousel or a department grid under one product is a second front page,
 * and the shop already has one of those.
 */
const NOT_PRODUCT: readonly PageKind[] = ['home', 'standard', 'department']

/**
 * The blocks worth offering under a basket or an order confirmation.
 *
 * ── SHORTER THAN THE REST, ON PURPOSE ────────────────────────────────────
 *
 * Both pages have one job and a shopper part-way through it. What belongs
 * there is reassurance and one more thing to look at: trust cards, a note, a
 * row of products, a sign-up. What does not is anything that reads as a
 * second front page — a carousel, a department grid, a countdown pressing
 * somebody who has already decided.
 *
 * The thank-you page has a further constraint the list cannot express, so it
 * is stated where it is enforced: see `sourcesFor`.
 */
const CART_AND_THANKS: readonly PageKind[] = ['cart', 'thankyou']

/**
 * Home and standard only.
 *
 * A department page already sits under a department heading. A department grid
 * there offers the shopper every OTHER aisle at the top of the aisle they just
 * walked into — a way out of the page rather than a way through it.
 */
const NOT_DEPARTMENT_OR_PRODUCT: readonly PageKind[] = ['home', 'standard']

/**
 * Shared by every kind, so the base is stated once.
 *
 * `tone` is written for EVERY section whatever its kind, because the builder
 * decides whether it has unsaved changes by comparing serialised JSON — a key
 * present on some sections and absent on others reads as a permanent edit.
 *
 * ── SPREAD IT AFTER `title`, NEVER BEFORE ───────────────────────────────
 *
 * For the same reason, key ORDER is part of the contract and not a matter of
 * taste: `{ ...BASE, title }` and `{ title, ...BASE }` hold identical values
 * and serialise differently, and the second one is what every stored layout
 * already has. Getting this backwards costs nothing at compile time and
 * shows up as an "unsaved changes" badge that no amount of saving clears.
 */
const BASE = { enabled: true, tone: 'plain' as const }

/**
 * The band a section sits on.
 *
 * ── ROLES, NEVER COLOURS ─────────────────────────────────────────────────
 *
 * `tone: plain | tinted` was one bit, and the instinct on widening it is to
 * offer a colour. That is the wrong direction: a section painted with a hex an
 * owner typed can fight the shop's own palette, and it cannot follow a theme
 * change — the two things the whole token layer exists to prevent. So these are
 * ROLES, resolved through the shop's theme, exactly as rich-text colours are.
 *
 * `contrast` is the notable one and the reason this is worth widening at all:
 * a dark band across a light page is the single most-used section control in
 * every builder on the market, and it is unreachable with two options.
 */
export const SECTION_BACKGROUNDS = ['none', 'tinted', 'surface', 'contrast'] as const
export type SectionBackground = (typeof SECTION_BACKGROUNDS)[number]
/** How much room a section takes above and below its own content. */
export const SECTION_PADDINGS = ['none', 'tight', 'normal', 'loose'] as const
export type SectionPadding = (typeof SECTION_PADDINGS)[number]
/**
 * How wide a section runs.
 *
 * `full` is the addition that needed real work: the page's width cap sits on
 * `<main>`, so bleeding past it means breaking OUT of a container rather than
 * widening one. A hero that stops short of the screen edges is the commonest
 * complaint about a builder, and it was previously impossible.
 */
export const SECTION_WIDTHS = ['contained', 'wide', 'full'] as const
export type SectionWidth = (typeof SECTION_WIDTHS)[number]

/** The shared style fields, spread into every kind — see BASE. */
export const STYLE_FIELDS: readonly SectionField[] = [
  {
    key: 'background',
    type: 'choice',
    of: SECTION_BACKGROUNDS,
    fallback: 'none',
    ui: {
      label: 'Background',
      options: [
        { value: 'none', label: 'The page itself' },
        { value: 'tinted', label: 'A tint of your colour' },
        { value: 'surface', label: 'A card' },
        { value: 'contrast', label: 'A dark band' },
      ],
    },
  },
  {
    key: 'padding',
    type: 'choice',
    of: SECTION_PADDINGS,
    fallback: 'normal',
    ui: {
      label: 'Room around it',
      options: [
        { value: 'none', label: 'None' },
        { value: 'tight', label: 'A little' },
        { value: 'normal', label: 'Normal' },
        { value: 'loose', label: 'A lot' },
      ],
    },
  },
  {
    key: 'width',
    type: 'choice',
    of: SECTION_WIDTHS,
    fallback: 'contained',
    ui: {
      label: 'How wide',
      hint: 'Edge to edge suits a picture; words are easier to read contained.',
      options: [
        { value: 'contained', label: 'With the rest of the page' },
        { value: 'wide', label: 'Wider' },
        { value: 'full', label: 'Edge to edge' },
      ],
    },
  },
]

export const SECTION_CATALOG: Record<SectionKind, SectionDef> = {
  hero: {
    kind: 'hero',
    label: 'Welcome banner',
    hint: 'Your headline and a line under it.',
    icon: 'Sparkles',
    pages: HOME_ONLY,
    defaults: () => ({ title: '', ...BASE }),
    // Draws the theme's greeting, so it is empty when the shop never wrote one.
    isEmpty: (f) => !f.heroHeadline && !f.heroSubtext,
    fields: [
      ...STYLE_FIELDS,],
  },
  banner: {
    kind: 'banner',
    label: 'Picture banner',
    hint: 'A photograph across the page, with words over it.',
    icon: 'Picture',
    pages: NOT_PRODUCT,
    defaults: () => ({
      title: '',
      ...BASE,
      imageId: null,
      imageAlt: '',
      linkUrl: '',
      bodyText: '',
      buttonLabel: '',
    }),
    isEmpty: (f) => !f.image,
    fields: [
      ...STYLE_FIELDS,
      { key: 'imageId', type: 'ref' },
      { key: 'imageAlt', type: 'text', max: 190 },
      { key: 'linkUrl', type: 'link', max: 300 },
      { key: 'bodyText', type: 'text', max: 300 },
      { key: 'buttonLabel', type: 'text', max: 40 },
    ],
  },
  carousel: {
    kind: 'carousel',
    label: 'Rotating banners',
    hint: 'Several pictures in the same spot, one after another.',
    icon: 'Pictures',
    pages: NOT_PRODUCT,
    // TWO empty slides, not one: a carousel of one is drawn as a plain banner,
    // so starting with one would show the owner something that is not what
    // they added. Two makes the arrows and dots appear the moment both have
    // pictures, which is the thing they came for.
    defaults: (make) => ({
      title: '',
      ...BASE,
      slides: [make.slide(), make.slide()],
      autoplaySeconds: DEFAULT_AUTOPLAY_SECONDS,
    }),
    // Same rule as a banner, applied per slide: no picture, nothing to show.
    // A carousel whose slides have all lost their pictures is as empty as one
    // with no slides at all.
    isEmpty: (f) => f.liveSlideCount() === 0,
    fields: [
      ...STYLE_FIELDS,],
    extras: ['slides', 'autoplaySeconds'],
  },
  split: {
    kind: 'split',
    label: 'Picture beside words',
    hint: 'A picture on one side, your words on the other.',
    icon: 'SplitPanes',
    pages: NOT_PRODUCT,
    defaults: () => ({
      title: 'A word about us',
      ...BASE,
      imageId: null,
      imageAlt: '',
      bodyText: '',
      buttonLabel: '',
      linkUrl: '',
      side: 'left',
    }),
    // Words alone are the `text` kind and a picture alone is a banner. This
    // section is the PAIRING, so it needs both — with one missing it would
    // silently render as a worse version of a section that already exists.
    isEmpty: (f) => !f.image || !(f.section.bodyText?.trim() || f.section.title),
    fields: [
      ...STYLE_FIELDS,
      { key: 'imageId', type: 'ref' },
      { key: 'imageAlt', type: 'text', max: 190 },
      { key: 'bodyText', type: 'text', max: MAX_SECTION_TEXT },
      { key: 'buttonLabel', type: 'text', max: 40 },
      { key: 'linkUrl', type: 'link', max: 300 },
      { key: 'side', type: 'choice', of: SPLIT_SIDES, fallback: 'left' },
    ],
  },
  categories: {
    kind: 'categories',
    label: 'Shop by department',
    hint: 'Tiles linking to each department you publish.',
    icon: 'LayoutGrid',
    pages: NOT_DEPARTMENT_OR_PRODUCT,
    defaults: () => ({ title: 'Shop by department', ...BASE, maxItems: 0 }),
    isEmpty: (f) => !f.departments || f.departments.length === 0,
    fields: [
      ...STYLE_FIELDS,{ key: 'maxItems', type: 'int', min: 0, max: MAX_SECTION_ITEMS, fallback: 0 }],
  },
  products: {
    kind: 'products',
    label: 'A row of products',
    hint: 'Pick the products yourself, or let a rule fill the row.',
    icon: 'Package',
    pages: [...ALL_PAGES, ...CART_AND_THANKS],
    defaults: () => ({
      title: 'Products',
      ...BASE,
      source: 'newest',
      productIds: [],
      maxItems: 8,
      departmentId: null,
      layout: null,
    }),
    isEmpty: (f) => !f.products || f.products.length === 0,
    fields: [
      ...STYLE_FIELDS,
      { key: 'source', type: 'choice', of: PRODUCT_SOURCES, fallback: 'manual' },
      { key: 'departmentId', type: 'ref' },
      { key: 'productIds', type: 'refList', max: MAX_SECTION_ITEMS },
      { key: 'maxItems', type: 'int', min: 0, max: MAX_SECTION_ITEMS, fallback: 8 },
      { key: 'layout', type: 'choiceOrNull', of: ROW_LAYOUTS },
    ],
  },
  reviews: {
    kind: 'reviews',
    label: 'What customers say',
    hint: 'Real reviews you have approved. Fills itself.',
    icon: 'Star',
    pages: ALL_PAGES,
    defaults: () => ({
      title: 'What customers say',
      ...BASE,
      maxItems: 6,
      minRating: 4,
      departmentId: null,
    }),
    // Correctly empty for a shop nobody has reviewed yet, which is every new
    // shop. The builder says so rather than calling it a fault.
    isEmpty: (f) => !f.reviews || f.reviews.length === 0,
    fields: [
      ...STYLE_FIELDS,
      { key: 'maxItems', type: 'int', min: 1, max: MAX_SECTION_ITEMS, fallback: 6 },
      { key: 'minRating', type: 'int', min: 1, max: 5, fallback: 4 },
      { key: 'departmentId', type: 'ref' },
    ],
  },
  countdown: {
    kind: 'countdown',
    label: 'Countdown to a deadline',
    hint: 'A ticking clock — “sale ends in…”.',
    icon: 'CalendarClock',
    pages: NOT_PRODUCT,
    defaults: () => ({
      title: 'Sale ends soon',
      ...BASE,
      specialId: null,
      endsAt: '',
      bodyText: '',
      finishedText: '',
    }),
    // A countdown with nothing left to count is over. It keeps drawing only if
    // the owner wrote something for it to say afterwards — otherwise a
    // finished sale would sit on the front page advertising 00:00:00.
    isEmpty: (f) => {
      const ends = f.section.endsAt?.trim() ?? ''
      if (!ends) return true
      return ends <= f.now() && !(f.section.finishedText?.trim() ?? '')
    },
    fields: [
      ...STYLE_FIELDS,
      { key: 'specialId', type: 'ref' },
      // A junk deadline becomes '' — no deadline — which sectionIsEmpty reads
      // as "draws nothing". Failing that way round is right: a half-parsed
      // date would put a wrong clock on a public page, and a countdown to the
      // wrong moment is worse than no countdown.
      { key: 'endsAt', type: 'dateTime' },
      { key: 'finishedText', type: 'text', max: 120 },
    ],
  },
  recent: {
    kind: 'recent',
    label: 'Recently viewed',
    hint: 'The last few things this shopper looked at. Nothing to set.',
    icon: 'History',
    pages: ALL_PAGES,
    defaults: () => ({ title: '', ...BASE }),
    /*
     * Never empty HERE, because the server cannot know.
     *
     * What this holds lives in the shopper's own browser, so at render time it
     * is genuinely unknown — and answering "empty" would make the builder draw
     * a placeholder for a section that is fine, while answering it on the shop
     * would drop a section that has content. The component itself renders
     * nothing when the list turns out to be short; see RecentlyViewed.
     */
    isEmpty: () => false,
    fields: [
      ...STYLE_FIELDS,],
  },
  cards: {
    kind: 'cards',
    label: 'Info cards',
    hint: 'Your own tiles — delivery info, opening hours, anything.',
    icon: 'Boxes',
    pages: [...ALL_PAGES, ...CART_AND_THANKS],
    defaults: () => ({
      title: '',
      ...BASE,
      cards: [{ icon: '🚚', heading: 'Delivery', text: '' }],
    }),
    // A card with nothing written on it is not worth a tile, so a section of
    // blank cards is as empty as one with none.
    isEmpty: (f) => (f.section.cards ?? []).filter((c) => c.heading || c.text).length === 0,
    fields: [
      ...STYLE_FIELDS,],
    extras: ['cards'],
  },
  text: {
    kind: 'text',
    label: 'A paragraph',
    hint: 'A note to shoppers — delivery days, a holiday message.',
    icon: 'AlignLeft',
    pages: [...ALL_PAGES, ...CART_AND_THANKS],
    defaults: () => ({ title: '', ...BASE, text: '', align: 'left' }),
    isEmpty: (f) => !(f.section.text?.trim() ?? '') && !f.section.title,
    fields: [
      ...STYLE_FIELDS,
      {
        key: 'text',
        type: 'text',
        max: MAX_SECTION_TEXT,
        ui: {
          label: 'What it says',
          rows: 6,
          placeholder: 'Deliveries go out on Tuesdays and Fridays.',
        },
      },
      {
        key: 'align',
        type: 'choice',
        of: TEXT_ALIGNS,
        fallback: 'left',
        ui: {
          label: 'Line it up',
          options: [
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centred' },
          ],
        },
      },
    ],
  },
  richtext: {
    kind: 'richtext',
    label: 'Formatted writing',
    hint: 'Headings, bold, colour, alignment, lists and links. For a longer page.',
    icon: 'FileText',
    pages: [...ALL_PAGES, ...CART_AND_THANKS],
    // One empty paragraph, not zero: an editor with no rows shows the owner
    // nothing to type into, and "add a paragraph" before you can write a word
    // is a step nobody should need.
    defaults: () => ({ title: '', ...BASE, blocks: [{ type: 'p', spans: [{ text: '' }] }] }),
    isEmpty: (f) => !f.hasRichText(),
    fields: [
      ...STYLE_FIELDS,],
    extras: ['blocks'],
  },
  signup: {
    kind: 'signup',
    label: 'Email sign-up',
    hint: 'Collect email addresses, with permission on the record.',
    icon: 'Mail',
    pages: [...NOT_PRODUCT, ...CART_AND_THANKS],
    defaults: () => ({
      title: 'Keep in touch',
      ...BASE,
      bodyText: 'News, offers and what is fresh — straight to your inbox.',
      buttonLabel: 'Sign up',
      // The default wording, not blank — a form collecting addresses with no
      // consent line is the one thing this section must never be.
      consentText: DEFAULT_CONSENT_TEXT,
      thanksText: '',
    }),
    // Never empty: the form IS the content, and a heading is optional. An owner
    // who added one meant to collect addresses.
    isEmpty: () => false,
    fields: [
      ...STYLE_FIELDS,
      { key: 'bodyText', type: 'text', max: 300 },
      { key: 'buttonLabel', type: 'text', max: 40 },
      // Falls back to a default rather than to '', because an empty consent
      // line is a form collecting addresses with nothing on the record about
      // what was agreed to — the one state 071 exists to prevent.
      { key: 'consentText', type: 'textOrDefault', max: 300, fallback: DEFAULT_CONSENT_TEXT },
      { key: 'thanksText', type: 'text', max: 200 },
    ],
  },
  testimonial: {
    kind: 'testimonial',
    label: 'Quotes',
    hint: 'Quotes you write yourself, not from the review queue.',
    icon: 'MessageSquare',
    pages: [...ALL_PAGES, ...CART_AND_THANKS],
    defaults: (make) => ({ title: 'In their words', ...BASE, quotes: [make.quote()] }),
    isEmpty: (f) => (f.section.quotes ?? []).filter((q) => q.quote.trim()).length === 0,
    fields: [
      ...STYLE_FIELDS,],
    extras: ['quotes'],
  },
  logos: {
    kind: 'logos',
    label: 'A row of logos',
    hint: 'Brands you stock, or badges you have earned.',
    icon: 'Shapes',
    pages: NOT_PRODUCT,
    defaults: () => ({ title: 'Brands we stock', ...BASE, logoImageIds: [] }),
    // Counted against what actually RESOLVED, not against the stored ids: a
    // strip whose pictures were all deleted is as empty as one with none.
    isEmpty: (f) => (f.logoImages?.size ?? 0) === 0,
    fields: [
      ...STYLE_FIELDS,],
    extras: ['logoImageIds'],
  },
  video: {
    kind: 'video',
    label: 'A video',
    hint: 'A YouTube or Vimeo video.',
    icon: 'Play',
    pages: NOT_PRODUCT,
    defaults: () => ({ title: '', ...BASE, videoProvider: 'youtube', videoId: '' }),
    isEmpty: (f) => !(f.section.videoId ?? '').trim(),
    fields: [
      ...STYLE_FIELDS,
      { key: 'videoProvider', type: 'choice', of: VIDEO_PROVIDERS, fallback: 'youtube' },
      { key: 'videoId', type: 'idChars', max: 40 },
    ],
  },
  map: {
    kind: 'map',
    label: 'Where to find us',
    hint: 'Your address, and a link to directions.',
    icon: 'Pin',
    pages: NOT_PRODUCT,
    defaults: () => ({ title: 'Where to find us', ...BASE, addressText: '', mapUrl: '' }),
    isEmpty: (f) => !(f.section.addressText?.trim() ?? ''),
    fields: [
      ...STYLE_FIELDS,
      { key: 'addressText', type: 'text', max: 300 },
      { key: 'mapUrl', type: 'url', max: 500 },
    ],
  },
  divider: {
    kind: 'divider',
    label: 'A dividing line',
    hint: 'A line between two parts of the page.',
    icon: 'Minus',
    pages: [...ALL_PAGES, ...CART_AND_THANKS],
    defaults: () => ({ title: '', ...BASE }),
    // Draws exactly itself and is never empty — that IS its content. Returning
    // true here would make it impossible to add.
    isEmpty: () => false,
    fields: [
      ...STYLE_FIELDS,],
  },
  spacer: {
    kind: 'spacer',
    label: 'A gap',
    hint: 'Empty room, to let a page breathe.',
    icon: 'StackedBands',
    pages: [...ALL_PAGES, ...CART_AND_THANKS],
    defaults: () => ({ title: '', ...BASE, size: 'medium' }),
    // As above: the gap is the point.
    isEmpty: () => false,
    fields: [
      ...STYLE_FIELDS,
      {
        key: 'size',
        type: 'choice',
        of: SPACE_SIZES,
        fallback: 'medium',
        ui: {
          label: 'How much room',
          options: [
            { value: 'small', label: 'A little' },
            { value: 'medium', label: 'Some' },
            { value: 'large', label: 'A lot' },
          ],
        },
      },
    ],
  },
  columns: {
    kind: 'columns',
    label: 'Side by side',
    hint: 'Two or three things across, instead of one under the other.',
    icon: 'SplitPanes',
    // Not on a product page: its sections sit under one product in a narrow
    // column, and splitting that into thirds is a row nobody can read.
    pages: NOT_PRODUCT,
    fields: [
      ...STYLE_FIELDS,
      { key: 'columnCount', type: 'int', min: 2, max: 3, fallback: 2 },
      { key: 'columnGap', type: 'choice', of: COLUMN_GAPS, fallback: 'normal' },
      { key: 'columnStack', type: 'choice', of: COLUMN_STACKS, fallback: 'phone' },
    ],
    extras: ['columns'],
    defaults: () => ({
      title: '',
      ...BASE,
      columnCount: 2,
      columnGap: 'normal',
      columnStack: 'phone',
      // Two empty columns, so the shape is visible the moment it is added.
      // An owner who dropped this in has said "side by side"; showing them
      // one empty box would be showing them something else.
      columns: [[], []],
    }),
    /*
     * Empty when every column is.
     *
     * Answered by the CALLER rather than here, because a column holds
     * sections and each has its own emptiness rule — asking them is a walk
     * this file cannot do without the resolved content for each child. The
     * renderer passes the answer in.
     */
    isEmpty: (f) => (f.columnsEmpty ?? true),
  },
}

/**
 * The section kinds worth offering on a given page.
 *
 * One definition because three menus ask — the canvas toolbar, the
 * between-sections insert point, and the empty-state menu in the inspector.
 *
 * Iterates `SECTION_KINDS` rather than the catalog's own keys so the palette
 * order stays the declared one: `Object.keys` on a record is insertion order in
 * practice, but the kind list is where that order is *stated*, and a menu whose
 * order depends on an object literal's shape is one that reorders itself the
 * next time somebody tidies this file.
 */
export function kindsFor(pageKind: PageKind): readonly SectionKind[] {
  return SECTION_KINDS.filter((kind) => SECTION_CATALOG[kind].pages.includes(pageKind))
}

/* ── How a section sits on the page ───────────────────────────────────────── */





