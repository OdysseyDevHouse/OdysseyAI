'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ColourInput,
  Field,
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
import { discardDraftAction, publishDraftAction, saveDraftAction, saveThemeAction } from './actions'

/**
 * The page builder.
 *
 * A LIST plus an inspector, rather than the drag-onto-a-canvas editor the old
 * one had. A shop front page is four kinds of block in an order — the ordering
 * is the whole interaction, and up/down controls do it in one tap on a phone,
 * survive keyboard use, and need no drag library. What was lost with the
 * canvas was a preview that never quite matched the real shop anyway; "View
 * shop" opens the actual storefront instead.
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
  departments,
  storeOpen,
  storePath,
}: {
  theme: StorefrontTheme
  published: HomeSection[]
  draft: HomeSection[] | null
  departments: { id: number; name: string }[]
  storeOpen: boolean
  storePath: string
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
        <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">
              {hasUnpublished ? 'You have changes customers cannot see yet' : 'Your page is live'}
            </p>
            <p className="text-sm text-muted">
              {saveState === 'saving'
                ? 'Saving your draft…'
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
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px] lg:items-start">
        {/* The page, top to bottom. */}
        <Card>
          <CardHeader
            title="Your front page"
            description="The order here is the order customers see."
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

          {sections.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-medium text-ink">Your front page is empty</p>
              <p className="mt-1 text-sm text-muted">
                Shoppers will land straight on your product list. Add a section to build a
                proper front page.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {sections.map((section, index) => (
                <li
                  key={section.id}
                  className={`flex items-center gap-3 px-5 py-3 ${
                    section.id === selectedId ? 'bg-brand-soft' : ''
                  }`}
                >
                  {/* `ghost`, not `bare`: ordering is the builder's main
                      interaction and a chromeless chevron gave no hint it was
                      a control. A disabled one now reads as disabled rather
                      than as a decorative arrow. */}
                  <div className="flex shrink-0 flex-col gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${section.title || SECTION_LABEL[section.kind]} up`}
                      disabled={index === 0}
                      onClick={() => move(section.id, -1)}
                    >
                      <Icons.ChevronUp size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${section.title || SECTION_LABEL[section.kind]} down`}
                      disabled={index === sections.length - 1}
                      onClick={() => move(section.id, 1)}
                    >
                      <Icons.ChevronDown size={15} />
                    </Button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setSelectedId(section.id)}
                    className="min-w-0 flex-1 text-left"
                    data-kit-ok
                    /* Not a kit Button: this is a selectable row, styled as a
                       row rather than a control, and a Button variant for it
                       would be used nowhere else. */
                  >
                    <span className="block truncate text-sm font-medium text-ink">
                      {section.title || SECTION_LABEL[section.kind]}
                    </span>
                    {/* The kind, but only when it adds something. An untitled
                        section already shows its kind as the title, and
                        repeating it read as a rendering bug. */}
                    <span className="text-xs text-muted">
                      {section.title && section.title !== SECTION_LABEL[section.kind]
                        ? SECTION_LABEL[section.kind]
                        : SECTION_HINT[section.kind]}
                    </span>
                  </button>

                  {!section.enabled && <Badge tone="neutral">Hidden</Badge>}

                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Remove ${section.title || SECTION_LABEL[section.kind]}`}
                    onClick={() => remove(section.id)}
                  >
                    <Icons.Trash size={15} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
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
                      <p className="text-sm text-muted">
                        Picking individual products is coming. For now, use a department or
                        the newest products.
                      </p>
                    )}

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
              <div className="px-5 py-8 text-center">
                <p className="text-sm text-muted">
                  Choose a section on the left to change it.
                </p>
              </div>
            </Card>
          )}

          {/* Appearance is NOT part of the draft — see saveThemeChanges. */}
          <Card>
            <CardHeader
              title="Appearance"
              description="Applies to your shop as soon as you save it."
            />
            <CardBody className="flex flex-col gap-4">
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

              <Field label="Opening hours" hint="Shown in the footer.">
                <Textarea
                  value={theme.footerHours}
                  rows={2}
                  maxLength={400}
                  placeholder="Mon–Fri 8am–5pm, Sat 8am–1pm"
                  onChange={(e) => setTheme({ ...theme, footerHours: e.target.value })}
                />
              </Field>

              <Field label="About your shop" hint="A line or two in the footer.">
                <Textarea
                  value={theme.footerAbout}
                  rows={2}
                  maxLength={600}
                  onChange={(e) => setTheme({ ...theme, footerAbout: e.target.value })}
                />
              </Field>

              <Field label="Facebook" hint="The full link, or leave blank.">
                <Input
                  value={theme.socialFacebook}
                  placeholder="https://facebook.com/yourshop"
                  onChange={(e) => setTheme({ ...theme, socialFacebook: e.target.value })}
                />
              </Field>

              <Field label="Instagram">
                <Input
                  value={theme.socialInstagram}
                  placeholder="https://instagram.com/yourshop"
                  onChange={(e) => setTheme({ ...theme, socialInstagram: e.target.value })}
                />
              </Field>

              <Field label="WhatsApp number">
                <Input
                  value={theme.socialWhatsapp}
                  placeholder="27821234567"
                  onChange={(e) => setTheme({ ...theme, socialWhatsapp: e.target.value })}
                />
              </Field>
            </CardBody>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
              <Button variant="primary" onClick={saveThemeChanges} disabled={busy}>
                Save appearance
              </Button>
            </div>
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
