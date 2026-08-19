'use client'

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import {
  Badge,
  Button,
  Callout,
  Field,
  Icons,
  Input,
  Modal,
  NumPad,
  RowDisclosure,
  Select,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_NUMERIC,
  TABLE_ROW,
  useToast,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import {
  tillDeclarationViewAction,
  tillSupervisorsAction,
  tillCashupOwnersAction,
  type CashupOwners,
  tillRevealTenderAction,
  tillSaveDeclarationAction,
  tillFinalizeDeclarationAction,
} from './shiftActions'
import type { VisibleDeclaration } from '@/app/(app)/sales/cashup/[shiftId]/declare/visible'

/**
 * The detailed cash-up, at the till.
 *
 * ── THE ONLY CASH-UP SCREEN IN THE PRODUCT ──────────────────────────────────
 *
 * There used to be two: this, and a back-office page at
 * /sales/cashup/[id]/declare rendering the same declaration a second time. Two
 * screens for one job meant every change had to be made twice, and they had
 * already drifted — they disagreed about how cash was declared and about what a
 * signed cash-up looked like.
 *
 * The page is gone. The back office opens THIS dialog now, from the cash-up
 * list and from a signed row in "Recent cash-ups" alike, so a change here lands
 * everywhere because there is nowhere else. Two consequences worth knowing:
 *
 *   - It must render a SIGNED cash-up read-only, not refuse it. Reading a
 *     committed record back is a back-office job this dialog inherited, and
 *     `locked` is what makes every control on the board inert.
 *   - It cannot assume it is running on a till. `terminalId` may be null and
 *     `pendingSales` zero because the back office has no outbox — see the
 *     callers in sales/cashup/.
 *
 * It stays a MODAL rather than becoming a route because the POS is one screen
 * that never navigates: sending a cashier away abandons whatever is on the till.
 * The count survives the dialog being closed because the draft is saved
 * server-side on every tender commit — so an interruption mid-count loses
 * nothing, which is the one property the page had that a dialog had to earn.
 *
 * ── ONE BOARD, NOT THREE TABS ───────────────────────────────────────────────
 *
 * This used to stack the count into tabs. It is now a single full-width board,
 * because tabs were answering the wrong question: a cashier counting a drawer
 * is not working through three steps in order, they are working across the
 * whole thing at once — counting notes while watching the cash difference,
 * declaring the card slip while the payout total is still on screen. A tab that
 * hides the difference while you enter the number that produces it makes the
 * screen a memory test.
 *
 * The numbered panels are deliberate. A supervisor reads a cash-up out loud
 * over the phone ("what does panel 8 say?"), and the legacy till this replaces
 * numbered them too — so the numbers are the shared vocabulary, not decoration.
 * They must therefore stay CONTIGUOUS: removing a panel renumbers the ones
 * after it, which is why merging the tender table into panel 1 moved 3, 4 and 5
 * down rather than leaving a gap where 2 had been.
 *
 * ── ONE TABLE, AND ITS DECLARED COLUMN IS THE FORM ──────────────────────────
 *
 * Panel 1 held a column of labelled boxes while panel 2 showed the same tenders
 * again as a read-only table of Expected / Declared / Difference. The box you
 * typed into and the row that judged it were in different panels, so checking
 * your own work meant looking away from what you had just typed.
 *
 * They are one table now: the Declared column IS the box. Cash keeps its
 * denomination breakdown, expanded inline beneath its own row rather than in a
 * panel of its own, because it belongs to the Cash line.
 *
 * ── ONE ENGINE, TWO FACES ───────────────────────────────────────────────────
 *
 * Every figure here comes from `declarationView` via the till actions, which
 * reuse the back office's own engine and its `visibleFor` strip. This file owns
 * the LAYOUT and nothing else — no arithmetic, no rules about what may be seen.
 *
 * ── BLIND, THEN REVEALED IN PLACE ───────────────────────────────────────────
 *
 * Expected figures are withheld by the SERVER until a tender is declared, and
 * are asked for on blur — one tender at a time, in exchange for a committed
 * count. A cashier who can see the target is copying rather than counting.
 *
 * So every total panel below has two faces: an em dash before its tender has
 * been declared, the real figure after. The board never rearranges when a
 * figure arrives — the tile is the same size either way — because a layout that
 * reflows mid-count loses the cashier's place in the drawer.
 */

/** Which box the numpad is typing into. */
type Target =
  | { kind: 'denomination'; id: number }
  | { kind: 'tender'; id: number }
  | { kind: 'bank' }
  /* The coppers box. No id: there is one of it. */
  | { kind: 'smallChange' }
  | null

export default function DeclarationModal({
  open,
  shiftId,
  terminalId,
  pendingSales,
  onClose,
  onFinalized,
}: {
  open: boolean
  /** Null while there is no open shift — the dialog simply says so. */
  shiftId: number | null
  /** The till this machine claimed, or null when it has claimed none. */
  terminalId: number | null
  /** Outbox depth. A close while sales are queued reads over by their value. */
  pendingSales: number
  onClose: () => void
  /** Fires once the shift is signed off, so the shell can drop its KV.shift. */
  onFinalized: () => void
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  /**
   * Whether the denomination grid is what declares the cash.
   *
   * Open by default — counting the drawer out pile by pile is what this screen
   * is FOR, and the quick count on the till's shift menu is where a total gets
   * typed. Folding it away hands the cash box back to the pad so a shift that
   * does not count by denomination can declare one figure and move on.
   *
   * The two are EITHER/OR. Before this, the grid and the cash tender were
   * separate fields written to separate columns, so a drawer could be signed
   * off declaring R1 000 with a grid adding to R950 and nothing on screen
   * disagreed with itself.
   */
  const [countingCash, setCountingCash] = useState(true)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<VisibleDeclaration | null>(null)
  const [supervisors, setSupervisors] = useState<{ id: number; name: string }[]>([])
  /* Whose takings these are — a till in terminal mode, a person in user mode.
     Answered by the server, which also says whether this operator may change
     it; see tillCashupOwnersAction. */
  const [owners, setOwners] = useState<CashupOwners | null>(null)
  const [ownerId, setOwnerId] = useState('')

  const [supervisorId, setSupervisorId] = useState('')
  const [qty, setQty] = useState<Record<number, number>>({})
  const [declared, setDeclared] = useState<Record<number, number | undefined>>({})
  /** Expected figures this browser has EARNED by committing a count. */
  const [revealed, setRevealed] = useState<
    Record<number, { expected: number; floatIncluded: number }>
  >({})
  /**
   * Coppers, declared as one amount.
   *
   * Not a denomination row: the grid counts QUANTITIES and 1c/2c/5c are swept
   * together rather than counted, so the figure that matters is the rand value
   * of the handful. See sql/site/184_cashup_small_change.sql.
   */
  const [smallChange, setSmallChange] = useState(0)

  const [bankDeclared, setBankDeclared] = useState(0)
  const [bankReference, setBankReference] = useState('')
  const [varianceNote, setVarianceNote] = useState('')
  const [note, setNote] = useState('')

  /* ── The numpad's target ──────────────────────────────────────────────────
     The pad types into whichever box was last focused, and `entry` is that
     box's value as a DECIMAL STRING while it is being typed — the same trick
     NumPad itself uses, and for the same reason: a number cannot represent
     "5." or a trailing zero mid-entry. It is parsed on commit. */
  const [target, setTarget] = useState<Target>(null)
  const [entry, setEntry] = useState('')
  /**
   * Whether the empty buffer is a live edit or a finished one.
   *
   * An empty `entry` is ambiguous on its own, and the two readings want
   * opposite things on screen:
   *
   *   MID-EDIT — the cashier backspaced the box to nothing and is about to type
   *     a new figure. The box must look EMPTY, or the old number reappears
   *     under their fingers and the next digit appends to a figure they thought
   *     they had deleted.
   *
   *   POST-COMMIT — Enter banked the figure and reset the buffer. The box must
   *     show the COMMITTED value, or a cashier who has just pressed Enter
   *     watches their count vanish and types it again.
   *
   * Telling them apart is what this flag is for. It is not derivable from
   * `entry` — both states are the empty string — which is why guessing from the
   * buffer alone produced one bug or the other every time.
   */
  const [editing, setEditing] = useState(false)

  /* Loaded on open rather than held: a shift's takings move with every sale,
     so a view cached from the last time this was opened would be counting
     against a stale target. */
  useEffect(() => {
    if (!open || shiftId === null) return
    setTarget(null)
    setEntry('')
    setLoading(true)
    void Promise.all([
      tillDeclarationViewAction(shiftId),
      tillSupervisorsAction(),
      tillCashupOwnersAction(terminalId ?? null),
    ])
      .then(([result, people, ownerList]) => {
        if ('ok' in result) {
          toast.error(result.error)
          return
        }
        setView(result)
        setSupervisorId(
          Array.isArray(people)
            ? (people.find((s) => s.name === result.supervisorName)?.id?.toString() ?? '')
            : '',
        )
        setSupervisors(Array.isArray(people) ? people : [])
        if (ownerList && !('ok' in ownerList)) {
          setOwners(ownerList)
          /* Their own till or their own name, filled in for them. Somebody
             without `sales.cashup_other` never changes it, and somebody with it
             starts from the same sensible answer rather than an empty box. */
          setOwnerId(ownerList.defaultId !== null ? String(ownerList.defaultId) : '')
        }
        /* Seeded from the stored draft so a resumed count shows the work
           already done rather than an empty grid somebody has to redo. */
        setQty(Object.fromEntries(result.counted.map((c) => [c.denominationId, c.qty])))
        /*
          A SIGNED cash-up follows the RECORD rather than the default.

          Counting by denomination is the right default for a drawer somebody is
          about to count. Reading a signed one back it is a claim about what
          happened: no counted rows means the cash was declared as a total, and
          opening an empty grid over it would show eleven blank boxes as though
          a count had been made and lost. An unsigned draft keeps the default,
          because there the grid is an invitation rather than a statement.
        */
        if (result.finalizedAt != null) setCountingCash(result.counted.length > 0)
        else setCountingCash(true)
        setDeclared(
          Object.fromEntries(
            result.tenders
              .filter((t) => t.declared !== null)
              .map((t) => [t.tenderTypeId, t.declared!]),
          ),
        )
        setRevealed(
          Object.fromEntries(
            result.tenders
              .filter((t) => t.expected !== null)
              .map((t) => [
                t.tenderTypeId,
                { expected: t.expected!, floatIncluded: t.floatIncluded ?? 0 },
              ]),
          ),
        )
        setBankDeclared(result.bankDeclared)
        setBankReference(result.bankReference ?? '')
        setVarianceNote(result.varianceNote ?? '')
        setNote(result.note ?? '')
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shiftId])

  /* Derived on every keystroke rather than stored: a total the cashier can edit
     independently of the counts under it is a figure that can silently
     disagree with them. */
  const declaredCash = useMemo(
    () =>
      /* The piles PLUS the sweepings: what the drawer holds is both, and the
         split only matters when reading the count back. */
      round(
        (view?.denominations ?? []).reduce(
          (sum, d) => round(sum + d.value * (qty[d.id] ?? 0), 2),
          0,
        ) + smallChange,
        2,
      ),
    [qty, view, smallChange],
  )

  /* `every` over an empty list is TRUE, which on a shift that took nothing read
     as "every tender is declared" and put a confident green "Balanced R0.00" on
     screen before anybody had opened the drawer. A shift with no tenders has
     nothing to reconcile, so it has no variance either. */
  const everyTenderDeclared =
    view !== null &&
    view.tenders.length > 0 &&
    view.tenders.every((t) => declared[t.tenderTypeId] !== undefined)

/*
    Whether this operator was given the targets up front.

    `sales.cashup_expected` decides it, and the server says so by shipping the
    expected figures or withholding them — an undeclared tender that still knows
    what it should hold means they may see. Derived rather than passed, so the
    permission is answered in ONE place (visible.ts) and this only reflects it.
  */
  const sighted =
    view !== null &&
    view.tenders.length > 0 &&
    view.tenders.every((t) => revealed[t.tenderTypeId] !== undefined)

  /**
   * The difference, as it stands right now.
   *
   * ── WHY IT RUNS FOR A SIGHTED COUNT AND WAITS FOR A BLIND ONE ─────────────
   *
   * Sighted, every target is already on screen, so a running total is simply
   * the arithmetic the cashier is doing in their head anyway — and watching it
   * close on zero as each tender goes in is the whole point of showing the
   * figures. Waiting for the last box before saying anything made the headline
   * dead weight for the entire count.
   *
   * Blind, the figures arrive one at a time as tenders are committed, so a
   * running total would leak: a cashier could type a number into card, read the
   * difference move, and work backwards to what card was expected to hold. So
   * that count still says nothing until every tender is in, at which point
   * there is nothing left to infer.
   */
  const liveVariance = useMemo(() => {
    if (!view || view.tenders.length === 0) return null

    /*
      SIGHTED: every tender counts, and an uncounted one counts as ZERO.

      The boxes read 0.00 from the moment the dialog opens, so the difference
      says what those boxes claim — a drawer nobody has touched IS short by
      everything the shift took, and that figure closing on zero as each pile
      goes in is the reconciliation happening in front of the cashier.

      Summing only the tenders already typed into was the wrong reading of the
      same screen: it showed "short by R460" while five boxes sat at 0.00,
      which is a different arithmetic from the one on display.
    */
    if (sighted) {
      return view.tenders.reduce(
        (sum, t) =>
          round(sum + ((declared[t.tenderTypeId] ?? 0) - (revealed[t.tenderTypeId]?.expected ?? 0)), 2),
        0,
      )
    }

    /*
      BLIND: nothing until every tender is in.

      A running figure here would leak the targets — type a number into card,
      watch the difference move, and card's expectation is arithmetic away.
      Once every tender is declared there is nothing left to infer.
    */
    if (!everyTenderDeclared) return null
    if (view.tenders.some((t) => revealed[t.tenderTypeId] === undefined)) return null
    return view.tenders.reduce(
      (sum, t) =>
        round(sum + ((declared[t.tenderTypeId] ?? 0) - revealed[t.tenderTypeId].expected), 2),
      0,
    )
  }, [view, declared, revealed, everyTenderDeclared, sighted])

  /* How much of the count the headline is speaking for. A running figure that
     does not say "3 of 5" reads as the final answer, and a cashier three
     tenders in would think the shift was R400 short when it is merely
     unfinished. */
  const countedTenders = view
    ? view.tenders.filter((t) => declared[t.tenderTypeId] !== undefined).length
    : 0

  /* Only once the count is COMPLETE. A running difference wanders past the
     tolerance halfway through — one tender in, the shift always looks wildly
     short — and demanding an explanation for a figure that is still moving
     would ask the cashier to explain their own unfinished work. */
  const outside =
    liveVariance !== null &&
    view !== null &&
    everyTenderDeclared &&
    Math.abs(liveVariance) > view.tolerance

  function input() {
    return {
      supervisorId: supervisorId ? Number(supervisorId) : null,
      supervisorName: supervisors.find((s) => s.id.toString() === supervisorId)?.name ?? '',
      denominations: qty,
      smallChange,
      tenders: Object.fromEntries(
        Object.entries(declared)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [Number(k), v as number]),
      ),
      bankDeclared,
      bankReference: bankReference.trim() || null,
      varianceNote: varianceNote.trim() || null,
      note: note.trim() || null,
    }
  }

  /**
   * Commits one tender and asks for its expected figure in exchange.
   *
   * On BLUR rather than per keystroke: revealing while somebody is still typing
   * hands them the target half way through entering their own number, which is
   * the copying the blind count exists to prevent.
   */
  const commitTender = useCallback(
    (tenderTypeId: number, value: number | undefined, counts: Record<number, number>) => {
      if (shiftId === null || value === undefined) return
      /* Already revealed: the draft still needs the new figure saved, but the
         expected one must not be asked for twice — the reveal is a one-way
         door and re-asking would let a cashier probe it by retyping. */
      if (revealed[tenderTypeId]) return
      startTransition(async () => {
        const result = await tillRevealTenderAction(shiftId, tenderTypeId, value, counts)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        setRevealed((r) => ({
          ...r,
          [tenderTypeId]: { expected: result.expected, floatIncluded: result.floatIncluded },
        }))
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shiftId, revealed],
  )

  /* ── Numpad plumbing ──────────────────────────────────────────────────────
     `commit` writes the typed string into whichever box owns it and clears the
     entry. Called on Enter, and on focus moving to another box — so a cashier
     who taps straight from one denomination to the next never loses the figure
     they just typed. */
  const commit = useCallback(
    (t: Target, raw: string) => {
      if (!t || raw === '') return
      const trimmed = raw.endsWith('.') ? raw.slice(0, -1) : raw
      const n = Number(trimmed)
      if (!Number.isFinite(n)) return

      if (t.kind === 'denomination') {
        setQty((q) => ({ ...q, [t.id]: Math.max(0, Math.floor(n)) }))
      } else if (t.kind === 'tender') {
        const value = round(n, 2)
        setDeclared((d) => ({ ...d, [t.id]: value }))
        /* The count grid as it stands right now — commitTender saves the draft
           alongside the reveal, and a stale `qty` here would persist a count
           the cashier has already corrected. */
        setQty((q) => {
          commitTender(t.id, value, q)
          return q
        })
      } else if (t.kind === 'smallChange') {
        setSmallChange(round(n, 2))
      } else {
        setBankDeclared(round(n, 2))
      }
    },
    [commitTender],
  )

  /** Focus moved, or Enter pressed: bank what was typed, then aim at the new box. */
  const aim = useCallback(
    (next: Target, seed = '') => {
      setTarget((current) => {
        setEntry((typed) => {
          if (current && typed !== '') commit(current, typed)
          return seed
        })
        /* A fresh box is not mid-edit: it shows what is committed until a key
           is pressed. */
        setEditing(false)
        return next
      })
    },
    [commit],
  )

  /**
   * What the pad is editing.
   *
   * The live buffer while one is being typed; otherwise the figure the aimed
   * box is showing — so backspace cuts a digit off the number on screen rather
   * than off an empty string it cannot see.
   */
  const padValue = useMemo(() => {
    if (editing) return entry
    if (!target) return entry
    if (target.kind === 'tender') {
      const v = declared[target.id]
      return v === undefined ? '' : String(v)
    }
    if (target.kind === 'denomination') {
      const q = qty[target.id]
      return q ? String(q) : ''
    }
    if (target.kind === 'smallChange') return smallChange ? String(smallChange) : ''
    return String(bankDeclared)
  }, [editing, entry, target, declared, qty, bankDeclared, smallChange])

  /** The pad wrote to the buffer, so it is a live edit from here. */
  const typeInto = useCallback((next: string) => {
    setEditing(true)
    setEntry(next)
  }, [])

  /* Enter commits and drops to the next denomination down, which is how a
     drawer is actually counted — R200s, then R100s, then R50s, without ever
     reaching for the mouse. */
  const denominationOrder = useMemo(
    () => (view?.denominations ?? []).map((d) => d.id),
    [view],
  )

  const onEnter = useCallback(() => {
    setTarget((current) => {
      /*
        THE BUFFER ALWAYS CLEARS; WHERE THE AIM GOES IS WHAT DIFFERS.

        On a denomination, Enter moves DOWN a row — the buffer empties for the
        pile about to be counted and the row just left renders its committed
        quantity.

        Otherwise the aim is DROPPED entirely. It used to stay put with the
        typed string retained, so the box would not look empty — but the buffer
        belongs to whatever is aimed, so that "100" followed the cashier to the
        next tender they touched and committed itself there a second time.

        With no target the box falls back to its committed value, which is the
        same figure on screen and nothing left to leak. The pad greys out until
        another box is tapped, which is honest: there is nothing to type into.
      */
      const movingOn =
        current?.kind === 'denomination' &&
        denominationOrder.indexOf(current.id) < denominationOrder.length - 1

      setEntry((typed) => {
        if (current && typed !== '') commit(current, typed)
        return ''
      })
      /* Committed, not cleared — the box goes back to showing its figure. */
      setEditing(false)

      if (!movingOn) return current
      const at = denominationOrder.indexOf((current as { kind: 'denomination'; id: number }).id)
      return { kind: 'denomination', id: denominationOrder[at + 1] }
    })
  }, [commit, denominationOrder])

  /* Enter is the pad's own key and belongs to it, not the dialog — a cash-up is
     not a form that submits, and letting Enter fall through to the footer would
     put "Finalize" one stray keypress away mid-count. */
  useEffect(() => {
    if (!open || target === null) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Enter') return
      event.preventDefault()
      onEnter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, target, onEnter])

  function saveNow() {
    if (shiftId === null) return
    startTransition(async () => {
      const result = await tillSaveDeclarationAction(shiftId, input())
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  function finalizeNow() {
    if (shiftId === null) return
    startTransition(async () => {
      const result = await tillFinalizeDeclarationAction(shiftId, input())
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        result.variance === 0
          ? 'Cashed up exactly.'
          : `Cashed up ${result.variance < 0 ? 'short' : 'over'} by ${Math.abs(result.variance).toFixed(2)}.`,
      )
      onFinalized()
      onClose()
    })
  }

  const signed = view?.finalizedAt != null

  /**
   * Every control's disabled state, in one name.
   *
   * A signed cash-up renders the same board so it can be read back, which means
   * every input on it must be inert — and "inert" has to be one decision rather
   * than `pending` in some places and `pending || signed` in others. That drift
   * is how a signed record ends up with one editable box nobody noticed.
   */
  const locked = pending || signed

  /* The drawer tender — the one the grid counts. Found by the flag rather
     than by name so a site that renamed it still works. */
  const cashTender = view?.tenders.find((t) => t.countsAsDrawerCash) ?? null

  /* Cash first, because it is the one that has to be physically counted and
     the one whose row opens. The rest keep the order the server sent them. */
  const orderedTenders = view
    ? [
        ...view.tenders.filter((t) => t.countsAsDrawerCash),
        ...view.tenders.filter((t) => !t.countsAsDrawerCash),
      ]
    : []

  /**
   * What cash is being declared as, whichever way it was entered.
   *
   * The single figure the rest of the screen reads, so the grid and the typed
   * total cannot reach the record as two different numbers.
   */
  const cashDeclared = cashTender
    ? countingCash
      ? declaredCash
      : declared[cashTender.tenderTypeId]
    : undefined

  /**
   * Opens and shuts the drawer count under the Cash row.
   *
   * Folding it away commits what the grid last added to as the cash figure, so
   * the number does not jump when somebody collapses it and the box below is
   * seeded rather than empty.
   */
  function toggleCounting() {
    if (signed || !cashTender) return
    setCountingCash((wasOpen) => {
      if (wasOpen) {
        commit({ kind: 'tender', id: cashTender.tenderTypeId }, String(declaredCash))
      }
      return !wasOpen
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="full"
      bodyFills
      /* The pad bar spends a fixed ~250px of the body on touch-size keys, so
         the content above it needs more than 70vh to stay readable. */
      bodyTall
      title="Cash-up / Cash declaration"
      /* The screen's crest. `titleMedia` is the kit's own slot for this, so the
         title and close button keep the positions every other dialog uses. */
      titleMedia={
        <span className="flex h-12 w-12 items-center justify-center rounded-card bg-brand-soft text-brand">
          <Icons.Calculator size={24} />
        </span>
      }
      description={
        view
          ? `${view.ownerLabel} · trading since ${new Date(view.openedAt).toLocaleString('en-ZA')}`
          : undefined
      }
      /* Half-counted work behind a stray click is exactly what this must not
         lose — the draft is saved per tender, but the grid is not. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Close
          </Button>
          {view && !signed && (
            <>
              <Button variant="ghost" onClick={saveNow} disabled={pending}>
                Save count
              </Button>
              <Button
                variant="success"
                disabled={
                  pending || !everyTenderDeclared || !supervisorId || (outside && !varianceNote.trim())
                }
                onClick={finalizeNow}
              >
                {!pending && <Icons.Check size={16} />}
                {pending ? 'Signing off…' : 'Finalize cash-up'}
              </Button>
            </>
          )}
        </>
      }
    >
      {shiftId === null ? (
        <Callout tone="brand" title="No shift is open on this till">
          Open a shift before cashing up — there is nothing to count against yet.
        </Callout>
      ) : loading && !view ? (
        <p className="py-8 text-center text-sm text-muted">Reading the shift…</p>
      ) : !view ? null : (
        /* `min-h-0` and NOT `overflow-y-auto`: the body no longer scrolls as
           one piece. Panel 1 pins its pad to its own bottom, and a pad inside a
           scrolling parent slides away with everything else however it is
           positioned — the parent is what moves. So the height stops here and
           each column overflows inside itself. */
        <div className="flex min-h-0 flex-col gap-4">
          {/*
            ── A SIGNED CASH-UP IS THE SAME BOARD, READ-ONLY ──────────────────

            This used to be a dead end: a one-line callout saying the back
            office held the record, which was true only while a second screen
            existed to hold it. There is one screen now, so a signed cash-up has
            to BE readable here — the frozen figures, the count that produced
            them, the difference somebody signed under.

            Same board, every control inert. Rebuilding it as a separate
            read-only view would be a third rendering of the same figures, and
            the two that already existed are exactly what this change removed.
          */}
          {signed && (
            <Callout tone="success" title="This cash-up is signed off">
              Every figure below was committed at the time and can no longer be changed.
              {view.finalizedAt
                ? ` Signed ${new Date(view.finalizedAt).toLocaleString('en-ZA')}.`
                : ''}
            </Callout>
          )}

          {/* Only worth saying while there is still something to sign. */}
          {!signed && pendingSales > 0 && (
            <Callout
              tone="warning"
              title={`${pendingSales} sale${pendingSales === 1 ? '' : 's'} still to send`}
            >
              The expected figures exclude them — send the outbox before signing off, or the
              drawer will read over by their whole value.
            </Callout>
          )}

          {/* Three columns on a till screen, stacking on anything narrower.
              The left one is the count and never moves; the middle and right
              are what the count is being measured against.

              `min-h-0 xl:flex-1` so the row takes the height the body has left
              rather than its content's height — which is what lets panel 1 be a
              fixed-height box with a scroller in it. Below xl the columns stack
              and the whole thing scrolls normally, because a stacked pad at the
              bottom of a phone-shaped modal would cover the boxes it types
              into. */}
          {/* The middle and right columns are wider than an equal split:
              "Direct deposit" wrapped onto two lines in the tender table and
              the supervisor's name truncated mid-word, both because a third
              each is not what this content needs. The count column is the one
              with a fixed-width pad in it, so it is the one that can be pinned. */}
          {/* Panel 1 got the width the merge needs. At 25rem it was sized for
              a column of labelled boxes; it now holds a four-column table with
              the denomination grid nested inside it, and at the old width the
              Cash row's own label ran into the Expected figure beside it. The
              other two columns hold read-only figures and give the room up more
              cheaply than the count can do without it. */}
          <div className="grid min-h-0 flex-1 auto-rows-fr gap-4 xl:grid-cols-[minmax(0,38rem)_minmax(0,1fr)_minmax(0,1fr)]">
            {/* ── 1 · Everything being declared, and the pad that types it ──
                THE PAD IS FIXED TO THE BOTTOM; THE DECLARATION SCROLLS ABOVE IT.

                The pad used to sit beside the boxes, which kept both on screen
                but cost the count half its width — and once cash, its
                denomination grid and every other tender lived in one panel,
                the column beside a 12rem pad was too narrow to read.

                Below and fixed is the arrangement a till actually wants: the
                keys never move, they are near the thumb at the bottom of the
                screen, and the list above scrolls to whatever is being counted.
                `shrink-0` on the pad and `min-h-0 overflow-y-auto` on the list
                is what splits them — without `min-h-0` the list refuses to
                shrink below its content and pushes the pad off the panel, which
                is the flex-column trap this codebase has hit before. */}
            <Panel n={1} title="Declare your takings" fills>
              <div className="flex min-h-0 flex-1 flex-col gap-4">
              {/* The whole declaration in one scroller. The pad is no longer in
                  here competing for the height — it spans the modal's own
                  bottom, under all three columns. */}
              {/* `till-pane`: a 12px thumb and contained overscroll, because
                  this is read at arm's length and dragged with a finger. The
                  app's 8px default is both invisible and unhittable on a
                  counter screen. */}
              <div className="till-pane min-w-0 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                {/*
                  "Nothing was taken" is only true if nothing was taken.

                  `view.tenders` is built from sales tenders alone, so a shift
                  that took a lay-by deposit and rang up no sale showed this
                  beside a drawer holding the deposit — telling a cashier to
                  expect the float when the right answer was the float plus it.
                */}
                {view.tenders.length === 0 && (
                  <p className="text-sm text-muted">
                    {view.offLedgerCash !== 0 ? (
                      <>
                        No sale was rung up on this shift, but{' '}
                        <span className="numeric font-semibold text-ink">
                          {formatMoney(view.offLedgerCash)}
                        </span>{' '}
                        came in against lay-bys and deposits. Count the drawer for the float and
                        that.
                      </>
                    ) : (
                      'Nothing was taken on this shift. Signing off records the float only.'
                    )}
                  </p>
                )}

                {/*
                  ── ONE TABLE, AND THE DECLARED COLUMN IS THE FORM ──────────

                  This panel used to be a column of labelled boxes while panel 2
                  showed the same tenders again as a read-only table of
                  Expected / Declared / Difference. Two renderings of one list:
                  the box you typed into and the row that judged it were in
                  different panels, so checking your own work meant looking away
                  from what you had just typed.

                  They are the same thing now. The Declared column IS the box,
                  so a tender is one row carrying what it should have taken,
                  what is being said it took, and the gap between them.

                  `table-fixed` so the columns divide the width they are GIVEN.
                  Left to itself the table sizes to its content and spills under
                  the pad, which is what put the Amount column behind the keys.
                */}
                {view.tenders.length > 0 && (
                  <table className={`${TABLE} table-fixed`}>
                    <thead>
                      <tr className={TABLE_HEAD_ROW}>
                        <th className={TABLE_TH}>Tender</th>
                        <th className={`${TABLE_TH} w-24 text-right`}>Expected</th>
                        <th className={`${TABLE_TH} w-32 text-right`}>Declared</th>
                        <th className={`${TABLE_TH} w-24 text-right`}>Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderedTenders.map((t) => {
                        const isCash = t.countsAsDrawerCash
                        /* Cash may be driven by the grid; every other tender is
                           only ever what was typed into its own row. */
                        const value = isCash ? cashDeclared : declared[t.tenderTypeId]
                        const shown = revealed[t.tenderTypeId]
                        /*
                          Sighted, an uncounted tender reads 0.00 in its box, so
                          it differences against the whole expectation. Blind, it
                          stays an em dash: there is no target to measure yet.
                        */
                        const effective = sighted ? (value ?? 0) : value
                        const variance =
                          effective !== undefined && shown
                            ? round(effective - shown.expected, 2)
                            : null
                        const aimed =
                          target?.kind === 'tender' && target.id === t.tenderTypeId

                        return (
                          <Fragment key={t.tenderTypeId}>
                            <tr className={TABLE_ROW}>
                              <td className={TABLE_TD}>
                                {/* The cash row carries the fold for its own
                                    breakdown. A tender with nothing to break
                                    down gets no chevron rather than a dead one. */}
                                {isCash ? (
                                  <RowDisclosure
                                    label={t.tenderName}
                                    hint={
                                      countingCash
                                        ? 'counted by denomination'
                                        : 'count it out'
                                    }
                                    open={countingCash}
                                    onToggle={toggleCounting}
                                    disabled={signed}
                                  />
                                ) : (
                                  t.tenderName
                                )}
                              </td>
                              <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                                {/* An em dash: this browser has not been told
                                    the figure, rather than being styled out of
                                    view. */}
                                {!shown ? (
                                  <span className="text-faint">—</span>
                                ) : (
                                  formatMoney(shown.expected)
                                )}
                              </td>
                              <td className={`${TABLE_TD_INPUT} ${TABLE_NUMERIC}`}>
                                {/* Plain Input, not NumberInput: the PAD is the
                                    writer here, so the box must render `entry`
                                    rather than keep a buffer of its own. */}
                                <Input
                                  icon={
                                    <span className="text-sm font-medium text-muted">R</span>
                                  }
                                  aria-label={`${t.tenderName} declared`}
                                  className={`numeric text-right ${
                                    value === undefined && !aimed ? 'text-faint' : ''
                                  }`}
                                  inputMode="decimal"
                                  autoComplete="off"
                                  data-1p-ignore
                                  data-lpignore="true"
                                  /*
                                    ALWAYS A FIGURE, NEVER AN EMPTY BOX. An
                                    uncounted tender reads 0.00 like every
                                    other; `value === undefined` still means
                                    "nobody counted this", and sign-off still
                                    refuses by name rather than banking a zero
                                    nobody counted. The faint tone is what
                                    carries the distinction on screen.
                                  */
                                  value={
                                    aimed && editing ? entry : (value ?? 0).toFixed(2)
                                  }
                                  /* Read-only while the grid drives it: two
                                     editable fields for one figure is how they
                                     come to disagree. */
                                  readOnly={signed || (isCash && countingCash)}
                                  disabled={locked}
                                  onFocus={
                                    signed || (isCash && countingCash)
                                      ? undefined
                                      : () =>
                                          aim(
                                            { kind: 'tender', id: t.tenderTypeId },
                                            value === undefined ? '' : String(value),
                                          )
                                  }
                                  onChange={(e) =>
                                    typeInto(
                                      e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''),
                                    )
                                  }
                                  onBlur={() => {
                                    if (
                                      (isCash && countingCash) ||
                                      target?.kind !== 'tender' ||
                                      target.id !== t.tenderTypeId ||
                                      entry === ''
                                    )
                                      return
                                    commit({ kind: 'tender', id: t.tenderTypeId }, entry)
                                  }}
                                />
                              </td>
                              {/* A pill per row: the difference is the one
                                  column carrying a judgement, and a tinted chip
                                  is findable down a column of plain figures in
                                  a way coloured text is not. */}
                              <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                                {variance === null ? (
                                  <span className="text-faint">—</span>
                                ) : variance === 0 ? (
                                  <Badge tone="success">0.00</Badge>
                                ) : (
                                  <Badge tone={variance < 0 ? 'danger' : 'warning'}>
                                    {variance < 0 ? '−' : '+'}
                                    {formatMoney(Math.abs(variance))}
                                  </Badge>
                                )}
                              </td>
                            </tr>

                            {/* ── The drawer, counted out, under its own row ── */}
                            {isCash && countingCash && (
                              <tr className="border-b border-border bg-surface-2">
                                <td colSpan={4} className="px-2 py-3">
                                  <table className={`${TABLE} table-fixed`}>
                                    <thead>
                                      <tr className={TABLE_HEAD_ROW}>
                                        <th className={TABLE_TH}>Denomination</th>
                                        {/* Fixed, or the qty inputs are the
                                            first thing the browser squeezes
                                            when the pad takes its width. */}
                                        <th className={`${TABLE_TH} w-24 text-right`}>Qty</th>
                                        <th className={`${TABLE_TH} text-right`}>Amount</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {view.denominations.map((d) => {
                                        const dAimed =
                                          target?.kind === 'denomination' && target.id === d.id
                                        const n = qty[d.id] ?? 0
                                        return (
                                          <tr key={d.id}>
                                            <td className={TABLE_TD}>{d.label}</td>
                                            <td className={`${TABLE_TD} text-right`}>
                                              {/*
                                                A plain Input, deliberately NOT
                                                NumberInput. NumberInput keeps
                                                its own buffer while focused and
                                                ignores `value` until blur —
                                                right when a keyboard is the
                                                only writer, wrong here: the pad
                                                writes to `entry`, so a
                                                touch-only cashier would watch
                                                their taps do nothing.
                                              */}
                                              <Input
                                                className="numeric w-full min-w-14 text-right"
                                                inputMode="numeric"
                                                autoComplete="off"
                                                data-1p-ignore
                                                data-lpignore="true"
                                                aria-label={`${d.label} count`}
                                                /* Aimed, the buffer is the box.
                                                   Unaimed, an empty pile stays
                                                   blank rather than showing a
                                                   column of noisy zeros. */
                                                value={dAimed ? entry : n === 0 ? '' : String(n)}
                                                disabled={locked}
                                                readOnly={signed}
                                                onFocus={
                                                  signed
                                                    ? undefined
                                                    : () =>
                                                        aim(
                                                          { kind: 'denomination', id: d.id },
                                                          n === 0 ? '' : String(n),
                                                        )
                                                }
                                                onChange={(e) =>
                                                  typeInto(e.target.value.replace(/[^0-9]/g, ''))
                                                }
                                              />
                                            </td>
                                            {/* Zero stays faint: a column of
                                                0.00 competes with the rows that
                                                actually hold money. */}
                                            <td
                                              className={`${TABLE_TD} ${TABLE_NUMERIC} ${n === 0 ? 'text-faint' : ''}`}
                                            >
                                              {formatMoney(round(d.value * n, 2))}
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>

                                  {/*
                                    ── SMALL CHANGE, AT THE BOTTOM ────────────

                                    Every row above counts a PILE — a quantity,
                                    multiplied by what that coin is worth. This
                                    one takes the money directly, because the
                                    coppers at the bottom of a drawer are not
                                    counted that way: 1c, 2c and 5c pieces are
                                    swept together and declared as one amount,
                                    and asking "how many 2c" gets either a guess
                                    or a cashier on their knees.

                                    Last, and separated by a rule, because it is
                                    the sweeping up rather than another pile.
                                  */}
                                  <div className="mt-3 flex items-center gap-3 border-t border-border px-2 pt-3">
                                    <label
                                      htmlFor="small-change"
                                      className="min-w-0 flex-1 text-sm font-medium text-ink-2"
                                    >
                                      Small change
                                      <span className="block text-xs font-normal text-muted">
                                        1c, 2c, 5c — as one amount
                                      </span>
                                    </label>
                                    <div className="w-32 shrink-0">
                                      <Input
                                        id="small-change"
                                        icon={
                                          <span className="text-sm font-medium text-muted">
                                            R
                                          </span>
                                        }
                                        className="numeric text-right"
                                        inputMode="decimal"
                                        autoComplete="off"
                                        data-1p-ignore
                                        data-lpignore="true"
                                        value={
                                          target?.kind === 'smallChange' && editing
                                            ? entry
                                            : smallChange.toFixed(2)
                                        }
                                        disabled={locked}
                                        readOnly={signed}
                                        onFocus={
                                          signed
                                            ? undefined
                                            : () =>
                                                aim({ kind: 'smallChange' }, String(smallChange))
                                        }
                                        onChange={(e) =>
                                          typeInto(
                                            e.target.value
                                              .replace(',', '.')
                                              .replace(/[^0-9.]/g, ''),
                                          )
                                        }
                                        onBlur={() => {
                                          if (target?.kind !== 'smallChange' || entry === '')
                                            return
                                          commit({ kind: 'smallChange' }, entry)
                                        }}
                                      />
                                    </div>
                                  </div>

                                  {/* The one figure here that is not typed.
                                      Loud, because it is what the whole grid
                                      exists to produce — and it is what the
                                      Declared box on the row above is showing. */}
                                  <div className="mt-3 flex items-baseline justify-between rounded-card bg-warning-soft px-4 py-2.5">
                                    <span className="text-sm font-medium text-ink">
                                      Total cash (declared)
                                    </span>
                                    <span className="numeric text-lg font-bold text-ink">
                                      {formatMoney(declaredCash)}
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              {/*
                ── THE PAD, ANCHORED TO THIS PANEL ───────────────────────────

                `shrink-0` under a `min-h-0 overflow-y-auto` list: the list gives
                way, the keys never do. It briefly spanned the whole dialog
                instead, which bought the declaration height but put the pad at
                the bottom of a modal whose columns scroll — so on a short screen
                you could scroll the keys out of reach, which is the one thing a
                numpad must never do.

                Here it cannot move at all. The panel owns its height, the list
                inside it scrolls, and the keys sit under that list wherever the
                scroll happens to be.
              */}
              {/* Gone entirely on a signed cash-up: a pad that cannot type is
                  a third of the panel spent telling somebody so, and the
                  record it sits under is the thing they opened this to read. */}
              <div className={`shrink-0 border-t border-border pt-3 ${signed ? 'hidden' : ''}`}>
                <div className="flex items-start justify-center gap-3">
                  {/* A stable key size under the thumb — not a fraction, which
                      would resize the keys every time the column did. */}
                  <div className="w-[13rem] shrink-0">
                    <NumPad
                      value={padValue}
                      onChange={typeInto}
                      /* Whole numbers when counting a pile of notes, decimals
                         when declaring a machine slip. */
                      maxDecimals={target?.kind === 'denomination' ? 0 : 2}
                      disabled={locked || target === null}
                    />
                  </div>
                  {/* Beside the keys rather than under them: stacked, the button
                      and its hint were the first things pushed off the panel. */}
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Button
                      variant="primary"
                      size="touch"
                      disabled={locked || target === null}
                      onClick={onEnter}
                    >
                      Enter
                      {/* The arrow says what the key DOES — drops to the next
                         row — which the word alone does not. */}
                      <Icons.ArrowRight size={16} />
                    </Button>
                    <p className="text-xs text-muted">
                      {target === null
                        ? 'Tap a box to start counting — the pad types into it.'
                        : 'Enter drops to the next row down.'}
                    </p>
                  </div>
                </div>
              </div>
              </div>
            </Panel>

            {/* ── The middle column: everything that is not a tender ────────
                The per-tender totals used to live here as a table of their own,
                repeating the boxes in the left column. They are now the same
                table — see panel 1 — so what is left here is the money that
                moved WITHOUT being a tender somebody counts, and the bag.
                Scrolls itself now that the body does not. */}
            <div className="till-pane flex flex-col gap-4 xl:min-h-0 xl:overflow-y-auto">
              <Panel n={2} title="Other transactions">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
                  <Figure label="Opening float" value={view.openingFloat} />
                  <Figure label="Payouts" value={-view.payoutsTotal} />
                  <Figure label="Pay-ins" value={view.payinsTotal} />
                  <Figure label="Drops to safe" value={-view.dropsTotal} />
                  <Figure label="Refunds" value={-view.refundsTotal} />
                  {/* The 5c the drawer legitimately does not hold. */}
                  <Figure label="Rounding" value={view.roundingTotal} />
                  <Figure label="Tips" value={view.tipsTotal} />
                  <Figure label="Lay-buy deposits" value={view.laybyDeposits} />
                  <Figure label="Lay-buy instalments" value={view.laybyPayments} />
                  <Figure label="Sale deposits" value={view.saleDepositsTaken} />
                  {view.saleDepositsRefunded > 0 && (
                    <Figure label="Deposits refunded" value={-view.saleDepositsRefunded} />
                  )}
                  <Figure label="Gift cards sold" value={view.giftCardSold} />
                  <Figure label="Gift cards redeemed" value={-view.giftCardRedeemed} />
                  <Figure label="Loyalty top-ups" value={view.loyaltyWallet} />
                </dl>
              </Panel>

              {/* Banking is its own question: a drawer can reconcile perfectly
                  and still have the wrong amount put in the bag. */}
              <Panel n={3} title="To bank">
                <div className="flex flex-wrap items-end gap-4">
                  <Field label="Bank declared" className="w-40">
                    <Input
                      icon={<span className="text-sm font-medium text-muted">R</span>}
                      className="numeric text-right"
                      inputMode="decimal"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      value={target?.kind === 'bank' ? entry : bankDeclared.toFixed(2)}
                      disabled={locked}
                      onFocus={() => aim({ kind: 'bank' }, String(bankDeclared))}
                      onChange={(e) =>
                        typeInto(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))
                      }
                      onBlur={() => {
                        if (target?.kind !== 'bank' || entry === '') return
                        commit({ kind: 'bank' }, entry)
                      }}
                    />
                  </Field>
                  <Field label="Bag / reference" className="w-48">
                    <Input
                      value={bankReference}
                      disabled={locked}
                      onFocus={() => aim(null)}
                      onChange={(e) => setBankReference(e.target.value)}
                      placeholder="e.g. BAG-0194"
                    />
                  </Field>
                  <div className="pb-1">
                    <span className="block text-xs font-medium text-muted">Available to bank</span>
                    <span className="numeric text-base font-semibold text-ink">
                      {view.expectedCashVisible === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        formatMoney(view.bankExpected)
                      )}
                    </span>
                  </div>
                </div>
              </Panel>
            </div>

            {/* ── The right column: what it all comes to ───────────────────
                Scrolls itself now that the body does not. */}
            <div className="till-pane flex flex-col gap-4 xl:min-h-0 xl:overflow-y-auto">
              {/* The bottom line sits FIRST in this column and not in a tab,
                  because it is the answer the whole dialog exists to produce. */}
              {/* WHO is signing this off — its own card, because it is answered
                  once at the start and then left alone. The figure below changes
                  on every keystroke; keeping the two apart stops a moving number
                  sitting inside the box somebody has already filled in. */}
              <div className="shrink-0 rounded-card border border-border bg-surface px-4 py-4">
                <div className="flex flex-wrap items-end gap-3 [&>*]:min-w-0 [&>*]:flex-1">
                  <div className="contents">
                    {/*
                      WHOSE TAKINGS THESE ARE.

                      Beside the supervisor because the two answer the halves of
                      the same question — whose money, and who watched it
                      counted. The label follows the site's mode: a till is what
                      a terminal-mode shift belongs to, a person is what a
                      user-mode one does.

                      Locked unless `sales.cashup_other`. Disabled rather than
                      hidden: a cashier should SEE which drawer they are
                      counting, and an absent field would leave them guessing at
                      a machine several people share.
                    */}
                    {owners && (
                      <Field
                        label={owners.mode === 'terminal' ? 'Till' : 'Cashier'}
                        className="min-w-0"
                        hint={
                          owners.canChoose
                            ? undefined
                            : owners.mode === 'terminal'
                              ? 'This machine’s own till.'
                              : 'Your own takings.'
                        }
                      >
                        <Select
                          value={ownerId}
                          disabled={locked || !owners.canChoose}
                          onFocus={() => aim(null)}
                          onChange={(e) => setOwnerId(e.target.value)}
                        >
                          {/* Only ever offered to somebody who may choose — for
                              everyone else the field is already filled in, and
                              an empty option would invite clearing it. */}
                          {owners.canChoose && <option value="">— Whose takings —</option>}
                          {owners.options.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    <Field label="Supervisor" className="min-w-0">
                      <Select
                        value={supervisorId}
                        disabled={locked}
                        onFocus={() => aim(null)}
                        onChange={(e) => setSupervisorId(e.target.value)}
                      >
                        <option value="">— Who witnessed the count —</option>
                        {supervisors.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                </div>
              </div>

              {/* WHAT IT CAME TO, and the two boxes that explain it. Left
                  aligned rather than right: this card is read top to bottom —
                  the label, the figure, then why — and a right-aligned headline
                  over left-aligned fields reads as two unrelated things. */}
              <div className="shrink-0 rounded-card border border-border bg-surface px-4 py-4">
                  <div>
                    <span className="block text-sm text-ink-2">
                      {liveVariance === null
                        ? 'Declare every tender to see the difference'
                        : liveVariance === 0
                          ? 'Balanced'
                          : liveVariance < 0
                            ? 'Short by'
                            : 'Over by'}
                      {/* The figure below counts every tender, treating an
                          uncounted one as zero — so it is the real difference
                          for what is on screen, but not yet the shift's final
                          answer. Saying how much has been counted is what keeps
                          those two readings apart. */}
                      {liveVariance !== null && !everyTenderDeclared && view !== null && (
                        <span className="text-muted">
                          {' '}
                          · {countedTenders} of {view.tenders.length} tenders counted
                        </span>
                      )}
                    </span>
                    <span
                      className={`numeric text-3xl font-bold ${
                        liveVariance === null
                          ? 'text-faint'
                          : liveVariance === 0
                            ? 'text-success'
                            : outside
                              ? 'text-danger'
                              : 'text-ink'
                      }`}
                    >
                      {liveVariance === null ? '—' : formatMoney(Math.abs(liveVariance))}
                    </span>
                  </div>

                {outside && (
                  <div className="mt-3">
                    <Field
                      label="Explain the difference"
                      hint={`Outside the ${formatMoney(view.tolerance)} tolerance, so this is required.`}
                    >
                      <Input
                        value={varianceNote}
                        disabled={locked}
                        onFocus={() => aim(null)}
                        onChange={(e) => setVarianceNote(e.target.value)}
                        placeholder="e.g. Two R20 notes could not be found. Reported."
                      />
                    </Field>
                  </div>
                )}

                <div className="mt-3">
                  <Field label="Note" hint="Anything the manager should read with this cash-up.">
                    <Input
                      value={note}
                      disabled={locked}
                      onFocus={() => aim(null)}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </Field>
                </div>
              </div>

              <Panel n={4} title="Counters">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <Count
                    icon={<Icons.Receipt size={18} />}
                    label="Sales"
                    value={view.counters.salesCount}
                  />
                  <Count
                    icon={<Icons.Banknote size={18} />}
                    label="Cash only"
                    value={view.counters.cashSales}
                  />
                  <Count
                    icon={<Icons.CreditCard size={18} />}
                    label="Card only"
                    value={view.counters.cardSales}
                  />
                  <Count
                    icon={<Icons.Users size={18} />}
                    label="Account"
                    value={view.counters.accountSales}
                  />
                  <Count
                    icon={<Icons.RotateCw size={18} />}
                    label="Refunds"
                    value={view.counters.refundCount}
                  />
                  {/* Three void figures, not one. An item void is a mis-scan
                      and happens all day; a sale void is a whole basket
                      abandoned. The old single "Voided sales" rolled those
                      together with finalised sales reversed after the fact,
                      and answered none of the three questions. */}
                  <Count
                    icon={<Icons.Ban size={18} />}
                    label="Void items"
                    value={view.counters.voidItems}
                  />
                  <Count
                    icon={<Icons.Ban size={18} />}
                    label="Void lines"
                    value={view.counters.voidLines}
                  />
                  <Count
                    icon={<Icons.Ban size={18} />}
                    label="Void sales"
                    value={view.counters.voidSales}
                    tone={view.counters.voidSales > 0 ? 'warning' : undefined}
                  />
                  <Count
                    icon={<Icons.RotateCw size={18} />}
                    label="Cancelled sales"
                    value={view.counters.cancelledSales}
                    tone={view.counters.cancelledSales > 0 ? 'warning' : undefined}
                  />
                  <Count
                    icon={<Icons.HandCoins size={18} />}
                    label="Payouts"
                    value={view.counters.payoutCount}
                  />
                </dl>

                {/* Transactions per tender, off the money table.

                    "Txns" and not "sales": a split sale puts a row under each
                    tender it used, so these sum to MORE than the sale count
                    above. Keeping them in their own group under a rule is what
                    stops the two being read as the same kind of number. */}
                {view.counters.tenderTxns.length > 0 && (
                  <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4">
                    {view.counters.tenderTxns.map((t) => (
                      <Count
                        key={t.tenderName}
                        icon={<Icons.Receipt size={18} />}
                        label={`${t.tenderName} txns`}
                        value={t.count}
                      />
                    ))}
                  </dl>
                )}
              </Panel>

            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

/**
 * One numbered block of the board.
 *
 * The number is not decoration: a supervisor reads a cash-up out loud over the
 * phone, and "panel 8" is a shorter thing to say than "the card totals box on
 * the right". The legacy till numbered them for the same reason.
 */
function Panel({
  n,
  title,
  fills = false,
  children,
}: {
  n: number
  title: string
  /**
   * Take the column's height and let the children do the scrolling.
   *
   * For the one panel that pins a control to its own bottom. `min-h-0` is the
   * load-bearing half: a flex child will not shrink below its content without
   * it, so the panel would grow past the column and take the pinned pad off the
   * screen with it — which is exactly the bug this mode exists to fix.
   */
  fills?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      className={`rounded-card border border-border bg-surface p-4 ${
        /* `shrink-0`, NOT `self-start`. Only the panel that pins a control to
           its own bottom wants the row's full height; the rest should keep
           their natural height and let the column scroll past them.

           self-start looked right and was the wrong axis: in a flex COLUMN the
           cross axis is horizontal, so it stopped each panel filling the
           column's width and every one shrank to its own content — panel 3 came
           out visibly narrower than panel 2 directly above it. */
        fills ? 'flex min-h-0 flex-col h-full self-stretch' : 'shrink-0'
      }`}
    >
      <h3 className="mb-3 flex shrink-0 items-center gap-2 text-sm font-semibold text-ink">
        {/* A FILLED disc, not a tint. These are the numbers a supervisor
            reads down the phone — "what does panel 8 say" — so they have to be
            findable at a glance across a busy screen, and a pale chip full of
            pale type is the one thing on the panel that disappears. */}
        <span className="numeric flex h-6 w-6 shrink-0 items-center justify-center rounded-pill bg-brand text-xs font-bold text-white">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </section>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`numeric text-sm font-semibold ${
          value < 0 ? 'text-danger' : value > 0 ? 'text-ink' : 'text-faint'
        }`}
      >
        {formatMoney(value)}
      </dd>
    </div>
  )
}

/**
 * One counter: a glyph, what it counts, and how many.
 *
 * The icon is not decoration. These are six near-identical figures — "how many
 * sales, how many of them cash, how many refunds" — and a column of bare
 * numbers under grey labels has nothing to aim at when somebody is reading one
 * out. A glyph gives each row a shape to find it by.
 *
 * The tile stays NEUTRAL whatever the number: a count is not a judgement, and a
 * refund count in danger red would read as an error rather than a fact. Only
 * the figure itself takes a tone, and only where one was asked for.
 */
function Count({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: number
  tone?: 'warning'
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-muted">
        {icon}
      </span>
      <div className="min-w-0">
        <dt className="truncate text-xs text-muted">{label}</dt>
        <dd
          className={`numeric text-sm font-semibold ${
            tone === 'warning' ? 'text-warning' : value === 0 ? 'text-faint' : 'text-ink'
          }`}
        >
          {value}
        </dd>
      </div>
    </div>
  )
}
