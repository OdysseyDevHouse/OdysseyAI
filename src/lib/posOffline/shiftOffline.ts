'use client'

import { KV } from './db'
import { kvGet, kvPut, posStore } from './store'
import type { OfflineMovement, OfflineShift, OutboxMovement, OutboxShift } from './types'

/**
 * Opening a drawer, and moving money in and out of it, with no network.
 *
 * ── THE HOLE THIS CLOSES ──────────────────────────────────────────────────
 *
 * A till could always SELL offline. It could not START. `openShift` is a server
 * action, so a machine that rebooted during an outage — a power cut, a Windows
 * update, a Sunmi somebody sat on — came back with no shift and no way to make
 * one. `OpenTillGate` said as much and refused the pad.
 *
 * The shop is not going to stop trading because of that, so what actually
 * happened is worse than a refusal: the cashier signed in past the gate and every
 * sale afterwards banked into a null shift. Real invoices, in a real drawer, that
 * no cash-up would ever account for — and the shift that WAS open ran short by
 * exactly the amount nobody could attribute.
 *
 * The outage is the whole reason the offline till exists. Losing the cash-up to
 * it was a strange place to stop.
 *
 * ── WHAT IS DELIBERATELY NOT HERE: CASHING UP ─────────────────────────────
 *
 * There is no `closeShiftOffline`, and there should not be. `closeShift` freezes
 * EXPECTED beside counted, and expected is derived by summing the sales that
 * POSTED — which, on a till that is offline, are sitting in its own outbox and
 * have posted nowhere. A cash-up computed against a local queue and one computed
 * against the books are two different numbers for the same drawer, and the one a
 * manager signed would be the one nothing else agrees with.
 *
 * 233 reached the same conclusion from the other end: "closing a shift already
 * needs the server to derive what was expected, so there was never an offline
 * cash-up to protect." Opening needs nothing but a counted float, which is why
 * one half of this is here and the other is not.
 *
 * ── AND WHY THE QUEUE IS SEPARATE FROM THE OUTBOX ─────────────────────────
 *
 * Same store, same rules, different tables. A sale, a shift and a movement post
 * through different server paths in a fixed order, and one queue holding all
 * three would have to encode that order in a status field. Three tables and a
 * sequenced flush say it once, in the place that flushes.
 */

/**
 * A uid for a shift or a movement.
 *
 * The same function `finaliseOffline` mints a `saleUid` with, and copied rather
 * than shared for the reason its own comment gives: it needs a secure context,
 * and the fallback is what keeps a plain-HTTP LAN till working. Not
 * cryptographically strong and it does not need to be — the uid's job is
 * uniqueness across one till's queue, and the database's UNIQUE key (252) is
 * what actually enforces it.
 */
function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`
}

/* ── The shift this till is banking into ─────────────────────────────────── */

/**
 * The shift a sale should name, however it was opened.
 *
 * ── TWO WAYS TO NAME ONE DRAWER, AND ONLY ONE IS EVER USABLE ─────────────
 *
 * A shift opened while online has a server `id` and no uid. One opened offline
 * has a `uid` and no id — until it syncs, at which point the sync loop fills the
 * id in and both are true. A sale carries whichever is available, and the server
 * prefers the uid: see `postOfflineSale`, where an unresolvable uid falls through
 * to the id and then to null.
 *
 * Read from what the till stored rather than worked out, and passed to the server
 * unchanged. That is the point, and it is the same argument `currentShiftId` has
 * always made: the cash went into a specific drawer at a specific moment, and by
 * sync time — possibly the next morning — that shift may be closed and another
 * open.
 */
export type LocalShift = { id: number | null; uid: string | null }

export async function currentShift(siteId: number): Promise<LocalShift> {
  const held = await kvGet<{ id: number | null; uid?: string | null } | null>(siteId, KV.shift)
  if (!held) return { id: null, uid: null }
  return { id: held.id ?? null, uid: held.uid ?? null }
}

/**
 * Records which shift this till is on.
 *
 * Both fields together, always, because they describe ONE drawer and a till
 * holding an id from one shift beside a uid from another would bank its sales
 * into whichever the server happened to resolve first.
 */
export async function setCurrentShift(siteId: number, shift: LocalShift | null): Promise<void> {
  await kvPut(siteId, KV.shift, shift ? { id: shift.id, uid: shift.uid } : null)
}

/* ── Opening ─────────────────────────────────────────────────────────────── */

export type OpenOfflineResult = { ok: true; shiftUid: string } | { ok: false; error: string }

/**
 * Opens a shift on this till, locally, and queues it for delivery.
 *
 * ── THE FLOAT IS THE ONLY THING THAT CANNOT BE RECONSTRUCTED ─────────────
 *
 * Everything else about a shift — its mode, its cash-up number, the till's code,
 * the unique index that stops two being open on one drawer — resolves on the
 * server at sync. The counted float does not: it is a person looking into a
 * drawer, once, and if this row is lost there is no way to recover what they saw.
 * That is why the local write happens BEFORE anything else and why nothing prunes
 * a pending row.
 *
 * ── IT DOES NOT CHECK WHETHER A SHIFT IS ALREADY OPEN ────────────────────
 *
 * It cannot — that is a fact about the server, and the server is what is missing.
 * `postOfflineShift` resolves it on arrival by ADOPTING the shift that is already
 * there, which is the only answer that keeps the takings reconcilable: the cash is
 * in one physical drawer whoever opened it. The float counted here is then
 * recorded in the activity log rather than added, because a drawer counted twice
 * is not a drawer holding twice as much.
 *
 * So a cashier is never blocked here, and is told afterwards. That is the right
 * way round: the alternative is a till that will not open at the one moment it
 * cannot ask permission.
 */
export async function openShiftOffline(
  siteId: number,
  input: {
    terminalId: number | null
    openingFloat: number
    operatorUserId: number
    operatorName: string
  },
): Promise<OpenOfflineResult> {
  if (!Number.isFinite(input.openingFloat) || input.openingFloat < 0) {
    return { ok: false, error: 'The opening float cannot be negative.' }
  }

  const shift: OfflineShift = {
    shiftUid: uid(),
    terminalId: input.terminalId,
    openedAt: new Date().toISOString(),
    openingFloat: input.openingFloat,
    operatorUserId: input.operatorUserId,
    operatorName: input.operatorName,
  }

  const entry: OutboxShift = {
    ...shift,
    status: 'pending',
    attempts: 0,
    lastError: null,
    syncedAt: null,
    shiftId: null,
  }

  try {
    /* The queue row FIRST, then the pointer. A till that crashed between the two
       comes back with a shift it will deliver and no shift to sell against, which
       is recoverable — the cashier opens another. The opposite order gives a till
       selling against a shift that will never reach the server, which is not. */
    await posStore(siteId).shiftPut(entry)
    await setCurrentShift(siteId, { id: null, uid: shift.shiftUid })
  } catch {
    return {
      ok: false,
      error: 'This machine cannot store a shift, so it cannot open one offline.',
    }
  }

  return { ok: true, shiftUid: shift.shiftUid }
}

/* ── Drawer movements ────────────────────────────────────────────────────── */

export type MovementResult = { ok: true; movementUid: string } | { ok: false; error: string }

/**
 * Queues a payout, pay-in or drop taken with the line down.
 *
 * ── WHY THIS MATTERS AS MUCH AS THE SHIFT ITSELF ─────────────────────────
 *
 * Without it a cash-up is wrong every time somebody takes a note out to pay for
 * milk, and the cashier is blamed for a variance that was an errand — which is
 * the argument `recordDrawerMovement` already makes for the online case. An
 * outage does not make the errand less likely; if anything a shop whose systems
 * are down does more of them.
 *
 * ── THE AMOUNT IS ALWAYS POSITIVE HERE ───────────────────────────────────
 *
 * The SERVER signs it, because a payout and a drop both take money out while a
 * pay-in adds, and that mapping is a policy rather than an arithmetic. Signing it
 * here as well would apply it twice on one path and never on the other.
 */
export async function queueDrawerMovement(
  siteId: number,
  input: {
    type: 'payout' | 'payin' | 'drop'
    amount: number
    reason: string
    terminalId: number | null
    operatorUserId: number
    operatorName: string
  },
): Promise<MovementResult> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, error: 'Enter an amount.' }
  }
  if (!input.reason?.trim()) return { ok: false, error: 'Give a reason.' }

  /*
   * Which shift, resolved AT THE MOMENT the money moves.
   *
   * Not at flush time. A movement belongs to the drawer that was open when the
   * note left it, and a till that cashed up and reopened before its queue drained
   * would otherwise attach yesterday's payout to today's shift.
   */
  const shift = await currentShift(siteId)
  if (!shift.id && !shift.uid) {
    return { ok: false, error: 'Open a shift before moving money in or out of the drawer.' }
  }

  const movement: OfflineMovement = {
    movementUid: uid(),
    shiftId: shift.id,
    shiftUid: shift.uid,
    terminalId: input.terminalId,
    type: input.type,
    amount: input.amount,
    reason: input.reason.trim(),
    takenAt: new Date().toISOString(),
    operatorUserId: input.operatorUserId,
    operatorName: input.operatorName,
  }

  const entry: OutboxMovement = {
    ...movement,
    status: 'pending',
    attempts: 0,
    lastError: null,
    syncedAt: null,
  }

  try {
    await posStore(siteId).movementPut(entry)
  } catch {
    return { ok: false, error: 'This machine cannot store the movement, so it was not recorded.' }
  }

  return { ok: true, movementUid: movement.movementUid }
}

/*
 * ── WHAT THE TILL HAS YET TO DELIVER IS NOT ANSWERED HERE ────────────────
 *
 * There was a `shiftQueueDepth` in this file and it has gone. `syncCounts` in
 * sync.ts already answers "what is still to go" for sales, returns and
 * cancellations, and a second function answering it for two more tables would be
 * a second thing to remember to call — the chip would show one set of numbers and
 * the outbox screen another.
 *
 * The counts live there, beside the ones they have to be read with.
 */

/**
 * The two fields a queued SALE carries to name its drawer.
 *
 * A convenience over `currentShift`, and it earns its place by being spreadable:
 * the call sites are inside object literals building an offline sale, and
 * `...(await bankingShift(siteId))` keeps the two fields adjacent and read in one
 * go. Two separate awaits there could straddle a cash-up and produce a sale
 * naming one shift by id and another by uid.
 */
export async function bankingShift(
  siteId: number,
): Promise<{ shiftId: number | null; shiftUid: string | null }> {
  const shift = await currentShift(siteId)
  return { shiftId: shift.id, shiftUid: shift.uid }
}
