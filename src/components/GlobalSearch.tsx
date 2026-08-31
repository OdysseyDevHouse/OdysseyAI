'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, HUB_ICONS } from '@/components/ui'
import {
  Search,
  Spinner,
  Close,
  CornerDownLeft,
  Contact,
  Boxes,
  Truck,
  Receipt,
  ArrowRight,
  type LucideIcon,
} from '@/components/ui/icons'
import { MODAL_PANEL } from '@/components/ui/styles'
import { buildPageIndex, groupHits, searchPages, type PageHit } from '@/lib/pageSearch'
import { SETTING_ANCHOR_EVENT } from '@/components/SettingAnchor'
import type { NavSection } from '@/lib/nav'
import { TILL_HREF, TILL_TARGET } from '@/lib/openTill'
import type { SearchHit, SearchSection } from '@/app/api/search/route'

/**
 * The global search palette — pages and records, centred on screen.
 *
 * Opened from the sidebar's search box or with Ctrl/⌘+K from anywhere. It answers
 * two different questions through one field:
 *
 *   PAGES come from the nav map, matched in the browser (src/lib/pageSearch.ts).
 *   A hundred-odd strings the client already holds, so they appear on the
 *   keystroke with no round trip — which is what makes the palette usable as a
 *   way to navigate rather than a form to fill in.
 *
 *   RECORDS come from /api/search, debounced, each section gated on its own
 *   capability. They arrive a beat later and are appended below the pages.
 *
 * Built on <dialog> like Modal, for the same reasons: focus trapping, the inert
 * background and the top layer come free, and the top layer is the only way to be
 * certain the panel paints above a sticky toolbar. NOT built WITH <Modal> — that
 * component owns a title row and a 60vh body, while this one is a field with a
 * result list under it and no header at all.
 */

/** Which icon stands for each kind of record the API can return. */
const SECTION_ICON: Record<SearchSection['kind'], LucideIcon> = {
  customers: Contact,
  products: Boxes,
  suppliers: Truck,
  documents: Receipt,
}

/**
 * How long to wait before asking the server.
 *
 * Long enough that typing "customer" is one query rather than eight, short
 * enough that it still feels like it is keeping up. The pages list is unaffected
 * — it re-filters on every keystroke — so the palette never looks idle while
 * this is pending.
 */
const DEBOUNCE_MS = 180

/**
 * Records need a LONGER term than pages do.
 *
 * A page is matched against a hundred-odd known names, so two characters
 * genuinely narrows: "ti" leaves Tills, Tips and Timesheets. A record is matched
 * with a database LIKE over tens of thousands of rows, where "ti" appears
 * somewhere in most of them — the probe on this palette returned "Adams Group"
 * and "Classic Alpen Tin" for it, five useless rows pushing the three screens
 * somebody was actually looking for off the bottom of the panel.
 *
 * Three is the point where a term is a fragment of a NAME rather than a letter
 * pair. The pages list is unaffected and still answers on the second keystroke,
 * so the palette never looks like it is waiting.
 */
const MIN_RECORD_TERM = 3

/** One row in the flat, keyboard-navigable list of everything on screen. */
type Row =
  | { kind: 'page'; hit: PageHit }
  | { kind: 'record'; hit: SearchHit }
  | { kind: 'more'; href: string; heading: string }

export default function GlobalSearch({
  open,
  onClose,
  sections,
}: {
  open: boolean
  onClose: () => void
  /** The nav this user can see, already filtered by capability upstream. */
  sections: NavSection[]
}) {
  const router = useRouter()
  const ref = useRef<HTMLDialogElement>(null)
  /* So clearing can put the caret back where it was. Clearing moves focus to the
     clear button, and leaving it there means the next keystroke goes nowhere. */
  const inputRef = useRef<HTMLInputElement>(null)
  const [term, setTerm] = useState('')
  const [records, setRecords] = useState<SearchSection[]>([])
  const [loading, setLoading] = useState(false)
  /** Which row Enter opens. An index into `rows` below. */
  const [cursor, setCursor] = useState(0)

  const index = useMemo(() => buildPageIndex(sections), [sections])
  const pages = useMemo(() => searchPages(index, term), [index, term])

  /* ── open / close ──────────────────────────────────────────────────────── */

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // showModal() throws if already open, and close() on a closed dialog fires a
    // spurious cancel — so check before doing either.
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    // Escape closes natively, but the parent still holds `open` and would render
    // it straight back. Intercept and let the parent drive.
    function onCancel(event: Event) {
      event.preventDefault()
      onClose()
    }
    dialog.addEventListener('cancel', onCancel)
    return () => dialog.removeEventListener('cancel', onCancel)
  }, [onClose])

  /*
   * Cleared on close, not on open.
   *
   * A <dialog> is never unmounted — showModal()/close() only toggle visibility —
   * so without this the next person to open the palette inherits the last search
   * and its stale results. Doing it on close rather than open means the field is
   * already empty in the frame the dialog appears, with no flash of old rows.
   */
  useEffect(() => {
    if (open) return
    setTerm('')
    setRecords([])
    setLoading(false)
    setCursor(0)
  }, [open])

  /* ── records ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    const needle = term.trim()
    if (needle.length < MIN_RECORD_TERM) {
      setRecords([])
      setLoading(false)
      return
    }

    /*
     * Aborted on the next keystroke, so a slow query cannot land after a faster
     * one fired later and overwrite it with results for a term nobody is looking
     * at any more. The classic type-ahead race, and the reason this is a fetch
     * rather than a server action.
     */
    const controller = new AbortController()
    setLoading(true)

    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(needle)}`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : { sections: [] }))
        .then((data: { sections: SearchSection[] }) => {
          setRecords(data.sections ?? [])
          setLoading(false)
        })
        .catch((error: unknown) => {
          // An abort is the expected outcome of typing, not a failure — leaving
          // the spinner up for it would make the palette look permanently busy.
          if (error instanceof DOMException && error.name === 'AbortError') return
          setRecords([])
          setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [term])

  /* ── the flat row list the keyboard walks ──────────────────────────────── */

  const pageGroups = useMemo(() => groupHits(pages), [pages])

  /**
   * Every selectable row, in the order they are rendered.
   *
   * Flat and derived rather than tracked per section, because the cursor has to
   * cross section boundaries: pressing Down at the end of Pages must land on the
   * first customer, and any structure richer than a list makes that arithmetic
   * rather than an increment.
   */
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const [, hits] of pageGroups) {
      // An unbuilt page is shown but cannot be opened, so it is not a row the
      // keyboard should ever land on.
      for (const hit of hits) if (hit.built) out.push({ kind: 'page', hit })
    }
    for (const section of records) {
      for (const hit of section.hits) out.push({ kind: 'record', hit })
      out.push({ kind: 'more', href: section.moreHref, heading: section.heading })
    }
    return out
  }, [pageGroups, records])

  /* Back to the top whenever the results change under it: the row that was
     highlighted is rarely the same row, and leaving the cursor at index 6 after
     a new keystroke points it at something arbitrary. */
  useEffect(() => setCursor(0), [term, records])

  const go = (href: string) => {
    onClose()
    /* The till opens beside the back office rather than replacing it, the same
       as pressing it in the sidebar — see lib/openTill.ts. Searching for "till"
       and pressing Enter must not be the one route that takes the back office
       away from someone mid-task. */
    if (href === TILL_HREF) {
      /* No 'noopener' feature: it would strip the window's name and open a
         SECOND till on every search — see the note in lib/openTill.ts. */
      window.open(TILL_HREF, TILL_TARGET)
      return
    }
    router.push(href)

    /*
     * A settings hit also ANNOUNCES its anchor, because the navigation above
     * cannot be relied on to carry it.
     *
     * Choosing a setting on the screen you are already reading pushes the URL
     * you already have, which does nothing: no navigation, no effect, no flash.
     * The event covers that case, and SettingAnchor's own retry covers the
     * other one — fired here the target usually does not exist yet, so it looks
     * for the card for a second before giving up.
     */
    const anchor = href.includes('#') ? href.split('#')[1] : null
    if (anchor) {
      window.dispatchEvent(new CustomEvent(SETTING_ANCHOR_EVENT, { detail: anchor }))
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (rows.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      // Wraps, so holding Down cannot dead-end at the bottom of a long list.
      setCursor((c) => (c + 1) % rows.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((c) => (c - 1 + rows.length) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const row = rows[cursor]
      if (row) go(row.kind === 'more' ? row.href : row.hit.href)
    }
  }

  /* Which flat index a rendered row is, tracked as the render walks the sections
     so each row knows whether it is the highlighted one. */
  let position = -1
  const next = () => (position += 1)

  const searching = term.trim().length > 0
  const nothing = searching && rows.length === 0 && !loading

  return (
    <dialog
      ref={ref}
      /* Top-aligned rather than vertically centred: the result list grows
         downwards, and a panel centred on its own height would slide the field
         up the screen on every keystroke — the one element the eye is fixed on. */
      className={`${MODAL_PANEL} mt-[12vh] max-w-2xl align-top`}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
      aria-label="Search everything"
    >
      {/*
        The field keeps its own frame rather than being chromeless.

        It is the one control on the panel and the thing every keystroke goes to,
        so it should look like a field — the brand focus line that every other
        input in the app draws is exactly the cue that says "type here", and
        stripping it left the palette looking like a list with a caption.
      */}
      <div className="flex items-center gap-2 p-3">
        {/* min-w-0 flex-1 on a WRAPPER, not on the Input.
            An Input given an `icon` renders itself inside its own
            `<div class="relative">`, so the class would land on the inner
            <input> while the div between them stayed sized to its content — the
            field measured 209px in a 672px panel and clipped the placeholder
            mid-word. The wrapper is the flex item, so it is the thing that has
            to grow. */}
        <div className="relative min-w-0 flex-1">
          <Input
            /* React 19 passes `ref` through as an ordinary prop, and Input
               spreads `...rest` onto its own <input> — so this reaches the
               element without Input needing forwardRef. */
            ref={inputRef}
            // Autofocus is right here and nowhere else: the palette exists to be
            // typed into, and it only appears in response to a deliberate act.
            autoFocus
            type="text"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages, customers, products, documents…"
            aria-label="Search everything"
            icon={<Search size={17} />}
            /* Room on the right for the two affordances that sit inside the
               field — the spinner or Esc cap, and the clear button. */
            className="h-11 pr-24 text-[15px]"
          />

          <span className="absolute inset-y-0 right-2 flex items-center gap-1.5">
            {loading ? (
              <Spinner size={15} className="animate-spin text-muted" aria-hidden />
            ) : (
              <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                Esc
              </kbd>
            )}
            {/* Clears without closing. A palette is often reused for a second
                search, and reaching for backspace nine times is the alternative.
                Hidden while empty rather than disabled — there is nothing to
                clear, so the affordance would be a lie. */}
            {term && (
              <Button
                variant="bare"
                size="sm"
                iconOnly
                aria-label="Clear search"
                onClick={() => {
                  setTerm('')
                  inputRef.current?.focus()
                }}
              >
                <Close size={15} />
              </Button>
            )}
          </span>
        </div>
      </div>

      {/*
        Scrolls at 60vh like Modal's body, so a long result list cannot push the
        panel past the bottom of the window on a laptop screen.
      */}
      <div className="max-h-[60vh] overflow-y-auto border-t border-border p-1.5">
        {!searching && (
          <p className="px-3 py-8 text-center text-sm text-muted">
            Start typing to find a screen, a customer, a product or a document.
          </p>
        )}

        {nothing && (
          <p className="px-3 py-8 text-center text-sm text-muted">
            Nothing matches “{term.trim()}”.
          </p>
        )}

        {pageGroups.map(([heading, hits]) => (
          <Group key={`page-${heading}`} heading={heading}>
            {hits.map((hit) => {
              const at = hit.built ? next() : -1
              return (
                <ResultRow
                  key={hit.href}
                  /* The screen's OWN glyph where a catalogue names one, so a
                     list of settings is not twelve identical cogs. */
                  icon={(hit.iconName && HUB_ICONS[hit.iconName]) || hit.icon}
                  label={hit.label}
                  /*
                   * What the screen DOES, falling back to where it lives.
                   *
                   * The description is the useful line — "Manage your tills and
                   * cash registers" tells somebody who has never opened Tills
                   * whether it is what they want, which is the whole job of a
                   * search result. The trail is only worth showing when there is
                   * no description AND it says something the heading above has
                   * not: otherwise every row under "Customers" reads "Age
                   * analysis / Customers", which is noise rather than
                   * orientation.
                   */
                  meta={hit.description ?? (hit.group === heading ? null : hit.group)}
                  selected={at === cursor}
                  disabled={!hit.built}
                  onSelect={() => go(hit.href)}
                  onHover={() => at >= 0 && setCursor(at)}
                />
              )
            })}
          </Group>
        ))}

        {records.map((section) => {
          const Icon = SECTION_ICON[section.kind]
          return (
            /*
             * "Matching customers", not "Customers".
             *
             * A nav section is called Customers and so is the table behind it, so
             * the two headings rendered identically one above the other and the
             * palette looked like it had drawn itself twice. Naming what the rows
             * ARE — records that matched, rather than the section they live in —
             * is the distinction the reader actually needs, and it is the records
             * heading that should carry it: the pages above are the menu, whose
             * names people already know.
             */
            <Group key={section.kind} heading={`Matching ${section.heading.toLowerCase()}`}>
              {section.hits.map((hit) => {
                const at = next()
                return (
                  <ResultRow
                    key={hit.key}
                    icon={Icon}
                    label={hit.label}
                    meta={hit.meta}
                    trailing={hit.trailing}
                    selected={at === cursor}
                    onSelect={() => go(hit.href)}
                    onHover={() => setCursor(at)}
                  />
                )
              })}
              {(() => {
                /* Always offered, even when fewer than the section limit came
                   back: the API caps at five per section and the palette cannot
                   tell "that is all of them" from "that is the first five", so
                   promising either would sometimes be a lie. */
                const at = next()
                return (
                  <ResultRow
                    icon={ArrowRight}
                    label={`See all ${section.heading.toLowerCase()}`}
                    selected={at === cursor}
                    onSelect={() => go(section.moreHref)}
                    onHover={() => setCursor(at)}
                    subdued
                  />
                )
              })()}
            </Group>
          )
        })}
      </div>

      {rows.length > 0 && (
        <div className="flex items-center gap-5 border-t border-border px-4 py-2.5">
          <Hint keys={<CornerDownLeft size={12} />} label="Open" />
          <Hint keys="↑ ↓" label="Navigate" />
          <Hint keys="Esc" label="Close" />
        </div>
      )}
    </dialog>
  )
}

/**
 * One keyboard hint: the cap, then what it does.
 *
 * The key drawn as a cap rather than run into the sentence ("↑↓ move"), because a
 * key cap is a shape the eye recognises without reading — which is what a footer
 * of hints is for. Nobody reads this row twice; they glance at it once.
 */
function Hint({ keys, label }: { keys: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-2 text-xs text-muted">
      <kbd className="flex min-w-6 items-center justify-center rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-ink-2">
        {keys}
      </kbd>
      {label}
    </span>
  )
}

/** One heading and its rows. */
function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <p className="px-3 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        {heading}
      </p>
      {children}
    </div>
  )
}

/**
 * One result: an icon tile, a name, the line that says what it is, and a figure.
 *
 * Deliberately not a <Button> and not a <Link>: it is a full-width list row with
 * no control chrome, driven by a cursor the keyboard owns rather than by focus —
 * moving focus per arrow key would pull it out of the search field and stop the
 * next keystroke from reaching it. PickerResults is the same shape but focus-
 * driven and without headings, tiles or a highlight, so it cannot serve here.
 *
 * The glyph sits in a rounded tile rather than floating loose against the text.
 * With two lines per row a bare 15px icon has nothing to align to and drifts
 * against the label; a 36px tile gives the row a fixed left edge and makes the
 * list scannable by shape, which is the same reason the hub tiles have one.
 */
function ResultRow({
  icon: Icon,
  label,
  meta,
  trailing,
  selected,
  disabled = false,
  subdued = false,
  onSelect,
  onHover,
}: {
  icon: LucideIcon
  label: string
  meta?: string | null
  trailing?: string | null
  selected: boolean
  disabled?: boolean
  /** For the "see all" row, which is a way out rather than a result. */
  subdued?: boolean
  onSelect: () => void
  onHover?: () => void
}) {
  if (disabled) {
    return (
      <span
        data-kit-ok
        title="Not built yet"
        aria-disabled
        className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 opacity-45"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-muted">
          <Icon size={17} strokeWidth={1.7} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm text-muted">{label}</span>
          <span className="mt-0.5 block truncate text-xs text-faint">Not built yet</span>
        </span>
      </span>
    )
  }

  return (
    /* data-kit-ok: a two-line result row inside a palette, highlighted by a
       cursor rather than by focus. Giving it button chrome, or any Button
       variant, would make the list read as a stack of controls. */
    <button
      data-kit-ok
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onMouseMove={onHover}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${
        selected ? 'bg-brand-soft' : 'hover:bg-surface-2'
      }`}
    >
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-control transition ${
          selected ? 'bg-brand/15 text-brand' : 'bg-surface-2 text-muted'
        }`}
      >
        <Icon size={17} strokeWidth={1.7} />
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm ${
            subdued ? 'text-muted' : selected ? 'font-semibold text-brand' : 'font-medium text-ink'
          }`}
        >
          {label}
        </span>
        {meta && <span className="mt-0.5 block truncate text-xs text-muted">{meta}</span>}
      </span>

      {trailing && <span className="numeric shrink-0 text-sm text-ink-2">{trailing}</span>}

      {/* The Enter key, on the row Enter would open. Shown only there, so it
          reads as "this one" rather than as decoration on every row. */}
      {selected && !trailing && (
        <CornerDownLeft size={15} className="shrink-0 text-brand" aria-hidden />
      )}
    </button>
  )
}
