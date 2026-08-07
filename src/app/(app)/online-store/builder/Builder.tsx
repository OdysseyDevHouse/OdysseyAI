'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ColourInput,
  EmptyState,
  Field,
  FieldGroup,
  Icons,
  Input,
  Menu,
  MenuItem,
  NumberInput,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import {
  MAX_SECTIONS,
  MAX_SECTION_CARDS,
  SECTION_HINT,
  SECTION_KINDS,
  SECTION_LABEL,
  SOURCE_LABEL,
  PRODUCT_SOURCES,
  normaliseSections,
  type HomeSection,
  type SectionKind,
  type StorefrontTheme,
  // The pure model, NOT lib/site/storefrontLayout — importing the server
  // module here would pull the database layer into the browser bundle.
} from '@/lib/storefrontModel'
import type { StorefrontDepartment, StorefrontProduct } from '@/lib/site/storefront'
import type { ProductDisplay, SectionContent } from '@/app/store/[token]/HomeSections'
import { BuilderCanvas } from './BuilderCanvas'
import ProductPicker from './ProductPicker'
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

let idCounter = 0
function newSection(kind: SectionKind): HomeSection {
  // Date-free so two sections added in the same millisecond cannot collide.
  const id = `s-${kind}-${++idCounter}-${Math.random().toString(36).slice(2, 7)}`
  const base = { id, kind, title: SECTION_LABEL[kind], enabled: true }
  if (kind === 'products') {
    return { ...base, title: 'Products', source: 'newest', productIds: [], maxItems: 8, departmentId: null }
  }
  if (kind === 'categories') return { ...base, title: 'Shop by department', maxItems: 0 }
  if (kind === 'cards') return { ...base, title: '', cards: [{ icon: '🚚', heading: 'Delivery', text: '' }] }
  return { ...base, title: '' }
}

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
}: {
  theme: StorefrontTheme
  published: HomeSection[]
  draft: HomeSection[] | null
  /** The sections with their real products, resolved server-side. */
  initialContent: SectionContent[]
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

  // The draft if there is one, else a copy of what is live.
  const [sections, setSections] = useState<HomeSection[]>(() =>
    normaliseSections(draft ?? published),
  )
  const [theme, setTheme] = useState(initialTheme)
  const [selectedId, setSelectedId] = useState<string | null>(sections[0]?.id ?? null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')

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

  const content: SectionContent[] = sections.map((section) => {
    const resolved = contentById.get(section.id)
    const local = pickedProducts.get(section.id)
    return {
      ...resolved,
      // Only a hand-picked row is overridden. A rule's contents are the
      // server's to decide — this map has no idea what "the newest eight" is.
      ...(local && section.source === 'manual' ? { products: local } : {}),
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

  const patch = useCallback((id: string, changes: Partial<HomeSection>) => {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...changes } : s)))
  }, [])

  function move(id: string, direction: -1 | 1) {
    setSections((prev) => {
      const index = prev.findIndex((s) => s.id === id)
      const target = index + direction
      if (index === -1 || target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  /**
   * Drag-and-drop reorder: lift `from` out and drop it where `to` sits.
   *
   * A SPLICE, not a swap. Dragging a section from the bottom to the top should
   * push everything else down one, not trade places with whatever happened to
   * be there — swapping is what makes a drag feel like it did the wrong thing.
   */
  function reorder(from: string, to: string) {
    setSections((prev) => {
      const fromIndex = prev.findIndex((s) => s.id === from)
      const toIndex = prev.findIndex((s) => s.id === to)
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }

  function add(kind: SectionKind) {
    if (sections.length >= MAX_SECTIONS) {
      toast.error(`A page can hold ${MAX_SECTIONS} sections.`)
      return
    }
    const section = newSection(kind)
    setSections((prev) => [...prev, section])
    setSelectedId(section.id)
  }

  function remove(id: string) {
    setSections((prev) => prev.filter((s) => s.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  function publish() {
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
      setSections(normaliseSections(published))
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
          <Button variant="primary" onClick={publish} disabled={busy || !hasUnpublished}>
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px] lg:items-start">
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
            onSelect={setSelectedId}
            onReorder={reorder}
            onToggle={(id, enabled) => patch(id, { enabled })}
            onAdd={add}
            onSelectAppearance={() => setSelectedId(null)}
          />
        </Card>


        {/* Whatever is selected. */}
        <div className="flex flex-col gap-5">
          {selected ? (
            <Card>
              <CardHeader
                title={SECTION_LABEL[selected.kind]}
                description={SECTION_HINT[selected.kind]}
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
                    <Field label="Fill this row with">
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
                <Field label="Your colour" hint="Used for buttons and highlights.">
                  <ColourInput
                    value={theme.brandColour}
                    onChange={(brandColour) => setTheme({ ...theme, brandColour })}
                  />
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
      </div>
    </>
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
            <Input
              value={card.icon}
              maxLength={4}
              aria-label="Icon"
              placeholder="🚚"
              className="w-16 text-center"
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
