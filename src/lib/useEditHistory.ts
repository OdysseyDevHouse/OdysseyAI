'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * Undo and redo for a value being edited on screen.
 *
 * ── IT LIVES AND DIES WITH THE SCREEN ─────────────────────────────────────
 *
 * Nothing here is written anywhere. A designer arranging a document is
 * exploring, and the useful question is "put that back" over the next few
 * seconds — not "what did I do last Tuesday". Persisting it would mean deciding
 * whose history it is, what happens when two people edit the same design, and
 * when it expires: three real problems in exchange for a feature nobody asked
 * for.
 *
 * Closing the screen loses it, which is the same promise the unsaved-changes
 * warning already makes.
 *
 * ── ONE FUNNEL, OR THE STACK LIES ─────────────────────────────────────────
 *
 * Every edit must go through `commit`. An edit that writes the value directly
 * leaves the stack describing a past that never happened, and undo then jumps
 * somewhere the designer never was — which is worse than having no undo at all,
 * because they will trust it.
 *
 * ── REDO IS DISCARDED THE MOMENT YOU DIVERGE ──────────────────────────────
 *
 * Undo twice, then make a change, and the two undone steps are gone. That is
 * what every editor does and it is the only honest answer: the future you undid
 * is no longer reachable from where you now are.
 */

/** Deep enough to cover a session of fiddling; short enough to stay cheap. */
const LIMIT = 50

export type EditHistory<T> = {
  /** Record the current value and move to the next one. */
  commit: (next: T) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
  /** Throw the history away — after a reset, or when the document changes. */
  clear: () => void
}

export function useEditHistory<T>(current: T, apply: (value: T) => void): EditHistory<T> {
  const past = useRef<T[]>([])
  const future = useRef<T[]>([])

  /*
   * The stacks are REFS so that pushing to them does not re-render, but the
   * buttons have to know whether they are empty — so the two answers they need
   * are the state, kept in step by sync() after every change.
   */
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const sync = useCallback(() => {
    setCanUndo(past.current.length > 0)
    setCanRedo(future.current.length > 0)
  }, [])

  const commit = useCallback(
    (next: T) => {
      past.current = [...past.current.slice(-(LIMIT - 1)), current]
      // Diverging discards the redo stack — see the note above.
      future.current = []
      apply(next)
      sync()
    },
    [current, apply, sync],
  )

  const undo = useCallback(() => {
    const prev = past.current.pop()
    if (prev === undefined) return
    future.current = [...future.current.slice(-(LIMIT - 1)), current]
    apply(prev)
    sync()
  }, [current, apply, sync])

  const redo = useCallback(() => {
    const next = future.current.pop()
    if (next === undefined) return
    past.current = [...past.current.slice(-(LIMIT - 1)), current]
    apply(next)
    sync()
  }, [current, apply, sync])

  const clear = useCallback(() => {
    past.current = []
    future.current = []
    sync()
  }, [sync])

  return { commit, undo, redo, canUndo, canRedo, clear }
}
