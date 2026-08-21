import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'

/**
 * Training mode: a session of pretend trading that leaves nothing behind.
 *
 * Read 170_training_mode.sql first — it carries the design argument for why
 * this works on a WATERMARK (the highest id in every table at the moment
 * training started) rather than an is_training flag on thirty tables. The short
 * version: a flag has to be set by every writer, and the writer added next
 * month will not set it, so the purge silently leaves rows behind. A watermark
 * cannot miss a row, because it never had to be told about one.
 *
 * ── THE ONE INVARIANT EVERYTHING RESTS ON ────────────────────────────────
 *
 * Training is SITE-WIDE. While it is on, nothing real is being created, so
 * "id greater than the mark" and "created during training" are the same set of
 * rows. Every guarantee below dissolves the moment that stops being true, which
 * is why isTrainingActive() gates the whole site rather than one till, and why
 * this module must never grow a per-terminal variant.
 *
 * ── WHY THIS DELETES, WHEN NOTHING ELSE IN THE CODEBASE DOES ─────────────
 *
 * Every other reversal here — voidDocument, createCreditNote, mirrorSaleReversal
 * — deliberately KEEPS the row and writes a compensating one, and each says at
 * length why deleting history is wrong. This does the opposite, and the
 * distinction is not a loosening of that rule but a consequence of it: those
 * paths reverse things that HAPPENED. A training sale never happened. There was
 * no customer, no money, no goods off the shelf. Keeping it — even cancelled —
 * would put rows into the void report, the VAT return and the stock ledger that
 * describe events which did not occur, and someone would eventually have to
 * explain them to an auditor. The honest record of a training session is that
 * the shop traded nothing, plus the training_sessions row saying who practised.
 */

/* ── The registry ───────────────────────────────────────────────────────── */

/**
 * Every table training can write to, in the order they must be DELETEd.
 *
 * ORDER IS LOAD-BEARING. Children come before parents so that foreign keys are
 * satisfied at every step — deleting sales_documents before sales_document_lines
 * is refused by the database, and the refusal would roll back a purge that had
 * already half-run if it were not all one transaction.
 *
 * `id` names the auto-increment column to compare the watermark against. A
 * handful of tables key on something else and are listed with the column they
 * actually use.
 *
 * WHAT IS DELIBERATELY ABSENT is as important as what is here:
 *
 *   products, customers, suppliers, users, terminals, gl_accounts, settings,
 *   tender_types, stock_locations, roles, price structures …
 *
 * — master data. A trainee who adds a product or a customer while practising
 * has created something the shop may well want to keep, and more to the point,
 * deleting a product that a REAL past sale points at is refused by an FK and
 * would fail the whole purge. Master data is left alone by design; the training
 * session removes TRANSACTIONS, which is what corrupts the figures.
 *
 * The consequence is stated plainly on the screen: practice customers and
 * products stay, and get tidied up by hand.
 */
type PurgeTable = {
  /** The table name, as it appears in the schema. */
  table: string
  /**
   * The ascending column the watermark is taken on. Almost always `id`.
   *
   * A handful of tables have no `id` at all — a 1:1 extension keyed on its
   * parent's id, or a composite junction. Those name the column that DOES rise
   * with time, which for an extension table is the parent document id. The
   * watermark logic is unchanged; only the column differs.
   */
  key?: string
  /** Why it is in the list, when that is not obvious from the name. */
  note?: string
}

/**
 * Children first, parents last. Within a group the same rule applies.
 *
 * A table that does not exist on a given site is skipped at runtime rather than
 * removed from this list — see tableExists(). Schema drifts between sites, and a
 * purge that throws because one site never ran a migration is a purge that
 * leaves training data on that site forever.
 */
const PURGE_TABLES: readonly PurgeTable[] = [
  /* ── The GL. First, because it mirrors everything below it and points at it. */
  { table: 'journal_lines', note: 'child of journal_batches' },
  { table: 'journal_batches', note: 'every posting mirrors into here' },

  /* ── Stock. Movements before the documents that caused them. */
  { table: 'batch_movements' },
  { table: 'serial_movements' },
  { table: 'stock_movements', note: 'the ledger every stock change writes to' },
  { table: 'product_batches', note: 'lots opened by a training receipt' },

  /* ── Sales documents and everything hanging off them. */
  { table: 'sales_document_line_instructions' },
  { table: 'sales_tenders' },
  { table: 'sales_tips' },
  { table: 'service_charge_removals' },
  /* A 1:1 extension of sales_documents, keyed on document_id and with no id of
     its own. document_id rises with the parent, so it watermarks correctly on
     that column. It also cascades, making this belt and braces. */
  { table: 'sales_order_details', key: 'document_id' },
  { table: 'sales_document_lines' },
  { table: 'document_audit', note: 'finalise/void trail for the documents below' },
  { table: 'discount_code_uses' },
  { table: 'pos_void_events' },
  /* offline_sync_claims and offline_return_claims are keyed on a UUID STRING,
     which has no order — a watermark cannot express "created after this one" on
     them, and comparing a uuid with `>` would delete an arbitrary subset. Both
     carry an ON DELETE CASCADE from sales_documents, so they are removed by the
     parent delete below rather than named here. Left OUT on purpose: a wrong
     rule is worse than a missing one when the missing one is already handled. */
  { table: 'offline_cancelled_sales' },
  { table: 'sales_documents', note: 'the header — after every child above' },

  /* ── Laybys. */
  { table: 'layby_payments' },
  { table: 'layby_lines' },
  { table: 'laybys' },

  /* ── Purchasing. */
  { table: 'purchase_document_audit' },
  { table: 'purchase_document_charges' },
  { table: 'purchase_document_lines' },
  /* The purchasing twin of sales_order_details — same shape, same reasoning. */
  { table: 'purchase_order_details', key: 'document_id' },
  { table: 'purchase_documents' },

  /* ── Subledgers. Allocations before the transactions they allocate. */
  { table: 'customer_allocations' },
  { table: 'customer_transactions' },
  { table: 'supplier_allocations' },
  { table: 'supplier_transactions' },

  /* ── Loyalty. The ledger and wallet move on a training sale; members and
       tiers are master data and stay. */
  { table: 'loyalty_ledger' },
  { table: 'loyalty_stamps' },
  { table: 'loyalty_card_items' },
  { table: 'loyalty_vouchers' },
  { table: 'loyalty_wallet', note: 'points balance moved by a training sale' },

  /* ── Gift cards. Events before cards; a card SOLD in training is removed,
       one that existed before it is untouched by the watermark. */
  { table: 'gift_card_events' },
  { table: 'gift_cards' },

  /* ── Stock documents. */
  { table: 'stock_adjustment_lines' },
  { table: 'stock_adjustments' },
  { table: 'stock_take_lines' },
  { table: 'stock_takes' },
  { table: 'stock_transfer_lines' },
  { table: 'stock_transfers' },
  { table: 'online_stock_holds', note: 'web reservations against stock' },
  { table: 'manufacturing_order_costs' },
  { table: 'manufacturing_order_lines' },
  { table: 'manufacturing_orders' },

  /* ── Cash. Shifts and the banking they produce. */
  { table: 'shift_count_denominations' },
  { table: 'shift_counts' },
  { table: 'shift_declarations' },
  { table: 'shift_movements' },
  { table: 'tip_payouts' },
  { table: 'cashbook_links' },
  { table: 'bank_transactions' },
  { table: 'shifts' },

  /* ── Expenses raised while practising. */
  { table: 'expense_lines' },
  { table: 'expenses' },

  /* ── Job cards. */
  { table: 'job_card_lines' },
  { table: 'job_card_items' },
  { table: 'job_card_travel' },
  /* A composite junction (job_card_id, user_id) with no id. Watermarked on the
     job card, which is the half that rises; it cascades from job_cards anyway. */
  { table: 'job_card_people', key: 'job_card_id' },
  { table: 'job_cards' },

  /* ── Baskets and tables left open at the till. */
  { table: 'online_saved_baskets' },
  { table: 'pos_tables', note: 'a table opened in training, not the floor plan' },

  /* ── The trail. Last, so anything above that logs on delete has somewhere to
       write, and because it is the least harmful thing to leave if a later
       statement fails. */
  /* Composite (notification_id, user_id), watermarked on the notification. */
  { table: 'notification_reads', key: 'notification_id' },
  { table: 'notifications' },
  { table: 'activity_log' },
]

/* ── State ──────────────────────────────────────────────────────────────── */

/**
 * Where one numbering sequence stood when training began.
 *
 * Captured per (doc_type, terminal_id) because that pair is the primary key of
 * document_sequences — a till owns its own run, and restoring all of them to one
 * shared value would destroy per-till numbering. See rewindSequences.
 */
export type SequencePosition = {
  docType: string
  terminalId: number
  nextNumber: number
  lastIssued: number
}

export type TrainingSession = {
  id: number
  startedAt: Date
  startedName: string | null
  marks: Record<string, number>
  /** Empty on a session started before sequence capture existed. */
  sequences: SequencePosition[]
}

export type TrainingSummary = {
  active: boolean
  session: TrainingSession | null
  /** Rows created so far, by table, for the confirmation screen. Empty when off. */
  pending: { table: string; rows: number }[]
  pendingTotal: number
}

type Row = RowDataPacket & Record<string, unknown>

/**
 * Whether this site is training RIGHT NOW.
 *
 * Deliberately reads the session table and not `settings`, so there is exactly
 * one source of truth. A settings flag could disagree with an open session —
 * flag on with no session means nothing would be purged, session open with the
 * flag off means real trade is landing above a watermark that will delete it —
 * and both of those are silent. One table, one answer.
 *
 * Defensive like every other read of shop configuration: a site whose migration
 * has not run yet answers "not training" rather than throwing and taking the
 * till down with it.
 */
export async function isTrainingActive(siteId: number): Promise<boolean> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      'SELECT id FROM training_sessions WHERE ended_at IS NULL LIMIT 1',
    )
    return Boolean(row)
  } catch {
    return false
  }
}

/** The open session, or null. */
export async function currentSession(siteId: number): Promise<TrainingSession | null> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT id, started_at, started_name, marks
         FROM training_sessions WHERE ended_at IS NULL LIMIT 1`,
    )
    if (!row) return null
    const manifest = parseManifest(row.marks)
    return {
      id: Number(row.id),
      startedAt: new Date(String(row.started_at)),
      startedName: row.started_name === null ? null : String(row.started_name),
      marks: manifest.marks,
      sequences: manifest.sequences,
    }
  } catch {
    return null
  }
}

/**
 * The stored manifest, in either shape it can take.
 *
 * Written as `{ marks: {...}, sequences: [...] }`. A session recorded before
 * sequences were captured holds the bare `{table: id}` object instead, and is
 * read as marks with no sequences — so an open session written by an older
 * build still purges correctly, it just cannot rewind the numbering. Detecting
 * the shape rather than versioning it: the two are unambiguous, and a version
 * field is one more thing that can disagree with the data beside it.
 */
function parseManifest(raw: unknown): { marks: Record<string, number>; sequences: SequencePosition[] } {
  if (typeof raw !== 'string' || raw.trim() === '') return { marks: {}, sequences: [] }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { marks: {}, sequences: [] }
    }
    const obj = parsed as Record<string, unknown>
    if (obj.marks && typeof obj.marks === 'object') {
      return { marks: parseMarks(JSON.stringify(obj.marks)), sequences: parseSequences(obj.sequences) }
    }
    // The legacy shape: the object IS the marks.
    return { marks: parseMarks(raw), sequences: [] }
  } catch {
    return { marks: {}, sequences: [] }
  }
}

function parseSequences(raw: unknown): SequencePosition[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const { docType, terminalId, nextNumber, lastIssued } = item as Record<string, unknown>
    const t = Number(terminalId)
    const n = Number(nextNumber)
    const l = Number(lastIssued)
    if (typeof docType !== 'string' || !Number.isFinite(t) || !Number.isFinite(n) || !Number.isFinite(l)) {
      return []
    }
    return [{ docType, terminalId: t, nextNumber: n, lastIssued: l }]
  })
}

/**
 * Marks are JSON in a LONGTEXT, so a hand-edited or truncated value is possible.
 * An unreadable manifest reads as EMPTY, which makes the purge delete nothing —
 * the safe direction. The alternative default (no mark means no floor) would
 * delete the entire table.
 */
function parseMarks(raw: unknown): Record<string, number> {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(value)
      if (Number.isFinite(n)) out[key] = n
    }
    return out
  } catch {
    return {}
  }
}

/** The purge receipt: an array of {table, rows}. See recentSessions. */
function parseRemoved(raw: unknown): { table: string; rows: number }[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const { table, rows } = item as { table?: unknown; rows?: unknown }
      const n = Number(rows)
      if (typeof table !== 'string' || !Number.isFinite(n)) return []
      return [{ table, rows: n }]
    })
  } catch {
    return []
  }
}

/* ── Schema probing ─────────────────────────────────────────────────────── */

/**
 * Which of the registry tables this particular site actually has.
 *
 * Schema drifts between sites — a table in sql/site/ may be missing on a site
 * whose migrations are behind. Probing information_schema once and filtering is
 * what stops a purge from dying on the first absent table and stranding the
 * site in training with data it cannot remove.
 */
async function presentTables(siteId: number, tx?: PoolConnection): Promise<Set<string>> {
  // Probes for the (table, key column) PAIR, not just the table.
  //
  // The first version asked only whether the table existed and then compared on
  // `id`, which threw "Unknown column 'id'" the moment it met one of the half
  // dozen tables that key on something else — a 1:1 extension or a composite
  // junction. Probing the column too means a registry entry naming a column the
  // site does not have is SKIPPED rather than aborting the whole purge, which is
  // the same defence the missing-table case already had.
  const pairs = PURGE_TABLES.map((t) => [t.table, t.key ?? 'id'] as const)
  const placeholders = pairs.map(() => '(?,?)').join(',')
  const params = pairs.flatMap(([table, key]) => [table, key])
  const sql = `SELECT table_name AS t FROM information_schema.columns
                WHERE table_schema = DATABASE()
                  AND (table_name, column_name) IN (${placeholders})`
  const rows = tx
    ? ((await tx.execute(sql, params as never))[0] as Row[])
    : await siteQuery<Row>(siteId, sql, params)
  return new Set(rows.map((r) => String(r.t)))
}

/* ── Starting ───────────────────────────────────────────────────────────── */

export type StartResult = { ok: true; session: TrainingSession } | { ok: false; error: string }

/**
 * Switches training on, capturing the watermark.
 *
 * The whole thing is one transaction so that the marks and the session row are
 * written together. A session row with no marks would purge nothing; marks with
 * no session row would never be read. Neither half is useful alone.
 *
 * MAX(id) is read per table rather than from information_schema.AUTO_INCREMENT
 * because the latter is cached and can be stale on InnoDB — it has been known to
 * report a value below the true maximum after a restart, which would put the
 * watermark UNDER existing rows and mark real history for deletion. MAX(id) is a
 * fact; AUTO_INCREMENT is an estimate.
 *
 * COALESCE(MAX(id), 0) — an empty table marks at zero, so everything a training
 * session puts in it is above the mark and gets removed.
 */
/**
 * Refuses training mode where its cleanup cannot reach the rows it would make.
 *
 * ── WHY A SHARED MASTER FILE BREAKS THE WHOLE SCHEME ──────────────────────
 *
 * Either file does it — customers or suppliers — and the argument below is
 * written about customers because that is the one that shipped first. The
 * creditors side fails identically and carries one extra hazard; see the note
 * inside the function.
 *
 * Training is built on high-water marks: startTraining records MAX(id) for each
 * table in THIS database, and stopTraining deletes everything above the mark.
 * That is exact, cheap and impossible to get wrong by a row — as long as every
 * row a training sale writes lands in the database the marks were taken from.
 *
 * A shared customer file breaks the premise rather than bending it. An account
 * sale at a branch posts its debtor row into the GROUP PRIMARY's
 * customer_transactions, and the same for customer_allocations, loyalty_ledger
 * and loyalty_wallet. The branch's own copies of those tables are EMPTY — an
 * emptiness that sharing guarantees, since a store may only join the group's
 * file while its own is empty.
 *
 * So the marks are all zero, stopTraining deletes nothing, rebuildLedgerBalances
 * rewrites balances in the branch that nothing has moved, and the screen reports
 * the practice data as removed. Meanwhile R12,000 of pretend invoices sit in
 * head office's REAL debtors book, on a real customer's statement, in the age
 * analysis, and in every credit check made anywhere in the group. Nothing in
 * this module can find them again: they are above no mark it holds.
 *
 * ── WHY REFUSED RATHER THAN EXTENDED ──────────────────────────────────────
 *
 * Marking and purging the owner's tables too is the obvious repair and it is
 * the wrong one. The mark would have to be taken across two databases and the
 * purge run in two transactions, so a crash between them leaves training rows
 * in a live shared book with the session already closed. Worse, the owner's
 * tables are receiving REAL rows from every other branch at the same time; a
 * delete above a mark there would take live sales made by other shops while
 * this one was practising.
 *
 * A branch that wants to practise can leave the group's customer file, or
 * practise on cash sales — which stay local and are covered by the marks as
 * they always were. Neither is as convenient as training mode, and both are
 * better than silently writing into another store's books.
 *
 * Never throws: a control-database problem must not block training on a shop
 * that is not sharing at all. Failing open is the same answer the site gave
 * before sharing existed.
 */
async function sharedMasterFileRefusal(siteId: number): Promise<string | null> {
  try {
    const { customerFileIsShared, supplierFileIsShared } = await import('../storeGroups')

    /*
     * ── THE SUPPLIER SIDE FAILS THE SAME WAY, AND ONE STATEMENT WORSE ─────
     *
     * PURGE_TABLES carries supplier_allocations and supplier_transactions, and
     * the marks for them are taken against the CALLER's database. With the
     * creditors book shared, a training GRV posts its supplier invoice to the
     * OWNER while the marks were read from the branch's own empty tables — so
     * stopTraining deletes nothing and a pretend invoice sits in the group's
     * real creditors book, on a real supplier's statement, in the age analysis
     * and in the next payment run.
     *
     * And rebuildLedgerBalances runs
     *
     *     UPDATE suppliers SET balance = (SELECT SUM(amount_signed) ...)
     *
     * Today that is a harmless no-op against the branch's empty tables. The
     * moment somebody "fixes" this file by pointing its supplier statements at
     * the owner, that one statement would rebuild EVERY supplier balance in the
     * group from a branch's empty ledger — zeroing the whole creditors book.
     * The refusal has to land before that conversion, not after.
     */
    const customers = await customerFileIsShared(siteId)
    const suppliers = await supplierFileIsShared(siteId)
    if (!customers && !suppliers) return null

    const which = customers && suppliers ? 'customer and supplier files' : customers ? 'customer file' : 'supplier file'
    const what = customers && suppliers
      ? 'Practice sales made on account, and practice purchases, would be written into the group’s real ledgers'
      : customers
        ? 'Practice sales made on account would be written into the group’s real customer ledger'
        : 'Practice purchases and supplier invoices would be written into the group’s real creditors book'

    return (
      `This store shares its ${which} with the rest of the group, and training ` +
      `mode cannot be used while it does. ${what}, and switching training off ` +
      'could not remove them. Cash sales are unaffected.'
    )
  } catch {
    // A control-database problem must not block training on a shop that is not
    // sharing at all. Failing open is what the site did before sharing existed.
    return null
  }
}

export async function startTraining(
  siteId: number,
  actor: { userId: number; userName: string },
): Promise<StartResult> {
  const sharedRefusal = await sharedMasterFileRefusal(siteId)
  if (sharedRefusal) return { ok: false, error: sharedRefusal }

  try {
    return await siteTransaction<StartResult>(siteId, async (tx) => {
      // Re-check inside the transaction. Two managers pressing the switch at the
      // same moment would otherwise both capture marks, and the second set --
      // taken after the first session had started -- would be too high, leaving
      // the first session's rows behind forever. The unique index is the real
      // guard; this turns the collision into a sentence instead of an error.
      const [openRows] = await tx.execute(
        'SELECT id FROM training_sessions WHERE ended_at IS NULL LIMIT 1',
      )
      if ((openRows as Row[]).length > 0) {
        return { ok: false, error: 'Training mode is already switched on for this store.' }
      }

      const present = await presentTables(siteId, tx)
      const marks: Record<string, number> = {}

      for (const entry of PURGE_TABLES) {
        if (!present.has(entry.table)) continue
        const key = entry.key ?? 'id'
        const [rows] = await tx.execute(
          `SELECT COALESCE(MAX(\`${key}\`), 0) AS m FROM \`${entry.table}\``,
        )
        marks[entry.table] = Number((rows as Row[])[0]?.m ?? 0)
      }

      // Where every numbering sequence stands, per till, so it can be put back
      // EXACTLY rather than inferred from surviving documents. See
      // rewindSequences for what went wrong when this was inferred.
      const [seqRows] = await tx.execute(
        `SELECT doc_type, terminal_id, next_number, last_issued_number
           FROM document_sequences`,
      )
      const sequences: SequencePosition[] = (seqRows as Row[]).map((r) => ({
        docType: String(r.doc_type),
        terminalId: Number(r.terminal_id),
        nextNumber: Number(r.next_number),
        lastIssued: Number(r.last_issued_number ?? 0),
      }))

      const [res] = await tx.execute(
        `INSERT INTO training_sessions (marks, started_by, started_name)
         VALUES (?,?,?)`,
        [
          JSON.stringify({ marks, sequences }),
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      const id = (res as { insertId: number }).insertId

      const [back] = await tx.execute(
        'SELECT started_at FROM training_sessions WHERE id = ?',
        [id] as never,
      )
      const startedAt = new Date(String((back as Row[])[0]?.started_at))

      return {
        ok: true,
        session: { id, startedAt, startedName: actor.userName, marks, sequences },
      }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The unique index firing means somebody else won the race between our check
    // and our insert. That is not an error worth showing as one.
    if (/uq_training_open|Duplicate entry/i.test(message)) {
      return { ok: false, error: 'Training mode is already switched on for this store.' }
    }
    if (/training_sessions.*doesn't exist|Unknown table/i.test(message)) {
      return {
        ok: false,
        error: 'Training mode is not installed on this store yet. Run the site migrations first.',
      }
    }
    return { ok: false, error: `Could not switch training mode on: ${message}` }
  }
}

/* ── Counting, before deleting ──────────────────────────────────────────── */

/**
 * What a purge WOULD remove, without removing it.
 *
 * The screen shows this before asking anyone to confirm. Deleting is not
 * undoable, so the number has to be visible first — "this will remove 47 sales,
 * 130 stock movements and 94 journal lines" is a sentence somebody can check
 * against what they remember doing.
 */
export async function pendingCounts(
  siteId: number,
  marks: Record<string, number>,
): Promise<{ table: string; rows: number }[]> {
  const present = await presentTables(siteId)
  const out: { table: string; rows: number }[] = []

  for (const entry of PURGE_TABLES) {
    if (!present.has(entry.table)) continue
    const mark = marks[entry.table]
    // No mark means the table was not captured -- it did not exist when training
    // started. Treated as "nothing to remove" rather than "remove everything",
    // for the reason parseMarks gives.
    if (mark === undefined) continue
    const key = entry.key ?? 'id'
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS c FROM \`${entry.table}\` WHERE \`${key}\` > ?`,
      [mark],
    )
    const rows = Number(row?.c ?? 0)
    if (rows > 0) out.push({ table: entry.table, rows })
  }

  return out
}

/** Everything the screen needs, in one call. */
export async function trainingSummary(siteId: number): Promise<TrainingSummary> {
  const session = await currentSession(siteId)
  if (!session) return { active: false, session: null, pending: [], pendingTotal: 0 }

  let pending: { table: string; rows: number }[] = []
  try {
    pending = await pendingCounts(siteId, session.marks)
  } catch {
    // A count that fails must not hide the fact that training is ON. The switch
    // is the important half of this screen.
    pending = []
  }

  return {
    active: true,
    session,
    pending,
    pendingTotal: pending.reduce((sum, p) => sum + p.rows, 0),
  }
}

/* ── Stopping ───────────────────────────────────────────────────────────── */

export type StopResult =
  | {
      ok: true
      removed: { table: string; rows: number }[]
      removedTotal: number
      /**
       * Set when the purge could not have reached everything the session wrote.
       *
       * startTraining refuses a store that shares its customer file, but sharing
       * can be switched on DURING a session — so a purge can run against a
       * store whose debtor rows went to the group primary, above no mark this
       * database holds. There is nothing safe to do about it here (see
       * sharedMasterFileRefusal), so the screen must say so rather than
       * report a clean removal.
       */
      warning?: string
    }
  | { ok: false; error: string }

/**
 * Switches training off and removes everything done during it.
 *
 * ── ONE TRANSACTION, NO EXCEPTIONS ───────────────────────────────────────
 *
 * Every DELETE and the session close commit together or not at all. A partial
 * purge is the one outcome that must be impossible: it would leave a sale whose
 * lines are gone, a journal batch with no lines, stock levels rewound against
 * movements that still exist. Those are unreconcilable by hand. Rolling back and
 * leaving the site IN training is recoverable — somebody presses the switch
 * again.
 *
 * FOREIGN_KEY_CHECKS is deliberately NOT disabled. The ordering in PURGE_TABLES
 * is meant to satisfy every constraint on the way through, and a constraint that
 * fires is telling us the registry is wrong — a child table that training writes
 * to and this list has never heard of. Switching the checks off would convert
 * that signal into a site with orphaned rows in it.
 */
export async function stopTraining(
  siteId: number,
  actor: { userId: number; userName: string },
): Promise<StopResult> {
  const session = await currentSession(siteId)
  if (!session) return { ok: false, error: 'Training mode is not switched on for this store.' }

  // Read BEFORE the purge, not after: this decides what the result may claim.
  // A session started when the store owned its own customers can still end
  // while it shares them — somebody switches sharing on mid-session — and then
  // the debtor rows this purge is about to look for are in another database,
  // above no mark it holds. Stopping is still the right thing to do; saying
  // "removed" without qualification is not.
  const sharedDuringSession = await sharedMasterFileRefusal(siteId)

  try {
    return await siteTransaction<StopResult>(siteId, async (tx) => {
      const present = await presentTables(siteId, tx)
      const removed: { table: string; rows: number }[] = []

      for (const entry of PURGE_TABLES) {
        if (!present.has(entry.table)) continue
        const mark = session.marks[entry.table]
        if (mark === undefined) continue
        const key = entry.key ?? 'id'
        const [res] = await tx.execute(
          `DELETE FROM \`${entry.table}\` WHERE \`${key}\` > ?`,
          [mark] as never,
        )
        const rows = (res as { affectedRows: number }).affectedRows
        if (rows > 0) removed.push({ table: entry.table, rows })
      }

      // ── THE DENORMALISED TOTALS ────────────────────────────────────────
      //
      // Some figures are not rows and therefore survive a DELETE untouched:
      // products.stock_on_hand, product_location_stock.stock_on_hand,
      // customers.balance and suppliers.balance are running totals maintained by
      // the posting paths, not sums computed on read. Removing the movements and
      // transactions beneath them does not move them at all, so without this the
      // shop leaves training with stock levels and account balances that its own
      // ledger no longer explains -- and reconcileStock/reconcileBalances would
      // report drift on a store that had done nothing wrong.
      //
      // Every one is REBUILT from what survives rather than adjusted by what was
      // removed. A recomputation cannot drift; an adjustment accumulates error
      // every time it is slightly wrong.
      await rebuildStockLevels(tx)
      await rebuildLedgerBalances(tx)

      // Sequences are rewound so training does not eat invoice numbers. Safe
      // ONLY because training is site-wide -- no real document can have been
      // numbered in between. See rewindSequences.
      await rewindSequences(tx, session.sequences)

      const removedTotal = removed.reduce((sum, r) => sum + r.rows, 0)

      // Closing the session is the LAST statement. Until it commits the site is
      // still in training, which is the state a crash should leave behind.
      await tx.execute(
        `UPDATE training_sessions
            SET ended_at = NOW(), ended_by = ?, ended_name = ?, removed = ?
          WHERE id = ? AND ended_at IS NULL`,
        [actor.userId, actor.userName.slice(0, 120), JSON.stringify(removed), session.id] as never,
      )

      return {
        ok: true,
        removed,
        removedTotal,
        ...(sharedDuringSession
          ? {
              warning:
                'This store now shares its customer file with the group. Any account ' +
                'sales, loyalty points or wallet movements made during training were ' +
                'written to the group’s customer ledger and could NOT be removed from ' +
                'here — check them at the store that holds the customer file.',
            }
          : {}),
      }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/foreign key|constraint fails/i.test(message)) {
      return {
        ok: false,
        error:
          'Some training data could not be removed because other records point at it. ' +
          'Nothing was deleted and the store is still in training mode. ' +
          `Please send this to support: ${message}`,
      }
    }
    return {
      ok: false,
      error:
        `Could not remove the training data: ${message}. ` +
        'Nothing was deleted and the store is still in training mode.',
    }
  }
}

/**
 * Rebuilds the two denormalised stock figures from the movement ledger.
 *
 * Only products that MOVED are touched — a full-catalogue rebuild would rewrite
 * every product row on every exit from training, and on a site whose ledger
 * predates a correction that would quietly restate stock nobody asked about.
 * The candidate set is products whose location piles exist; the site total is
 * then the sum of its piles, which is invariant (C) in stockMovements.ts.
 *
 * Runs after the DELETEs and inside the same transaction, so it sees exactly the
 * movements that survive.
 */
async function rebuildStockLevels(tx: PoolConnection): Promise<void> {
  // The pile: Σ qty_change per (product, location) over what is left.
  await tx.execute(
    `UPDATE product_location_stock pls
        SET pls.stock_on_hand = COALESCE((
              SELECT SUM(sm.qty_change) FROM stock_movements sm
               WHERE sm.product_id = pls.product_id
                 AND sm.location_id = pls.location_id
            ), 0)`,
  )

  // The site total: Σ piles per product. Read from the piles just rebuilt rather
  // than from the movements again, so (A) and (C) cannot disagree.
  await tx.execute(
    `UPDATE products p
        SET p.stock_on_hand = COALESCE((
              SELECT SUM(pls.stock_on_hand) FROM product_location_stock pls
               WHERE pls.product_id = p.id
            ), 0)
      WHERE p.product_type <> 'parent'`,
  )
}

/**
 * Rebuilds customer and supplier balances from their subledgers.
 *
 * The invariant both ledgers state: `balance` always equals SUM(amount_signed)
 * over that party's transactions. Deleting a training sale removes the
 * transaction and leaves the balance, so a practice customer would be left owing
 * money for an invoice that no longer exists — which is exactly what
 * reconcileBalances found the first time this test ran without it.
 *
 * Restricted to parties that HAVE transactions, plus any left at a non-zero
 * balance with none — the second half is what catches the customer whose only
 * ever transaction was the training sale just removed. A blanket rebuild of
 * every party on every exit would rewrite rows that training never touched.
 */
async function rebuildLedgerBalances(tx: PoolConnection): Promise<void> {
  await tx.execute(
    `UPDATE customers c
        SET c.balance = COALESCE((
              SELECT SUM(ct.amount_signed) FROM customer_transactions ct
               WHERE ct.customer_id = c.id
            ), 0)
      WHERE c.balance <> 0
         OR EXISTS (SELECT 1 FROM customer_transactions ct WHERE ct.customer_id = c.id)`,
  )

  await tx.execute(
    `UPDATE suppliers s
        SET s.balance = COALESCE((
              SELECT SUM(st.amount_signed) FROM supplier_transactions st
               WHERE st.supplier_id = s.id
            ), 0)
      WHERE s.balance <> 0
         OR EXISTS (SELECT 1 FROM supplier_transactions st WHERE st.supplier_id = s.id)`,
  )
}

/**
 * Puts the document numbers back, from the positions recorded at entry.
 *
 * A training session that rings up forty sales advances the invoice sequence by
 * forty. Without this, the shop leaves training and its next real invoice is
 * INV-0041 with nothing behind it — a permanent, unexplainable gap in a run that
 * sequences.ts promises is gapless, and the first thing an auditor asks about.
 *
 * ── WHY THE POSITIONS ARE CAPTURED, NOT DERIVED ──────────────────────────
 *
 * The first version of this computed where each sequence "should" be from
 * MAX(the numeric tail of document_number) over the surviving documents. That is
 * wrong twice over, and the test caught it:
 *
 *   1. It ignores the PREFIX. A stray document numbered TSTDUP70180404 — test
 *      litter, not an invoice — matched the digits-at-the-end pattern and drove
 *      every invoice sequence to 70,180,405.
 *   2. It ignores terminal_id. Each till owns its own row and its own run; one
 *      MAX over the whole table cannot restore 89 independent positions, and
 *      writing the same value to all of them destroys per-till numbering.
 *
 * So the positions are recorded at entry, exactly as they were, and written back
 * verbatim. A restore cannot be cleverer than a copy, and here it must not try:
 * the value being restored is the value that was there.
 *
 * ── WHY REWINDING IS SAFE HERE AND NOWHERE ELSE ──────────────────────────
 *
 * Moving a sequence backwards is normally dangerous: if any real document took a
 * number in the range being reclaimed, the next issue collides with it. That
 * cannot happen here, because training is site-wide — no real document was
 * created between the mark and now, on any till. This is the single strongest
 * reason the feature is not per-terminal.
 */
async function rewindSequences(tx: PoolConnection, positions: SequencePosition[]): Promise<void> {
  for (const pos of positions) {
    // Guarded on the CURRENT value being at or above the recorded one. A
    // sequence somebody deliberately advanced during training -- or one already
    // below its mark -- is left alone rather than dragged backwards past a
    // number that may since have been issued.
    await tx.execute(
      `UPDATE document_sequences
          SET next_number = ?, last_issued_number = ?
        WHERE doc_type = ? AND terminal_id = ? AND next_number >= ?`,
      [pos.nextNumber, pos.lastIssued, pos.docType, pos.terminalId, pos.nextNumber] as never,
    )
  }
}

/** The log of past sessions, newest first, for the screen. */
export async function recentSessions(
  siteId: number,
  limit = 20,
): Promise<
  {
    id: number
    startedAt: Date
    endedAt: Date | null
    startedName: string | null
    endedName: string | null
    removedTotal: number
  }[]
> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, started_at, ended_at, started_name, ended_name, removed
         FROM training_sessions
        ORDER BY started_at DESC
        LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}`,
    )
    return rows.map((row) => {
      // `removed` is written as an ARRAY of {table, rows} -- not the object
      // shape `marks` uses -- so it gets its own reader. Same defensive rule:
      // unreadable reads as "nothing recorded" rather than throwing and hiding
      // the whole session log.
      const removed = parseRemoved(row.removed)
      return {
        id: Number(row.id),
        startedAt: new Date(String(row.started_at)),
        endedAt: row.ended_at === null ? null : new Date(String(row.ended_at)),
        startedName: row.started_name === null ? null : String(row.started_name),
        endedName: row.ended_name === null ? null : String(row.ended_name),
        removedTotal: removed.reduce((sum, r) => sum + r.rows, 0),
      }
    })
  } catch {
    return []
  }
}
