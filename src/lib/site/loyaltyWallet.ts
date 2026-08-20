import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { branchDbPrefix, customerQuery, customerQueryOne, customerTransaction } from './customerDb'
import { round, toNum } from '../decimals'
import { logActivity, type Actor } from './activityLog'
import { getTenderType } from './tenderTypes'
import { shiftToBankInto } from './shifts'

/**
 * The loyalty wallet — rand a customer has pre-loaded onto their card.
 *
 * ── WHY THIS IS NOT POINTS ───────────────────────────────────────────────
 *
 * Points are earned, priced through a redemption rate, and carry tier
 * consequences. Wallet rand is MONEY the customer already handed over, and it
 * spends 1:1. Running the two through one balance would mean either pricing
 * real cash through the points rate — so changing that rate silently revalues
 * money people have already paid in — or losing the audit line between money
 * taken and points granted. They stay apart.
 *
 * ── A TOP-UP IS A CASH EVENT, NOT A LOYALTY ONE ──────────────────────────
 *
 * Real money crosses the counter, so the row records the tender it arrived on,
 * the terminal, and the shift that banked it. Without that the drawer is over
 * at every cash-up by exactly the day's top-ups and nobody can say why.
 *
 * A top-up deliberately earns NO POINTS. Loading R500 is not a purchase — it is
 * the customer moving their own money — and granting points on the load and
 * again on the spend pays twice for one sale.
 *
 * ── THE FLOAT IS A LIABILITY ─────────────────────────────────────────────
 *
 * Every unspent rand is money owed in goods. `SUM(amount)` across the table is
 * that liability, and it belongs on the balance sheet rather than in income —
 * which is why the wallet is append-only like the points ledger, and why
 * `loyalty_members.wallet_balance` is a display cache no decision reads.
 */

type Row = RowDataPacket & Record<string, unknown>

export type WalletEntryType = 'topup' | 'spend' | 'refund' | 'adjust'

export type WalletEntry = {
  id: number
  customerId: number
  entryType: WalletEntryType
  amount: number
  tenderName: string
  documentId: number | null
  documentNumber: string
  note: string
  userName: string
  createdAt: Date
}

function mapEntry(r: Row): WalletEntry {
  return {
    id: Number(r.id),
    customerId: Number(r.customer_id),
    entryType: String(r.entry_type) as WalletEntryType,
    amount: toNum(r.amount),
    tenderName: String(r.tender_name ?? ''),
    documentId: r.document_id === null ? null : Number(r.document_id),
    documentNumber: String(r.document_number ?? ''),
    note: String(r.note ?? ''),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

/** The authoritative balance: summed from the rows, never read off the cache. */
export async function getWalletBalance(siteId: number, customerId: number): Promise<number> {
  const row = await customerQueryOne<Row>(
    siteId,
    'SELECT COALESCE(SUM(amount),0) AS amount FROM loyalty_wallet WHERE customer_id = ?',
    [customerId],
  )
  return round(toNum(row?.amount), 2)
}

/** Same, under a lock, for a caller about to spend it. */
async function lockedWalletBalance(tx: PoolConnection, customerId: number): Promise<number> {
  await tx.query('SELECT customer_id FROM loyalty_members WHERE customer_id = ? FOR UPDATE', [
    customerId,
  ] as never)

  const [[row]] = await tx.query<Row[]>(
    'SELECT COALESCE(SUM(amount),0) AS amount FROM loyalty_wallet WHERE customer_id = ?',
    [customerId] as never,
  )
  return round(toNum(row?.amount), 2)
}

export async function listWallet(
  siteId: number,
  customerId: number,
  limit = 100,
): Promise<WalletEntry[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 1000)

  // The wallet moves WITH the customer, but tender_types stays in each branch —
  // it is the shop's own list of ways to take money. So this runs against the
  // owner and reaches BACK to name the caller's tender table. Unqualified, a
  // top-up taken at branch 7 would be labelled with whatever tender happens to
  // share that id at the primary: a wrong label on a money record.
  const bdb = await branchDbPrefix(siteId)
  const rows = await customerQuery<Row>(
    siteId,
    `SELECT w.id, w.customer_id, w.entry_type, w.amount, w.document_id, w.document_number,
            w.note, w.user_name, w.created_at, t.name AS tender_name
       FROM loyalty_wallet w
       LEFT JOIN ${bdb}tender_types t ON t.id = w.tender_type_id
      WHERE w.customer_id = ?
      ORDER BY w.id DESC
      LIMIT ${capped}`,
    [customerId],
  )
  return rows.map(mapEntry)
}

/** Rewrites the display cache. Called on the caller's transaction. */
async function refreshWalletCache(tx: PoolConnection, customerId: number): Promise<void> {
  const [[row]] = await tx.query<Row[]>(
    'SELECT COALESCE(SUM(amount),0) AS amount FROM loyalty_wallet WHERE customer_id = ?',
    [customerId] as never,
  )
  await tx.execute(
    `INSERT INTO loyalty_members (customer_id, wallet_balance, last_activity_at)
     VALUES (?,?,NOW())
     ON DUPLICATE KEY UPDATE wallet_balance = VALUES(wallet_balance),
                             last_activity_at = VALUES(last_activity_at)`,
    [customerId, round(toNum(row?.amount), 4).toFixed(4)] as never,
  )
}

/* ── Topping up ──────────────────────────────────────────────────────────── */

export type TopUpInput = {
  customerId: number
  amount: number
  tenderTypeId: number
  terminalId?: number | null
  note?: string
}

export type TopUpResult = { ok: true; balance: number } | { ok: false; error: string }

/** A sanity ceiling. Anything above this is a mis-keyed amount, not a top-up. */
const MAX_TOPUP = 100_000

/**
 * Takes money onto a customer's card.
 *
 * Refuses a tender that cannot represent money arriving:
 *
 *   ACCOUNT would mean loading the card on credit — borrowing money to store as
 *   money, which is a debtor entry pretending to be a payment.
 *
 *   ANOTHER LOYALTY TENDER would mean funding the wallet from the wallet, or
 *   from points, laundering an earned reward into spendable cash.
 */
export async function topUpWallet(
  siteId: number,
  actor: Actor,
  input: TopUpInput,
): Promise<TopUpResult> {
  const amount = round(input.amount, 2)
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Enter an amount.' }
  if (amount > MAX_TOPUP) {
    return { ok: false, error: `A top-up above R${MAX_TOPUP.toLocaleString()} has to be split.` }
  }

  const customer = await customerQueryOne<Row>(
    siteId,
    'SELECT id, name FROM customers WHERE id = ? LIMIT 1',
    [input.customerId],
  )
  if (!customer) return { ok: false, error: 'That customer no longer exists.' }

  const tender = await getTenderType(siteId, input.tenderTypeId)
  if (!tender) return { ok: false, error: 'Choose how the money was paid.' }
  if (!tender.isActive) return { ok: false, error: `${tender.name} is not available.` }
  if (tender.postsToDebtor) {
    return { ok: false, error: 'A card cannot be loaded on account — that is borrowing, not paying.' }
  }
  if (tender.integrationKey === 'loyalty') {
    return { ok: false, error: 'A loyalty card cannot be loaded with loyalty money.' }
  }

  // Which shift banks it, so the cash-up sees the money on the right day.
  //
  // Routed through shiftToBankInto rather than the terminal's shift directly:
  // a site cashing up BY USER banks this into the operator's own shift, and
  // taking the till's would put a waiter's top-up in someone else's drawer.
  const shiftId = await shiftToBankInto(siteId, input.terminalId ?? null, actor.userId)

  const balance = await customerTransaction(siteId, async (tx) => {
    await tx.execute(
      // origin_site_id is not optional here: tender_type_id, shift_id and
      // terminal_id are ALL branch ids, and without the origin none of them
      // means anything once ten stores share one wallet. walletTopUpsForShift
      // filters on it, so a missing stamp shows up as a drawer that is over.
      `INSERT INTO loyalty_wallet
         (customer_id, entry_type, amount, tender_type_id, shift_id, terminal_id,
          origin_site_id, note, user_id, user_name)
       VALUES (?, 'topup', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.customerId,
        amount.toFixed(4),
        tender.id,
        shiftId,
        input.terminalId ?? null,
        siteId,
        (input.note ?? '').slice(0, 255),
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    await refreshWalletCache(tx, input.customerId)
    return lockedWalletBalance(tx, input.customerId)
  })

  await logActivity(siteId, actor, {
    entity: 'loyalty',
    entityId: input.customerId,
    action: 'wallet_topped_up',
    detail: `R${amount.toFixed(2)} by ${tender.name}`,
  })

  return { ok: true, balance }
}

/* ── Spending ────────────────────────────────────────────────────────────── */

export type WalletSpendInput = {
  customerId: number
  documentId: number
  documentNumber: string
  amount: number
}

/**
 * Settles part of a sale from the wallet. JOINS THE SALE'S TRANSACTION.
 *
 * THROWS on any problem so an unaffordable spend rolls the sale back. The
 * balance is read under a lock and re-checked here rather than trusted from the
 * till, because the basket may have sat on screen while the same card was spent
 * at another till.
 */
export async function spendWalletForSale(
  tx: PoolConnection,
  actor: Actor,
  /** The store making the sale — see insertLedger in loyalty.ts. */
  originSiteId: number,
  input: WalletSpendInput,
): Promise<{ amount: number }> {
  const amount = round(input.amount, 2)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Enter an amount to settle from the wallet.')
  }

  const balance = await lockedWalletBalance(tx, input.customerId)
  if (amount > balance) {
    throw new Error(
      `Not enough on the card: R${balance.toFixed(2)} available, R${amount.toFixed(2)} asked for.`,
    )
  }

  await tx.execute(
    `INSERT INTO loyalty_wallet
       (customer_id, entry_type, amount, document_id, document_number,
        origin_site_id, user_id, user_name)
     VALUES (?, 'spend', ?, ?, ?, ?, ?, ?)`,
    [
      input.customerId,
      (-amount).toFixed(4),
      input.documentId,
      input.documentNumber,
      originSiteId,
      actor.userId,
      actor.userName.slice(0, 120),
    ] as never,
  )
  await refreshWalletCache(tx, input.customerId)

  return { amount }
}

/**
 * Puts wallet money back when a sale is refunded or voided.
 *
 * Idempotent: the unique key on (document_id, entry_type) means a second
 * attempt for the same sale is refused by the database rather than crediting
 * the customer twice.
 */
export async function refundWalletForSale(
  siteId: number,
  actor: Actor,
  documentId: number,
  reason: string,
): Promise<{ amount: number }> {
  return customerTransaction(siteId, async (tx) => {
    const [[spent]] = await tx.query<Row[]>(
      `SELECT customer_id, amount, document_number
         FROM loyalty_wallet
        WHERE document_id = ? AND entry_type = 'spend'
          -- Document ids are per-database, so in a shared wallet the id alone
          -- would match another branch's spend and refund the wrong sale.
          AND (origin_site_id IS NULL OR origin_site_id = ?)
          FOR UPDATE`,
      [documentId, siteId] as never,
    )
    if (!spent) return { amount: 0 }

    const [[already]] = await tx.query<Row[]>(
      `SELECT id FROM loyalty_wallet WHERE document_id = ? AND entry_type = 'refund'`,
      [documentId] as never,
    )
    if (already) return { amount: 0 }

    const customerId = Number(spent.customer_id)
    const amount = round(Math.abs(toNum(spent.amount)), 2)

    await tx.execute(
      `INSERT INTO loyalty_wallet
         (customer_id, entry_type, amount, document_id, document_number,
          origin_site_id, note, user_id, user_name)
       VALUES (?, 'refund', ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId,
        amount.toFixed(4),
        documentId,
        String(spent.document_number ?? ''),
        siteId,
        reason.slice(0, 255),
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    await refreshWalletCache(tx, customerId)

    return { amount }
  })
}

/** A manual correction to a wallet — a goodwill credit, or fixing a mis-key. */
export async function adjustWallet(
  siteId: number,
  actor: Actor,
  customerId: number,
  amount: number,
  reason: string,
): Promise<TopUpResult> {
  const value = round(amount, 2)
  if (!Number.isFinite(value) || value === 0) return { ok: false, error: 'Enter an amount.' }
  if (!reason.trim()) return { ok: false, error: 'Give a reason for the adjustment.' }

  try {
    const balance = await customerTransaction(siteId, async (tx) => {
      const current = await lockedWalletBalance(tx, customerId)
      if (value < 0 && current + value < 0) {
        throw new Error(`That would overdraw the card — R${current.toFixed(2)} is available.`)
      }

      await tx.execute(
        `INSERT INTO loyalty_wallet
           (customer_id, entry_type, amount, note, user_id, user_name)
         VALUES (?, 'adjust', ?, ?, ?, ?)`,
        [
          customerId,
          value.toFixed(4),
          reason.trim().slice(0, 255),
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      await refreshWalletCache(tx, customerId)
      return round(current + value, 2)
    })

    await logActivity(siteId, actor, {
      entity: 'loyalty',
      entityId: customerId,
      action: value > 0 ? 'wallet_credited' : 'wallet_debited',
      detail: `R${Math.abs(value).toFixed(2)} · ${reason.trim()}`,
    })

    return { ok: true, balance }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not adjust the wallet.',
    }
  }
}

/* ── Cash-up ─────────────────────────────────────────────────────────────── */

export type WalletTopUpTotal = { tenderTypeId: number; tenderName: string; amount: number }

/**
 * Top-ups banked by a shift, split by how the money arrived.
 *
 * The cash-up needs this or every drawer that took a top-up reads as over by
 * exactly that amount. SPEND rows are excluded deliberately: spending the card
 * moves no money at the counter, so counting it would double the sale.
 */
export async function walletTopUpsForShift(
  siteId: number,
  shiftId: number,
): Promise<WalletTopUpTotal[]> {
  // Two boundary problems in one query, and the second is the dangerous one.
  //
  //   · tender_types stays in the branch, so it is named explicitly.
  //   · shift_id is ALSO a branch id. In a shared wallet, filtering on it alone
  //     would pull in another store's shift that happens to share the number —
  //     and this figure is what a drawer is counted against. origin_site_id is
  //     what makes the shift unambiguous.
  const bdb = await branchDbPrefix(siteId)
  const rows = await customerQuery<Row>(
    siteId,
    `SELECT w.tender_type_id, COALESCE(t.name,'Unknown') AS tender_name,
            COALESCE(SUM(w.amount),0) AS amount
       FROM loyalty_wallet w
       LEFT JOIN ${bdb}tender_types t ON t.id = w.tender_type_id
      WHERE w.shift_id = ? AND w.entry_type = 'topup'
        AND (w.origin_site_id IS NULL OR w.origin_site_id = ?)
      GROUP BY w.tender_type_id, t.name
      ORDER BY t.name`,
    [shiftId, siteId],
  )
  return rows.map((r) => ({
    tenderTypeId: Number(r.tender_type_id ?? 0),
    tenderName: String(r.tender_name),
    amount: round(toNum(r.amount), 2),
  }))
}
