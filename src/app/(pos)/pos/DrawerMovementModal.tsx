'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Button,
  Callout,
  Field,
  Input,
  Modal,
  NumPad,
  NumPadDisplay,
  numPadValue,
  useToast,
} from '@/components/ui'
import {
  tillShiftStatusAction,
  tillDrawerMovementAction,
} from './shiftActions'

/**
 * Money in or out of the drawer that is not a sale — as its own key.
 *
 * ── WHY IT LEFT THE SHIFT DIALOG ────────────────────────────────────────────
 *
 * These three were buried two taps inside the shift dialog: press the shift
 * button in the status bar, then press Payout, then count. That is the wrong
 * depth for what they are. Opening a shift happens once a day; a payout happens
 * whenever the milk arrives, and it happens WHILE somebody is standing at the
 * counter waiting. A key that is two taps and a dialog away is a key a cashier
 * postpones — and a postponed payout is a drawer that reads short at close with
 * nobody able to say why.
 *
 * So each is a quick key now, arranged wherever the shop wants it, and the
 * shift dialog is left doing the one thing it is for: starting and ending a
 * shift. See QUICK_KEY_ACTIONS for the three slugs and quickKeyRunner for what
 * pressing one does.
 *
 * ── ONE DIALOG, THREE FACES ─────────────────────────────────────────────────
 *
 * A payout, a pay-in and a drop differ only in a direction and the words around
 * them: same amount, same required reason, same server action, same shift. Three
 * dialogs would be three copies of one form, and the copy that gets an
 * improvement is never all three. `type` picks the words; everything else is
 * shared, exactly as it was inside the shift dialog.
 *
 * ── IT RESOLVES ITS OWN SHIFT ───────────────────────────────────────────────
 *
 * Deliberately not handed a shift id by the shell. A movement must land on the
 * shift that is OPEN AT THE MOMENT IT IS RECORDED, and the shell's copy is a
 * cached value that a cash-up in another tab may already have closed. Asking the
 * server on open costs one round trip and removes a whole class of movement
 * banked into a shift somebody has signed off.
 *
 * It is also what lets this refuse honestly: no shift open, no drawer to move
 * money in or out of, said in a sentence rather than by a dead button.
 */
export default function DrawerMovementModal({
  open,
  type,
  online,
  terminalId,
  onClose,
  /** Fires after a movement lands, so the shell can refresh what it shows. */
  onRecorded,
}: {
  open: boolean
  /** Which of the three this dialog is being. Null while none is asked for. */
  type: MovementType | null
  online: boolean
  terminalId: number | null
  onClose: () => void
  onRecorded?: () => void
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [loading, setLoading] = useState(false)
  const [shiftId, setShiftId] = useState<number | null>(null)
  const [canCashup, setCanCashup] = useState(true)
  const [amountEntry, setAmountEntry] = useState('')
  const [reason, setReason] = useState('')

  /* Read on every open, never cached between them: see the note above about
     which shift a movement must land on. */
  useEffect(() => {
    if (!open || !online || type === null) return
    setAmountEntry('')
    setReason('')
    setShiftId(null)
    setLoading(true)
    void tillShiftStatusAction(terminalId)
      .then((result) => {
        if ('ok' in result) {
          toast.error(result.error)
          return
        }
        setShiftId(result.shift?.id ?? null)
        setCanCashup(result.canCashup)
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, online, type, terminalId])

  function record() {
    if (shiftId === null || type === null) return
    startTransition(async () => {
      const result = await tillDrawerMovementAction(shiftId, {
        type,
        amount: numPadValue(amountEntry),
        reason,
        terminalId,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(MOVEMENT_DONE[type])
      setAmountEntry('')
      setReason('')
      onRecorded?.()
      /* Closes on success. This is a single-purpose key pressed mid-sale with a
         customer waiting — leaving the dialog up so it can be pressed again is
         a dialog somebody has to dismiss before they can get back to serving. */
      onClose()
    })
  }

  return (
    <Modal
      open={open && type !== null}
      onClose={onClose}
      title={type ? MOVEMENT_TITLES[type] : ''}
      /* The hint belongs in the header, not floating above the pad. It is a
         one-line gloss on the title — "money out that is not a sale" — and the
         header is where every other dialog in the app puts exactly that. Under
         the pad's own plaque it read as an instruction the cashier had to get
         past to reach the keys. */
      description={type ? MOVEMENT_HINTS[type] : undefined}
      /* MEASURED, not assumed: plaque + full-width pad + Reason is 514px of
         body, and the default 60vh cap on a 1366×768 till is 461. Without this
         the dialog scrolls, and the row that goes below the fold first is the
         Reason field — on the one dialog that REFUSES a movement without one.
         The cashier would meet a dead "Record it" with the cause out of sight.
         `bodyGrows` lifts the cap to 560 and leaves 46px of headroom. */
      bodyGrows
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Close
          </Button>
          {online && shiftId !== null && canCashup && (
            <Button
              variant="primary"
              /* Refused here for the same reasons the server refuses it, so the
                 cashier learns it from the button rather than from an error: a
                 movement with no reason is a variance nobody can explain at
                 close, and a zero movement is not an event. */
              disabled={pending || !reason.trim() || numPadValue(amountEntry) <= 0}
              onClick={record}
            >
              {pending ? 'Recording…' : 'Record it'}
            </Button>
          )}
        </>
      }
    >
      {!online ? (
        <Callout tone="brand" title="Moving money needs the connection">
          A payout has to land on the shift it belongs to, and the shift lives on the server.
          Sales keep working offline and queue safely on this till.
        </Callout>
      ) : loading ? (
        <p className="py-8 text-center text-sm text-muted">Reading the shift…</p>
      ) : !canCashup ? (
        <Callout tone="warning" title="This needs the cash-up right">
          Ask a manager — they can move money under their own PIN.
        </Callout>
      ) : shiftId === null ? (
        <Callout tone="warning" title="No shift is open on this till">
          There is no drawer to move money in or out of yet. Open a shift first, and the
          movement will land on it.
        </Callout>
      ) : (
        /* FULL WIDTH, and the pad at `wide`. This dialog asks for one number
           and one sentence, and it is worked mid-sale by a thumb on a touch
           screen — so the keys take the room the dialog has rather than sitting
           as a 256px block with a margin either side of it. That block was the
           default size's own doing: `touch` keys are 56px tall whatever width
           they are given, so a wider container only stretched them.

           `wide` rather than `lg`: measured, `lg` here came to 556px of body
           against a 560px cap on a 1366×768 till. See the size's own note. */
        <div className="flex flex-col gap-4">
          <NumPadDisplay label="Amount" value={amountEntry} layout="plaque" />
          <NumPad size="wide" value={amountEntry} onChange={setAmountEntry} disabled={pending} />
          <Field label="Reason">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={type ? MOVEMENT_PLACEHOLDERS[type] : ''}
            />
          </Field>
        </div>
      )}
    </Modal>
  )
}

export type MovementType = 'payout' | 'payin' | 'drop'

/* The words, kept beside the dialog that says them. They moved here wholesale
   from ShiftModal rather than being rewritten — a cashier who knew the old
   screen should read the same sentences on the new key. */
const MOVEMENT_TITLES: Record<MovementType, string> = {
  payout: 'Payout — money out of the drawer',
  payin: 'Pay in — money into the drawer',
  drop: 'Drop — cash to the safe',
}

const MOVEMENT_HINTS: Record<MovementType, string> = {
  payout: 'Milk, the window cleaner, a COD delivery — money out that is not a sale.',
  payin: 'Extra change from the safe, or money returned to the drawer.',
  drop: 'Skimming excess cash to the safe mid-shift. It still counts toward the shift.',
}

const MOVEMENT_PLACEHOLDERS: Record<MovementType, string> = {
  payout: 'e.g. milk for the kitchen',
  payin: 'e.g. change from the safe',
  drop: 'e.g. lunchtime skim',
}

const MOVEMENT_DONE: Record<MovementType, string> = {
  payout: 'Payout recorded.',
  payin: 'Pay-in recorded.',
  drop: 'Drop recorded.',
}
