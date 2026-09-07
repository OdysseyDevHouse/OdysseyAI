import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import {
  cashupMode,
  getShift,
  openShift,
  openShiftFor,
  openShiftForUser,
  recordDrawerMovement,
} from './shifts'
import type { OfflineMovement, OfflineShift, SyncMovementResult, SyncShiftResult } from '../posOffline/types'

/**
 * Where an offline till's SHIFT comes home.
 *
 * ── WHAT WAS MISSING, AND WHY IT MATTERED MORE THAN IT SOUNDS ─────────────
 *
 * A till could always SELL offline. It could not START. `openShift` is a server
 * action, so a machine that rebooted during an outage came back with no shift and
 * no way to make one — and `finaliseOffline` duly banked every sale after that
 * into a null shift, which the schema has always allowed.
 *
 * Allowed, and silent. Those takings then belonged to no reconciliation: the
 * drawer holding them could not be cashed up, and whichever shift WAS open ran
 * short by exactly the amount nobody could attribute. The outage is the whole
 * reason the offline till exists; losing the cash-up to it was a strange place to
 * stop.
 *
 * ── THE ORDER IS A CORRECTNESS REQUIREMENT, AND IT IS THE ROUTE'S JOB ─────
 *
 * Shifts post BEFORE sales, and movements AFTER shifts. Not tidiness: a sale
 * carries `shiftUid` and cannot be banked until the shift that uid names exists,
 * and a movement is `ON DELETE CASCADE` from a shift that must therefore be
 * there. The sync route sequences it, exactly as it already sequences sales
 * before cancellations, and for the reason its header gives — the order is the
 * server's to get right, not a client's flush sequence.
 *
 * ── THIS DOES NOT CLOSE A SHIFT, AND THAT IS NOT AN OMISSION ──────────────
 *
 * There is no `postOfflineCashup` here and there should not be. `closeShift`
 * freezes EXPECTED alongside counted, and expected is derived by summing the
 * sales that posted — which, for a till that is offline, are sitting in its own
 * outbox and have posted nowhere. A cash-up computed against a local outbox and
 * one computed against the books are two different numbers for the same drawer,
 * and the one a manager signed would be the one nothing else agrees with.
 *
 * 233 reached the same conclusion from the other end and wrote it down: "closing
 * a shift already needs the server to derive what was expected, so there was
 * never an offline cash-up to protect." Opening is a different question — it
 * needs nothing but a counted float — which is why one is here and the other is
 * not.
 */

type Row = RowDataPacket & Record<string, unknown>

/* ── Validation ──────────────────────────────────────────────────────────── */

/**
 * Whether this is structurally a shift, before anything is written.
 *
 * Runs BEFORE the uid is consumed, matching `validateOfflineSale`: a malformed
 * payload must not burn an idempotency key, or the till's retry would come back
 * as a duplicate of something that never happened.
 */
export function validateOfflineShift(shift: OfflineShift): string | null {
  if (!shift || typeof shift !== 'object') return 'Not a shift.'
  if (!isUid(shift.shiftUid)) return 'Missing or malformed shift uid.'
  if (!Number.isFinite(shift.openingFloat) || shift.openingFloat < 0) {
    return 'The opening float cannot be negative.'
  }
  if (!Number.isFinite(Date.parse(shift.openedAt))) return 'Bad opening time.'
  return null
}

export function validateOfflineMovement(movement: OfflineMovement): string | null {
  if (!movement || typeof movement !== 'object') return 'Not a drawer movement.'
  if (!isUid(movement.movementUid)) return 'Missing or malformed movement uid.'
  if (!['payout', 'payin', 'drop'].includes(movement.type)) return 'Unknown movement type.'
  if (!Number.isFinite(movement.amount) || movement.amount <= 0) return 'Enter an amount.'
  if (!movement.reason?.trim()) return 'Give a reason.'
  /* One of the two, and only one is ever known: a movement recorded before the
     reboot names a numeric shift, one recorded after names the uid of the shift
     this same batch is opening. Neither means it belongs nowhere, which for a
     movement is not a legitimate answer the way it is for a sale — a payout with
     no drawer is money that left no till. */
  if (!movement.shiftId && !movement.shiftUid) return 'The movement names no shift.'
  return null
}

/** The shape a till mints. Bounded so a hostile value cannot reach an index. */
function isUid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
}

/**
 * Who did this, resolved SERVER-SIDE.
 *
 * Lifted verbatim from `postOfflineSale` step 3, and it must stay that way: the
 * payload's name is attribution only, and a till's claim about who is standing
 * there is never trusted for anything but the label. A cashier who has since been
 * deleted or deactivated still opened a real drawer, so the event is recorded
 * against the name the till gave with "(offline)" on it — losing that would make
 * the shift unattributable entirely, which is worse than attributing it to
 * somebody the user list no longer has.
 *
 * userId 0 for an operator who no longer exists, matching what `postOfflineSale`,
 * `paidOrders` and the contract biller already do for an actor who is not a row
 * in `users`: a foreign key to a deleted row is not available.
 */
async function resolveActor(
  siteId: number,
  operatorUserId: number,
  operatorName: string,
): Promise<Actor> {
  const operator = await siteQueryOne<
    RowDataPacket & { id: number; name: string; is_active: number }
  >(siteId, 'SELECT id, name, is_active FROM users WHERE id = ?', [operatorUserId])

  const name = operator?.is_active ? operator.name : `${operatorName || 'Unknown'} (offline)`
  return { userId: operator?.id ?? 0, userName: name.slice(0, 120) }
}

/* ── Opening ─────────────────────────────────────────────────────────────── */

/**
 * Opens the shift a till started with no network, or finds the one it means.
 *
 * ── THREE OUTCOMES, AND THE THIRD IS THE INTERESTING ONE ─────────────────
 *
 *   1. This uid has been delivered before → the same shift id, `duplicate`.
 *   2. Nothing is open on that drawer → it opens, dated by the till's clock.
 *   3. SOMETHING ELSE IS ALREADY OPEN on that drawer → that shift is ADOPTED.
 *
 * ── WHY ADOPT RATHER THAN REFUSE ─────────────────────────────────────────
 *
 * Refusing looks safer and is not. The cash is real: it went into a physical
 * drawer, and a rejected shift leaves every sale carrying its uid with nowhere to
 * bank — the exact null-shift hole this module exists to close, reintroduced at
 * the last step. The takings would land on the books and belong to no
 * reconciliation, and the cash-up for the drawer they are sitting in would come
 * up short by their total.
 *
 * There is only ever one drawer. `uq_shift_open_terminal` guarantees it, so the
 * shift already open on that till IS the reconciliation for the money the
 * offline till took, whoever opened it. Adopting says that out loud.
 *
 * ── WHAT ADOPTING DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * It does not add the offline float. The drawer was counted once, by whoever
 * opened the shift that is already there, and a second float would report the
 * drawer over by its value — turning a clean cash-up into a surplus nobody can
 * account for. The counted figure is recorded in the activity log instead, where
 * a manager reconciling a difference can find it, because two people counting one
 * drawer differently is worth knowing about and is not something to write into
 * `opening_float` on either of their behalves.
 */
export async function postOfflineShift(
  siteId: number,
  shift: OfflineShift,
): Promise<SyncShiftResult> {
  const invalid = validateOfflineShift(shift)
  if (invalid) return { shiftUid: shift?.shiftUid ?? '', ok: false, error: invalid, retryable: false }

  /* 1. Already delivered. The unique index is the real guard; this is the read
        that turns a redelivery into an answer rather than an error. */
  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM shifts WHERE shift_uid = ? LIMIT 1',
    [shift.shiftUid],
  )
  if (existing) {
    return { shiftUid: shift.shiftUid, ok: true, shiftId: Number(existing.id), duplicate: true }
  }

  const actor = await resolveActor(siteId, shift.operatorUserId, shift.operatorName ?? '')
  const mode = await cashupMode(siteId)

  /* 2. Is a drawer already open? Asked before attempting the insert so the
        ordinary adoption is an answer rather than a caught unique violation. */
  const open = await openDrawerFor(siteId, mode, shift.terminalId, actor.userId)

  if (open) return adopt(siteId, shift, actor, open)

  const result = await openShift(siteId, actor, shift.terminalId, shift.openingFloat, {
    shiftUid: shift.shiftUid,
    openedAt: new Date(shift.openedAt),
  })

  if (result.ok) return { shiftUid: shift.shiftUid, ok: true, shiftId: result.shiftId }

  /*
   * 3. It failed. Two of these are races worth resolving rather than reporting,
   *    because both mean the answer the till needs now exists:
   *
   *      · another request delivered this same uid between the read above and
   *        the insert — a till whose flush overlapped its own retry;
   *      · somebody opened a shift on that drawer in the same moment.
   *
   *    Anything else is a real refusal (a deactivated till, no till chosen in
   *    terminal mode) and is NOT retryable: the payload will not become valid by
   *    being sent again, and a queue that retries it forever is a queue that
   *    never drains.
   */
  const raced = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM shifts WHERE shift_uid = ? LIMIT 1',
    [shift.shiftUid],
  )
  if (raced) {
    return { shiftUid: shift.shiftUid, ok: true, shiftId: Number(raced.id), duplicate: true }
  }

  const late = await openDrawerFor(siteId, mode, shift.terminalId, actor.userId)
  if (late) return adopt(siteId, shift, actor, late)

  return { shiftUid: shift.shiftUid, ok: false, error: result.error, retryable: false }
}

/**
 * The shift already open on this drawer, in whichever mode the site runs.
 *
 * Asked twice — once before attempting the insert, once after it fails — so it is
 * one function rather than two copies of a ternary. The second call is the race
 * resolution and must ask exactly the same question as the first, or the two
 * paths could disagree about which drawer "this" is.
 *
 * `userId` 0 answers null in user mode: it is the sentinel for an operator who is
 * not a row in `users`, and such a person cannot own a shift.
 */
async function openDrawerFor(
  siteId: number,
  mode: 'terminal' | 'user',
  terminalId: number | null,
  userId: number,
): Promise<number | null> {
  if (mode === 'terminal') {
    return terminalId ? ((await openShiftFor(siteId, terminalId))?.id ?? null) : null
  }
  return userId ? ((await openShiftForUser(siteId, userId))?.id ?? null) : null
}

/**
 * Hands back the shift that is already open on this drawer, and says so.
 *
 * The activity-log entry is not decoration. A shift a till believes it opened,
 * that turned out to be somebody else's, is precisely the thing a manager
 * investigating a variance needs to be able to find — including the float this
 * till counted, which is a second independent count of the same drawer and is
 * evidence rather than noise.
 */
async function adopt(
  siteId: number,
  shift: OfflineShift,
  actor: Actor,
  shiftId: number,
): Promise<SyncShiftResult> {
  await logActivity(siteId, actor, {
    entity: 'shift',
    entityId: shiftId,
    action: 'offline_shift_adopted',
    /* Everything in `detail`, nothing in `changes`: this is not a field moving
       from one value to another, which is the only shape `changes` records. It is
       a second, independent count of one drawer, and the sentence is the record. */
    detail:
      `A till opened a shift offline at ${shift.openedAt} and counted a float of ` +
      `${shift.openingFloat.toFixed(2)}, but this drawer already had a shift open. ` +
      `Its takings were banked into the open shift. The float it counted was NOT ` +
      `added — the drawer was counted once already — and stands here as a second ` +
      `count of the same money. Offline shift ${shift.shiftUid}.`,
  })
  return { shiftUid: shift.shiftUid, ok: true, shiftId, adopted: true }
}

/* ── Drawer movements ────────────────────────────────────────────────────── */

/**
 * Records a payout, pay-in or drop that happened with the line down.
 *
 * ── THE UID RESOLVER IS PASSED IN ────────────────────────────────────────
 *
 * A movement may name its shift by NUMBER — the shift was open before the outage,
 * so the till knew its id — or by UID, where the shift was itself opened offline
 * and is being created by the very batch carrying this movement. The route holds
 * the map from one to the other because the route is what posted the shifts, and
 * passing it in keeps that knowledge in the one place that has it rather than
 * making this module re-read what was just written.
 *
 * ── A CLOSED SHIFT IS A REFUSAL, NOT A RETRY ─────────────────────────────
 *
 * `recordDrawerMovement` refuses a shift that is already cashed up, and that
 * refusal stands here. The alternative would be to reopen or to reassign, and both
 * rewrite a figure somebody has signed off. The movement is reported as
 * non-retryable so the till stops asking and the outbox screen shows it to a
 * human — which is the correct end for money that left a drawer nobody can now
 * reconcile it against.
 */
export async function postOfflineMovement(
  siteId: number,
  movement: OfflineMovement,
  resolveShiftUid: (uid: string) => number | undefined,
): Promise<SyncMovementResult> {
  const invalid = validateOfflineMovement(movement)
  if (invalid) {
    return { movementUid: movement?.movementUid ?? '', ok: false, error: invalid, retryable: false }
  }

  /* Already delivered. Same read as the shift above, and it is what makes a
     retried flush safe for a row with no natural key. */
  const existing = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM shift_movements WHERE movement_uid = ? LIMIT 1',
    [movement.movementUid],
  )
  if (existing) {
    return {
      movementUid: movement.movementUid,
      ok: true,
      id: Number(existing.id),
      duplicate: true,
    }
  }

  const shiftId = movement.shiftUid
    ? resolveShiftUid(movement.shiftUid)
    : (movement.shiftId ?? undefined)

  if (!shiftId) {
    /*
     * RETRYABLE, unlike everything else that fails here.
     *
     * The shift this names was in the same batch and did not post — most often
     * because the batch was cut short by a transport failure partway through. The
     * money genuinely left the drawer, and the shift will exist on the next
     * attempt, so discarding the record now would lose a real payout to a
     * temporary ordering problem.
     */
    return {
      movementUid: movement.movementUid,
      ok: false,
      error: 'The shift this movement belongs to has not arrived yet.',
      retryable: true,
    }
  }

  const shift = await getShift(siteId, shiftId)
  if (!shift) {
    return {
      movementUid: movement.movementUid,
      ok: false,
      error: 'That shift no longer exists.',
      retryable: false,
    }
  }

  const result = await recordDrawerMovement(
    siteId,
    await resolveActor(siteId, movement.operatorUserId, movement.operatorName ?? ''),
    shiftId,
    {
      type: movement.type,
      amount: movement.amount,
      reason: movement.reason,
      terminalId: movement.terminalId ?? null,
      movementUid: movement.movementUid,
    },
  )

  if (result.ok) return { movementUid: movement.movementUid, ok: true, id: result.id }

  /* The unique index is the real guard, and a race lands here — re-read rather
     than report, exactly as the shift path does. */
  const raced = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM shift_movements WHERE movement_uid = ? LIMIT 1',
    [movement.movementUid],
  )
  if (raced) {
    return { movementUid: movement.movementUid, ok: true, id: Number(raced.id), duplicate: true }
  }

  return { movementUid: movement.movementUid, ok: false, error: result.error, retryable: false }
}
