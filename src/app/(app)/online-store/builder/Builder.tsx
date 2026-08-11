'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ChoiceTile,
  ColourInput,
  ConfirmModal,
  EmptyState,
  Field,
  FieldGroup,
  Icons,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Modal,
  NumberInput,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import {
  BRAND_SWATCHES,
  DEFAULT_AUTOPLAY_SECONDS,
  DEFAULT_CONSENT_TEXT,
  FONT_KEYS,
  FONT_LABEL,
  announcementShowing,
  brandColourProblem,
  MAX_AUTOPLAY_SECONDS,
  MAX_LOGOS,
  MAX_QUOTES,
  MAX_RICH_BLOCKS,
  MAX_SECTIONS,
  MAX_SECTION_CARDS,
  MAX_SECTION_TEXT,
  MAX_SLIDES,
  MAX_SPAN_TEXT,
  MIN_AUTOPLAY_SECONDS,
  PAGE_PRESETS,
  SECTION_HINT,
  SECTION_LABEL,
  kindsFor,
  describeSource,
  describeLayoutChanges,
  applyToSelection,
  isScheduledNow,
  normaliseSections,
  pageWarnings,
  replaceBlockText,
  richBlockText,
  sectionName,
  sourcesFor,
  shopToday,
  RICH_ALIGNS,
  RICH_COLOURS,
  type BannerSlide,
  type HomeSection,
  type LayoutChange,
  type PagePreset,
  type RichAlign,
  type RichBlock,
  type RichBlockType,
  type RichColour,
  type RichSpan,
  type SectionKind,
  type StorefrontTheme,
  type Testimonial,
  // The pure model, NOT lib/site/storefrontLayout — importing the server
  // module here would pull the database layer into the browser bundle.
} from '@/lib/storefrontModel'
import { blocksFromPastedText, parsePastedHtml } from '@/lib/richTextPaste'
import type { StorefrontDepartment, StorefrontProduct } from '@/lib/site/storefront'
import type { StorefrontImage } from '@/lib/site/storefrontImages'
import type { PageVersion, SavedSection, StorefrontPage } from '@/lib/site/storefrontPages'
import type { ProductDisplay, SectionContent } from '@/app/store/[token]/HomeSections'
import { BuilderCanvas, type PreviewWidth } from './BuilderCanvas'
import ProductPicker from './ProductPicker'
import Outline from './Outline'
import PicturePicker from '@/components/PicturePicker'
import {
  deleteSavedSectionAction,
  discardDraftAction,
  previewLinkAction,
  restoreVersionAction,
  saveSectionAction,
  schedulePublishAction,
  publishDraftAction,
  saveDraftAction,
  saveThemeAction,
} from './actions'

/**
 * The page builder: the real shop on the left, the settings for whatever is
 * selected on the right.
 *
 * ── THE PREVIEW IS THE SHOP ──────────────────────────────────────────────
 *
 * The canvas renders the SAME HomeSections component a shopper gets, wrapped
 * in drag handles. Not a mock — there is no second implementation, so the
 * preview cannot drift from the thing it is previewing. Click a section to
 * edit it; drag it to move it.
 *
 * An earlier version of this screen was a list of section NAMES beside the
 * inspector. It was simpler and it was worse: arranging a page you cannot see
 * is guesswork, and the whole reason to build a page visually is to watch it
 * change.
 *
 * Everything writes to a DRAFT, autosaved. Publish is the only thing that
 * moves the live shop.
 */

/** How long after the last edit the draft is written. */
const AUTOSAVE_MS = 1200

/**
 * How many steps back the undo stack remembers.
 *
 * Deep enough to cover a genuine "that was wrong, take it all off" — deleting
 * three sections and retyping a heading is already six or seven states —
 * without keeping an unbounded copy of the page for a session that runs all
 * afternoon.
 */
/**
 * How many sections a page needs before the outline is offered.
 *
 * Below this the canvas IS the outline — everything fits on a screen and a
 * second list of the same names is noise in a panel that is already busy.
 */
const OUTLINE_FROM = 5

const HISTORY_LIMIT = 50

let idCounter = 0
function newId(kind: SectionKind): string {
  // Date-free so two sections added in the same millisecond cannot collide.
  return `s-${kind}-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`
}

function newSection(kind: SectionKind): HomeSection {
  const base = { id: newId(kind), kind, title: SECTION_LABEL[kind], enabled: true, tone: 'plain' as const }
  if (kind === 'products') {
    return {
      ...base,
      title: 'Products',
      source: 'newest',
      productIds: [],
      maxItems: 8,
      departmentId: null,
      layout: null,
    }
  }
  if (kind === 'categories') return { ...base, title: 'Shop by department', maxItems: 0 }
  if (kind === 'cards') return { ...base, title: '', cards: [{ icon: '🚚', heading: 'Delivery', text: '' }] }
  if (kind === 'banner') {
    return { ...base, title: '', imageId: null, imageAlt: '', linkUrl: '', bodyText: '', buttonLabel: '' }
  }
  if (kind === 'carousel') {
    // TWO empty slides, not one: a carousel of one is drawn as a plain banner,
    // so starting with one would show the owner something that is not what
    // they added. Two makes the arrows and dots appear the moment both have
    // pictures, which is the thing they came for.
    return {
      ...base,
      title: '',
      slides: [newSlide(), newSlide()],
      autoplaySeconds: DEFAULT_AUTOPLAY_SECONDS,
    }
  }
  if (kind === 'text') return { ...base, title: '', text: '', align: 'left' }
  if (kind === 'split') {
    return {
      ...base,
      title: 'A word about us',
      imageId: null,
      imageAlt: '',
      bodyText: '',
      buttonLabel: '',
      linkUrl: '',
      side: 'left',
    }
  }
  if (kind === 'reviews') {
    return { ...base, title: 'What customers say', maxItems: 6, minRating: 4, departmentId: null }
  }
  if (kind === 'countdown') {
    return {
      ...base,
      title: 'Sale ends soon',
      specialId: null,
      endsAt: '',
      bodyText: '',
      finishedText: '',
    }
  }
  if (kind === 'richtext') {
    // One empty paragraph, not zero: an editor with no rows shows the owner
    // nothing to type into, and "add a paragraph" before you can write a word
    // is a step nobody should need.
    return { ...base, title: '', blocks: [{ type: 'p', spans: [{ text: '' }] }] }
  }
  if (kind === 'testimonial') {
    return { ...base, title: 'In their words', quotes: [newQuote()] }
  }
  if (kind === 'signup') {
    return {
      ...base,
      title: 'Keep in touch',
      bodyText: 'News, offers and what is fresh — straight to your inbox.',
      buttonLabel: 'Sign up',
      // The default wording, not blank — a form collecting addresses with no
      // consent line is the one thing this section must never be.
      consentText: DEFAULT_CONSENT_TEXT,
      thanksText: '',
    }
  }
  if (kind === 'logos') return { ...base, title: 'Brands we stock', logoImageIds: [] }
  if (kind === 'video') return { ...base, title: '', videoProvider: 'youtube', videoId: '' }
  if (kind === 'map') return { ...base, title: 'Where to find us', addressText: '', mapUrl: '' }
  if (kind === 'spacer') return { ...base, title: '', size: 'medium' }
  return { ...base, title: '' }
}

/** A blank quote. Same id reasoning as `newSlide` — date-free. */
function newQuote(): Testimonial {
  return {
    id: `q-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`,
    quote: '',
    author: '',
    detail: '',
  }
}

/** A blank slide. Same id reasoning as `newId` — date-free, so two in one
 *  millisecond cannot collide. */
function newSlide(): BannerSlide {
  return {
    id: `sl-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`,
    imageId: null,
    imageAlt: '',
    heading: '',
    bodyText: '',
    buttonLabel: '',
    linkUrl: '',
  }
}

/**
 * The pictures a carousel's slides currently resolve to.
 *
 * Only THIS section's, because `sectionIsEmpty` asks whether a slide's picture
 * resolves — handing over the browser's whole library would let a carousel
 * inherit the answer for a picture belonging to somewhere else.
 */
function slideImagesFor(
  section: HomeSection,
  known: Map<number, StorefrontImage>,
): Map<number, StorefrontImage> {
  const mine = new Map<number, StorefrontImage>()
  for (const slide of section.slides ?? []) {
    const found = slide.imageId ? known.get(slide.imageId) : undefined
    if (found) mine.set(slide.imageId as number, found)
  }
  return mine
}

/**
 * How each kind of change reads in the publish summary.
 *
 * Written as full literal maps rather than built from the kind — Tailwind
 * scans source text, and `Badge` picks its classes the same way, so a computed
 * tone would silently render unstyled.
 */
const CHANGE_LABEL: Record<LayoutChange['kind'], string> = {
  added: 'New',
  removed: 'Removed',
  moved: 'Moved',
  edited: 'Changed',
  shown: 'Now showing',
  hidden: 'Now hidden',
}

/**
 * Colour carries meaning here, so it is chosen per kind rather than for
 * variety: danger for the two that TAKE something away from the page, success
 * for the one that adds something a shopper will now see, neutral for the
 * rearranging.
 */
const CHANGE_TONE: Record<LayoutChange['kind'], 'brand' | 'success' | 'danger' | 'neutral'> = {
  added: 'success',
  removed: 'danger',
  moved: 'neutral',
  edited: 'brand',
  shown: 'success',
  hidden: 'danger',
}

/** The emoji an info card is most likely to want. */
const CARD_ICONS = ['🚚', '🕘', '💳', '📦', '🎁', '⭐', '✅', '📞', '📍', '🔒', '♻️', '🛠️']

export default function Builder({
  page,
  pages,
  theme: initialTheme,
  published,
  draft,
  initialContent,
  departments,
  publishedDepartments,
  storeName,
  blurb,
  storeOpen,
  storePath,
  display,
  images,
  specials,
  subscriberCount,
  versions,
  savedSections,
}: {
  /**
   * The page being edited.
   *
   * The builder is otherwise page-agnostic: every section, every drag and the
   * whole inspector work on an array, and always did. This is the id that
   * array gets saved against, plus enough about the page to say which one the
   * owner is looking at.
   */
  page: StorefrontPage
  /** Every page, for the switcher. */
  pages: StorefrontPage[]
  theme: StorefrontTheme
  published: HomeSection[]
  draft: HomeSection[] | null
  /** The sections with their real products, resolved server-side. */
  initialContent: SectionContent[]
  /** The banner pictures those sections refer to, resolved server-side. */
  images: StorefrontImage[]
  departments: { id: number; name: string }[]
  /** What the shop actually publishes — the categories section previews these. */
  publishedDepartments: StorefrontDepartment[]
  storeName: string
  blurb: string
  storeOpen: boolean
  storePath: string
  /** Passed straight to the canvas so the preview matches the shop. */
  display: ProductDisplay
  /**
   * Specials a countdown can be bound to.
   *
   * Name and id only: the inspector draws a picker, and handing the browser
   * whole specials would put every shop's pricing rules in the bundle of a
   * screen that needs two fields.
   */
  specials: { id: number; name: string }[]
  /** How many people are on the mailing list — shown beside the sign-up form. */
  subscriberCount: number
  /** What this page used to be, newest first. */
  versions: PageVersion[]
  /** Sections kept from anywhere in the shop. */
  savedSections: SavedSection[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startAction] = useTransition()

  /*
   * The page, and every state it has been in this session.
   *
   * ── WHY A HISTORY AND NOT JUST A VALUE ───────────────────────────────
   *
   * Removing a section used to be unrecoverable: the only way back was
   * "Discard changes", which throws away everything since the last publish —
   * so the cost of undoing one mistaken delete was every deliberate edit made
   * before it. That is not a choice anyone should have to make, and it is why
   * the delete button did not exist.
   *
   * With a history, delete is cheap and therefore safe to offer. It is also
   * what makes the rest of the screen worth using: an owner will only try
   * rearranging a page they can put back.
   *
   * `past` and `future` hold whole section arrays. They are small — twenty
   * sections of plain data — and storing snapshots rather than diffs means
   * undo cannot disagree with what it is undoing.
   */
  const [history, setHistory] = useState<{
    past: HomeSection[][]
    present: HomeSection[]
    future: HomeSection[][]
  }>(() => ({ past: [], present: normaliseSections(draft ?? published), future: [] }))
  const sections = history.present

  const [theme, setTheme] = useState(initialTheme)
  const [selectedId, setSelectedId] = useState<string | null>(sections[0]?.id ?? null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [width, setWidth] = useState<PreviewWidth>('desktop')
  /** Collapsing the panel gives the preview the whole width. */
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleAt, setScheduleAt] = useState(page.publishAt)
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  /** The version awaiting confirmation, because restoring replaces the draft. */
  const [restoring, setRestoring] = useState<PageVersion | null>(null)
  /** The section being given a name to save, if any. */
  const [savingSection, setSavingSection] = useState<HomeSection | null>(null)
  const [saveName, setSaveName] = useState('')
  /** The "here is what will change" dialog, shown before anything goes live. */
  const [confirmOpen, setConfirmOpen] = useState(false)

  /**
   * Replace the page, remembering what it was.
   *
   * Every edit goes through here rather than calling a setter directly, so
   * there is exactly one place that can forget to record history.
   */
  const commit = useCallback((next: HomeSection[] | ((prev: HomeSection[]) => HomeSection[])) => {
    setHistory((h) => {
      const value = typeof next === 'function' ? next(h.present) : next
      // A no-op edit must not consume an undo step: without this, typing and
      // deleting one character would push two states and cost two Ctrl+Zs to
      // get back to where you started.
      if (value === h.present) return h
      return {
        past: [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: value,
        // Doing something new abandons the redo branch, as every editor does.
        future: [],
      }
    })
  }, [])

  const undo = useCallback(() => {
    setHistory((h) => {
      const previous = h.past[h.past.length - 1]
      if (!previous) return h
      return {
        past: h.past.slice(0, -1),
        present: previous,
        future: [h.present, ...h.future],
      }
    })
  }, [])

  const redo = useCallback(() => {
    setHistory((h) => {
      const [next, ...rest] = h.future
      if (!next) return h
      return { past: [...h.past, h.present], present: next, future: rest }
    })
  }, [])

  const selected = sections.find((s) => s.id === selectedId) ?? null

  /*
   * What the preview draws.
   *
   * The section LIST is local state (it changes on every keystroke), but the
   * products inside each row were resolved on the server. Re-pairing them by
   * id means a rename or a reorder re-renders instantly, while the contents
   * stay whatever the server last resolved — a new row shows empty until the
   * draft saves and the page revalidates, which is the honest thing to show.
   */
  const contentById = useMemo(
    () => new Map(initialContent.map((c) => [c.section.id, c])),
    [initialContent],
  )

  /*
   * Products the PICKER has resolved since the page loaded.
   *
   * A pick is not a keystroke: it changes what the row contains, and the whole
   * reason to build a page visually is to watch it change. Waiting for the
   * autosave and a revalidate would leave the row looking empty for over a
   * second and — worse — show the "nothing you picked is published" warning
   * while the picks were in fact perfectly fine.
   *
   * The picker has already fetched these products to draw its own list, so
   * handing them over costs nothing and needs no round-trip.
   */
  const [pickedProducts, setPickedProducts] = useState<Map<string, StorefrontProduct[]>>(new Map())

  /*
   * Which section the picker is editing, held in a ref so `resolvePicks` keeps
   * a STABLE identity. The picker calls it from an effect that depends on it —
   * a fresh function each render would re-run that effect forever.
   */
  const pickingFor = useRef<string | null>(null)
  pickingFor.current = selectedId

  const resolvePicks = useCallback((products: StorefrontProduct[]) => {
    const id = pickingFor.current
    if (!id) return
    setPickedProducts((prev) => {
      // Same products in the same order means nothing to do. Without this the
      // set would be replaced on every resolve, re-rendering the whole canvas
      // for no change.
      const before = prev.get(id)
      if (before?.length === products.length && before.every((p, i) => p.id === products[i].id)) {
        return prev
      }
      const next = new Map(prev)
      next.set(id, products)
      return next
    })
  }, [])

  /*
   * Banner pictures known to the browser: those the server resolved, plus any
   * chosen since the page loaded.
   *
   * Same reasoning as `pickedProducts` — choosing a picture must show it
   * immediately, not after the autosave and a revalidate. The picker has
   * already loaded the image to draw its own grid, so handing it over costs
   * nothing.
   */
  const [knownImages, setKnownImages] = useState<Map<number, StorefrontImage>>(
    () => new Map(images.map((i) => [i.id, i])),
  )

  const rememberImage = useCallback((image: StorefrontImage | null) => {
    if (!image) return
    setKnownImages((prev) => (prev.has(image.id) ? prev : new Map(prev).set(image.id, image)))
  }, [])

  const content: SectionContent[] = sections.map((section) => {
    const resolved = contentById.get(section.id)
    const local = pickedProducts.get(section.id)
    return {
      ...resolved,
      // Only a hand-picked row is overridden. A rule's contents are the
      // server's to decide — this map has no idea what "the newest eight" is.
      ...(local && section.source === 'manual' ? { products: local } : {}),
      // A banner's picture is whatever its id currently resolves to. Taken
      // from the local map rather than the server's copy so a just-chosen one
      // appears at once, and so a section whose picture was deleted correctly
      // resolves to null.
      ...(section.kind === 'banner'
        ? { image: section.imageId ? knownImages.get(section.imageId) ?? null : null }
        : {}),
      // A carousel's slides, resolved the same way and for the same reason: a
      // picture chosen a moment ago must appear at once, and a slide whose
      // picture was deleted must correctly resolve to nothing.
      ...(section.kind === 'carousel'
        ? { slideImages: slideImagesFor(section, knownImages) }
        : {}),
      section,
    }
  })

  // What is on the server right now, so the dirty check compares like with
  // like. Normalised on both sides — see normaliseSections' key-order note.
  const savedJson = useRef(JSON.stringify(normaliseSections(draft ?? published)))
  const publishedJson = useMemo(() => JSON.stringify(normaliseSections(published)), [published])
  const currentJson = JSON.stringify(sections)
  const hasUnpublished = currentJson !== publishedJson

  // Autosave the draft. Debounced, because this fires on every keystroke in
  // the inspector and a write per character would be absurd.
  useEffect(() => {
    if (currentJson === savedJson.current) return
    setSaveState('saving')
    const timer = setTimeout(async () => {
      const result = await saveDraftAction(page.id, sections)
      if (result.ok) {
        savedJson.current = currentJson
        setSaveState('saved')
      } else {
        toast.error(result.error)
        setSaveState('idle')
      }
    }, AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [currentJson, sections, toast, page.id])

  // Flash "Saved" briefly once an autosave lands, then fall back to idle.
  // Without this the 'saved' state was computed but never shown, so the bar
  // went silently from "Saving…" back to its resting text.
  useEffect(() => {
    if (saveState !== 'saved') return
    const timer = setTimeout(() => setSaveState('idle'), 2500)
    return () => clearTimeout(timer)
  }, [saveState])

  /*
   * Ctrl+Z and Ctrl+Shift+Z, on the document.
   *
   * Bound at document level because the thing being undone is the PAGE, and
   * the focus at the time is usually a heading field in the inspector or
   * nothing at all — a handler on the canvas would never fire.
   *
   * Which is also why a text field has to be excluded: inside an input, Ctrl+Z
   * already means "undo my typing", and hijacking it to remove a whole section
   * instead is precisely the kind of surprise undo exists to prevent. The
   * browser's own history handles the field; this handles the page.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey && !event.metaKey) return
      if (event.key.toLowerCase() !== 'z') return

      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  const patch = useCallback(
    (id: string, changes: Partial<HomeSection>) => {
      commit((prev) => prev.map((s) => (s.id === id ? { ...s, ...changes } : s)))
    },
    [commit],
  )

  /**
   * Drag-and-drop reorder: lift `from` out and drop it where `to` sits.
   *
   * A SPLICE, not a swap. Dragging a section from the bottom to the top should
   * push everything else down one, not trade places with whatever happened to
   * be there — swapping is what makes a drag feel like it did the wrong thing.
   */
  function reorder(from: string, to: string) {
    commit((prev) => {
      const fromIndex = prev.findIndex((s) => s.id === from)
      const toIndex = prev.findIndex((s) => s.id === to)
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }

  /** Add a section at a given position. `add` is this, at the end. */
  function insert(kind: SectionKind, index: number) {
    if (sections.length >= MAX_SECTIONS) {
      toast.error(`A page can hold ${MAX_SECTIONS} sections.`)
      return
    }
    const section = newSection(kind)
    commit((prev) => {
      const next = [...prev]
      next.splice(Math.min(Math.max(index, 0), next.length), 0, section)
      return next
    })
    setSelectedId(section.id)
  }

  function add(kind: SectionKind) {
    insert(kind, sections.length)
  }

  /**
   * Drop a saved section onto this page, at the end.
   *
   * A COPY with a fresh id, and fresh ids for anything inside it that has one.
   * Adding the same saved section twice would otherwise put two sections with
   * the same key on one page — and the nested ids matter for the same reason
   * they do in `duplicate`: a shared slide id makes dragging one carousel's
   * slide reorder the other's.
   */
  /**
   * Move the section at `index` one place, for the outline's arrows.
   *
   * By INDEX rather than by the two ids `reorder` takes: the outline knows
   * where a row sits and wants "one place up", and translating that back into
   * a pair of ids at the call site would just be this function inlined.
   */
  function moveByIndex(index: number, by: number) {
    const to = index + by
    if (to < 0 || to >= sections.length) return
    commit((prev) => {
      const next = [...prev]
      const [moved] = next.splice(index, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  function insertSaved(saved: HomeSection) {
    if (sections.length >= MAX_SECTIONS) {
      toast.error(`A page can hold ${MAX_SECTIONS} sections.`)
      return
    }
    const copy: HomeSection = {
      ...saved,
      id: newId(saved.kind),
      productIds: saved.productIds ? [...saved.productIds] : undefined,
      logoImageIds: saved.logoImageIds ? [...saved.logoImageIds] : undefined,
      cards: saved.cards?.map((c) => ({ ...c })),
      slides: saved.slides?.map((s) => ({ ...s, id: newSlide().id })),
      quotes: saved.quotes?.map((q) => ({ ...q, id: newQuote().id })),
      blocks: saved.blocks?.map((b) => ({ ...b, spans: b.spans.map((s) => ({ ...s })) })),
    }
    commit((prev) => [...prev, copy])
    setSelectedId(copy.id)
    toast.success('Added at the bottom of the page.')
  }

  /**
   * Copy a section, and put the copy directly beneath the original.
   *
   * Beneath rather than at the end, because the reason to duplicate is almost
   * always "another one of these" — a second product row for a different
   * department — and landing it at the bottom of the page means dragging it
   * back to where it was wanted.
   *
   * A fresh id, and productIds copied rather than shared: the two rows are
   * independent from the moment they exist, and a shared array would make
   * editing one silently edit the other.
   */
  function duplicate(id: string) {
    if (sections.length >= MAX_SECTIONS) {
      toast.error(`A page can hold ${MAX_SECTIONS} sections.`)
      return
    }
    const source = sections.find((s) => s.id === id)
    if (!source) return

    const copy: HomeSection = {
      ...source,
      id: newId(source.kind),
      productIds: source.productIds ? [...source.productIds] : undefined,
      cards: source.cards?.map((c) => ({ ...c })),
      // Fresh slide ids, not merely a fresh array: an id is the drag key in the
      // slide editor, and two carousels sharing them would make dragging a
      // slide in one reorder the other.
      slides: source.slides?.map((s) => ({ ...s, id: newSlide().id })),
      // Fresh quote ids for the same reason as slides: an id is the reorder
      // key, and two sections sharing them would move the wrong quote.
      quotes: source.quotes?.map((q) => ({ ...q, id: newQuote().id })),
      // Copied rather than shared — same reasoning as productIds. A shared
      // array would make editing one section silently edit the other.
      logoImageIds: source.logoImageIds ? [...source.logoImageIds] : undefined,
      blocks: source.blocks?.map((b) => ({ ...b, spans: b.spans.map((s) => ({ ...s })) })),
    }
    commit((prev) => {
      const index = prev.findIndex((s) => s.id === id)
      const next = [...prev]
      next.splice(index + 1, 0, copy)
      return next
    })
    setSelectedId(copy.id)
  }

  function remove(id: string) {
    commit((prev) => prev.filter((s) => s.id !== id))
    if (selectedId === id) setSelectedId(null)
    // Said out loud, because the section vanishes from under the cursor and
    // the only clue it can come back is a button in a toolbar above.
    toast.info('Section removed. Undo puts it back.')
  }

  /**
   * Start again from a ready-made page.
   *
   * REPLACES rather than appends — a preset is a page, not a pile of sections,
   * and appending one to an existing page produces neither. Undo covers it,
   * which is why this is a confirmation rather than a refusal.
   */
  function applyPreset(preset: PagePreset) {
    const next = preset.sections.map((s) => ({ ...s, id: newId(s.kind) }))
    commit(next)
    setSelectedId(next[0]?.id ?? null)
    setPresetsOpen(false)
    toast.success(`Started from “${preset.name}”. Undo puts your page back.`)
  }

  /*
   * What publishing would change, worked out in the browser from the two
   * arrays it already holds. No round trip: this has to be ready the instant
   * the owner reaches for Publish, or the dialog appears after the decision
   * rather than before it.
   */
  const changes = useMemo(
    () => describeLayoutChanges(published, sections),
    [published, sections],
  )

  /*
   * Problems worth mentioning before this goes live. Computed in the browser
   * from the sections it already holds, for the same reason the change list is:
   * it has to be ready the instant the owner reaches for Publish.
   */
  const warnings = useMemo(() => pageWarnings(sections), [sections])

  // Silent for every ready-made swatch; speaks only for a typed colour that
  // fails — see brandColourProblem.
  const colourProblem = useMemo(() => brandColourProblem(theme.brandColour), [theme.brandColour])

  function publish() {
    setConfirmOpen(false)
    startAction(async () => {
      // Flush the draft first: publishing copies the SERVER's draft, so an
      // unsaved keystroke would otherwise be silently left behind.
      await saveDraftAction(page.id, sections)
      savedJson.current = currentJson

      const result = await publishDraftAction(page.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        page.kind === 'home' ? 'Your shop front page is live.' : `“${page.title}” is live.`,
      )
      router.refresh()
    })
  }

  /**
   * Open this page's draft on the real shop, in a new tab.
   *
   * ── THE TAB IS OPENED BEFORE THE AWAIT, NOT AFTER ────────────────────
   *
   * A browser only allows `window.open` while it can still attribute the call
   * to a click. Minting the link first and opening the tab afterwards puts an
   * await in between, by which point the gesture has expired and every popup
   * blocker silently swallows it — which looks exactly like a broken button.
   *
   * So the tab is opened empty and immediately, and its location is set once
   * the link comes back. If the action fails the tab is closed again, so a
   * failure does not leave a blank window sitting there.
   */
  function openPreview() {
    const tab = window.open('', '_blank')
    startAction(async () => {
      const result = await previewLinkAction(page.id, sections)
      if (!result.ok) {
        tab?.close()
        toast.error(result.error)
        return
      }
      // The draft was flushed server-side to mint this, so the local copy is
      // now what is saved — recording that stops the autosave writing it again.
      savedJson.current = currentJson
      if (tab) tab.location.href = result.url
      // Blocked despite the synchronous open. Better to say so than to leave
      // the owner clicking a button that appears to do nothing.
      else toast.error('Your browser blocked the new tab. Allow pop-ups for this site.')
    })
  }

  function discard() {
    startAction(async () => {
      await discardDraftAction(page.id)
      // Through commit, so discarding is itself undoable: it is the most
      // destructive button on the screen, and the one most easily hit by
      // someone who meant "undo my last change".
      commit(normaliseSections(published))
      savedJson.current = publishedJson
      toast.success('Back to what customers can see.')
      router.refresh()
    })
  }

  function saveThemeChanges() {
    startAction(async () => {
      const result = await saveThemeAction(theme)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // Theme is NOT part of the draft — it applies to the shop immediately,
      // so say so rather than letting an owner think Publish is still pending.
      toast.success('Appearance saved and live.')
      router.refresh()
    })
  }

  return (
    <>
      <Card>
        <CardBody className="flex flex-wrap items-center gap-3">
          {/*
            Which page is being edited, and how to reach the others.

            A menu rather than tabs: a shop can have thirty pages, and thirty
            tabs is a scrollbar. It sits FIRST in the bar because it answers
            "what am I looking at" — a question the rest of the bar assumes you
            already know the answer to.
          */}
          {pages.length > 1 && (
            <Menu
              variant="secondary"
              align="left"
              label={
                <>
                  <Icons.LayoutGrid size={15} />
                  <span className="max-w-40 truncate">{page.title || 'Front page'}</span>
                  <Icons.ChevronDown size={14} />
                </>
              }
            >
              {pages.map((p) => (
                <MenuItem
                  key={p.id}
                  onClick={() => router.push(`/online-store/builder?page=${p.id}`)}
                >
                  {p.title || 'Untitled'}
                  {/* Said here, because the reason to switch pages is often
                      "which one did I leave half-finished". */}
                  {p.hasDraft && <span className="ml-2 text-xs text-warning-ink">Draft</span>}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onClick={() => router.push('/online-store/pages')}>
                Manage pages…
              </MenuItem>
            </Menu>
          )}

          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">
              {hasUnpublished ? 'You have changes customers cannot see yet' : 'Your page is live'}
            </p>
            <p className="text-sm text-muted">
              {saveState === 'saving'
                ? 'Saving your draft…'
                : saveState === 'saved'
                  ? 'Draft saved.'
                  : /* A pending schedule outranks the usual nudge: "publish
                       when you are happy with it" is misleading advice for a
                       page that is going to publish itself tonight. */
                    page.publishAt
                    ? `Going live by itself at ${page.publishAt.replace('T', ', ')}.`
                    : hasUnpublished
                      ? 'Publish when you are happy with it.'
                      : 'Everything here is what shoppers see.'}
            </p>
          </div>

          {/* Undo first, and always visible rather than only when there is
              something to undo: a control that appears and disappears is one
              nobody learns the position of. */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              iconOnly
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              disabled={history.past.length === 0}
              onClick={undo}
            >
              <Icons.Undo size={15} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Redo"
              title="Redo (Ctrl+Shift+Z)"
              disabled={history.future.length === 0}
              onClick={redo}
            >
              <Icons.Redo size={15} />
            </Button>
          </div>

          {/* Straight to THIS page on the real shop, not the shop's front
              door: on a policy page, "View shop" landing on the home page
              means finding it again by hand.

              Only when it is actually reachable — an unpublished page would
              open the shop's own "we couldn't find that", which looks like a
              fault rather than the state it is. */}
          {/*
            Walk the draft on the real shop.

            Offered whatever the page's published state, unlike "View shop":
            previewing something not yet live is the entire point, and an
            unpublished page is exactly the one an owner most wants to check.
            A closed shop is the one case it cannot work — the storefront
            serves nothing at all — so it is hidden there rather than handing
            over a link that 404s.
          */}
          {storeOpen && (
            <Button variant="ghost" onClick={openPreview} disabled={busy}>
              <Icons.Eye size={15} />
              Preview
            </Button>
          )}

          {storeOpen && (page.kind === 'home' || page.isPublished) && (
            <a
              href={page.kind === 'standard' ? `${storePath}/page/${page.slug}` : storePath}
              target="_blank"
              rel="noreferrer"
            >
              <Button variant="ghost">
                <Icons.ExternalLink size={15} />
                View shop
              </Button>
            </a>
          )}
          {hasUnpublished && (
            <Button variant="secondary" onClick={discard} disabled={busy}>
              Discard changes
            </Button>
          )}
          {/* Publishing later. Beside Publish rather than buried in a panel,
              because it is the same decision with a different moment attached
              — and an owner who has decided to go live tonight should not have
              to hunt for where to say so. */}
          <Button variant="ghost" onClick={() => setScheduleOpen(true)} disabled={busy}>
            <Icons.Clock size={15} />
            {page.publishAt ? 'Scheduled' : 'Later'}
          </Button>

          {/* Opens the summary rather than publishing outright. This is the
              one button on the screen that changes what the public sees, and
              it was the only one with nothing between the click and the
              consequence. */}
          <Button
            variant="primary"
            onClick={() => setConfirmOpen(true)}
            disabled={busy || !hasUnpublished}
          >
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
        </CardBody>
      </Card>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Publish these changes?"
        description="This is what shoppers will see change."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Not yet
            </Button>
            <Button variant="primary" onClick={publish} disabled={busy}>
              {busy ? 'Publishing…' : 'Publish'}
            </Button>
          </>
        }
      >
        {/*
          What is wrong with the page, above the change list.

          Above, because it is the thing that might change the decision — a
          summary read after the fact is a summary nobody acts on. Never a
          blocker: see `pageWarnings` on why a publish that can be refused is
          one that refuses somebody at the worst possible moment.
        */}
        {warnings.length > 0 && (
          <div className="mb-4">
            <Callout tone="warning" title="Worth a look first">
              <ul className="mt-1 flex flex-col gap-0.5">
                {warnings.map((w) => (
                  <li key={w.label} className="text-sm">
                    {w.label}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm">
                You can publish anyway — a description is what a shopper using a screen reader
                hears where the picture is.
              </p>
            </Callout>
          </div>
        )}

        {changes.length === 0 ? (
          /*
            Reachable: the theme is saved separately and is live already, so an
            owner who only changed colours has a page that differs in nothing.
            Saying so is better than an empty box that looks broken.
          */
          <p className="text-sm text-muted">
            Nothing on the page itself has changed. Publishing will do no harm — it simply
            republishes the same layout.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {changes.map((change, index) => (
              <li key={index} className="flex items-start gap-2.5">
                <Badge tone={CHANGE_TONE[change.kind]}>{CHANGE_LABEL[change.kind]}</Badge>
                <span className="min-w-0 flex-1 text-sm text-ink">
                  {change.label}
                  {change.detail && <span className="text-muted"> — {change.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <Modal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        title="Publish this page later"
        description="It goes live by itself, with whatever is in the draft at that moment."
        footer={
          <>
            {/* Cancelling a schedule is a distinct action from closing the
                dialog, so it is its own button rather than "set it to blank". */}
            {page.publishAt && (
              <Button
                variant="danger-ghost"
                disabled={busy}
                onClick={() =>
                  startAction(async () => {
                    const result = await schedulePublishAction(page.id, '', sections)
                    if (!result.ok) {
                      toast.error(result.error)
                      return
                    }
                    setScheduleOpen(false)
                    toast.success('It will not publish by itself now.')
                    router.refresh()
                  })
                }
              >
                Cancel the schedule
              </Button>
            )}
            <Button variant="secondary" onClick={() => setScheduleOpen(false)}>
              Close
            </Button>
            <Button
              variant="primary"
              disabled={busy || !scheduleAt.trim()}
              onClick={() =>
                startAction(async () => {
                  const result = await schedulePublishAction(page.id, scheduleAt, sections)
                  if (!result.ok) {
                    toast.error(result.error)
                    return
                  }
                  savedJson.current = currentJson
                  setScheduleOpen(false)
                  toast.success('Set. It will go live by itself.')
                  router.refresh()
                })
              }
            >
              Schedule it
            </Button>
          </>
        }
      >
        <Field
          label="Go live at"
          hint="Your own clock, not the shopper’s. It can be a few minutes late, never early."
        >
          <Input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
          />
        </Field>

        {/*
          Said before they commit. Scheduling captures the draft as it is now
          and the page keeps taking edits afterwards — so what goes live is
          whatever the draft holds at the moment it fires, not a frozen copy.
          That is the useful behaviour and the surprising one.
        */}
        <p className="mt-3 text-sm text-muted">
          Whatever is in your draft when the time comes is what goes live. Carry on editing until
          then and those changes go too.
        </p>
      </Modal>

      {/*
        Restoring replaces whatever is in the draft, so it asks first — unlike
        every other control here, this one destroys work that undo cannot reach
        (the draft on the SERVER, not the session's history).
      */}
      <ConfirmModal
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        title="Put this version back?"
        message="Your current unpublished changes to this page will be replaced. Nothing goes live until you publish."
        confirmLabel="Put it back"
        tone="primary"
        onConfirm={() => {
          const version = restoring
          if (!version) return
          setRestoring(null)
          startAction(async () => {
            const result = await restoreVersionAction(page.id, version.id)
            if (!result.ok) {
              toast.error(result.error)
              return
            }
            toast.success('Loaded. Publish when you are happy with it.')
            router.refresh()
          })
        }}
      />

      {/* Naming a section to reuse. A dialog rather than an inline field
          because the name is the only input and it wants a moment's thought —
          it is what the owner will scan for on another page. */}
      <Modal
        open={savingSection !== null}
        onClose={() => setSavingSection(null)}
        title="Save this section"
        description="Keep it to drop onto another page later."
        footer={
          <>
            <Button variant="secondary" onClick={() => setSavingSection(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !saveName.trim()}
              onClick={() => {
                const section = savingSection
                if (!section) return
                startAction(async () => {
                  const result = await saveSectionAction(saveName, section)
                  if (!result.ok) {
                    toast.error(result.error)
                    return
                  }
                  setSavingSection(null)
                  toast.success('Saved. You will find it under “Add a saved section”.')
                  router.refresh()
                })
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Field label="Call it" hint="Something you will recognise on another page.">
          <Input
            value={saveName}
            maxLength={80}
            autoFocus
            placeholder="e.g. Delivery cards"
            onChange={(e) => setSaveName(e.target.value)}
          />
        </Field>
        {/* Said plainly, because "template" is the word owners will expect and
            this is deliberately not one — see 074. */}
        <p className="mt-3 text-sm text-muted">
          This takes a copy. Editing it here later will not change the saved one, and using the
          saved one will not change this page.
        </p>
      </Modal>

      {/* The inspector collapses, because the canvas is drawing a whole shop
          in whatever is left over — and at 360px of panel on a laptop that is
          not much. */}
      <div
        className={`grid gap-5 lg:items-start ${
          inspectorOpen ? 'lg:grid-cols-[1fr_360px]' : 'lg:grid-cols-[1fr_auto]'
        }`}
      >
        {/* The page itself, live. Not a list of section names — the actual
            storefront, arranged in place. See BuilderCanvas. */}
        <Card className="overflow-hidden p-0">
          <BuilderCanvas
            sections={sections}
            content={content}
            theme={theme}
            display={display}
            storeName={storeName}
            blurb={blurb}
            departments={publishedDepartments}
            selected={selectedId}
            width={width}
            pageKind={page.kind}
            onWidthChange={setWidth}
            onSelect={(id) => {
              setSelectedId(id)
              // Selecting a section with the panel shut is a request to edit
              // it, and there is nowhere to do that until the panel is back.
              setInspectorOpen(true)
            }}
            onReorder={reorder}
            onToggle={(id, enabled) => patch(id, { enabled })}
            onAdd={add}
            onInsert={insert}
            onDuplicate={duplicate}
            onRemove={remove}
            onSelectAppearance={() => {
              setSelectedId(null)
              setInspectorOpen(true)
            }}
          />
        </Card>

        {!inspectorOpen ? (
          <div className="lg:sticky lg:top-4">
            <Button
              variant="secondary"
              iconOnly
              aria-label="Show the settings panel"
              title="Show the settings panel"
              onClick={() => setInspectorOpen(true)}
            >
              <Icons.PanelLeft size={15} />
            </Button>
          </div>
        ) : (
        /* Whatever is selected. */
        <div className="flex flex-col gap-5">
          {selected ? (
            <Card>
              <CardHeader
                title={SECTION_LABEL[selected.kind]}
                description={SECTION_HINT[selected.kind]}
                action={
                  <div className="flex items-center gap-1">
                    {/* Keeping a section is a property of the section, so it
                        lives on the section's own panel rather than in a
                        toolbar that would have to say which one it meant. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label="Save this section to use again"
                      title="Save to use again"
                      onClick={() => {
                        setSaveName(sectionName(selected))
                        setSavingSection(selected)
                      }}
                    >
                      <Icons.Star size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label="Hide the settings panel"
                      title="Hide the settings panel"
                      onClick={() => setInspectorOpen(false)}
                    >
                      <Icons.Close size={15} />
                    </Button>
                  </div>
                }
              />
              <CardBody className="flex flex-col gap-4">
                <Field label="Heading" hint="Leave blank for no heading.">
                  <Input
                    value={selected.title}
                    maxLength={80}
                    onChange={(e) => patch(selected.id, { title: e.target.value })}
                  />
                </Field>

                <div className="flex items-center justify-between gap-4 rounded-control bg-surface-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">Show this section</p>
                    <p className="text-sm text-muted">Off keeps it here but hides it.</p>
                  </div>
                  {/* aria-label rather than `label`: the row beside it already
                      says "Show this section", and passing it again rendered
                      the words twice — once as the heading and once wrapping
                      against the toggle. */}
                  <Switch
                    checked={selected.enabled}
                    onChange={(next) => patch(selected.id, { enabled: next })}
                    ariaLabel="Show this section"
                  />
                </div>

                {selected.kind === 'products' && (
                  <>
                    <Field
                      label="Fill this row with"
                      hint={describeSource(selected.source ?? 'manual', page.kind).hint}
                    >
                      <Select
                        value={selected.source ?? 'manual'}
                        onChange={(e) =>
                          patch(selected.id, { source: e.target.value as HomeSection['source'] })
                        }
                      >
                        {sourcesFor(page.kind).map((source) => (
                          <option key={source} value={source}>
                            {describeSource(source, page.kind).label}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    {selected.source === 'department' && (
                      <Field
                        label="Which department"
                        hint={
                          departments.length === 0
                            ? 'You are not publishing any departments yet.'
                            : undefined
                        }
                      >
                        <Select
                          value={String(selected.departmentId ?? '')}
                          onChange={(e) =>
                            patch(selected.id, {
                              departmentId: e.target.value ? Number(e.target.value) : null,
                            })
                          }
                        >
                          <option value="">Choose a department</option>
                          {departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}

                    {selected.source === 'manual' && (
                      <ProductPicker
                        value={selected.productIds ?? []}
                        onChange={(productIds) => patch(selected.id, { productIds })}
                        onResolve={resolvePicks}
                        departments={publishedDepartments}
                      />
                    )}

                    {/* Only a RULE needs a count. A hand-picked row shows what
                        was picked — offering "how many" beside a list of 5
                        would invite the owner to set 8 and wonder where the
                        other 3 went. */}
                    {selected.source !== 'manual' && (
                      <Field label="How many to show">
                        <NumberInput
                          value={selected.maxItems ?? 8}
                          min={1}
                          max={24}
                          onChange={(e) =>
                            patch(selected.id, { maxItems: Number(e.target.value) || 8 })
                          }
                          className="w-24"
                        />
                      </Field>
                    )}

                    {/* Per-row, overriding the shop-wide choice under
                        Appearance. A specials row wants tiles even in a shop
                        that lists everything else. */}
                    <Field
                      label="How this row looks"
                      hint="“Same as my shop” follows the setting under Appearance."
                    >
                      <Select
                        value={selected.layout ?? ''}
                        onChange={(e) =>
                          patch(selected.id, {
                            layout: e.target.value === '' ? null : (e.target.value as 'grid' | 'list'),
                          })
                        }
                      >
                        <option value="">Same as my shop</option>
                        <option value="grid">Grid of tiles</option>
                        <option value="list">A list</option>
                      </Select>
                    </Field>
                  </>
                )}

                {selected.kind === 'banner' && (
                  <>
                    <Field label="Picture">
                      <PicturePicker
                        value={selected.imageId ?? null}
                        current={
                          selected.imageId ? knownImages.get(selected.imageId) ?? null : null
                        }
                        onChange={(image) => {
                          rememberImage(image)
                          patch(selected.id, {
                            imageId: image?.id ?? null,
                            // The library's own description, unless this
                            // banner has already been given one — a section
                            // that says something specific must not be
                            // overwritten by picking a different picture.
                            imageAlt: selected.imageAlt || image?.altText || '',
                          })
                        }}
                      />
                    </Field>

                    <Field
                      label="Describe the picture"
                      hint="Read aloud to shoppers who cannot see it."
                    >
                      <Input
                        value={selected.imageAlt ?? ''}
                        maxLength={190}
                        placeholder="e.g. Fresh bread on a wooden counter"
                        onChange={(e) => patch(selected.id, { imageAlt: e.target.value })}
                      />
                    </Field>

                    {/*
                      Only once a picture is actually chosen: warning about a
                      missing description before there is anything to describe
                      is nagging, and a warning that is usually noise is one
                      nobody reads by the time it matters.

                      A hint on the field would not do — an empty optional
                      field reads as "leave this if you like", which is exactly
                      the wrong impression. A shopper using a screen reader
                      gets nothing at all from an undescribed banner.
                    */}
                    {selected.imageId && !(selected.imageAlt ?? '').trim() && (
                      <Callout tone="warning" title="No description yet">
                        Shoppers using a screen reader will hear nothing where this picture is.
                        A few words about what it shows is enough.
                      </Callout>
                    )}

                    <Field label="Words over the picture" hint="Optional — leave blank for none.">
                      <Textarea
                        value={selected.bodyText ?? ''}
                        rows={2}
                        maxLength={300}
                        onChange={(e) => patch(selected.id, { bodyText: e.target.value })}
                      />
                    </Field>

                    <Field
                      label="Where it goes when clicked"
                      hint="A full https:// link, or a page of your own shop. Blank means it is not a link."
                    >
                      <Input
                        value={selected.linkUrl ?? ''}
                        maxLength={300}
                        placeholder="https://…"
                        onChange={(e) => patch(selected.id, { linkUrl: e.target.value })}
                      />
                    </Field>

                    {/* See isBareShopPath: "/store" passes validation and 404s
                        on the live shop, which the owner cannot tell from here. */}
                    {isBareShopPath(selected.linkUrl ?? '') && <BareShopPathWarning />}

                    {/* Only offered once there is somewhere to go — a button
                        that does nothing is worse than no button. */}
                    {(selected.linkUrl ?? '').trim() !== '' && (
                      <Field label="Button" hint="Leave blank to show no button.">
                        <Input
                          value={selected.buttonLabel ?? ''}
                          maxLength={40}
                          placeholder="Shop now"
                          onChange={(e) => patch(selected.id, { buttonLabel: e.target.value })}
                        />
                      </Field>
                    )}
                  </>
                )}

                {selected.kind === 'carousel' && (
                  <SlideEditor
                    slides={selected.slides ?? []}
                    autoplaySeconds={selected.autoplaySeconds ?? DEFAULT_AUTOPLAY_SECONDS}
                    knownImages={knownImages}
                    onRememberImage={rememberImage}
                    onChange={(slides) => patch(selected.id, { slides })}
                    onAutoplayChange={(autoplaySeconds) =>
                      patch(selected.id, { autoplaySeconds })
                    }
                  />
                )}

                {selected.kind === 'text' && (
                  <>
                    <Field
                      label="What it says"
                      hint={`${(selected.text ?? '').length} of ${MAX_SECTION_TEXT} characters. Line breaks are kept.`}
                    >
                      <Textarea
                        value={selected.text ?? ''}
                        rows={6}
                        maxLength={MAX_SECTION_TEXT}
                        placeholder="Deliveries go out on Tuesdays and Fridays."
                        onChange={(e) => patch(selected.id, { text: e.target.value })}
                      />
                    </Field>

                    <Field label="Line it up">
                      <Select
                        value={selected.align ?? 'left'}
                        onChange={(e) =>
                          patch(selected.id, { align: e.target.value as 'left' | 'center' })
                        }
                      >
                        <option value="left">Left</option>
                        <option value="center">Centred</option>
                      </Select>
                    </Field>
                  </>
                )}

                {selected.kind === 'split' && (
                  <>
                    <Field label="Picture">
                      <PicturePicker
                        value={selected.imageId ?? null}
                        current={
                          selected.imageId ? knownImages.get(selected.imageId) ?? null : null
                        }
                        onChange={(image) => {
                          rememberImage(image)
                          patch(selected.id, {
                            imageId: image?.id ?? null,
                            imageAlt: selected.imageAlt || image?.altText || '',
                          })
                        }}
                      />
                    </Field>

                    <Field
                      label="Describe the picture"
                      hint="Read aloud to shoppers who cannot see it."
                    >
                      <Input
                        value={selected.imageAlt ?? ''}
                        maxLength={190}
                        placeholder="e.g. Our bakers at 5am"
                        onChange={(e) => patch(selected.id, { imageAlt: e.target.value })}
                      />
                    </Field>

                    {/* Same rule as a banner: only once there is a picture to
                        describe. Nagging before then is noise. */}
                    {selected.imageId && !(selected.imageAlt ?? '').trim() && (
                      <Callout tone="warning" title="No description yet">
                        Shoppers using a screen reader will hear nothing where this picture is.
                      </Callout>
                    )}

                    <Field label="Which side the picture sits on">
                      <Select
                        value={selected.side ?? 'left'}
                        onChange={(e) =>
                          patch(selected.id, { side: e.target.value as 'left' | 'right' })
                        }
                      >
                        <option value="left">Picture on the left</option>
                        <option value="right">Picture on the right</option>
                      </Select>
                    </Field>

                    <Field label="Your words" hint="Line breaks are kept.">
                      <Textarea
                        value={selected.bodyText ?? ''}
                        rows={5}
                        maxLength={MAX_SECTION_TEXT}
                        placeholder="We have been baking on this corner since 1974."
                        onChange={(e) => patch(selected.id, { bodyText: e.target.value })}
                      />
                    </Field>

                    <Field
                      label="Where the button goes"
                      hint="A full https:// link, or a page of your own shop."
                    >
                      <Input
                        value={selected.linkUrl ?? ''}
                        maxLength={300}
                        placeholder="https://…"
                        onChange={(e) => patch(selected.id, { linkUrl: e.target.value })}
                      />
                    </Field>

                    {isBareShopPath(selected.linkUrl ?? '') && <BareShopPathWarning />}

                    {(selected.linkUrl ?? '').trim() !== '' && (
                      <Field label="Button" hint="Leave blank to show no button.">
                        <Input
                          value={selected.buttonLabel ?? ''}
                          maxLength={40}
                          placeholder="Read our story"
                          onChange={(e) => patch(selected.id, { buttonLabel: e.target.value })}
                        />
                      </Field>
                    )}
                  </>
                )}

                {selected.kind === 'reviews' && (
                  <>
                    {/*
                      Said first, because it is the thing an owner needs to
                      know before touching anything else: this row fills itself
                      from the review queue and cannot be hand-picked.
                    */}
                    <Callout tone="neutral" title="These come from your review queue">
                      Only reviews you have approved appear here, newest first. Nothing you write
                      goes in this section — use “Quotes” for that.
                    </Callout>

                    <Field label="How many to show">
                      <NumberInput
                        value={selected.maxItems ?? 6}
                        min={1}
                        max={24}
                        onChange={(e) =>
                          patch(selected.id, { maxItems: Number(e.target.value) || 6 })
                        }
                        className="w-24"
                      />
                    </Field>

                    <Field
                      label="Only show reviews of at least"
                      hint="Approving a review means it is real, not that it is an advertisement. This keeps the honest low ones on the product page without leading your front page with them."
                    >
                      <Select
                        value={String(selected.minRating ?? 4)}
                        onChange={(e) =>
                          patch(selected.id, { minRating: Number(e.target.value) })
                        }
                      >
                        <option value="5">5 stars only</option>
                        <option value="4">4 stars and up</option>
                        <option value="3">3 stars and up</option>
                        <option value="1">Every approved review</option>
                      </Select>
                    </Field>

                    <Field label="From one department" hint="Or leave it on all of them.">
                      <Select
                        value={String(selected.departmentId ?? '')}
                        onChange={(e) =>
                          patch(selected.id, {
                            departmentId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      >
                        <option value="">Every department</option>
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </>
                )}

                {selected.kind === 'countdown' && (
                  <>
                    <Field
                      label="Counting down to"
                      hint={
                        specials.length === 0
                          ? 'You have no specials running. Type a date and time instead.'
                          : 'A special keeps itself right — extend the sale and the clock follows.'
                      }
                    >
                      <Select
                        value={String(selected.specialId ?? '')}
                        onChange={(e) =>
                          patch(selected.id, {
                            specialId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      >
                        <option value="">A date I type myself</option>
                        {specials.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    {/*
                      Only when it is NOT bound to a special. Showing both
                      would invite an owner to set a date the special overrides
                      — a field whose value is silently ignored.
                    */}
                    {!selected.specialId && (
                      <Field label="Ends at" hint="Your own clock, not the shopper’s.">
                        <Input
                          type="datetime-local"
                          value={selected.endsAt ?? ''}
                          onChange={(e) => patch(selected.id, { endsAt: e.target.value })}
                        />
                      </Field>
                    )}

                    {selected.specialId !== null && selected.specialId !== undefined && (
                      <Callout tone="neutral" title="Following that special">
                        The clock reads the special’s own end time every time somebody loads the
                        page, so changing the sale changes the clock.
                      </Callout>
                    )}

                    <Field label="Under the heading" hint="Optional.">
                      <Input
                        value={selected.bodyText ?? ''}
                        maxLength={300}
                        placeholder="Everything in store, while stocks last"
                        onChange={(e) => patch(selected.id, { bodyText: e.target.value })}
                      />
                    </Field>

                    <Field
                      label="What it says afterwards"
                      hint="Leave blank and the whole section disappears when the time is up."
                    >
                      <Input
                        value={selected.finishedText ?? ''}
                        maxLength={120}
                        placeholder="This sale has ended."
                        onChange={(e) => patch(selected.id, { finishedText: e.target.value })}
                      />
                    </Field>
                  </>
                )}

                {selected.kind === 'richtext' && (
                  <RichTextEditor
                    blocks={selected.blocks ?? []}
                    onChange={(blocks) => patch(selected.id, { blocks })}
                  />
                )}

                {selected.kind === 'testimonial' && (
                  <QuoteEditor
                    quotes={selected.quotes ?? []}
                    onChange={(quotes) => patch(selected.id, { quotes })}
                  />
                )}

                {selected.kind === 'logos' && (
                  <LogoEditor
                    imageIds={selected.logoImageIds ?? []}
                    knownImages={knownImages}
                    onRememberImage={rememberImage}
                    onChange={(logoImageIds) => patch(selected.id, { logoImageIds })}
                  />
                )}

                {selected.kind === 'signup' && (
                  <>
                    <Field label="Under the heading" hint="Why they should sign up.">
                      <Textarea
                        value={selected.bodyText ?? ''}
                        rows={2}
                        maxLength={300}
                        onChange={(e) => patch(selected.id, { bodyText: e.target.value })}
                      />
                    </Field>

                    <Field label="Button">
                      <Input
                        value={selected.buttonLabel ?? ''}
                        maxLength={40}
                        placeholder="Sign up"
                        onChange={(e) => patch(selected.id, { buttonLabel: e.target.value })}
                      />
                    </Field>

                    <Field
                      label="What they are agreeing to"
                      hint="Kept with every sign-up, exactly as worded when they ticked it."
                    >
                      <Textarea
                        value={selected.consentText ?? ''}
                        rows={3}
                        maxLength={300}
                        onChange={(e) => patch(selected.id, { consentText: e.target.value })}
                      />
                    </Field>

                    {/*
                      Blank is not allowed to pass quietly. Normalisation puts
                      the default back, so the shop is never left collecting
                      addresses with nothing on the record — but an owner who
                      cleared the box deliberately should be told why it filled
                      itself in again.
                    */}
                    {!(selected.consentText ?? '').trim() && (
                      <Callout tone="warning" title="This cannot be blank">
                        A sign-up form has to say what somebody is agreeing to, and your record
                        has to show it. Leaving this empty puts the standard wording back.
                      </Callout>
                    )}

                    <Field label="What it says afterwards" hint="Once they have signed up.">
                      <Input
                        value={selected.thanksText ?? ''}
                        maxLength={200}
                        placeholder="Thank you — you are on the list."
                        onChange={(e) => patch(selected.id, { thanksText: e.target.value })}
                      />
                    </Field>

                    <Callout tone="neutral" title={`${subscriberCount} on your list`}>
                      Sign-ups are kept with the date and the exact wording they agreed to, so you
                      can show permission was given.
                    </Callout>
                  </>
                )}

                {selected.kind === 'video' && (
                  <>
                    <Field label="Where it is">
                      <Select
                        value={selected.videoProvider ?? 'youtube'}
                        onChange={(e) =>
                          patch(selected.id, {
                            videoProvider: e.target.value as 'youtube' | 'vimeo',
                          })
                        }
                      >
                        <option value="youtube">YouTube</option>
                        <option value="vimeo">Vimeo</option>
                      </Select>
                    </Field>

                    <Field
                      label="Paste the link"
                      hint="The whole address from your browser is fine — we take the bit we need."
                    >
                      <Input
                        value={selected.videoId ?? ''}
                        placeholder="https://www.youtube.com/watch?v=…"
                        /*
                          Reduced to an id on the way IN, so what is stored is
                          always an id and never a URL. Doing it here rather
                          than only in normalisation means the owner sees
                          immediately that we understood their paste.
                        */
                        onChange={(e) =>
                          patch(selected.id, {
                            videoId: videoIdFrom(
                              e.target.value,
                              selected.videoProvider ?? 'youtube',
                            ),
                          })
                        }
                      />
                    </Field>

                    {(selected.videoId ?? '').trim() !== '' && (
                      <p className="text-sm text-muted">
                        Using video <span className="font-medium text-ink">{selected.videoId}</span>.
                      </p>
                    )}
                  </>
                )}

                {selected.kind === 'map' && (
                  <>
                    <Field label="Your address" hint="Line breaks are kept.">
                      <Textarea
                        value={selected.addressText ?? ''}
                        rows={4}
                        maxLength={300}
                        placeholder={'12 Main Road\nGreen Point\nCape Town 8005'}
                        onChange={(e) => patch(selected.id, { addressText: e.target.value })}
                      />
                    </Field>

                    <Field
                      label="Link to directions"
                      hint="Open your shop in Google Maps and paste the address bar here."
                    >
                      <Input
                        value={selected.mapUrl ?? ''}
                        maxLength={500}
                        placeholder="https://maps.google.com/…"
                        onChange={(e) => patch(selected.id, { mapUrl: e.target.value })}
                      />
                    </Field>
                  </>
                )}

                {selected.kind === 'spacer' && (
                  <Field label="How much room">
                    <Select
                      value={selected.size ?? 'medium'}
                      onChange={(e) =>
                        patch(selected.id, { size: e.target.value as 'small' | 'medium' | 'large' })
                      }
                    >
                      <option value="small">A little</option>
                      <option value="medium">Some</option>
                      <option value="large">A lot</option>
                    </Select>
                  </Field>
                )}

                {selected.kind === 'divider' && (
                  <p className="text-sm text-muted">
                    A line, and nothing to set. Use the background below if you want the parts
                    either side to look different too.
                  </p>
                )}

                {selected.kind === 'categories' && (
                  <Field label="How many to show" hint="0 shows every published department.">
                    <NumberInput
                      value={selected.maxItems ?? 0}
                      min={0}
                      max={24}
                      onChange={(e) =>
                        patch(selected.id, { maxItems: Number(e.target.value) || 0 })
                      }
                      className="w-24"
                    />
                  </Field>
                )}

                {selected.kind === 'cards' && (
                  <CardEditor
                    cards={selected.cards ?? []}
                    onChange={(cards) => patch(selected.id, { cards })}
                  />
                )}

                {selected.kind === 'hero' && (
                  <p className="text-sm text-muted">
                    The words come from the welcome message below, so they stay the same
                    wherever your shop is introduced.
                  </p>
                )}

                {/* Last, and on every kind: it is a finishing touch, not a
                    thing to decide before the section has any content. */}
                <Field
                  label="Background"
                  hint="A tinted band makes a long page read as several parts."
                >
                  <Select
                    value={selected.tone ?? 'plain'}
                    onChange={(e) =>
                      patch(selected.id, { tone: e.target.value as HomeSection['tone'] })
                    }
                  >
                    <option value="plain">Plain</option>
                    <option value="tinted">A tint of your colour</option>
                  </Select>
                </Field>

                <FieldGroup
                  title="When to show it"
                  hint="Leave both blank to show it all the time."
                >
                  <div className="flex gap-3">
                    <Field label="From">
                      <Input
                        type="date"
                        value={selected.showFrom ?? ''}
                        onChange={(e) => patch(selected.id, { showFrom: e.target.value })}
                      />
                    </Field>
                    <Field label="Until">
                      <Input
                        type="date"
                        value={selected.showUntil ?? ''}
                        onChange={(e) => patch(selected.id, { showUntil: e.target.value })}
                      />
                    </Field>
                  </div>

                  {/*
                    Both ends are INCLUSIVE, and that is worth one sentence:
                    "until the 25th" meaning the 24th is exactly how a
                    Christmas banner comes down a day early.
                  */}
                  {(selected.showFrom || selected.showUntil) && (
                    <p className="text-sm text-muted">
                      {scheduleSentence(selected)}
                    </p>
                  )}

                  {/* A window that has already closed, or whose dates are the
                      wrong way round, is a section that will never appear
                      again — and nothing else on this screen would say so. */}
                  {selected.showFrom &&
                    selected.showUntil &&
                    selected.showUntil < selected.showFrom && (
                      <Callout tone="warning" title="Those dates are back to front">
                        The end is before the start, so this section will never show. Swap them.
                      </Callout>
                    )}
                </FieldGroup>
              </CardBody>
            </Card>
          ) : (
            <Card>
              <EmptyState
                icon={<Icons.LayoutGrid size={22} />}
                title="Nothing selected"
                hint="Click a section in the preview to edit it, or add a new one."
                action={
                  <Menu
                    variant="secondary"
                    label={
                      <>
                        <Icons.Plus size={15} />
                        Add a section
                      </>
                    }
                  >
                    {kindsFor(page.kind).map((kind) => (
                      <MenuItem key={kind} onClick={() => add(kind)}>
                        {SECTION_LABEL[kind]}
                      </MenuItem>
                    ))}
                  </Menu>
                }
              />
            </Card>
          )}

          {/* Ready-made pages. Below the inspector rather than above it: this
              is where somebody looks when they do not know what to do next,
              and it must not be the first thing offered to somebody who
              already has a page they like.

              Front page only: every preset is a SHOP WINDOW — a welcome, some
              departments, a row of products. Applying one to a Returns policy
              would replace it with a storefront, which is not a starting point
              for the thing being edited. */}
          {page.kind === 'home' && (
          <Card>
            <CardHeader
              title="Start from a ready-made page"
              description="Replaces your page. Undo puts it back."
              action={
                <Button variant="ghost" size="sm" onClick={() => setPresetsOpen((o) => !o)}>
                  {presetsOpen ? 'Hide' : 'Show'}
                </Button>
              }
            />
            {presetsOpen && (
              <CardBody className="flex flex-col gap-2">
                {/* ChoiceTile, not SelectableCard: applying a preset acts and
                    moves on — there is no "chosen preset" for a tile to keep
                    showing afterwards, because the page is then just a page. */}
                {PAGE_PRESETS.map((preset) => (
                  <ChoiceTile
                    key={preset.key}
                    layout="inline"
                    title={preset.name}
                    description={preset.hint}
                    onClick={() => applyPreset(preset)}
                  />
                ))}
              </CardBody>
            )}
          </Card>
          )}

          {/*
            The page as a list.

            Above the presets and the saved sections because it is about the
            page being edited right now, and below the inspector because the
            inspector is what the owner is actually working in. Only once a
            page is long enough to be hard to scan — on four sections the
            canvas IS the outline, and a second copy of it is noise.
          */}
          {sections.length > OUTLINE_FROM && (
            <Card>
              <CardHeader
                title="Everything on this page"
                description={`${sections.length} sections. Click one to edit it.`}
                action={
                  <Button variant="ghost" size="sm" onClick={() => setOutlineOpen((o) => !o)}>
                    {outlineOpen ? 'Hide' : 'Show'}
                  </Button>
                }
              />
              {outlineOpen && (
                <CardBody>
                  <Outline
                    sections={sections}
                    selected={selectedId}
                    onSelect={setSelectedId}
                    onMove={moveByIndex}
                    onToggle={(id, enabled) => patch(id, { enabled })}
                  />
                </CardBody>
              )}
            </Card>
          )}

          {/*
            Sections kept from anywhere in the shop.

            This is also how a section gets from one page to another: save it
            there, add it here. A dedicated "copy to page" control would need a
            page picker, a destination-position picker, and would drop the
            section somewhere the owner is not looking — this puts it where
            they are, on the page they are already editing.
          */}
          {savedSections.length > 0 && (
            <Card>
              <CardHeader
                title="Saved sections"
                description="Add a copy to this page. Editing it here leaves the saved one alone."
              />
              <CardBody className="flex flex-col gap-2">
                {savedSections.map((saved) => (
                  <div
                    key={saved.id}
                    className="flex items-center gap-2 rounded-control bg-surface-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{saved.name}</p>
                      <p className="text-sm text-muted">
                        {SECTION_LABEL[saved.section.kind] ?? saved.kind}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || sections.length >= MAX_SECTIONS}
                      onClick={() => insertSaved(saved.section)}
                    >
                      Add
                    </Button>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Forget “${saved.name}”`}
                      title="Forget this"
                      disabled={busy}
                      onClick={() =>
                        startAction(async () => {
                          await deleteSavedSectionAction(saved.id)
                          router.refresh()
                        })
                      }
                    >
                      <Icons.Trash size={14} />
                    </Button>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {/*
            What this page used to be.

            Below the presets, because it is a recovery tool rather than a
            building one — nobody opens the builder looking for it, and it must
            not compete with the controls somebody uses every time.
          */}
          {versions.length > 0 && (
            <Card>
              <CardHeader
                title="Earlier versions"
                description="Loads it back as a draft. Nothing goes live until you publish."
                action={
                  <Button variant="ghost" size="sm" onClick={() => setHistoryOpen((o) => !o)}>
                    {historyOpen ? 'Hide' : 'Show'}
                  </Button>
                }
              />
              {historyOpen && (
                <CardBody className="flex flex-col gap-2">
                  {versions.map((v) => (
                    <div
                      key={v.id}
                      className="flex items-center gap-3 rounded-control bg-surface-2 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink">
                          {v.replacedAt.toLocaleString('en-ZA', {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                        <p className="text-sm text-muted">
                          {v.sectionCount} section{v.sectionCount === 1 ? '' : 's'}
                          {v.replacedBy && ` · replaced by ${v.replacedBy}`}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => setRestoring(v)}
                      >
                        Put back
                      </Button>
                    </div>
                  ))}
                </CardBody>
              )}
            </Card>
          )}

          {/* Appearance is NOT part of the draft — see saveThemeChanges. */}
          <Card>
            <CardHeader
              title="Appearance"
              description="Applies to your shop as soon as you save it."
            />
            {/* Grouped by what the owner is doing — one undifferentiated
                column of eight fields is where these settings got lost. */}
            <CardBody className="flex flex-col gap-4">
              <FieldGroup title="Look">
                {/* From the SAME library the banners use, so a shop uploads
                    its logo once and can reuse it anywhere. */}
                <Field
                  label="Your logo"
                  hint="Shown at the top of every page, in place of your shop’s name."
                >
                  <PicturePicker
                    value={theme.logoImageId}
                    current={theme.logoImageId ? knownImages.get(theme.logoImageId) ?? null : null}
                    onChange={(image) => {
                      rememberImage(image)
                      setTheme({ ...theme, logoImageId: image?.id ?? null })
                    }}
                  />
                </Field>

                <Field label="Your colour" hint="Used for buttons and highlights.">
                  <div className="flex flex-col gap-2">
                    <ColourInput
                      value={theme.brandColour}
                      onChange={(brandColour) => setTheme({ ...theme, brandColour })}
                    />
                    <SwatchRow
                      value={theme.brandColour}
                      onChange={(brandColour) => setTheme({ ...theme, brandColour })}
                    />
                  </div>
                </Field>

                {/*
                  Only for a colour that actually fails — every swatch above
                  passes, so this is silent unless the owner typed their own.
                  A warning that is usually noise is one nobody reads by the
                  time it matters.
                */}
                {colourProblem && (
                  <Callout tone="warning" title="This colour may be hard to read">
                    <p className="text-sm">{colourProblem}</p>
                    {/*
                      The two failures shown rather than described. An owner
                      looking at their own colour behind white text decides in
                      a second what a contrast ratio would never convey — and
                      the button below is exactly what their shop will draw.
                    */}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex h-control items-center rounded-control px-4 text-sm font-medium text-white"
                        style={{ background: theme.brandColour }}
                      >
                        Add to basket
                      </span>
                      <span
                        className="inline-flex h-control items-center rounded-control bg-white px-4 text-sm font-medium"
                        style={{ color: theme.brandColour }}
                      >
                        A link on your shop
                      </span>
                    </div>
                    <p className="mt-2 text-sm">
                      You can keep it — the ready-made colours above are all safe if you would
                      rather not.
                    </p>
                  </Callout>
                )}

                <Field
                  label="Your typeface"
                  hint="Loaded from your own shop, so nothing is requested from anywhere else."
                >
                  <Select
                    value={theme.fontKey}
                    onChange={(e) =>
                      setTheme({ ...theme, fontKey: e.target.value as StorefrontTheme['fontKey'] })
                    }
                  >
                    {FONT_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {FONT_LABEL[key]}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Product layout">
                  <Select
                    value={theme.productLayout}
                    onChange={(e) =>
                      setTheme({ ...theme, productLayout: e.target.value as 'grid' | 'list' })
                    }
                  >
                    <option value="grid">Grid of tiles</option>
                    <option value="list">A list</option>
                  </Select>
                </Field>
              </FieldGroup>

              {/*
                What a shared link looks like.

                Its own group because it is the one part of Appearance nobody
                sees on the shop itself — it only shows up in somebody else's
                chat window, which is exactly why it goes unnoticed until a
                customer mentions the link "looks broken".
              */}
              <FieldGroup
                title="When someone shares your link"
                hint="Shown on WhatsApp and Facebook."
              >
                <Field
                  label="The picture"
                  hint="Wide works best — about twice as wide as it is tall."
                >
                  <PicturePicker
                    value={theme.shareImageId}
                    current={
                      theme.shareImageId ? knownImages.get(theme.shareImageId) ?? null : null
                    }
                    onChange={(image) => {
                      rememberImage(image)
                      setTheme({ ...theme, shareImageId: image?.id ?? null })
                    }}
                  />
                </Field>

                {/* Only when there is nothing set, and worded as what happens
                    rather than as a fault — plenty of shops will never notice
                    or care, and a permanent warning about an optional field is
                    one nobody reads by the time it matters. */}
                {!theme.shareImageId && (
                  <Callout tone="neutral" title="No picture yet">
                    Your link shows a plain card with just your shop’s name. A picture is what
                    makes somebody tap it.
                  </Callout>
                )}
              </FieldGroup>

              <FieldGroup
                title="Announcement strip"
                hint="A band above everything, on every page of your shop."
              >
                <Field label="What it says" hint="Leave blank for no strip at all.">
                  <Input
                    value={theme.announceText}
                    maxLength={200}
                    placeholder="Free delivery on orders over R500"
                    onChange={(e) => setTheme({ ...theme, announceText: e.target.value })}
                  />
                </Field>

                {/* Only once there is something to click on. A link field on an
                    empty strip is a setting for a thing that does not exist. */}
                {theme.announceText.trim() !== '' && (
                  <>
                    <Field
                      label="Where it goes when clicked"
                      hint="Optional. A full https:// link, or a page of your own shop."
                    >
                      <Input
                        value={theme.announceLink}
                        maxLength={300}
                        placeholder="https://…"
                        onChange={(e) => setTheme({ ...theme, announceLink: e.target.value })}
                      />
                    </Field>

                    {isBareShopPath(theme.announceLink) && <BareShopPathWarning />}

                    <div className="flex gap-3">
                      <Field label="From">
                        <Input
                          type="date"
                          value={theme.announceFrom}
                          onChange={(e) => setTheme({ ...theme, announceFrom: e.target.value })}
                        />
                      </Field>
                      <Field label="Until">
                        <Input
                          type="date"
                          value={theme.announceUntil}
                          onChange={(e) => setTheme({ ...theme, announceUntil: e.target.value })}
                        />
                      </Field>
                    </div>

                    {/*
                      Dates matter more here than on a section, because an
                      announcement is almost always an offer — and a strip still
                      promising free delivery a week after the promotion ended
                      is worse than no strip at all. Said as a sentence for the
                      same reason a section's schedule is: two date boxes are a
                      specification, a sentence is something you can check.
                    */}
                    <p className="text-sm text-muted">{announceSentence(theme)}</p>

                    {theme.announceFrom &&
                      theme.announceUntil &&
                      theme.announceUntil < theme.announceFrom && (
                        <Callout tone="warning" title="Those dates are back to front">
                          The end is before the start, so the strip will never show. Swap them.
                        </Callout>
                      )}
                  </>
                )}
              </FieldGroup>

              {/*
                The welcome words belong to the FRONT page's hero section, and
                nowhere else renders them. Offering them while editing a
                Delivery page is a control that appears to do something and
                does not — the owner types a headline, saves, and nothing on
                the page they are looking at changes.

                Hidden rather than disabled: a greyed-out field still says
                "this is a setting of the thing you are editing", which is the
                bit that is untrue.
              */}
              {page.kind === 'home' && (
                <FieldGroup title="Front page">
                  <Field label="Welcome headline" hint="The big line on your front page.">
                    <Input
                      value={theme.heroHeadline}
                      maxLength={120}
                      placeholder="e.g. Fresh every morning"
                      onChange={(e) => setTheme({ ...theme, heroHeadline: e.target.value })}
                    />
                  </Field>

                  <Field label="Under the headline">
                    <Textarea
                      value={theme.heroSubtext}
                      rows={2}
                      maxLength={300}
                      onChange={(e) => setTheme({ ...theme, heroSubtext: e.target.value })}
                    />
                  </Field>
                </FieldGroup>
              )}

              <FieldGroup title="Footer" hint="Shown at the bottom of every shop page.">
                <Field label="Opening hours">
                  <Textarea
                    value={theme.footerHours}
                    rows={2}
                    maxLength={400}
                    placeholder="Mon–Fri 8am–5pm, Sat 8am–1pm"
                    onChange={(e) => setTheme({ ...theme, footerHours: e.target.value })}
                  />
                </Field>

                <Field label="About your shop" hint="A line or two.">
                  <Textarea
                    value={theme.footerAbout}
                    rows={2}
                    maxLength={600}
                    onChange={(e) => setTheme({ ...theme, footerAbout: e.target.value })}
                  />
                </Field>

                <Field label="Facebook" hint="Optional — the full link.">
                  <div className="max-w-64">
                    <Input
                      value={theme.socialFacebook}
                      placeholder="https://facebook.com/yourshop"
                      onChange={(e) => setTheme({ ...theme, socialFacebook: e.target.value })}
                    />
                  </div>
                </Field>

                <Field label="Instagram" hint="Optional.">
                  <div className="max-w-64">
                    <Input
                      value={theme.socialInstagram}
                      placeholder="https://instagram.com/yourshop"
                      onChange={(e) => setTheme({ ...theme, socialInstagram: e.target.value })}
                    />
                  </div>
                </Field>

                <Field label="WhatsApp number" hint="Optional.">
                  <div className="w-44">
                    <Input
                      value={theme.socialWhatsapp}
                      placeholder="27821234567"
                      onChange={(e) => setTheme({ ...theme, socialWhatsapp: e.target.value })}
                    />
                  </div>
                </Field>
              </FieldGroup>
            </CardBody>
            <CardFooter>
              {/* secondary: the screen's one primary is Publish, in the bar
                  above — two primaries is zero primaries. */}
              <Button variant="secondary" onClick={saveThemeChanges} disabled={busy}>
                Save appearance
              </Button>
            </CardFooter>
          </Card>

          {!storeOpen && (
            <Card>
              <div className="flex items-start gap-3 px-5 py-4">
                <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
                <p className="text-sm text-muted">
                  Your shop is closed, so nobody can see this page yet.{' '}
                  <Link
                    href="/online-store/setup"
                    className="font-medium text-brand hover:underline"
                  >
                    Open it in setup
                  </Link>
                </p>
              </div>
            </Card>
          )}

          {/*
            Publishing a LAYOUT and publishing a PAGE are two different things,
            and this is the one place that distinction bites: an owner can
            arrange a Delivery page, hit Publish, see "it's live" — and still
            have a page no shopper can reach, because the page itself was never
            switched on. Nothing else on this screen would say so.

            Not shown for the front page, which is always reachable when the
            shop is open.
          */}
          {page.kind !== 'home' && !page.isPublished && (
            <Card>
              <div className="flex items-start gap-3 px-5 py-4">
                <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
                <p className="text-sm text-muted">
                  This page is not switched on, so it is not on your shop yet — publishing here
                  only saves the arrangement.{' '}
                  <Link href="/online-store/pages" className="font-medium text-brand hover:underline">
                    Switch it on under Pages
                  </Link>
                </p>
              </div>
            </Card>
          )}
        </div>
        )}
      </div>
    </>
  )
}

/**
 * The schedule, said back in a sentence.
 *
 * Dates in two boxes are a specification; a sentence is what an owner can
 * check. It also states the thing the boxes cannot — that both ends are
 * inclusive, and whether the window is on right now.
 */
function scheduleSentence(section: HomeSection): string {
  const from = section.showFrom?.trim() ?? ''
  const until = section.showUntil?.trim() ?? ''
  const live = isScheduledNow(section)
  const today = shopToday()

  const window = from && until
    ? `Shows from ${from} to ${until}, both days included.`
    : from
      ? `Shows from ${from} onwards.`
      : `Shows until the end of ${until}.`

  if (live) return `${window} That includes today.`
  return from && today < from
    ? `${window} It is not showing yet.`
    : `${window} It has finished showing.`
}

/**
 * A row of ready-made brand colours.
 *
 * Sits UNDER the colour field rather than replacing it: a shop with real brand
 * colours must be able to type theirs, and a shop without one should not have
 * to invent a hex code to get started.
 *
 * The swatches are the store's own data — see BRAND_SWATCHES in
 * storefrontModel — so the inline background is a value, not a style choice
 * this screen is making. `data-kit-ok`: a swatch is a colour with a hit area,
 * and a Button variant for it would be used nowhere else.
 */
function SwatchRow({ value, onChange }: { value: string; onChange: (colour: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {BRAND_SWATCHES.map((colour) => {
        const active = colour.toLowerCase() === value.toLowerCase()
        return (
          <button
            data-kit-ok
            key={colour}
            type="button"
            onClick={() => onChange(colour)}
            aria-label={`Use ${colour}`}
            aria-pressed={active}
            className="size-7 rounded-pill border border-border transition hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:hover:scale-100"
            style={{
              background: colour,
              ...(active ? { outline: '2px solid var(--color-ink)', outlineOffset: 2 } : {}),
            }}
          />
        )
      })}
    </div>
  )
}

/** The repeating editor for an info-cards section. */
/**
 * The slides of a rotating banner.
 *
 * ── ONE OPEN AT A TIME ───────────────────────────────────────────────────
 *
 * A slide has six fields. Eight slides expanded is forty-eight controls in a
 * 360px panel, which is not an editor so much as a wall — and the thing an
 * owner is actually doing most of the time is looking at the ORDER, which that
 * wall makes impossible to see.
 *
 * So each slide is a row showing its picture and its heading, and opens when
 * clicked. Closed rows stay small enough that the whole carousel is visible at
 * once, which is what reordering needs.
 */
function SlideEditor({
  slides,
  autoplaySeconds,
  knownImages,
  onRememberImage,
  onChange,
  onAutoplayChange,
}: {
  slides: BannerSlide[]
  autoplaySeconds: number
  knownImages: Map<number, StorefrontImage>
  onRememberImage: (image: StorefrontImage | null) => void
  onChange: (slides: BannerSlide[]) => void
  onAutoplayChange: (seconds: number) => void
}) {
  /** Which slide is expanded. Null means all closed. */
  const [openId, setOpenId] = useState<string | null>(slides[0]?.id ?? null)

  const edit = (id: string, changes: Partial<BannerSlide>) =>
    onChange(slides.map((s) => (s.id === id ? { ...s, ...changes } : s)))

  /** Move a slide one place, which is how the ORDER is set — see the header. */
  const move = (index: number, by: number) => {
    const to = index + by
    if (to < 0 || to >= slides.length) return
    const next = [...slides]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {slides.length === 0 && (
        <p className="text-sm text-muted">
          No pictures yet. Add one below — a rotating banner needs at least two to turn.
        </p>
      )}

      {slides.map((slide, index) => {
        const open = openId === slide.id
        const picture = slide.imageId ? knownImages.get(slide.imageId) ?? null : null

        return (
          <div key={slide.id} className="flex flex-col gap-3 rounded-control bg-surface-2 p-3">
            {/* The row: what this slide is, and where it sits. */}
            <div className="flex items-center gap-2">
              {/* Opens the slide. Not a kit Button — it is a summary row with a
                  thumbnail in it, and a Button would fight its own padding. */}
              <button
                data-kit-ok
                type="button"
                onClick={() => setOpenId(open ? null : slide.id)}
                aria-expanded={open}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-control text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <Icons.ChevronRight
                  size={14}
                  className={`shrink-0 text-muted transition ${open ? 'rotate-90' : ''}`}
                />
                {/* The picture itself, because that is what identifies a slide
                    — a list of "Slide 1, Slide 2" tells the owner nothing about
                    which is which. */}
                {picture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/storefront-images/${picture.id}`}
                    alt=""
                    className="size-9 shrink-0 rounded-control border border-border object-cover"
                  />
                ) : (
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-control border border-dashed border-border-strong text-muted">
                    <Icons.Picture size={14} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {slide.heading.trim() || `Picture ${index + 1}`}
                  </span>
                  {!slide.imageId && (
                    <span className="block text-xs text-warning-ink">No picture yet</span>
                  )}
                </span>
              </button>

              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Move picture ${index + 1} up`}
                title="Move up"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <Icons.ChevronUp size={14} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Move picture ${index + 1} down`}
                title="Move down"
                disabled={index === slides.length - 1}
                onClick={() => move(index, 1)}
              >
                <Icons.ChevronDown size={14} />
              </Button>
              <Button
                variant="danger-ghost"
                size="sm"
                iconOnly
                aria-label={`Remove picture ${index + 1}`}
                onClick={() => onChange(slides.filter((s) => s.id !== slide.id))}
              >
                <Icons.Trash size={14} />
              </Button>
            </div>

            {open && (
              <div className="flex flex-col gap-3 border-t border-border pt-3">
                <Field label="Picture">
                  <PicturePicker
                    value={slide.imageId}
                    current={picture}
                    onChange={(image) => {
                      onRememberImage(image)
                      edit(slide.id, {
                        imageId: image?.id ?? null,
                        // The library's description unless this slide already
                        // has its own — same rule as a single banner.
                        imageAlt: slide.imageAlt || image?.altText || '',
                      })
                    }}
                  />
                </Field>

                <Field
                  label="Describe the picture"
                  hint="Read aloud to shoppers who cannot see it."
                >
                  <Input
                    value={slide.imageAlt}
                    maxLength={190}
                    placeholder="e.g. Fresh bread on a wooden counter"
                    onChange={(e) => edit(slide.id, { imageAlt: e.target.value })}
                  />
                </Field>

                {/* Same rule as a single banner: only once there is a picture
                    to describe. Nagging before then is noise, and a warning
                    that is usually noise is one nobody reads. */}
                {slide.imageId && !slide.imageAlt.trim() && (
                  <Callout tone="warning" title="No description yet">
                    Shoppers using a screen reader will hear nothing where this picture is.
                  </Callout>
                )}

                <Field label="Words over the picture" hint="Optional — leave blank for none.">
                  <Input
                    value={slide.heading}
                    maxLength={80}
                    placeholder="Headline"
                    onChange={(e) => edit(slide.id, { heading: e.target.value })}
                  />
                </Field>

                <Field label="Under the headline">
                  <Textarea
                    value={slide.bodyText}
                    rows={2}
                    maxLength={300}
                    onChange={(e) => edit(slide.id, { bodyText: e.target.value })}
                  />
                </Field>

                <Field
                  label="Where it goes when clicked"
                  hint="A full https:// link, or a page of your own shop."
                >
                  <Input
                    value={slide.linkUrl}
                    maxLength={300}
                    placeholder="https://…"
                    onChange={(e) => edit(slide.id, { linkUrl: e.target.value })}
                  />
                </Field>

                {/* A slide is a banner, so it gets the banner's warning too —
                    see isBareShopPath. */}
                {isBareShopPath(slide.linkUrl) && <BareShopPathWarning />}

                {/* Only once there is somewhere to go — a button that does
                    nothing is worse than no button. */}
                {slide.linkUrl.trim() !== '' && (
                  <Field label="Button" hint="Leave blank to show no button.">
                    <Input
                      value={slide.buttonLabel}
                      maxLength={40}
                      placeholder="Shop now"
                      onChange={(e) => edit(slide.id, { buttonLabel: e.target.value })}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
        )
      })}

      {slides.length < MAX_SLIDES ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const slide = newSlide()
            onChange([...slides, slide])
            // Opened, because the next thing anybody does after adding a slide
            // is choose its picture.
            setOpenId(slide.id)
          }}
        >
          <Icons.Plus size={15} />
          Add a picture
        </Button>
      ) : (
        <p className="text-sm text-muted">
          {MAX_SLIDES} pictures is the most one rotating banner can hold.
        </p>
      )}

      {/*
        How fast it turns, and whether it turns at all.

        Below the slides because it is a property of the whole set, and because
        it is the thing an owner decides once — after the pictures are in.
      */}
      <FieldGroup title="Turning">
        <Field
          label="Seconds on each picture"
          hint={
            autoplaySeconds === 0
              ? 'Shoppers move it themselves with the arrows.'
              : `Between ${MIN_AUTOPLAY_SECONDS} and ${MAX_AUTOPLAY_SECONDS} seconds. It stops while a shopper is looking at it.`
          }
        >
          <div className="flex items-center gap-3">
            <NumberInput
              value={autoplaySeconds}
              min={0}
              max={MAX_AUTOPLAY_SECONDS}
              disabled={autoplaySeconds === 0}
              onChange={(e) => {
                const seconds = Number(e.target.value)
                onAutoplayChange(
                  !Number.isFinite(seconds) || seconds <= 0
                    ? MIN_AUTOPLAY_SECONDS
                    : Math.min(Math.max(seconds, MIN_AUTOPLAY_SECONDS), MAX_AUTOPLAY_SECONDS),
                )
              }}
              className="w-24"
            />
            {/*
              A switch rather than "type 0", because 0 meaning "never" is a
              convention the owner has no way to guess — and typing 0 into a
              box whose hint says "between 4 and 30" reads as an error.
            */}
            <label className="flex items-center gap-2 text-sm text-ink">
              <Switch
                checked={autoplaySeconds > 0}
                onChange={(on) => onAutoplayChange(on ? DEFAULT_AUTOPLAY_SECONDS : 0)}
                ariaLabel="Turn by itself"
              />
              Turn by itself
            </label>
          </div>
        </Field>

        {/*
          Said once, where the decision is made. Owners ask for a carousel and
          then wonder why it sits still on their phone; this is the answer, and
          it is not a fault.
        */}
        {autoplaySeconds > 0 && (
          <p className="text-sm text-muted">
            Shoppers who have asked their device to reduce motion will see the first picture and
            the arrows, and it will not turn on its own.
          </p>
        )}
      </FieldGroup>
    </div>
  )
}

/**
 * Does this look like an in-shop path that is missing the shop's token?
 *
 * A storefront lives at /store/<token>/…, so "/store", "/page/delivery" and
 * "/c/4" are all paths that pass `safeLinkTarget` — they are same-origin and
 * harmless — and all 404 on the live shop. The owner cannot tell from the box
 * they typed it into, so the builder says so.
 *
 * Deliberately narrow: it flags only the prefixes the shop itself owns, so a
 * relative link to something outside the storefront is left alone.
 */
/**
 * The announcement strip's schedule, said back in a sentence.
 *
 * The same job `scheduleSentence` does for a section, and worth repeating for
 * the strip because this one is almost always an OFFER — the case where "is it
 * running right now" is the question the owner actually has, and two date
 * boxes cannot answer it.
 */
function announceSentence(theme: StorefrontTheme): string {
  const from = theme.announceFrom.trim()
  const until = theme.announceUntil.trim()
  if (!from && !until) return 'Showing all the time.'

  const window = from && until
    ? `Shows from ${from} to ${until}, both days included.`
    : from
      ? `Shows from ${from} onwards.`
      : `Shows until the end of ${until}.`

  if (announcementShowing(theme)) return `${window} It is showing now.`
  const today = shopToday()
  return from && today < from
    ? `${window} It is not showing yet.`
    : `${window} It has finished showing.`
}

/** Said the same way wherever a link can be typed. */
function BareShopPathWarning() {
  return (
    <Callout tone="warning" title="That link will not work">
      Your shop’s pages all sit under your own web address. Open your shop, copy the link from
      the address bar, and paste the whole thing here.
    </Callout>
  )
}

function isBareShopPath(href: string): boolean {
  const raw = href.trim()
  if (!raw.startsWith('/')) return false
  // Already carries a token — /store/<something>/… — so it is fine.
  if (/^\/store\/[^/]+\//.test(raw)) return false
  return /^\/(store|page|c|p)(\/|$)/.test(raw)
}

/**
 * The id inside a pasted video link.
 *
 * Owners paste what is in their address bar; asking them to find "the id" is
 * asking them to know how YouTube URLs are built. Every recognised shape is
 * reduced here, and anything unrecognised falls through to the same character
 * filter normalisation applies — so a bare id typed by hand still works.
 */
function videoIdFrom(input: string, provider: 'youtube' | 'vimeo'): string {
  const raw = input.trim()
  if (!raw) return ''

  // Not a URL at all — treat it as an id already.
  if (!/^https?:\/\//i.test(raw)) return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)

  try {
    const url = new URL(raw)
    if (provider === 'vimeo') {
      // vimeo.com/76979871 — the last all-digits path segment.
      const digits = url.pathname.split('/').filter((p) => /^\d+$/.test(p))
      return digits[digits.length - 1] ?? ''
    }
    // youtube.com/watch?v=ID
    const v = url.searchParams.get('v')
    if (v) return v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
    // youtu.be/ID and youtube.com/embed/ID both put it last.
    const last = url.pathname.split('/').filter(Boolean).pop() ?? ''
    return last.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  } catch {
    return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  }
}

/**
 * The formatted-writing editor.
 *
 * ── A LIST OF BLOCKS, NOT A CONTENTEDITABLE ──────────────────────────────
 *
 * A WYSIWYG surface would be a better typing experience and a much worse
 * bargain: contentEditable produces HTML, and the whole reason this kind
 * stores a tree is that we never want HTML from a browser reaching a page that
 * takes payments. Parsing it back into blocks means writing the sanitiser we
 * were avoiding.
 *
 * So each block is a textarea with a type beside it.
 *
 * ── FORMATTING FOLLOWS THE SELECTION ─────────────────────────────────────
 *
 * Bold, italic, colour and links apply to whatever is SELECTED in the
 * textarea, falling back to the whole line when nothing is. That is what makes
 * "call us on 021 555 0000" with only the number bold possible, and it is the
 * one thing the block-at-a-time version could not do.
 *
 * A textarea reports its selection as two offsets into plain text, and
 * `applyToSelection` takes exactly that — so this component never has to know
 * how a block is divided into spans, and the splitting logic stays testable
 * without a browser.
 *
 * Alignment and size stay per BLOCK, because that is what they are: half a
 * centred paragraph is not a thing.
 */
const ALIGN_LABEL: Record<RichAlign, string> = {
  left: 'Left',
  center: 'Centred',
  right: 'Right',
}

/**
 * The colours in the owner's words, not the token's.
 *
 * "Brand colour" rather than "brand" because the point is that it follows the
 * shop — an owner who reads "your shop's colour" understands that changing the
 * brand changes this, which is exactly the property that makes named colours
 * better than a picker.
 */
const COLOUR_LABEL: Record<RichColour, string> = {
  default: 'Normal colour',
  brand: 'Your shop’s colour',
  muted: 'Grey',
  success: 'Green',
  warning: 'Amber',
  danger: 'Red',
}

function RichTextEditor({
  blocks,
  onChange,
}: {
  blocks: RichBlock[]
  onChange: (blocks: RichBlock[]) => void
}) {
  /*
   * Which block is focused and what is selected inside it.
   *
   * Held in state rather than read on demand because the toolbar buttons take
   * focus when clicked, and by the time onClick runs the textarea's own
   * selection has already collapsed. Recording it as it changes is what makes
   * the buttons act on what the owner actually highlighted.
   */
  const [focused, setFocused] = useState<number | null>(null)
  const [range, setRange] = useState<{ from: number; to: number }>({ from: 0, to: 0 })

  const trackSelection = (index: number, el: HTMLTextAreaElement) => {
    setFocused(index)
    setRange({ from: el.selectionStart, to: el.selectionEnd })
  }

  /** The first span of a block — what an empty selection reads its state from. */
  const spanOf = (block: RichBlock): RichSpan => block.spans[0] ?? { text: '' }

  /**
   * The span the toolbar should show as active.
   *
   * With a selection that is the span the selection STARTS in, so highlighting
   * a bold word lights the bold button. With no selection it is the first
   * span, which is the whole line's formatting when the line is uniform.
   */
  const activeSpan = (block: RichBlock, index: number): RichSpan => {
    if (focused !== index || range.from === range.to) return spanOf(block)
    let cursor = 0
    for (const span of block.spans) {
      const end = cursor + span.text.length
      if (range.from < end) return span
      cursor = end
    }
    return spanOf(block)
  }

  /**
   * Apply a formatting change to the selection, or to the whole line when
   * there is none.
   *
   * Falling back to the whole line matters: pressing B with the cursor parked
   * somewhere is what an owner does when they mean "make this line bold", and
   * doing nothing would read as a broken button.
   */
  const format = (index: number, changes: Partial<Omit<RichSpan, 'text'>>) =>
    onChange(
      blocks.map((b, i) => {
        if (i !== index) return b
        const whole = richBlockText(b).length
        const selected = focused === index && range.from !== range.to
        return applyToSelection(b, selected ? range.from : 0, selected ? range.to : whole, changes)
      }),
    )

  /** Typing — keeps the formatting of whatever was not edited. */
  const retype = (index: number, text: string) =>
    onChange(blocks.map((b, i) => (i === index ? replaceBlockText(b, text) : b)))

  const setType = (index: number, type: RichBlockType) =>
    onChange(blocks.map((b, i) => (i === index ? { ...b, type } : b)))

  const setAlign = (index: number, align: RichAlign) =>
    onChange(blocks.map((b, i) => (i === index ? { ...b, align } : b)))

  /**
   * What the last paste left out, so it can be said out loud.
   *
   * Null until something is actually dropped. Silently truncating a pasted
   * document is the same class of invisible loss the span cap once had — the
   * owner sees writing that looks complete and finds out when a customer does.
   */
  const [pasteNote, setPasteNote] = useState<string | null>(null)

  /**
   * Pasting from Word, Google Docs or a web page.
   *
   * ── WHY THIS IS NOT A SANITISER ───────────────────────────────────────
   *
   * The clipboard's HTML is PARSED and converted to blocks, then thrown away.
   * Nothing it contained is stored and nothing unrecognised is passed through
   * — see richTextPaste.ts. This is the one way to accept pasted formatting
   * that does not walk back the decision RichBlock documents.
   *
   * The pasted blocks REPLACE the block that was pasted into when it is empty,
   * and are inserted after it when it is not. Replacing a line someone had
   * already written would be a destructive surprise; leaving an empty one
   * behind is just litter.
   */
  const paste = (index: number, event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const html = event.clipboardData.getData('text/html')
    const plain = event.clipboardData.getData('text/plain')

    // Nothing worth converting — let the browser do its ordinary thing, which
    // types the text into the textarea and keeps the caret where it should be.
    if (!html.trim() && !plain.includes('\n')) return

    const result = html.trim() ? parsePastedHtml(html) : blocksFromPastedText(plain)
    if (result.blocks.length === 0) return

    event.preventDefault()

    const target = blocks[index]
    const targetEmpty = !richBlockText(target ?? { type: 'p', spans: [] }).trim()
    const next = [...blocks]
    next.splice(targetEmpty ? index : index + 1, targetEmpty ? 1 : 0, ...result.blocks)

    const overflow = Math.max(0, next.length - MAX_RICH_BLOCKS)
    onChange(next.slice(0, MAX_RICH_BLOCKS))

    /*
     * Counted in BLOCKS, and called "lines" because that is what the editor
     * below calls them — every row in this panel is one. It is deliberately
     * not what the preview appears to show: three bullets are three lines
     * here and one list there, and the number has to match the thing the
     * owner is about to scroll through.
     */
    const kept = result.blocks.length - Math.min(result.blocks.length, overflow)
    const lost = result.dropped + overflow
    setPasteNote(
      lost > 0
        ? `Pasted ${kept} lines. ${lost} more did not fit — ${MAX_RICH_BLOCKS} is the most one of these can hold.`
        : `Pasted ${kept} lines. Colours are not carried over — set them here.`,
    )
  }

  const move = (index: number, by: number) => {
    const to = index + by
    if (to < 0 || to >= blocks.length) return
    const next = [...blocks]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {/*
        Said once, at the top, because "you can paste a whole document in here"
        is not something anybody would guess from a list of textareas — and
        retyping a page out of Word is exactly what this section is for.
      */}
      <Callout tone="neutral" title="Paste from Word or Google Docs">
        Headings, bold, lists and links come across. Colours do not — pick those here.
      </Callout>

      {pasteNote && (
        <Callout tone="neutral" title="Pasted">
          {pasteNote}
        </Callout>
      )}

      {blocks.map((block, index) => {
        const span = activeSpan(block, index)
        const align = block.align ?? 'left'
        const hasSelection = focused === index && range.from !== range.to
        return (
          <div key={index} className="flex flex-col gap-2 rounded-control bg-surface-2 p-3">
            <div className="flex items-center gap-2">
              <Select
                value={block.type}
                aria-label="What kind of line"
                className="w-36"
                onChange={(e) => setType(index, e.target.value as RichBlockType)}
              >
                <option value="h2">Big heading</option>
                <option value="h3">Heading</option>
                <option value="p">Paragraph</option>
                <option value="small">Small print</option>
                <option value="ul">Bullet</option>
                <option value="ol">Numbered</option>
              </Select>

              <div className="ml-auto flex items-center">
                <Button
                  variant={span.bold ? 'secondary' : 'ghost'}
                  size="sm"
                  iconOnly
                  aria-label="Bold"
                  aria-pressed={Boolean(span.bold)}
                  title={hasSelection ? 'Bold the selected words' : 'Bold this line'}
                  onClick={() => format(index, { bold: !span.bold })}
                >
                  <span className="text-sm font-bold">B</span>
                </Button>
                <Button
                  variant={span.italic ? 'secondary' : 'ghost'}
                  size="sm"
                  iconOnly
                  aria-label="Italic"
                  aria-pressed={Boolean(span.italic)}
                  title={hasSelection ? 'Italicise the selected words' : 'Italicise this line'}
                  onClick={() => format(index, { italic: !span.italic })}
                >
                  <span className="text-sm italic">I</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Move line ${index + 1} up`}
                  title="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <Icons.ChevronUp size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Move line ${index + 1} down`}
                  title="Move down"
                  disabled={index === blocks.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <Icons.ChevronDown size={14} />
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove line ${index + 1}`}
                  onClick={() => onChange(blocks.filter((_, i) => i !== index))}
                >
                  <Icons.Trash size={14} />
                </Button>
              </div>
            </div>

            {/*
              Alignment and colour on their own row, because the row above is
              already full and these two are the controls an owner hunts for.
            */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center" role="group" aria-label="How this line sits">
                {RICH_ALIGNS.map((option) => (
                  <Button
                    key={option}
                    variant={align === option ? 'secondary' : 'ghost'}
                    size="sm"
                    iconOnly
                    aria-label={ALIGN_LABEL[option]}
                    aria-pressed={align === option}
                    title={ALIGN_LABEL[option]}
                    onClick={() => setAlign(index, option)}
                  >
                    {option === 'left' ? (
                      <Icons.AlignLeft size={14} />
                    ) : option === 'center' ? (
                      <Icons.AlignCenter size={14} />
                    ) : (
                      <Icons.AlignRight size={14} />
                    )}
                  </Button>
                ))}
              </div>

              <Select
                value={span.colour ?? 'default'}
                aria-label={hasSelection ? 'Colour of the selected words' : 'Colour of this line'}
                className="w-40"
                onChange={(e) => format(index, { colour: e.target.value as RichColour })}
              >
                {RICH_COLOURS.map((option) => (
                  <option key={option} value={option}>
                    {COLOUR_LABEL[option]}
                  </option>
                ))}
              </Select>

              {/*
                Said only while something is selected, because that is the
                moment the buttons mean something different from what they did
                a second ago — and a permanent hint is one nobody reads.
              */}
              {hasSelection && (
                <p className="text-xs text-muted">Applies to the selected words.</p>
              )}
            </div>

            <Textarea
              value={richBlockText(block)}
              rows={block.type === 'h2' || block.type === 'h3' ? 1 : 3}
              maxLength={MAX_SPAN_TEXT}
              aria-label="What it says"
              placeholder={
                block.type === 'h2' || block.type === 'h3' ? 'A heading' : 'Write here'
              }
              onChange={(e) => {
                retype(index, e.target.value)
                trackSelection(index, e.target)
              }}
              /*
               * Both events, deliberately: `onSelect` covers dragging and
               * double-clicking, `onKeyUp` covers shift+arrow. Missing either
               * leaves the toolbar acting on a stale range, which is worse
               * than not having selection formatting at all — it silently
               * formats the wrong words.
               */
              onSelect={(e) => trackSelection(index, e.currentTarget)}
              onKeyUp={(e) => trackSelection(index, e.currentTarget)}
              onFocus={(e) => trackSelection(index, e.currentTarget)}
              onPaste={(e) => paste(index, e)}
            />

            <Field
              label={hasSelection ? 'Link the selected words to' : 'Link this line to'}
              hint="Optional. A full https:// link, or a page of your own shop."
            >
              <Input
                value={span.href ?? ''}
                maxLength={300}
                placeholder="https://…"
                onChange={(e) => format(index, { href: e.target.value })}
              />
            </Field>

            {/*
              ── WHY THIS WARNING EXISTS ───────────────────────────────────
              A shop lives at /store/<its own token>/…, so a link typed as
              "/store" or "/page/delivery" lands on a path with no token and
              404s. It looks perfectly reasonable in this box and is broken on
              the live shop, which is the worst combination — so it is caught
              here rather than discovered by a customer.
            */}
            {isBareShopPath(span.href ?? '') && <BareShopPathWarning />}
          </div>
        )
      })}

      {blocks.length < MAX_RICH_BLOCKS ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            onChange([
              ...blocks,
              // Matching the LAST block's type, because writing is usually a
              // run of the same thing — three bullets, then a paragraph — and
              // resetting to Paragraph every time means re-choosing on each.
              { type: blocks[blocks.length - 1]?.type ?? 'p', spans: [{ text: '' }] },
            ])
          }
        >
          <Icons.Plus size={15} />
          Add a line
        </Button>
      ) : (
        <p className="text-sm text-muted">
          {MAX_RICH_BLOCKS} lines is the most one of these can hold.
        </p>
      )}
    </div>
  )
}

/** The repeating editor for a quotes section. */
function QuoteEditor({
  quotes,
  onChange,
}: {
  quotes: Testimonial[]
  onChange: (quotes: Testimonial[]) => void
}) {
  const edit = (id: string, changes: Partial<Testimonial>) =>
    onChange(quotes.map((q) => (q.id === id ? { ...q, ...changes } : q)))

  return (
    <div className="flex flex-col gap-3">
      {/* Said once, where the confusion lives: this section and the reviews
          section look similar on the page and come from opposite places. */}
      <Callout tone="neutral" title="You write these yourself">
        For real reviews shoppers submitted, add a “What customers say” section instead.
      </Callout>

      {quotes.map((quote, index) => (
        <div key={quote.id} className="flex flex-col gap-2 rounded-control bg-surface-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink">Quote {index + 1}</p>
            <Button
              variant="danger-ghost"
              size="sm"
              iconOnly
              aria-label={`Remove quote ${index + 1}`}
              onClick={() => onChange(quotes.filter((q) => q.id !== quote.id))}
            >
              <Icons.Trash size={14} />
            </Button>
          </div>

          <Textarea
            value={quote.quote}
            rows={3}
            maxLength={400}
            aria-label="What they said"
            placeholder="Best bread in the city."
            onChange={(e) => edit(quote.id, { quote: e.target.value })}
          />
          <div className="flex gap-2">
            <Input
              value={quote.author}
              maxLength={80}
              aria-label="Who said it"
              placeholder="Sarah M."
              onChange={(e) => edit(quote.id, { author: e.target.value })}
            />
            <Input
              value={quote.detail}
              maxLength={80}
              aria-label="A detail about them"
              placeholder="Regular since 2019"
              onChange={(e) => edit(quote.id, { detail: e.target.value })}
            />
          </div>
        </div>
      ))}

      {quotes.length < MAX_QUOTES && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange([...quotes, newQuote()])}
        >
          <Icons.Plus size={15} />
          Add a quote
        </Button>
      )}
    </div>
  )
}

/** The picker for a logo strip. */
function LogoEditor({
  imageIds,
  knownImages,
  onRememberImage,
  onChange,
}: {
  imageIds: number[]
  knownImages: Map<number, StorefrontImage>
  onRememberImage: (image: StorefrontImage | null) => void
  onChange: (imageIds: number[]) => void
}) {
  const move = (index: number, by: number) => {
    const to = index + by
    if (to < 0 || to >= imageIds.length) return
    const next = [...imageIds]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {imageIds.length === 0 && (
        <p className="text-sm text-muted">No logos yet. Add one below.</p>
      )}

      {imageIds.map((id, index) => {
        const picture = knownImages.get(id) ?? null
        return (
          <div key={id} className="flex items-center gap-2 rounded-control bg-surface-2 p-2">
            {picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/storefront-images/${picture.id}`}
                alt=""
                className="size-9 shrink-0 rounded-control border border-border object-contain"
              />
            ) : (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-control border border-dashed border-border-strong text-muted">
                <Icons.Picture size={14} />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-sm text-ink">
              {/* A deleted picture is not an error — see storefrontImages —
                  but the owner has to be told, or the strip silently shortens. */}
              {picture?.filename ?? 'This picture has been deleted'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Move logo ${index + 1} up`}
              title="Move up"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <Icons.ChevronUp size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={`Move logo ${index + 1} down`}
              title="Move down"
              disabled={index === imageIds.length - 1}
              onClick={() => move(index, 1)}
            >
              <Icons.ChevronDown size={14} />
            </Button>
            <Button
              variant="danger-ghost"
              size="sm"
              iconOnly
              aria-label={`Remove logo ${index + 1}`}
              onClick={() => onChange(imageIds.filter((x) => x !== id))}
            >
              <Icons.Trash size={14} />
            </Button>
          </div>
        )
      })}

      {imageIds.length < MAX_LOGOS ? (
        <Field label="Add a logo">
          <PicturePicker
            // Always empty: this picker ADDS rather than replaces, so showing
            // the last-added one as "current" would suggest picking again
            // would swap it.
            value={null}
            current={null}
            onChange={(image) => {
              if (!image) return
              onRememberImage(image)
              if (imageIds.includes(image.id)) return
              onChange([...imageIds, image.id])
            }}
          />
        </Field>
      ) : (
        <p className="text-sm text-muted">{MAX_LOGOS} logos is the most one strip can hold.</p>
      )}
    </div>
  )
}

/** The repeating editor for an info-cards section. */
function CardEditor({
  cards,
  onChange,
}: {
  cards: { icon: string; heading: string; text: string }[]
  onChange: (cards: { icon: string; heading: string; text: string }[]) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {cards.map((card, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-control bg-surface-2 p-3">
          <div className="flex items-center gap-2">
            <Menu
              variant="secondary"
              align="left"
              label={
                // The chosen emoji IS the button, so the control shows what it
                // is set to rather than describing it.
                <span className="text-base leading-none">{card.icon || '🙂'}</span>
              }
            >
              {/* A grid inside the menu rather than one emoji per row: twelve
                  stacked rows is a scroll, and these are recognised by shape
                  at a glance. */}
              <div className="grid grid-cols-6 gap-1 p-1">
                {CARD_ICONS.map((icon) => (
                  <button
                    data-kit-ok
                    key={icon}
                    type="button"
                    aria-label={`Use ${icon}`}
                    onClick={() =>
                      onChange(cards.map((c, i) => (i === index ? { ...c, icon } : c)))
                    }
                    className="flex size-8 items-center justify-center rounded-control text-base transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {icon}
                  </button>
                ))}
              </div>
              <MenuSeparator />
              <MenuItem
                onClick={() => onChange(cards.map((c, i) => (i === index ? { ...c, icon: '' } : c)))}
              >
                No icon
              </MenuItem>
            </Menu>

            {/* The field stays: the twelve above are the common ones, not the
                only ones, and pasting any other emoji must still work. */}
            <Input
              value={card.icon}
              maxLength={4}
              aria-label="Icon"
              placeholder="🚚"
              className="w-14 text-center"
              onChange={(e) =>
                onChange(cards.map((c, i) => (i === index ? { ...c, icon: e.target.value } : c)))
              }
            />
            <Input
              value={card.heading}
              maxLength={60}
              aria-label="Card heading"
              placeholder="Heading"
              onChange={(e) =>
                onChange(cards.map((c, i) => (i === index ? { ...c, heading: e.target.value } : c)))
              }
            />
            <Button
              variant="danger-ghost"
              size="sm"
              iconOnly
              aria-label="Remove card"
              onClick={() => onChange(cards.filter((_, i) => i !== index))}
            >
              <Icons.Trash size={15} />
            </Button>
          </div>
          <Textarea
            value={card.text}
            rows={2}
            maxLength={200}
            aria-label="Card text"
            placeholder="A line about it"
            onChange={(e) =>
              onChange(cards.map((c, i) => (i === index ? { ...c, text: e.target.value } : c)))
            }
          />
        </div>
      ))}

      {cards.length < MAX_SECTION_CARDS && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange([...cards, { icon: '', heading: '', text: '' }])}
        >
          <Icons.Plus size={15} />
          Add a card
        </Button>
      )}
    </div>
  )
}
