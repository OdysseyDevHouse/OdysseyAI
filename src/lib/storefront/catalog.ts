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

export const SECTION_CATALOG: Record<SectionKind, SectionDef> = {
  hero: {
    kind: 'hero',
    label: 'Welcome banner',
    hint: 'Your headline and a line under it.',
    icon: 'Sparkles',
    pages: HOME_ONLY,
    defaults: () => ({ title: '', ...BASE }),
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
  },
  categories: {
    kind: 'categories',
    label: 'Shop by department',
    hint: 'Tiles linking to each department you publish.',
    icon: 'LayoutGrid',
    pages: NOT_DEPARTMENT_OR_PRODUCT,
    defaults: () => ({ title: 'Shop by department', ...BASE, maxItems: 0 }),
  },
  products: {
    kind: 'products',
    label: 'A row of products',
    hint: 'Pick the products yourself, or let a rule fill the row.',
    icon: 'Package',
    pages: ALL_PAGES,
    defaults: () => ({
      title: 'Products',
      ...BASE,
      source: 'newest',
      productIds: [],
      maxItems: 8,
      departmentId: null,
      layout: null,
    }),
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
  },
  recent: {
    kind: 'recent',
    label: 'Recently viewed',
    hint: 'The last few things this shopper looked at. Nothing to set.',
    icon: 'History',
    pages: ALL_PAGES,
    defaults: () => ({ title: '', ...BASE }),
  },
  cards: {
    kind: 'cards',
    label: 'Info cards',
    hint: 'Your own tiles — delivery info, opening hours, anything.',
    icon: 'Boxes',
    pages: ALL_PAGES,
    defaults: () => ({
      title: '',
      ...BASE,
      cards: [{ icon: '🚚', heading: 'Delivery', text: '' }],
    }),
  },
  text: {
    kind: 'text',
    label: 'A paragraph',
    hint: 'A note to shoppers — delivery days, a holiday message.',
    icon: 'AlignLeft',
    pages: ALL_PAGES,
    defaults: () => ({ title: '', ...BASE, text: '', align: 'left' }),
  },
  richtext: {
    kind: 'richtext',
    label: 'Formatted writing',
    hint: 'Headings, bold, colour, alignment, lists and links. For a longer page.',
    icon: 'FileText',
    pages: ALL_PAGES,
    // One empty paragraph, not zero: an editor with no rows shows the owner
    // nothing to type into, and "add a paragraph" before you can write a word
    // is a step nobody should need.
    defaults: () => ({ title: '', ...BASE, blocks: [{ type: 'p', spans: [{ text: '' }] }] }),
  },
  signup: {
    kind: 'signup',
    label: 'Email sign-up',
    hint: 'Collect email addresses, with permission on the record.',
    icon: 'Mail',
    pages: NOT_PRODUCT,
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
  },
  testimonial: {
    kind: 'testimonial',
    label: 'Quotes',
    hint: 'Quotes you write yourself, not from the review queue.',
    icon: 'MessageSquare',
    pages: ALL_PAGES,
    defaults: (make) => ({ title: 'In their words', ...BASE, quotes: [make.quote()] }),
  },
  logos: {
    kind: 'logos',
    label: 'A row of logos',
    hint: 'Brands you stock, or badges you have earned.',
    icon: 'Shapes',
    pages: NOT_PRODUCT,
    defaults: () => ({ title: 'Brands we stock', ...BASE, logoImageIds: [] }),
  },
  video: {
    kind: 'video',
    label: 'A video',
    hint: 'A YouTube or Vimeo video.',
    icon: 'Play',
    pages: NOT_PRODUCT,
    defaults: () => ({ title: '', ...BASE, videoProvider: 'youtube', videoId: '' }),
  },
  map: {
    kind: 'map',
    label: 'Where to find us',
    hint: 'Your address, and a link to directions.',
    icon: 'Pin',
    pages: NOT_PRODUCT,
    defaults: () => ({ title: 'Where to find us', ...BASE, addressText: '', mapUrl: '' }),
  },
  divider: {
    kind: 'divider',
    label: 'A dividing line',
    hint: 'A line between two parts of the page.',
    icon: 'Minus',
    pages: ALL_PAGES,
    defaults: () => ({ title: '', ...BASE }),
  },
  spacer: {
    kind: 'spacer',
    label: 'A gap',
    hint: 'Empty room, to let a page breathe.',
    icon: 'StackedBands',
    pages: ALL_PAGES,
    defaults: () => ({ title: '', ...BASE, size: 'medium' }),
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
