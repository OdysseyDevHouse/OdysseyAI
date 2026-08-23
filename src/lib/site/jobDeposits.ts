import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { customerQuery, customerDbPrefix } from './customerDb'
import { recordCustomerReceipt } from './cashbook'
import { logActivity, type Actor } from './activityLog'
import { toNum } from '../decimals'

/**
 * Money taken up front on a job.
 *
 * ── NO NEW TABLE, AND NO NEW ACCOUNTING ────────────────────────────────────
 *
 * The PRD answers this itself: "Not required to sync to an accounting system at
 * this stage", and "deposits must follow the approved Odyssey POS and
 * accounting-integration rules. The job card system must not independently
 * invent accounting postings."
 *
 * A deposit already IS something this app can express — a customer receipt. So
 * it goes through `recordCustomerReceipt`, the cashbook's own function, as
 * `doc_type = 'payment'` with `source = 'job_deposit'` and `source_doc_id`
 * naming the job. That one call brings the period lock, the duplicate-number
 * guard, the balance update AND the bank row. A `job_deposits` table would have
 * been a second ledger that agreed with the first only while somebody
 * maintained it.
 *
 * ── BOTH HALVES, OR THE CASH POSITION LIES ─────────────────────────────────
 *
 * The first version of this file called `postTransaction` directly, which
 * writes the DEBTORS side only. The customer owed less and the money appeared in
 * no account, so the cash position would have understated by every deposit ever
 * taken. Found by reading what postTransaction actually does rather than what
 * its name suggests.
 *
 * ── IT DOES NOT ALLOCATE ITSELF ────────────────────────────────────────────
 *
 * `autoAllocate` is deliberately NOT set. A deposit sits on the account as an
 * unallocated credit until somebody settles it against an invoice, which is how
 * this app already treats a payment with nothing to match.
 *
 * Allocating on invoicing would look helpful and be wrong: a job can raise more
 * than one invoice, and the deposit would land on whichever was raised first
 * rather than the one the customer meant it for. That is a debtors decision, and
 * the debtors screen is where it is made.
 *
 * ── WHAT THE JOB SCREEN OWES THE USER ──────────────────────────────────────
 *
 * The figure that matters is not the deposit — it is what is still to pay. So
 * `depositSummary` returns the quoted total beside the deposits and the
 * difference, because a deposit with no context is a number nobody can act on.
 */

type Row = RowDataPacket & Record<string, unknown>

export type JobDeposit = {
  transactionId: number
  docNumber: string | null
  docDate: string
  amount: number
  reference: string | null
  description: string | null
  userName: string
  /** How much of it is still unspent. Zero once fully allocated to invoices. */
  outstanding: number
}

export type DepositSummary = {
  deposits: JobDeposit[]
  /** What has been taken, in total. */
  taken: number
  /** Of that, how much is still sitting unallocated on the account. */
  unallocated: number
  /**
   * How much has been given back.
   *
   * Its own figure rather than netted into `taken`: "R2 000 taken, R500
   * refunded" and "R1 500 taken" are different histories, and only the first
   * explains why the customer is asking about a payment they remember making.
   */
  refunded: number
  /**
   * The accepted quote total, where there is one. Null when the job was never
   * quoted — a deposit on an unquoted job is legitimate, and inventing a
   * "balance" against nothing would be a made-up figure.
   */
  quoted: number | null
  /** quoted - taken, or null when there is nothing to compare against. */
  stillToPay: number | null
}

export type DepositResult = { ok: true; transactionId: number } | { ok: false; error: string }

/**
 * Every deposit taken against one job.
 *
 * Matched on source + source_doc_id rather than by scanning the customer's whole
 * ledger: a customer with four open jobs has four separate deposits, and showing
 * all of them on each job would make every balance wrong.
 */
export async function jobDeposits(siteId: number, jobId: number): Promise<JobDeposit[]> {
  try {
    // The deposits are in the customer ledger, which a store group may keep in
    // the primary's database — recordCustomerReceipt already writes them there.
    // Read locally this returned nothing at every branch, so a job card showed
    // "no deposits" for money the customer had actually paid and the technician
    // invoiced the full amount again on completion.
    //
    // Only customer_transactions is named here, so the whole statement moves to
    // the owner. The origin_site_id scoping below is what keeps it correct once
    // it gets there.
    const rows = await customerQuery<Row>(
      siteId,
      `SELECT id, doc_number, doc_date, amount_gross, amount_outstanding,
              reference, description, user_name
         FROM customer_transactions
        WHERE source = 'job_deposit' AND source_doc_id = ?
          -- Scoped to THIS store: job ids are per-database, so a shared ledger
          -- holding ten branches' deposits would otherwise show job 42 at store 3
          -- the deposits taken against job 42 at store 7.
          AND (origin_site_id IS NULL OR origin_site_id = ?)
          AND doc_type = 'payment'
        ORDER BY doc_date, id`,
      [jobId, siteId],
    )
    return rows.map((r) => ({
      transactionId: Number(r.id),
      docNumber: r.doc_number === null ? null : String(r.doc_number),
      docDate: String(r.doc_date).slice(0, 10),
      amount: toNum(r.amount_gross),
      reference: r.reference === null ? null : String(r.reference),
      description: r.description === null ? null : String(r.description),
      userName: String(r.user_name ?? ''),
      // Stored as a negative on a credit, so the magnitude is what a reader
      // means by "still unspent".
      outstanding: Math.abs(toNum(r.amount_outstanding)),
    }))
  } catch {
    // A site without the job module, or without the ledger. Neither should stop
    // a job card opening.
    return []
  }
}

/** The deposits, and what they mean against what was quoted. */
export async function depositSummary(siteId: number, jobId: number): Promise<DepositSummary> {
  const deposits = await jobDeposits(siteId, jobId)
  const taken = deposits.reduce((sum, d) => sum + d.amount, 0)

  /*
   * Refunds come off what is left to refund, and this is load-bearing.
   *
   * jobDeposits reads doc_type = 'payment' only, so a refund — posted as a
   * journal, see refundDeposit — is invisible to it. Without this the
   * unallocated figure would still show the full deposit after it had been
   * given back, and refundDeposit's own guard reads that figure: the same money
   * could be handed over twice, and the ledger would be right while the screen
   * and the guard were both wrong.
   */
  const refunded = await refundedTotal(siteId, jobId)
  const unallocated = Math.max(
    0,
    deposits.reduce((sum, d) => sum + d.outstanding, 0) - refunded,
  )

  let quoted: number | null = null
  try {
    /*
     * The ACCEPTED quote, not the latest one.
     *
     * A job can carry several quote revisions; the accepted one is the baseline
     * the customer agreed to, and it is the only figure a deposit can sensibly
     * be measured against. accepted_quote_id names it — see decision 3 in the
     * plan.
     */
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT sd.total_incl
         FROM job_cards j
         JOIN sales_documents sd ON sd.id = j.accepted_quote_id
        WHERE j.id = ?`,
      [jobId],
    )
    if (row) quoted = toNum(row.total_incl)
  } catch {
    quoted = null
  }

  return {
    deposits,
    taken,
    unallocated,
    refunded,
    quoted,
    /*
     * Net of refunds: what the customer has actually left with the business is
     * what counts against the quote. Ignoring refunds here would tell somebody
     * a job was nearly paid for when the money had gone back.
     */
    stillToPay: quoted === null ? null : quoted - (taken - refunded),
  }
}

/**
 * What has already been given back on this job.
 *
 * Its own query because refunds are journals, and jobDeposits deliberately
 * reads payments — see the note in depositSummary. Scoped by origin_site_id for
 * the reason jobDeposits is: job ids are per-database, so a shared ledger
 * holding ten branches' rows would otherwise credit job 42 here with job 42's
 * refunds at another store.
 */
async function refundedTotal(siteId: number, jobId: number): Promise<number> {
  try {
    const rows = await customerQuery<Row>(
      siteId,
      `SELECT amount_gross FROM customer_transactions
        WHERE source = 'job_deposit_refund' AND source_doc_id = ?
          AND (origin_site_id IS NULL OR origin_site_id = ?)
          AND doc_type = 'journal'`,
      [jobId, siteId],
    )
    return rows.reduce((sum, r) => sum + Math.abs(toNum(r.amount_gross)), 0)
  } catch {
    // No ledger on this site. Not a reason a job card cannot open.
    return 0
  }
}

/**
 * Take a deposit against a job.
 *
 * Thin on purpose: it validates what only this module knows — that the job
 * exists, has a customer account, and is not closed — and hands everything else
 * to `recordCustomerReceipt`, which owns period locks, duplicate numbers, the
 * balance and the bank row.
 */
export async function takeDeposit(
  siteId: number,
  actor: Actor,
  jobId: number,
  input: {
    amount: number
    /** Which account the money went into. See the note on the call below. */
    bankAccountId: number
    docDate?: string
    reference?: string | null
    description?: string | null
  },
): Promise<DepositResult> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, document_number, customer_id, customer_name, status, title
       FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }

  /*
   * A walk-in job has no account, and a deposit has to land on one. Refused
   * with the fix named rather than posting against a customer nobody chose.
   */
  if (job.customer_id === null) {
    return {
      ok: false,
      error: 'This job has no customer account, so there is nowhere to put a deposit. Add a customer first.',
    }
  }

  if (String(job.status) !== 'open') {
    return {
      ok: false,
      error: 'This job is closed. Take the payment on the customer account instead.',
    }
  }

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'A deposit has to be an amount greater than zero.' }
  }

  const label = String(job.document_number ?? `job ${jobId}`)

  /*
   * recordCustomerReceipt, NOT postTransaction — and this was a real mistake in
   * the first version of this file.
   *
   * postTransaction writes the DEBTORS side only. It reduces what the customer
   * owes and stops there: no bank row, so the money never appears in any
   * account. A deposit taken that way would leave the cash position understated
   * by every deposit ever taken, and somebody would have to re-key the receipt
   * on the cashbook to put it right.
   *
   * recordCustomerReceipt does both halves in the order the cashbook chose —
   * ledger first, bank row second, so a failure in between leaves an unlinked
   * receipt rather than a bank row pointing at a payment that does not exist.
   *
   * That is why bankAccountId is required rather than optional: money received
   * has to be received INTO something, and a default would be this module
   * guessing at an accounting fact.
   */
  const posted = await recordCustomerReceipt(siteId, actor, {
    customerId: Number(job.customer_id),
    bankAccountId: input.bankAccountId,
    amount,
    receiptDate: input.docDate,
    reference: input.reference ?? null,
    description: input.description?.trim() || `Deposit on ${label} — ${String(job.title)}`,
    source: 'job_deposit',
    sourceDocId: jobId,
    /*
     * NOT auto-allocated, and this is the one place it differs from an ordinary
     * receipt (which defaults to true). See the module header: which invoice a
     * deposit settles is a debtors decision, and a job can raise more than one.
     */
    autoAllocate: false,
  })
  if (!posted.ok) return posted

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'deposit_taken',
    detail: `Deposit of ${amount.toFixed(2)} received`,
  }).catch(() => {})

  return { ok: true, transactionId: posted.customerTxnId }
}

/* ── Giving it back ───────────────────────────────────────────────────────── */

export type RefundResult = { ok: true; transactionId: number } | { ok: false; error: string }

/**
 * Refund a deposit — the customer changed their mind, or the job was called off.
 *
 * ── WHY THIS IS A JOURNAL AND NOT A NEGATIVE PAYMENT ───────────────────────
 *
 * The obvious move is `docType: 'payment'` with a negative amount. It does not
 * work, and it does not fail either: signedAmount() clamps a payment to a
 * credit, so a negative one posts as another CREDIT. The refund would INCREASE
 * the customer's credit balance while the money left the bank — the ledger
 * saying they are owed more, precisely because we paid them.
 *
 * The other move is a new doc_type. customer_transactions is shared with the
 * whole app — POS, invoicing, statements, aging, every report — so widening
 * that enum gives every switch over DocType a silently unhandled case, and most
 * of them read strings the compiler cannot check.
 *
 * `journal` is the type that keeps the sign it is given, and writeOffs.ts
 * already uses it for exactly this shape of correction. POSITIVE here, because
 * a refund is a DEBIT: it cancels the credit the deposit created.
 *
 * ── IT CANNOT REFUND MORE THAN IS STILL THERE ──────────────────────────────
 *
 * Measured against what is UNALLOCATED, never against what was taken. Once a
 * deposit has been settled against an invoice the customer has had the value,
 * and refunding it again hands back money already earned while leaving the
 * invoice unpaid. That check is the difference between a refund and a giveaway.
 *
 * ── BOTH HALVES, AGAIN ─────────────────────────────────────────────────────
 *
 * The module header records what happened when the first takeDeposit wrote the
 * debtors side only. A refund has the same two halves in the same order, and
 * the bank row is the one allowed to fail alone: a missing bank row is a
 * visible reconciliation item, whereas a rolled-back ledger with the cash
 * already handed over is money nobody can find.
 */
export async function refundDeposit(
  siteId: number,
  actor: Actor,
  jobId: number,
  input: {
    amount: number
    /** Which account the money comes OUT of. */
    bankAccountId: number
    /** Why. Required — a refund with no reason is the one somebody has to explain. */
    reason: string
    docDate?: string
    reference?: string | null
  },
): Promise<RefundResult> {
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT id, document_number, customer_id, title FROM job_cards WHERE id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (job.customer_id === null) {
    return { ok: false, error: 'This job has no customer account, so it has no deposit to refund.' }
  }
  if (!input.reason?.trim()) {
    return {
      ok: false,
      error: 'Why is it being refunded? A refund with no reason is the one somebody has to explain later.',
    }
  }

  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'A refund has to be an amount greater than zero.' }
  }

  /*
   * NOT gated on the job being open, unlike takeDeposit.
   *
   * A cancelled job is the commonest reason to give a deposit back, and
   * cancelling is what closed it. Refusing here would mean the only route to a
   * refund is reopening a job everybody agrees is finished.
   */
  const summary = await depositSummary(siteId, jobId)
  if (summary.unallocated <= 0) {
    return {
      ok: false,
      error:
        summary.taken > 0
          ? 'Every deposit on this job has been settled against an invoice, so there is nothing left to give back.'
          : 'No deposit has been taken on this job.',
    }
  }
  /*
   * Half a cent of tolerance, so a refund of the whole remaining balance is not
   * refused by a rounding artefact the person on the screen cannot see.
   */
  if (amount > summary.unallocated + 0.004) {
    return {
      ok: false,
      error:
        `Only ${summary.unallocated.toFixed(2)} of the deposit is unspent. Refunding more than ` +
        `that would hand back money the invoices have already used.`,
    }
  }

  const label = String(job.document_number ?? `job ${jobId}`)
  const { postTransaction } = await import('./customerLedger')

  const posted = await postTransaction(siteId, actor, {
    customerId: Number(job.customer_id),
    docType: 'journal',
    /*
     * POSITIVE — a debit, cancelling the credit the deposit put on the account.
     * A journal keeps the sign it is given; see signedAmount() in ledger.ts,
     * and the header for why a negative payment does the opposite of this.
     */
    amount,
    docDate: input.docDate,
    reference: input.reference ?? null,
    description: `Deposit refunded on ${label} — ${input.reason.trim()}`.slice(0, 190),
    source: 'job_deposit_refund',
    sourceDocId: jobId,
    /*
     * NOT auto-allocated, for the reason the deposit is not: which invoice this
     * touches is a debtors decision. Allocating a DEBIT would be the wrong
     * shape anyway — allocation settles debits WITH credits.
     */
    autoAllocate: false,
  })
  if (!posted.ok) return { ok: false, error: posted.error }

  /*
   * The bank half, whose failure is REPORTED rather than thrown.
   *
   * The same stance recordCustomerReceipt takes on its own second half:
   * rethrowing would report "refund failed" for a customer whose account has
   * already been debited, which is the worst of both.
   *
   * No categoryKey, deliberately. Where the contra posts is an accounting
   * decision this module must not invent — the PRD is explicit that the job
   * system does not invent postings — so the row stands uncategorised and the
   * reconciliation screen shows the gap until somebody files it.
   */
  let bankOk = true
  try {
    const { captureTransaction } = await import('./cashbook')
    const captured = await captureTransaction(siteId, actor, {
      bankAccountId: input.bankAccountId,
      // NEGATIVE: money out of the account.
      amount: -amount,
      txnDate: input.docDate,
      description: `Deposit refund — ${label}`,
      reference: input.reference ?? null,
      source: 'job_deposit_refund',
      sourceDocId: jobId,
    })
    bankOk = captured.ok
  } catch {
    bankOk = false
  }

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'deposit_refunded',
    detail:
      `Refund of ${amount.toFixed(2)} — ${input.reason.trim()}` +
      (bankOk ? '' : '. The bank entry could not be written; capture it on the cashbook.'),
  }).catch(() => {})

  return { ok: true, transactionId: posted.id }
}


export type DepositDrift = {
  /**
   * A deposit whose job has been deleted.
   *
   * customer_transactions has no foreign key to job_cards — it cannot, the
   * source pair is loose so one column can point at several kinds of record. So
   * a deleted job leaves its deposit pointing at nothing. The MONEY is still
   * right, which is what matters; what is lost is the reason it was taken.
   */
  orphaned: { transactionId: number; jobId: number; amount: number; docDate: string }[]
}

/**
 * Reports, never repairs.
 *
 * ── THE QUERY THAT NEITHER DATABASE CAN ANSWER ALONE ─────────────────────
 *
 * This is the textbook mixed statement: customer_transactions may live in the
 * group primary while job_cards stays in the branch that opened the job. Run on
 * either connection alone it gives a confident wrong answer rather than an
 * error, and the two wrong answers are opposites:
 *
 *   · on the BRANCH, customer_transactions is empty, so it reports zero
 *     orphans — a clean bill of health for a store it never looked at.
 *   · on the OWNER, every branch's deposit is compared against head office's
 *     job_cards, so every one of them looks orphaned.
 *
 * So it stays on the caller's connection and names the owner's database in the
 * FROM, with origin_site_id narrowing the ledger to deposits this store took.
 * That last part is what makes the NOT IN meaningful: job ids are per-database,
 * so comparing another branch's job id against this store's job_cards would
 * manufacture an orphan out of a perfectly good deposit.
 *
 * Both prefixes are empty for a single store, so the SQL is what it always was.
 */
export async function reconcileJobDeposits(siteId: number): Promise<DepositDrift> {
  try {
    // Only the customer side needs naming: the statement runs on the caller's
    // own connection, so job_cards resolves here without a qualifier.
    const cdb = await customerDbPrefix(siteId)
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT t.id, t.source_doc_id, t.amount_gross, t.doc_date
         FROM ${cdb}customer_transactions t
        WHERE t.source = 'job_deposit'
          AND t.source_doc_id IS NOT NULL
          AND (t.origin_site_id IS NULL OR t.origin_site_id = ?)
          AND t.source_doc_id NOT IN (SELECT id FROM job_cards)`,
      [siteId],
    )
    return {
      orphaned: rows.map((r) => ({
        transactionId: Number(r.id),
        jobId: Number(r.source_doc_id),
        amount: toNum(r.amount_gross),
        docDate: String(r.doc_date).slice(0, 10),
      })),
    }
  } catch {
    return { orphaned: [] }
  }
}
