'use client'

import { useCallback, useRef, useState } from 'react'
import type { FieldProblems } from '@/lib/fieldErrors'

/**
 * Per-field validation errors, and taking somebody TO the one that is wrong.
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────
 *
 * A failed save used to raise a toast in the corner — "Choose when this change
 * should happen." — while the box it meant sat somewhere on a form long enough
 * to scroll. The sentence was correct and useless: it named a rule, not a place.
 * Somebody who knows the form fills in the gap; somebody who does not reads the
 * message twice and starts hunting.
 *
 * So a failure now does three things at once: it marks EVERY field that is
 * wrong, writes the message under each one, and moves the person to the first.
 * Marking all of them is what stops a form with three gaps taking three saves,
 * each revealing the next problem — which is the shape that makes a form feel
 * like it is arguing.
 *
 * ── HOW IT IS USED ───────────────────────────────────────────────────────
 *
 *   const errors = useFieldErrors()
 *
 *   function save() {
 *     const problems = validateThing(draft)
 *     if (errors.show(problems)) return          // marks, scrolls, focuses
 *     start(async () => {
 *       const result = await saveThingAction(draft)
 *       if (!result.ok) return errors.showResult(result)   // server's turn
 *       onSaved()
 *     })
 *   }
 *
 *   <Field label="Starts" {...errors.field('startsAt')}>
 *     <Input … />
 *   </Field>
 *
 * `errors.field(name)` hands back the `error` message AND the ref that makes
 * scrolling possible, so a call site cannot wire up half of it. Everything else
 * — the red border, the message under the control, aria-invalid — the kit's
 * `Field` already does once it has an `error`, and has done all along.
 *
 * ── WHY A REF MAP RATHER THAN document.getElementById ────────────────────
 *
 * `Field` already invents an id and wires the label to it, but that id is a
 * generated `useId` string that no caller knows. Reaching for the DOM would mean
 * inventing a second id scheme alongside it and keeping the two in step. A ref
 * per named field is the same information without the second scheme.
 */

/** What a Field needs to render and be found. Spread straight onto it. */
export type FieldErrorProps = {
  error?: string
  ref: (node: HTMLDivElement | null) => void
}

export type FieldErrors = {
  /** Props for one control. Spread onto its `Field`. */
  field: (name: string) => FieldErrorProps
  /** The message for one field, when a control is not wrapped in a `Field`. */
  messageFor: (name: string) => string | undefined
  /**
   * Mark these problems and go to the first. Returns TRUE when there was
   * something wrong, so a caller reads `if (errors.show(problems)) return`.
   */
  show: (problems: FieldProblems) => boolean
  /**
   * The same, for whatever a server action returned. Understands both the new
   * shape (`problems`) and the old one (a bare `error` sentence), so it can be
   * called on any action's result without checking which kind it is first.
   *
   * Returns FALSE when the result was a success, so it is safe to call on any
   * result at all.
   */
  showResult: (result: unknown) => boolean
  /** Wipe every mark — after a successful save, or when the form is reset. */
  clear: () => void
  /** Drop one field's mark, e.g. as soon as the person edits it. */
  clearField: (name: string) => void
  /** Whatever is currently marked, for a caller that wants to count them. */
  problems: Record<string, string>
  /** A sentence for a banner or toast, when a form still wants one as well. */
  summary: string
}

export function useFieldErrors(): FieldErrors {
  const [problems, setProblems] = useState<Record<string, string>>({})
  /* Kept in a ref rather than state: these are DOM nodes, and re-rendering
     because one arrived would be a render per field on every mount. */
  const nodes = useRef(new Map<string, HTMLElement>())

  /**
   * One ref callback per field name, kept FOREVER.
   *
   * Built once per name and cached, because React compares ref callbacks by
   * identity: hand it a freshly-built closure on a render and it detaches the
   * old one — calling it with null, which empties the map — before attaching the
   * new one. `field()` is rebuilt every time `problems` changes, so a brand new
   * callback arrived on exactly the render that set the error, and the map was
   * empty at the moment `goTo` looked in it. The field went red and nothing
   * scrolled or focused.
   *
   * A stable callback per name means React never detaches, and the map keeps
   * pointing at whatever node is currently mounted.
   */
  const refs = useRef(new Map<string, (node: HTMLDivElement | null) => void>())

  const register = useCallback((name: string) => {
    const existing = refs.current.get(name)
    if (existing) return existing
    const fn = (node: HTMLDivElement | null) => {
      if (node) nodes.current.set(name, node)
      else nodes.current.delete(name)
    }
    refs.current.set(name, fn)
    return fn
  }, [])

  /**
   * Put the person in front of the field, and leave them able to type.
   *
   * `scrollIntoView` on the element rather than scrolling the window: the app
   * shell is `h-screen overflow-hidden` with an inner `<main>` doing the
   * scrolling, and a Modal body is its own scroller again — so scrolling "the
   * page" scrolls nothing at all. Called on the element, the browser walks up to
   * whichever ancestor actually scrolls, which is right in both cases and inside
   * a dialog too. Same reasoning as SettingAnchor, which found this out first.
   */
  const goTo = useCallback((name: string) => {
    /*
     * The node is looked up AFTER the render that marks the field, not before.
     *
     * `show()` calls this straight after setState, and at that instant React has
     * not re-rendered — on the first failure the field may not even be mounted
     * yet (a section that only appears once there is something wrong). Reading
     * the map synchronously found nothing and returned, silently doing neither
     * the scroll nor the focus.
     */
    const node = nodes.current.get(name)
    if (!node) return

    /* 'center' rather than 'start': a field pinned to the top edge of its
       scroller loses the label above it and reads as the top of the form
       rather than as the thing singled out. */
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })

    /*
     * Focus the CONTROL, not the wrapper — and find it again when the time
     * comes rather than closing over it.
     *
     * The ref is on the Field's <div>, because that is the thing carrying the
     * label above and the message below and therefore the thing worth scrolling
     * to. Focus has to land somewhere a person can type, so the first real
     * control inside it is what takes it.
     *
     * Re-read at focus time because a save that fails usually re-renders the
     * screen — a router.refresh(), a transition ending — and React swaps the
     * input for a new node. An element captured now is detached by the time the
     * frame arrives, and focusing a detached node silently does nothing: the
     * field went red, the message appeared, and the caret stayed in the button.
     * That is exactly what happened on the price-change screen.
     *
     * Retried a few frames for the same reason: the re-render may not have
     * happened yet when the first frame fires.
     */
    let tries = 0
    const land = () => {
      const live = nodes.current.get(name)
      if (!live) return
      const control = live.matches(FOCUSABLE)
        ? live
        : live.querySelector<HTMLElement>(FOCUSABLE)
      if (!control) return

      /* preventScroll: focus() would otherwise jump the element into view
         instantly and cut the smooth scroll above off in its first frame. */
      control.focus({ preventScroll: true })

      /* Not focused after all — the node was replaced between the lookup and
         the call. Try again next frame, a few times, then give up quietly: the
         field is marked and scrolled to either way, and stealing focus forever
         is worse than not stealing it once. */
      if (document.activeElement !== control && tries < 6) {
        tries += 1
        requestAnimationFrame(land)
      }
    }
    requestAnimationFrame(land)
  }, [])

  const show = useCallback(
    (list: FieldProblems) => {
      if (!list || list.length === 0) {
        setProblems({})
        return false
      }
      const next: Record<string, string> = {}
      /* First message per field wins. Two problems on one box can only show one
         message, and the first is the one the validator thought was the more
         basic — "a name is required" before "names must be unique". */
      for (const p of list) if (!(p.field in next)) next[p.field] = p.message
      setProblems(next)
      /* A frame later, so the render that marks the fields has committed and the
         one being scrolled to is mounted and registered. Calling straight after
         setState reads the map as it was BEFORE the failure. */
      requestAnimationFrame(() => goTo(list[0].field))
      return true
    },
    [goTo],
  )

  const showResult = useCallback(
    (result: unknown) => {
      const r = result as
        | { ok?: boolean; problems?: FieldProblems; field?: string; error?: string }
        | null
      if (!r || r.ok !== false) return false

      /* The new shape, when the action has been converted. */
      if (Array.isArray(r.problems) && r.problems.length > 0) return show(r.problems)

      /* A single field named alongside the sentence — the halfway shape. */
      if (r.field && r.error) return show([{ field: r.field, message: r.error }])

      /*
       * An action that has not been converted: a sentence and nothing else.
       *
       * Marked against no field, so `summary` below can still say it and the
       * form can put it in a banner. Deliberately NOT swallowed — an error with
       * no home is still an error, and dropping it would turn "save did nothing"
       * into a silent failure, which is worse than a message in the wrong place.
       */
      setProblems({})
      return true
    },
    [show],
  )

  const clear = useCallback(() => setProblems({}), [])

  const clearField = useCallback((name: string) => {
    setProblems((current) => {
      if (!(name in current)) return current
      const next = { ...current }
      delete next[name]
      return next
    })
  }, [])

  const field = useCallback(
    (name: string): FieldErrorProps => ({
      error: problems[name],
      ref: register(name),
    }),
    [problems, register],
  )

  const messageFor = useCallback((name: string) => problems[name], [problems])

  return {
    field,
    messageFor,
    show,
    showResult,
    clear,
    clearField,
    problems,
    summary: Object.values(problems)[0] ?? '',
  }
}

/**
 * What counts as the thing to focus inside a field.
 *
 * `[contenteditable]` for the rich-text boxes, and `[tabindex]` for the composed
 * controls — Combobox, TreeSelect — whose visible half is a div rather than an
 * input. Ordered widest-first so `querySelector` returns whichever comes first
 * in the DOM, which is the control itself rather than a clear button after it.
 */
const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
