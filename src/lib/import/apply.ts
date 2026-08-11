import 'server-only'
import type {
  ApplyContext, ExistingMode, ImportSpec, RowOutcome,
} from './spec'

/**
 * Writing one batch of rows.
 *
 * ── ONE ROW AT A TIME, AND NOT ONE TRANSACTION ───────────────────────────
 *
 * Two hundred rows in a single transaction means one bad row rolls back a
 * hundred and ninety-nine good ones, and the operator is left with a file of
 * 20,000 and no idea which part of it landed. `applyOpeningBalances` made this
 * call already and it is the right one: each row succeeds or fails on its own
 * and comes back named.
 *
 * ── SEQUENTIAL, NEVER PARALLEL ───────────────────────────────────────────
 *
 * Two rows creating the same department race: `nameClash` is a read-then-write
 * with no unique key behind it, so both would read "not there" and both would
 * insert. Sequential also keeps the progress meter honest and the resume point
 * unambiguous, which matters more than the wall-clock time saved — a 20k import
 * is bounded by the database, not by how many promises are in flight.
 */

export type BatchRequest = {
  entity: string
  mode: ExistingMode
  /** Where in the file this chunk starts, 0-based. Echoed back. */
  offset: number
  rows: { line: number; code: string; draft: Record<string, unknown> }[]
  /** Which draft keys the FILE mapped. Drives every merge. */
  mapped: string[]
  /** The whole-file date format, decided at plan time and shown to the user. */
  dateFormat: string | null
}

export type BatchResponse =
  | { ok: true; offset: number; outcomes: RowOutcome[] }
  | { ok: false; offset: number; error: string }

export async function applyBatch<T>(
  spec: ImportSpec<T>,
  ctx: ApplyContext,
  request: BatchRequest,
): Promise<RowOutcome[]> {
  if (!spec.applyRow) {
    throw new Error(`${spec.title} is read into a screen, not written directly.`)
  }

  const outcomes: RowOutcome[] = []

  for (const row of request.rows) {
    // Re-resolved HERE, not trusted from the request. The browser has held
    // these rows across a review step, and a code created by an earlier batch
    // of this same run — or by somebody else entirely — has to be seen now
    // rather than at plan time. This is what stands in for openingBalances'
    // whole-file re-plan, which chunking cannot do.
    const key = row.code.trim().toUpperCase()
    const existingId = key ? (ctx.lookups.existingIdByCode.get(key) ?? null) : null

    try {
      const outcome = await spec.applyRow(ctx, row.draft, existingId, request.mode)
      outcomes.push({ ...outcome, line: row.line, code: row.code || outcome.code })

      // A row that created a record puts its code in the map, so a duplicate
      // later in the same run is seen as existing rather than colliding on the
      // unique index with an error nobody can act on.
      if (outcome.status === 'created' && outcome.id && key) {
        ctx.lookups.existingIdByCode.set(key, outcome.id)
      }
    } catch (error) {
      // One row throwing is a row problem, not a batch problem. The batch only
      // fails as a whole when the infrastructure does.
      outcomes.push({
        line: row.line,
        code: row.code,
        status: 'failed',
        reason: error instanceof Error ? error.message : 'Something went wrong writing this row.',
      })
    }
  }

  return outcomes
}

export { BATCH_SIZE, emptyTotals, fold, type RunTotals } from './totals'
