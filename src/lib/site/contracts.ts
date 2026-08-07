import 'server-only'
import type { RowDataPacket, PoolConnection } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { saveDraft, getDocument } from './salesDocuments'
import { finaliseDocument } from './salesPosting'
import { getTenderByCode } from './tenderTypes'
import { getCustomer } from './customers'
import { nextDocumentNumber } from './sequences'
import { today } from './ledger'
import {
  CONTRACT_FREQUENCIES,
  CONTRACT_FREQUENCY_LABELS,
  contractState,
  contractTotal,
  annualValue,
  duePeriods,
  nextBillingDate,
  isBillingDue,
  escalationsDue,
  escalationsAppliedBy,
  escalatedPrice,
  nextEscalation,
  refuseContract,
  type ContractFrequency,
  type ContractInput,
  type ContractState,
} from '../contractModel'

/**
 * Contracts — billing a customer the same thing every month, unattended.
 *
 * The debtors-side mirror of recurringExpenses.ts, and it follows that file's
 * design wherever it can: a schedule, an idempotence key, and a catch-up loop
 * that bills three missed months as three invoices rather than one.
 *
 * ── WHERE IT DEPARTS: THIS ONE CAN POST BY ITSELF ────────────────────────
 *
 * A recurring expense ALWAYS produces a draft, because an amount that changed
 * or a bill that never arrived is something a person must see before money
 * moves. A contract is different in kind: the amount is not a guess about what
 * a supplier will charge, it is a price the customer signed. There is nothing
 * for a person to check that the contract does not already state.
 *
 * So `auto_send` exists — and defaults to OFF. A contract earns its automation
 * after somebody has watched it produce one correct invoice. See the schema
 * note in 061_contracts.sql; the default is the whole safety argument.
 *
 * ── THE TWO-KEY IDEMPOTENCE ──────────────────────────────────────────────
 *
 * `contracts.last_generated_for` is the fast path — it makes the common case a
 * single indexed read. `contract_invoices.uq_contract_period` is the GUARANTEE:
 * two ticks running concurrently both read the same stamp, both decide March is
 * due, and the second one's INSERT fails on the unique key. Billing a customer
 * twice for one month is the failure this feature must not have, so it is
 * defended twice.
 *
 * ── BACK-DATED INVOICES CARRY THE PRICE OF THEIR PERIOD ──────────────────
 *
 * A March invoice generated in June must show March's price, not June's. The
 * escalation count is therefore computed per PERIOD (escalationsAppliedBy),
 * never from the contract's current state. Getting this wrong overcharges every
 * caught-up invoice, and it is the customer who finds it.
 */

export type ContractLine = {
  id: number
  lineNumber: number
  productId: number | null
  productCode: string | null
  description: string
  qty: number
  unitPriceIncl: number
  basePriceIncl: number
  vatRatePct: number
  departmentId: number | null
  lineTotalIncl: number
}

export type Contract = {
  id: number
  contractNumber: string | null
  name: string
  customerId: number
  customerCode: string | null
  customerName: string | null
  customerEmail: string | null
  frequency: ContractFrequency
  frequencyLabel: string
  billingDay: number
  startsOn: string
  endsOn: string | null
  lastGeneratedFor: string | null
  escalationPct: number
  escalationMonth: number | null
  lastEscalatedFor: string | null
  autoSend: boolean
  offerPaymentLink: boolean
  paymentTermsDays: number
  isActive: boolean
  reference: string | null
  notes: string | null
  internalNote: string | null
  userName: string
  createdAt: Date
  /** Derived, never stored — see contractState in contractModel.ts. */
  state: ContractState
  /** Computed: when this next produces an invoice. Null once ended. */
  nextDue: string | null
  /** Computed: whether a period is waiting to be billed now. */
  due: boolean
  /** Per-period value at today's price. */
  totalIncl: number
  annualValue: number
  /** When the price next moves, and to what. Null when nothing is scheduled. */
  escalation: { on: string; from: number; to: number } | null
  lines: ContractLine[]
}

type Row = RowDataPacket & Record<string, unknown>

function mapLine(l: Row): ContractLine {
  const qty = toNum(l.qty)
  const unit = toNum(l.unit_price_incl)
  return {
    id: Number(l.id),
    lineNumber: Number(l.line_number),
    productId: l.product_id === null ? null : Number(l.product_id),
    productCode: (l.product_code as string | null) ?? null,
    description: String(l.description),
    qty,
    unitPriceIncl: unit,
    basePriceIncl: toNum(l.base_price_incl),
    vatRatePct: toNum(l.vat_rate_pct),
    departmentId: l.department_id === null ? null : Number(l.department_id),
    lineTotalIncl: round(qty * unit, 2),
  }
}

function mapContract(r: Row, lines: ContractLine[] = [], asAt = today()): Contract {
  const frequency = String(r.frequency) as ContractFrequency
  const schedule = {
    frequency,
    billingDay: Number(r.billing_day),
    startsOn: String(r.starts_on),
    endsOn: r.ends_on === null ? null : String(r.ends_on),
    lastGeneratedFor: r.last_generated_for === null ? null : String(r.last_generated_for),
  }

  const contractNumber = (r.contract_number as string | null) ?? null
  const isActive = Boolean(r.is_active)
  const state = contractState(
    { isActive, contractNumber, startsOn: schedule.startsOn, endsOn: schedule.endsOn },
    asAt,
  )

  const total = lines.reduce((sum, l) => round(sum + l.lineTotalIncl, 2), 0)
  const escalationPct = toNum(r.escalation_pct)
  const escalationMonth = r.escalation_month === null ? null : Number(r.escalation_month)

  // Only a live contract has a next billing date or a next raise. Showing
  // "next on 1 September" for a paused or ended contract is a lie the screen
  // would otherwise tell.
  const live = state === 'active' || state === 'scheduled'

  return {
    id: Number(r.id),
    contractNumber,
    name: String(r.name),
    customerId: Number(r.customer_id),
    customerCode: (r.customer_code as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    customerEmail: (r.customer_email as string | null) ?? null,
    frequency,
    frequencyLabel: CONTRACT_FREQUENCY_LABELS[frequency] ?? frequency,
    billingDay: schedule.billingDay,
    startsOn: schedule.startsOn,
    endsOn: schedule.endsOn,
    lastGeneratedFor: schedule.lastGeneratedFor,
    escalationPct,
    escalationMonth,
    lastEscalatedFor: r.last_escalated_for === null ? null : String(r.last_escalated_for),
    autoSend: Boolean(r.auto_send),
    offerPaymentLink: Boolean(r.offer_payment_link),
    paymentTermsDays: Number(r.payment_terms_days ?? 30),
    isActive,
    reference: (r.reference as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    internalNote: (r.internal_note as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
    state,
    nextDue: live ? nextBillingDate(schedule, asAt) : null,
    due: state === 'active' && isBillingDue(schedule, asAt),
    totalIncl: total,
    annualValue: annualValue(total, frequency),
    escalation: live
      ? nextEscalation(
          {
            escalationPct,
            escalationMonth,
            startsOn: schedule.startsOn,
            endsOn: schedule.endsOn,
            lastEscalatedFor: r.last_escalated_for === null ? null : String(r.last_escalated_for),
          },
          total,
          asAt,
        )
      : null,
    lines,
  }
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

const SELECT_CONTRACT = `
  SELECT c.*, cu.code AS customer_code, cu.name AS customer_name, cu.email AS customer_email
    FROM contracts c
    INNER JOIN customers cu ON cu.id = c.customer_id
`

export type ContractListOptions = {
  includeInactive?: boolean
  customerId?: number
  /** Only those with a period waiting to be billed. */
  dueOnly?: boolean
}

export async function listContracts(
  siteId: number,
  opts: ContractListOptions = {},
): Promise<Contract[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (!opts.includeInactive) where.push('c.is_active = 1')
  if (opts.customerId) {
    where.push('c.customer_id = ?')
    params.push(opts.customerId)
  }

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_CONTRACT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.is_active DESC, c.name`,
    params,
  )

  const asAt = today()

  // Lines are needed for the value column, so they are fetched in ONE query for
  // the whole list rather than per contract. A book of 400 contracts would
  // otherwise be 401 round trips to render a page.
  const ids = rows.map((r) => Number(r.id))
  const linesByContract = await linesFor(siteId, ids)

  const list = rows.map((r) => mapContract(r, linesByContract.get(Number(r.id)) ?? [], asAt))
  return opts.dueOnly ? list.filter((c) => c.due) : list
}

export async function getContract(siteId: number, id: number): Promise<Contract | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_CONTRACT} WHERE c.id = ? LIMIT 1`, [id])
  if (!row) return null

  const lines = await linesFor(siteId, [id])
  return mapContract(row, lines.get(id) ?? [])
}

async function linesFor(
  siteId: number,
  contractIds: number[],
): Promise<Map<number, ContractLine[]>> {
  const out = new Map<number, ContractLine[]>()
  if (contractIds.length === 0) return out

  // Ids come from our own rows, never from user input, so the inline list is
  // safe — and a parameterised IN of 400 placeholders is markedly slower.
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM contract_lines
      WHERE contract_id IN (${contractIds.map(() => '?').join(',')})
      ORDER BY contract_id, line_number`,
    contractIds,
  )

  for (const r of rows) {
    const key = Number(r.contract_id)
    const list = out.get(key) ?? []
    list.push(mapLine(r))
    out.set(key, list)
  }
  return out
}

export type ContractSummary = {
  active: number
  monthlyValue: number
  annualValue: number
  dueNow: number
  endingSoon: number
}

/** The header figures for the contracts list. */
export async function contractSummary(siteId: number): Promise<ContractSummary> {
  const contracts = await listContracts(siteId)
  const asAt = today()
  const soon = addDays(asAt, 60)

  return {
    active: contracts.filter((c) => c.state === 'active').length,
    // Normalised to a month so quarterly and annual contracts are comparable —
    // a book made of mixed frequencies otherwise has no single headline figure.
    monthlyValue: round(
      contracts
        .filter((c) => c.state === 'active')
        .reduce((sum, c) => sum + c.annualValue / 12, 0),
      2,
    ),
    annualValue: round(
      contracts.filter((c) => c.state === 'active').reduce((sum, c) => sum + c.annualValue, 0),
      2,
    ),
    dueNow: contracts.filter((c) => c.due).length,
    // Worth surfacing: a contract that lapses unnoticed is revenue that stops
    // without anyone deciding it should.
    endingSoon: contracts.filter(
      (c) => c.state === 'active' && c.endsOn && c.endsOn <= soon,
    ).length,
  }
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export async function saveContract(
  siteId: number,
  actor: Actor,
  input: ContractInput,
  existingId?: number,
): Promise<SaveResult> {
  const invalid = refuseContract(input)
  if (invalid) return { ok: false, error: invalid }

  const customer = await getCustomer(siteId, input.customerId)
  if (!customer) return { ok: false, error: 'That customer no longer exists.' }

  // A contract bills on account by definition, so a closed account cannot hold
  // one. Caught here rather than at the first tick, when the failure would be
  // a silent row in a log nobody reads.
  if (customer.status === 'closed') {
    return { ok: false, error: `${customer.name}'s account is closed.` }
  }

  const existing = existingId ? await getContract(siteId, existingId) : null
  if (existingId && !existing) return { ok: false, error: 'That contract no longer exists.' }

  return siteTransaction(siteId, async (tx) => {
    let id = existingId ?? 0

    if (id) {
      await tx.execute(
        `UPDATE contracts SET
           name = ?, customer_id = ?, frequency = ?, billing_day = ?,
           starts_on = ?, ends_on = ?, escalation_pct = ?, escalation_month = ?,
           auto_send = ?, offer_payment_link = ?, payment_terms_days = ?,
           reference = ?, notes = ?, internal_note = ?
         WHERE id = ?`,
        [
          input.name.trim(),
          input.customerId,
          input.frequency,
          input.billingDay,
          input.startsOn,
          input.endsOn || null,
          input.escalationPct.toFixed(3),
          input.escalationMonth ?? null,
          input.autoSend ? 1 : 0,
          input.offerPaymentLink ? 1 : 0,
          input.paymentTermsDays,
          input.reference?.trim() || null,
          input.notes?.trim() || null,
          input.internalNote?.trim() || null,
          id,
        ] as never,
      )
      await tx.execute('DELETE FROM contract_lines WHERE contract_id = ?', [id] as never)
    } else {
      // Numbered at creation, not at first bill: a contract is referred to by
      // number long before it generates anything.
      const contractNumber = await nextDocumentNumber(tx, 'contract')

      const [res] = await tx.execute(
        `INSERT INTO contracts
           (contract_number, name, customer_id, frequency, billing_day,
            starts_on, ends_on, escalation_pct, escalation_month,
            auto_send, offer_payment_link, payment_terms_days,
            reference, notes, internal_note, user_id, user_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          contractNumber,
          input.name.trim(),
          input.customerId,
          input.frequency,
          input.billingDay,
          input.startsOn,
          input.endsOn || null,
          input.escalationPct.toFixed(3),
          input.escalationMonth ?? null,
          input.autoSend ? 1 : 0,
          input.offerPaymentLink ? 1 : 0,
          input.paymentTermsDays,
          input.reference?.trim() || null,
          input.notes?.trim() || null,
          input.internalNote?.trim() || null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      id = (res as { insertId: number }).insertId
    }

    for (const [index, line] of input.lines.entries()) {
      // base_price_incl is what the line was worth before ANY escalation. On an
      // edit it must survive: re-deriving it from the current price would reset
      // the baseline every time somebody opens the contract, and the escalation
      // history would quietly stop being provable.
      const previous = existing?.lines.find(
        (l) => l.productId === (line.productId ?? null) && l.description === line.description.trim(),
      )
      const base =
        previous && previous.unitPriceIncl === round(line.unitPriceIncl, 2)
          ? previous.basePriceIncl
          : round(line.unitPriceIncl, 2)

      await tx.execute(
        `INSERT INTO contract_lines
           (contract_id, line_number, product_id, product_code, description,
            qty, unit_price_incl, base_price_incl, vat_rate_pct, department_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          index + 1,
          line.productId ?? null,
          line.productCode?.trim() || null,
          line.description.trim(),
          round(line.qty, 3).toFixed(3),
          round(line.unitPriceIncl, 2).toFixed(4),
          base.toFixed(4),
          line.vatRatePct,
          line.departmentId ?? null,
        ] as never,
      )
    }

    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: input.customerId,
      action: existingId ? 'contract_update' : 'contract_create',
      detail: `${existingId ? 'Updated' : 'Created'} contract "${input.name.trim()}" — ${CONTRACT_FREQUENCY_LABELS[input.frequency].toLowerCase()}, ${contractTotal(input.lines).toFixed(2)}`,
    })

    return { ok: true as const, id }
  })
}

export type ActionResult = { ok: true } | { ok: false; error: string }

export async function setContractActive(
  siteId: number,
  actor: Actor,
  id: number,
  active: boolean,
): Promise<ActionResult> {
  const contract = await getContract(siteId, id)
  if (!contract) return { ok: false, error: 'That contract no longer exists.' }

  await siteExecute(siteId, 'UPDATE contracts SET is_active = ? WHERE id = ?', [active ? 1 : 0, id])
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: contract.customerId,
    action: active ? 'contract_resume' : 'contract_pause',
    detail: `${active ? 'Resumed' : 'Paused'} contract "${contract.name}"`,
  })
  return { ok: true }
}

export async function setAutoSend(
  siteId: number,
  actor: Actor,
  id: number,
  autoSend: boolean,
): Promise<ActionResult> {
  const contract = await getContract(siteId, id)
  if (!contract) return { ok: false, error: 'That contract no longer exists.' }

  await siteExecute(siteId, 'UPDATE contracts SET auto_send = ? WHERE id = ?', [autoSend ? 1 : 0, id])
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: contract.customerId,
    action: 'contract_autosend',
    detail: `Automatic sending turned ${autoSend ? 'on' : 'off'} for "${contract.name}"`,
  })
  return { ok: true }
}

/**
 * Deletes a contract.
 *
 * The invoices it produced STAY — they are posted tax documents and deleting a
 * contract must never touch them. contract_invoices cascades (the schedule's own
 * record goes with it), but its document_id FK is SET NULL from the other side,
 * so the sales documents themselves are untouched.
 */
export async function deleteContract(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<ActionResult> {
  const contract = await getContract(siteId, id)
  if (!contract) return { ok: false, error: 'That contract no longer exists.' }

  await siteExecute(siteId, 'DELETE FROM contracts WHERE id = ?', [id])
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: contract.customerId,
    action: 'contract_delete',
    detail: `Deleted contract "${contract.name}"`,
  })
  return { ok: true }
}

/* ── Escalation ──────────────────────────────────────────────────────────── */

/**
 * Applies any escalations that have fallen due, in place, one at a time.
 *
 * Called by the tick BEFORE billing, so a March invoice carries March's raise.
 * Idempotent through `last_escalated_for`: running twice in a month raises
 * nothing the second time.
 *
 * Returns how many were applied, so the caller can log a raise that actually
 * happened rather than one it assumed.
 */
export async function applyEscalations(
  siteId: number,
  actor: Actor,
  contractId: number,
  asAt = today(),
): Promise<{ applied: number; newTotal: number }> {
  const contract = await getContract(siteId, contractId)
  if (!contract) return { applied: 0, newTotal: 0 }

  const due = escalationsDue(
    {
      escalationPct: contract.escalationPct,
      escalationMonth: contract.escalationMonth,
      startsOn: contract.startsOn,
      endsOn: contract.endsOn,
      lastEscalatedFor: contract.lastEscalatedFor,
    },
    asAt,
  )
  if (due.length === 0) return { applied: 0, newTotal: contract.totalIncl }

  const before = contract.totalIncl

  await siteTransaction(siteId, async (tx) => {
    for (const line of contract.lines) {
      const raised = escalatedPrice(line.unitPriceIncl, contract.escalationPct, due.length)
      await tx.execute('UPDATE contract_lines SET unit_price_incl = ? WHERE id = ?', [
        raised.toFixed(4),
        line.id,
      ] as never)
    }

    // Stamped to the LAST escalation applied, so a contract two years behind
    // catches up fully rather than one year per tick.
    await tx.execute('UPDATE contracts SET last_escalated_for = ? WHERE id = ?', [
      due[due.length - 1],
      contractId,
    ] as never)
  })

  const after = await getContract(siteId, contractId)
  const newTotal = after?.totalIncl ?? before

  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: contract.customerId,
    action: 'contract_escalated',
    detail: `"${contract.name}" escalated ${due.length > 1 ? `${due.length}× ` : ''}by ${contract.escalationPct}% — ${before.toFixed(2)} → ${newTotal.toFixed(2)}`,
  })

  return { applied: due.length, newTotal }
}

/* ── Generation ──────────────────────────────────────────────────────────── */

export type GeneratedInvoice = {
  contractId: number
  contractName: string
  documentId: number
  forDate: string
  totalIncl: number
  posted: boolean
}

export type GenerateResult = {
  generated: GeneratedInvoice[]
  skipped: { contractId: number; name: string; reason: string }[]
  /**
   * `times` is how many annual raises were applied in one go — a contract two
   * years behind catches up both at once, and reporting that as a single
   * escalation would understate what just happened to the customer's price.
   */
  escalated: { contractId: number; name: string; from: number; to: number; times: number }[]
}

/**
 * Bills every contract that is due.
 *
 * Order matters: escalate FIRST, then bill. A contract whose raise lands in the
 * same month it bills must invoice at the new price, and doing it the other way
 * round means the customer gets one more month at the old rate every single
 * year — a slow, systematic under-billing nobody would spot.
 *
 * Each period is claimed in contract_invoices before its document is created,
 * so a crash part-way leaves a claimed-but-empty row (visible, fixable) rather
 * than an unclaimed period that bills again on the next tick.
 */
export async function generateDue(
  siteId: number,
  actor: Actor,
  asAt = today(),
): Promise<GenerateResult> {
  const result: GenerateResult = { generated: [], skipped: [], escalated: [] }

  const contracts = await listContracts(siteId)

  for (const summary of contracts) {
    if (summary.state !== 'active') continue

    // ── Escalate first. See the note above on why the order matters. ──────
    if (summary.escalationPct > 0 && summary.escalationMonth) {
      const before = summary.totalIncl
      const raise = await applyEscalations(siteId, actor, summary.id, asAt)
      if (raise.applied > 0) {
        result.escalated.push({
          contractId: summary.id,
          name: summary.name,
          from: before,
          to: raise.newTotal,
          times: raise.applied,
        })
      }
    }

    // Re-read: escalation may have moved the prices this invoice must carry.
    const contract = await getContract(siteId, summary.id)
    if (!contract) continue
    if (contract.lines.length === 0) {
      result.skipped.push({
        contractId: contract.id,
        name: contract.name,
        reason: 'The contract has no lines to bill.',
      })
      continue
    }

    const periods = duePeriods(
      {
        frequency: contract.frequency,
        billingDay: contract.billingDay,
        startsOn: contract.startsOn,
        endsOn: contract.endsOn,
        lastGeneratedFor: contract.lastGeneratedFor,
      },
      asAt,
    )

    for (const forDate of periods) {
      const billed = await billOnePeriod(siteId, actor, contract, forDate, asAt)
      if (billed.ok) {
        result.generated.push(billed.invoice)
      } else if (billed.reason) {
        // A period already claimed by a concurrent tick is not a failure and is
        // deliberately not reported — it means the guarantee did its job.
        result.skipped.push({
          contractId: contract.id,
          name: contract.name,
          reason: billed.reason,
        })
      }
    }
  }

  if (result.generated.length > 0) {
    await logActivity(siteId, actor, {
      entity: 'customer',
      entityId: null,
      action: 'contract_generate',
      detail: `Billed ${result.generated.length} contract invoice${result.generated.length === 1 ? '' : 's'}`,
    })
  }

  return result
}

type BillOutcome =
  | { ok: true; invoice: GeneratedInvoice }
  | { ok: false; reason: string | null }

/**
 * Bills ONE period of one contract.
 *
 * Split out because it is also what "bill this now" does from the contract
 * screen, and because the claim-then-create sequence is the delicate part of
 * this whole feature and deserves to be readable in one screen.
 */
async function billOnePeriod(
  siteId: number,
  actor: Actor,
  contract: Contract,
  forDate: string,
  /**
   * The date the run considers "now". MUST be the same value applyEscalations
   * was given, because the wind-back below is relative to how many raises the
   * contract's stored prices already carry — and that is decided by `asAt`, not
   * by the wall clock. Defaulting this to today() was a real bug: a run
   * simulating February wound back a March raise that had not been applied,
   * and every invoice came out one escalation too cheap.
   */
  asAt: string,
): Promise<BillOutcome> {
  // ── 1. CLAIM the period. ─────────────────────────────────────────────────
  //
  // Before anything is created. The unique key on (contract_id, for_date) means
  // a second tick racing this one fails HERE, having written nothing.
  let claimId: number
  try {
    const claim = await siteExecute(
      siteId,
      `INSERT INTO contract_invoices (contract_id, for_date, status) VALUES (?,?,'draft')`,
      [contract.id, forDate],
    )
    claimId = claim.insertId
  } catch {
    // Already claimed — the other tick is billing it. Silent by design.
    return { ok: false, reason: null }
  }

  // ── 2. The price AS AT THIS PERIOD. ──────────────────────────────────────
  //
  // A March invoice generated in June carries March's price. The lines already
  // hold today's escalated price, so any raise that landed AFTER this period is
  // wound back off. See the header note — this is the back-dating rule.
  const raisesByThen = escalationsAppliedBy(
    {
      escalationPct: contract.escalationPct,
      escalationMonth: contract.escalationMonth,
      startsOn: contract.startsOn,
      endsOn: contract.endsOn,
    },
    forDate,
  )
  const raisesNow = escalationsAppliedBy(
    {
      escalationPct: contract.escalationPct,
      escalationMonth: contract.escalationMonth,
      startsOn: contract.startsOn,
      endsOn: contract.endsOn,
    },
    asAt,
  )
  const wind = raisesNow - raisesByThen

  const lines = contract.lines.map((l) => ({
    productId: l.productId,
    productCode: l.productCode,
    description: l.description,
    departmentId: l.departmentId,
    qty: l.qty,
    unitPriceIncl:
      wind > 0
        ? unescalate(l.unitPriceIncl, contract.escalationPct, wind)
        : l.unitPriceIncl,
    vatRatePct: l.vatRatePct,
  }))

  // ── 3. Create the draft invoice. ─────────────────────────────────────────
  const customer = await getCustomer(siteId, contract.customerId)
  const draft = await saveDraft(siteId, actor, {
    docType: 'invoice',
    documentDate: forDate,
    customerId: contract.customerId,
    customerName: customer?.name ?? contract.customerName,
    customerVatNo: customer?.vatNumber ?? null,
    customerPhone: customer?.phone ?? null,
    reference: contract.reference,
    notes: contract.notes,
    lines,
  })

  if (!draft.ok) {
    await siteExecute(
      siteId,
      `UPDATE contract_invoices SET status = 'failed', error = ? WHERE id = ?`,
      [draft.error.slice(0, 400), claimId],
    )
    return { ok: false, reason: draft.error }
  }

  await siteExecute(siteId, 'UPDATE contract_invoices SET document_id = ? WHERE id = ?', [
    draft.id,
    claimId,
  ])

  // Stamp the contract. The fast path for the next tick; the claim above is
  // what actually guarantees no double bill.
  await siteExecute(siteId, 'UPDATE contracts SET last_generated_for = ? WHERE id = ?', [
    forDate,
    contract.id,
  ])

  const document = await getDocument(siteId, draft.id)
  const totalIncl = document?.totalIncl ?? 0

  // ── 4. Post it, if this contract is trusted to post itself. ──────────────
  //
  // auto_send off leaves a draft for somebody to release, which is the default
  // and the safe path. A posting failure — over credit limit, account on hold —
  // leaves the draft in place with the reason recorded: the invoice still
  // exists and can be released by hand once the account is sorted out.
  let posted = false
  if (contract.autoSend) {
    const outcome = await postContractInvoice(siteId, actor, draft.id, contract.customerId)
    if (outcome.ok) {
      posted = true
      await siteExecute(
        siteId,
        `UPDATE contract_invoices SET status = 'posted' WHERE id = ?`,
        [claimId],
      )
    } else {
      await siteExecute(
        siteId,
        `UPDATE contract_invoices SET status = 'draft', error = ? WHERE id = ?`,
        [outcome.error.slice(0, 400), claimId],
      )
    }
  }

  return {
    ok: true,
    invoice: {
      contractId: contract.id,
      contractName: contract.name,
      documentId: draft.id,
      forDate,
      totalIncl,
      posted,
    },
  }
}

/** The inverse of escalatedPrice, for winding a back-dated invoice's price back. */
function unescalate(price: number, escalationPct: number, times: number): number {
  let out = price
  for (let i = 0; i < times; i++) {
    out = round(out / (1 + escalationPct / 100), 2)
  }
  return out
}

/**
 * Posts a contract invoice to the customer's account.
 *
 * Goes through finaliseDocument like every other sale — NOT a bespoke posting
 * path. That is what makes a contract invoice indistinguishable from a hand-
 * captured one downstream: the same stock movement, the same debtor
 * transaction, the same GL mirror, the same credit check. A second posting
 * engine for contracts is how two parts of a system start disagreeing about
 * what was sold.
 *
 * The single tender is the ACCOUNT one, because a contract is by definition
 * billed rather than paid at a till.
 */
export async function postContractInvoice(
  siteId: number,
  actor: Actor,
  documentId: number,
  customerId: number,
): Promise<{ ok: true; documentNumber: string } | { ok: false; error: string }> {
  const document = await getDocument(siteId, documentId)
  if (!document) return { ok: false, error: 'That invoice no longer exists.' }
  if (document.status === 'finalised') {
    return { ok: false, error: 'That invoice is already posted.' }
  }

  const account = await getTenderByCode(siteId, 'ACCOUNT')
  if (!account) {
    return {
      ok: false,
      error: 'There is no "on account" payment method set up, so a contract cannot be billed.',
    }
  }
  if (!account.isActive) {
    return { ok: false, error: 'The "on account" payment method is switched off.' }
  }

  const result = await finaliseDocument(siteId, actor, {
    documentId,
    customerId,
    tenders: [{ tenderTypeId: account.id, amount: document.totalIncl }],
  })

  return result.ok
    ? { ok: true, documentNumber: result.documentNumber }
    : { ok: false, error: result.error }
}

/** What a contract has billed, for its detail screen. */
export type ContractInvoiceRow = {
  id: number
  forDate: string
  documentId: number | null
  documentNumber: string | null
  status: 'draft' | 'posted' | 'failed'
  emailStatus: 'pending' | 'sent' | 'failed' | 'skipped'
  emailedTo: string | null
  emailedAt: Date | null
  totalIncl: number
  error: string | null
}

export async function contractInvoices(
  siteId: number,
  contractId: number,
  limit = 36,
): Promise<ContractInvoiceRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ci.*, d.document_number, d.total_incl, d.status AS doc_status
       FROM contract_invoices ci
       LEFT JOIN sales_documents d ON d.id = ci.document_id
      WHERE ci.contract_id = ?
      ORDER BY ci.for_date DESC LIMIT ${capped}`,
    [contractId],
  )

  return rows.map((r) => ({
    id: Number(r.id),
    forDate: String(r.for_date),
    documentId: r.document_id === null ? null : Number(r.document_id),
    documentNumber: (r.document_number as string | null) ?? null,
    status: String(r.status) as 'draft' | 'posted' | 'failed',
    emailStatus: String(r.email_status) as 'pending' | 'sent' | 'failed' | 'skipped',
    emailedTo: (r.emailed_to as string | null) ?? null,
    emailedAt: (r.emailed_at as Date | null) ?? null,
    totalIncl: toNum(r.total_incl),
    error: (r.error as string | null) ?? null,
  }))
}

/** Billing one contract on demand, from its screen. */
export async function billNow(
  siteId: number,
  actor: Actor,
  contractId: number,
  asAt = today(),
): Promise<GenerateResult> {
  const contract = await getContract(siteId, contractId)
  if (!contract) {
    return { generated: [], skipped: [], escalated: [] }
  }

  const result: GenerateResult = { generated: [], skipped: [], escalated: [] }

  if (contract.escalationPct > 0 && contract.escalationMonth) {
    const before = contract.totalIncl
    const raise = await applyEscalations(siteId, actor, contractId, asAt)
    if (raise.applied > 0) {
      result.escalated.push({
        contractId,
        name: contract.name,
        from: before,
        to: raise.newTotal,
        times: raise.applied,
      })
    }
  }

  const fresh = await getContract(siteId, contractId)
  if (!fresh) return result

  const periods = duePeriods(
    {
      frequency: fresh.frequency,
      billingDay: fresh.billingDay,
      startsOn: fresh.startsOn,
      endsOn: fresh.endsOn,
      lastGeneratedFor: fresh.lastGeneratedFor,
    },
    asAt,
  )

  if (periods.length === 0) {
    result.skipped.push({
      contractId,
      name: fresh.name,
      reason: 'Nothing is due to be billed yet.',
    })
    return result
  }

  for (const forDate of periods) {
    const billed = await billOnePeriod(siteId, actor, fresh, forDate, asAt)
    if (billed.ok) result.generated.push(billed.invoice)
    else if (billed.reason) {
      result.skipped.push({ contractId, name: fresh.name, reason: billed.reason })
    }
  }

  return result
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00`)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export { CONTRACT_FREQUENCIES, CONTRACT_FREQUENCY_LABELS }
export type { ContractFrequency, ContractInput, ContractState }
