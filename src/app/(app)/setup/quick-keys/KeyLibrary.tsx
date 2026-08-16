'use client'

import { useEffect, useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import {
  Card,
  CardHeader,
  Icons,
  Input,
  SegmentedControl,
  useToast,
} from '@/components/ui'
import {
  QUICK_KEY_ACTIONS,
  quickKeyAllowedOnSection,
  quickKeyAllowedOnTill,
  quickKeySig,
  type QuickKeyRow,
  type QuickKeySection,
  type QuickKeyTarget,
} from '@/lib/quickKeys'
import { quickKeyArt, quickKeyArtSrc } from '@/lib/quickKeyArt'
import { searchProductsAction, listProductDepartmentsAction } from '@/app/(app)/sales/actions'

/**
 * The library — everything a bar could hold, on the right, ready to be dragged on.
 *
 * ── WHY A RAIL AND NOT ONLY A MODAL ───────────────────────────────────────
 *
 * Setting a bar up is not one act, it is thirty. A modal is right for "add this one
 * thing" and wrong for "lay out a till": every key costs an open, a choose, a confirm
 * and a dismiss, and the canvas is hidden for all four — so a manager cannot see the
 * thing they are building while they build it.
 *
 * With a rail the whole catalogue is visible beside the canvas and a key costs one drag.
 * The modal stays, because a precise search for one product in forty thousand is still
 * better in a dialog with room for it.
 *
 * ── A NEW KEY IS ALWAYS APPENDED ──────────────────────────────────────────
 *
 * Dropping one is not aimed: wherever it lands, it goes to the end of the open scope.
 * Placing a brand-new key precisely is a second drag, and asking for that precision at
 * the moment of creation makes the common act (get it onto the bar) pay for the rare one
 * (get it exactly there). Reordering afterwards is one drag and already works.
 */

/** A key that does not exist yet, described well enough to create. */
export type NewKeyDraft = {
  target: QuickKeyTarget
  label: string
  icon: string
  colourToken: string
}

export function KeyLibrary({
  keys,
  section,
  hospitality,
  busy,
  onAdd,
}: {
  /** Everything already on a bar — so the library can hide what is already placed. */
  keys: readonly QuickKeyRow[]
  section: QuickKeySection
  /** A restaurant till. Decides which actions this shop can use at all. */
  hospitality: boolean
  busy: boolean
  /** Click-to-add. The drag path goes through the canvas's own drop handling. */
  onAdd: (draft: NewKeyDraft) => void
}) {
  const [tab, setTab] = useState<'action' | 'product' | 'department'>('action')
  const [query, setQuery] = useState('')
  const [departments, setDepartments] = useState<{ id: number; name: string; depth: number }[]>([])
  const [products, setProducts] = useState<{ id: number; description: string; code: string }[]>([])
  const [searching, setSearching] = useState(false)
  const toast = useToast()

  /*
   * Where each already-placed key LIVES, by signature.
   *
   * Not merely "is it placed". A key filed inside a folder is invisible on the bar, so
   * a manager looking for "Cash up" sees a greyed row and an empty canvas and concludes
   * the screen is broken — when in fact the key is two taps away inside Supervisor.
   * Naming the folder answers the question the greyed row provokes.
   *
   * The value is the group's caption, or '' for a key sitting on the bar itself.
   */
  const placedIn = new Map<string, string>()
  for (const k of keys.filter((k) => k.section === section)) {
    const parent = k.parentId === null ? null : keys.find((p) => p.id === k.parentId)
    placedIn.set(k.sig, parent?.caption || '')
  }

  /* Debounced at 180ms and two characters, the same as the till's search and the add
     modal's — one letter matches most of a 40,000-line product file. */
  useEffect(() => {
    if (tab !== 'product') return
    const term = query.trim()
    if (term.length < 2) {
      setProducts([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      searchProductsAction(term, null)
        .then((rows) => {
          if (!cancelled) {
            setProducts(rows.map((p) => ({ id: p.id, description: p.description, code: p.code })))
          }
        })
        .catch(() => {
          if (!cancelled) setProducts([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [tab, query])

  // The tree is small enough to hold, and loading it for somebody who only adds action
  // keys would be a query nobody asked for.
  useEffect(() => {
    if (tab !== 'department' || departments.length > 0) return
    let cancelled = false
    void listProductDepartmentsAction()
      .then((rows) => {
        if (!cancelled) setDepartments(rows)
      })
      .catch(() => {
        if (!cancelled) toast.error('The department list could not be loaded.')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, departments.length])

  const term = query.trim().toLowerCase()

  const actionRows: NewKeyDraft[] = QUICK_KEY_ACTIONS.filter(
    (a) =>
      /* Hidden outright, not greyed — a hospitality shop will never have parked
         baskets, so a permanently dead "Saved sales" row is noise rather than
         information. Contrast the tables-bar rule, which greys and explains, because
         there the key IS available, just on the other bar. */
      !quickKeyAllowedOnTill({ kind: 'action', actionSlug: a.slug }, hospitality),
  )
    .filter(
      (a) => !term || a.label.toLowerCase().includes(term) || a.hint.toLowerCase().includes(term),
    )
    .map((a) => ({
      target: { kind: 'action', actionSlug: a.slug },
      label: a.label,
      icon: a.icon,
      colourToken: 'tile-1',
    }))

  const productRows: NewKeyDraft[] = products.map((p) => ({
    target: { kind: 'product', productId: p.id },
    label: p.description,
    icon: '',
    colourToken: 'tile-1',
  }))

  const departmentRows: NewKeyDraft[] = departments
    .filter((d) => !term || d.name.toLowerCase().includes(term))
    .map((d) => ({
      target: { kind: 'department', departmentId: d.id },
      label: d.name,
      icon: '',
      colourToken: 'tile-1',
    }))

  const rows = tab === 'action' ? actionRows : tab === 'product' ? productRows : departmentRows

  return (
    <Card>
      <CardHeader
        title="Add keys"
        description="Drag one onto the canvas, or click to put it at the end."
      />

      <div className="flex flex-col gap-3 p-4">
        <SegmentedControl
          aria-label="What kind of key"
          value={tab}
          onChange={(next) => {
            setTab(next)
            setQuery('')
          }}
          /* Short labels, because this control sits in a 320px rail and the segmented
             bar does not wrap — "Does something" and "Departments" together overflowed
             the card and clipped the last segment. The nouns carry the meaning on their
             own here: the card above already says these are keys to add. */
          options={[
            { value: 'action', label: 'Actions' },
            { value: 'product', label: 'Products' },
            { value: 'department', label: 'Depts' },
          ]}
        />

        <Input
          value={query}
          icon={<Icons.Search size={16} />}
          placeholder={
            tab === 'product' ? 'Search the product file…' : 'Filter…'
          }
          disabled={busy}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted">
              {tab === 'product'
                ? searching
                  ? 'Searching…'
                  : query.trim().length >= 2
                    ? 'No product matches.'
                    : 'Type two characters to search the product file.'
                : 'Nothing matches.'}
            </p>
          ) : (
            rows.map((draft) => {
              const sig = quickKeySig(draft.target)
              const banned = quickKeyAllowedOnSection(
                {
                  kind: draft.target.kind,
                  actionSlug: draft.target.kind === 'action' ? draft.target.actionSlug : '',
                },
                section,
              )
              return (
                <LibraryRow
                  key={sig}
                  draft={draft}
                  sig={sig}
                  /* Already on this bar, or not allowed on it. Both are shown rather
                     than hidden when there is a REASON worth reading — "already on this
                     bar" answers the question a manager is about to ask. */
                  placed={placedIn.has(sig)}
                  /* Which folder it is in, so a key that cannot be found on the canvas
                     says where it went. '' means it is on the bar itself. */
                  placedIn={placedIn.get(sig) ?? ''}
                  banned={banned}
                  busy={busy}
                  onAdd={() => onAdd(draft)}
                />
              )
            })
          )}
        </div>
      </div>
    </Card>
  )
}

/**
 * One row in the library — draggable onto the canvas, clickable to append.
 *
 * The drag data is the whole draft rather than an id, because the thing being dragged
 * has no id yet: it is not a row until it lands.
 */
function LibraryRow({
  draft,
  sig,
  placed,
  placedIn,
  banned,
  busy,
  onAdd,
}: {
  draft: NewKeyDraft
  sig: string
  placed: boolean
  /** The folder it is in, or '' for the bar itself. Only meaningful when `placed`. */
  placedIn: string
  banned: string | null
  busy: boolean
  onAdd: () => void
}) {
  const disabled = placed || Boolean(banned) || busy
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `new-${sig}`,
    disabled,
    data: { draft },
  })

  const art = quickKeyArt({
    actionSlug: draft.target.kind === 'action' ? draft.target.actionSlug : '',
    icon: draft.icon,
  })
  const Glyph = glyphFor(draft.icon)

  return (
    /* Not a kit control: it is a draggable row that is also a button, and the kit's
       TouchRow cannot carry dnd-kit's listeners onto its own element. */
    <button
      ref={setNodeRef}
      type="button"
      data-kit-ok
      {...attributes}
      {...listeners}
      disabled={disabled}
      onClick={onAdd}
      title={
        banned ??
        (placed
          ? placedIn
            ? `Already on this bar, inside "${placedIn}".`
            : 'Already on this bar.'
          : undefined)
      }
      className={`flex items-center gap-2.5 rounded-control border border-border bg-surface px-2.5 py-2 text-left transition ${
        disabled
          ? 'cursor-not-allowed opacity-50'
          : 'hover:border-border-strong hover:bg-surface-2'
      } ${isDragging ? 'opacity-40' : ''}`}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2">
        {art ? (
          <img src={quickKeyArtSrc(art.file)} alt="" className="h-5 w-5" />
        ) : Glyph ? (
          <Glyph size={16} />
        ) : (
          <Icons.Sparkles size={16} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{draft.label}</span>
        {(placed || banned) && (
          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted">
            {banned ? (
              'Not on this bar'
            ) : placedIn ? (
              /* The folder it went into. A key filed away is invisible on the canvas,
                 so without this the greyed row reads as "already added" over a bar that
                 plainly does not have it — and the manager goes looking for a bug. */
              <>
                <Icons.Shapes size={11} className="shrink-0" />
                <span className="truncate">In “{placedIn}”</span>
              </>
            ) : (
              'On this bar'
            )}
          </span>
        )}
      </span>
      {!disabled && <Icons.Plus size={14} className="shrink-0 text-muted" />}
    </button>
  )
}

function glyphFor(name: string) {
  if (!name) return null
  const set = Icons as unknown as Record<string, typeof Icons.Sparkles>
  return set[name] ?? null
}
