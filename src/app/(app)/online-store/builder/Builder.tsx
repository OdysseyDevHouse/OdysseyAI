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
  MAX_SECTIONS,
  MAX_SECTION_CARDS,
  MAX_SECTION_TEXT,
  PAGE_PRESETS,
  SECTION_HINT,
  SECTION_KINDS,
  SECTION_LABEL,
  SOURCE_HINT,
  SOURCE_LABEL,
  PRODUCT_SOURCES,
  describeLayoutChanges,
  isScheduledNow,
  normaliseSections,
  shopToday,
  type HomeSection,
  type LayoutChange,
  type PagePreset,
  type SectionKind,
  type StorefrontTheme,
  // The pure model, NOT lib/site/storefrontLayout — importing the server
  // module here would pull the database layer into the browser bundle.
} from '@/lib/storefrontModel'
import type { StorefrontDepartment, StorefrontProduct } from '@/lib/site/storefront'
import type { StorefrontImage } from '@/lib/site/storefrontImages'
import type { ProductDisplay, SectionContent } from '@/app/store/[token]/HomeSections'
import { BuilderCanvas, type PreviewWidth } from './BuilderCanvas'
import ProductPicker from './ProductPicker'
import ImagePicker from './ImagePicker'
import { discardDraftAction, publishDraftAction, saveDraftAction, saveThemeAction } from './actions'

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
  if (kind === 'text') return { ...base, title: '', text: '', align: 'left' }
  return { ...base, title: '' }
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
}: {
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
      const result = await saveDraftAction(sections)
      if (result.ok) {
        savedJson.current = currentJson
        setSaveState('saved')
      } else {
        toast.error(result.error)
        setSaveState('idle')
      }
    }, AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [currentJson, sections, toast])

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

  function publish() {
    setConfirmOpen(false)
    startAction(async () => {
      // Flush the draft first: publishing copies the SERVER's draft, so an
      // unsaved keystroke would otherwise be silently left behind.
      await saveDraftAction(sections)
      savedJson.current = currentJson

      const result = await publishDraftAction()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Your shop front page is live.')
      router.refresh()
    })
  }

  function discard() {
    startAction(async () => {
      await discardDraftAction()
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
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">
              {hasUnpublished ? 'You have changes customers cannot see yet' : 'Your page is live'}
            </p>
            <p className="text-sm text-muted">
              {saveState === 'saving'
                ? 'Saving your draft…'
                : saveState === 'saved'
                  ? 'Draft saved.'
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

          {storeOpen && (
            <a href={storePath} target="_blank" rel="noreferrer">
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
                      hint={SOURCE_HINT[selected.source ?? 'manual']}
                    >
                      <Select
                        value={selected.source ?? 'manual'}
                        onChange={(e) =>
                          patch(selected.id, { source: e.target.value as HomeSection['source'] })
                        }
                      >
                        {PRODUCT_SOURCES.map((source) => (
                          <option key={source} value={source}>
                            {SOURCE_LABEL[source]}
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
                      <ImagePicker
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
                      hint="A page in your shop like /store, or a full https:// link. Blank means it is not a link."
                    >
                      <Input
                        value={selected.linkUrl ?? ''}
                        maxLength={300}
                        placeholder="https://…"
                        onChange={(e) => patch(selected.id, { linkUrl: e.target.value })}
                      />
                    </Field>

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
                    {SECTION_KINDS.map((kind) => (
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
              already has a page they like. */}
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
                  <ImagePicker
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
