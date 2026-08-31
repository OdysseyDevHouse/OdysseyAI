import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteTransaction } from '../siteDb'
import { getSettings, setSetting } from './settings'
import { currencyFor, symbolFor, type CurrencySpec } from '../currencies'

/**
 * The money this shop counts, and which currency it is.
 *
 * ── WHY THIS IS NOT IN cashupDeclaration.ts ─────────────────────────────────
 *
 * That file is about COUNTING a drawer — the expected figures, the blind-count
 * rule, the arithmetic a declaration has to reconcile against. This is about
 * what the rows in the grid ARE, which is a setup question asked once when a
 * shop opens and almost never again. `listDenominations` stays where it is,
 * because the count reads it; everything that WRITES is here.
 *
 * ── REPLACING A SET IS ONE ACT ──────────────────────────────────────────────
 *
 * Switching from rand to Canadian dollars is not eleven edits — it is one
 * decision, and it must not be possible to observe it half-done. A shop left
 * with six ZAR rows and four CAD rows has a grid that reconciles to nothing,
 * and the cash-up is the screen where that matters most. So the swap runs in a
 * transaction and the currency setting moves with it.
 *
 * ── WHAT IS NEVER DELETED ───────────────────────────────────────────────────
 *
 * A denomination that has been COUNTED. `shift_count_denominations` keeps its
 * own label and value per row — see 168, which copied them deliberately — so a
 * historical count still reads correctly whatever happens here. But the id is
 * still referenced, and a delete would break the join that shows a past
 * declaration's grid. Rows that have been used are DEACTIVATED instead, which
 * takes them off the counting screen and leaves history intact.
 */

type Row = RowDataPacket & Record<string, unknown>

export type SaveResult = { ok: true } | { ok: false; error: string }

/** What this shop trades in, and whether its grid agrees. */
export type CurrencyState = {
  /** ISO 4217, from `settings.currency_code`. */
  code: string
  /** What prints against a number. */
  symbol: string
  /** The known set for that code, or null for one this build does not carry. */
  spec: CurrencySpec | null
  /**
   * The currency the DENOMINATION ROWS are actually in.
   *
   * Usually the same as `code`, and the interesting case is when it is not: a
   * shop that changed its currency and has not yet replaced its grid. The
   * screen has to be able to see that rather than assume it — which is why 240
   * put `currency_code` on the row as well as in settings.
   */
  denominationCode: string | null
  /** Whether the grid needs replacing to match the currency. */
  mismatched: boolean
}

/**
 * What currency this shop is on, and whether its denominations match.
 *
 * `denominationCode` is read from the rows themselves rather than assumed. A
 * site mid-switch genuinely has two answers, and the honest thing is to report
 * both — the setup screen turns that into "your grid is still in rand".
 */
export async function currencyState(siteId: number): Promise<CurrencyState> {
  const [settings, rows] = await Promise.all([
    getSettings(siteId, ['currency_code', 'currency_symbol']),
    /*
     * ── ACTIVE ROWS ONLY, AND THAT IS THE WHOLE SUBTLETY ────────────────────
     *
     * A shop that has ever switched currency keeps its RETIRED rows — a
     * denomination somebody counted cannot be deleted without breaking the join
     * that renders that declaration (see switchCurrency). Those rows keep their
     * own old currency code for ever, by design.
     *
     * So the table legitimately holds two codes after any switch, and asking it
     * "which currency are you?" without this filter answers "two" and reports a
     * mismatch on a shop that is in perfectly good order. Found by
     * test-cash-denominations, which switches with a counted row on file.
     *
     * The question this is really asking is "what would a cashier be counting
     * into", and that is the ACTIVE grid.
     */
    siteQuery<Row>(
      siteId,
      'SELECT DISTINCT currency_code FROM cash_denominations WHERE is_active = 1',
    ).catch(() => [] as Row[]),
  ])

  const code = (settings.currency_code || 'ZAR').toUpperCase()

  /*
   * More than one currency in the table means a previous switch was interrupted
   * — which the transaction below should make impossible, but a database can be
   * edited by hand. Reported as a mismatch so the screen offers to fix it,
   * rather than picking one of the two and pretending.
   */
  const codes = [...new Set(rows.map((r) => String(r.currency_code || 'ZAR').toUpperCase()))]
  const denominationCode = codes.length === 1 ? codes[0] : (codes[0] ?? null)

  return {
    code,
    /* The stored symbol wins over the spec's: a shop may legitimately prefer
       "R" to "ZAR", or write "US$" where the table says "$". */
    symbol: settings.currency_symbol || symbolFor(code),
    spec: currencyFor(code),
    denominationCode,
    mismatched: codes.length > 1 || (denominationCode !== null && denominationCode !== code),
  }
}

/**
 * Switch the shop to a currency, and replace its denomination grid.
 *
 * ── WHY THE OLD ROWS ARE NOT SIMPLY DELETED ─────────────────────────────────
 *
 * Because some of them have been counted, and `shift_count_denominations`
 * points at their ids. Deleting those would break every past declaration's
 * grid — the figures survive (168 copies label and value onto the count row)
 * but the join that renders one would find nothing.
 *
 * So: rows never counted are deleted, rows that have been counted are
 * deactivated. Both disappear from the counting screen, which is what the shop
 * asked for, and history keeps working.
 *
 * ── AND WHY THE WHOLE THING IS ONE TRANSACTION ──────────────────────────────
 *
 * A half-switched grid reconciles to nothing. If the insert fails after the old
 * rows are gone, a cashier opens the cash-up to an empty table and cannot count
 * the drawer at all — on the screen where being unable to work is most
 * expensive. Either the shop is fully on the new currency or fully on the old.
 */
export async function switchCurrency(siteId: number, code: string): Promise<SaveResult> {
  const spec = currencyFor(code)
  if (!spec) {
    return { ok: false, error: `${code} is not a currency this system knows.` }
  }

  try {
    await siteTransaction(siteId, async (tx) => {
      /* Which existing rows a count has ever used. Those are the ones that must
         survive as history. */
      const [usedRows] = await tx.query<Row[]>(
        `SELECT DISTINCT denomination_id AS id FROM shift_count_denominations`,
      )
      const used = new Set(usedRows.map((r) => Number(r.id)))

      const [existing] = await tx.query<Row[]>('SELECT id FROM cash_denominations')

      const toDelete = existing.map((r) => Number(r.id)).filter((id) => !used.has(id))
      const toRetire = existing.map((r) => Number(r.id)).filter((id) => used.has(id))

      if (toDelete.length > 0) {
        await tx.execute(
          `DELETE FROM cash_denominations WHERE id IN (${toDelete.map(() => '?').join(',')})`,
          toDelete,
        )
      }
      if (toRetire.length > 0) {
        /*
         * Deactivated AND moved out of the way. The value stays as it was —
         * changing it would rewrite what a past count meant — so a retired
         * R50 and a new $50 would collide on uq_denom_currency_value unless
         * the old row's currency still says ZAR. It does: only the new rows
         * carry the new code.
         */
        await tx.execute(
          `UPDATE cash_denominations SET is_active = 0
            WHERE id IN (${toRetire.map(() => '?').join(',')})`,
          toRetire,
        )
      }

      /* Position in tens, largest first, matching how 168 seeded the rand set —
         it leaves room to insert a row between two without renumbering. */
      let position = 10
      for (const d of spec.denominations) {
        await tx.execute(
          `INSERT INTO cash_denominations (label, value, currency_code, is_note, position, is_active)
           VALUES (?,?,?,?,?,1)
           ON DUPLICATE KEY UPDATE
             label = VALUES(label),
             is_note = VALUES(is_note),
             position = VALUES(position),
             is_active = 1`,
          [d.label, d.value.toFixed(4), spec.code, d.isNote ? 1 : 0, position],
        )
        position += 10
      }
    })
  } catch (err) {
    console.error('[cashDenominations] could not switch currency', err)
    return {
      ok: false,
      error: 'The denominations could not be changed. Nothing was altered — try again.',
    }
  }

  /*
   * The settings AFTER the grid, and outside the transaction.
   *
   * They are in the same database, so they could join it — but the ordering
   * matters more than the atomicity: if the grid succeeded and this fails, the
   * shop has the right rows and a stale code, which `currencyState` reports as
   * a mismatch and the screen offers to fix. The other order would leave a
   * shop claiming to be Canadian with a grid full of rand and nothing saying so.
   */
  await setSetting(siteId, 'currency_code', spec.code)
  await setSetting(siteId, 'currency_symbol', spec.symbol)

  return { ok: true }
}

/**
 * Turn one denomination on or off.
 *
 * The tick 168 argued for: a country demonetises a coin, or a shop never sees
 * the 5c, and that should be a checkbox rather than a support call. Never a
 * delete — see the header.
 */
export async function setDenominationActive(
  siteId: number,
  id: number,
  active: boolean,
): Promise<SaveResult> {
  await siteQuery(siteId, 'UPDATE cash_denominations SET is_active = ? WHERE id = ?', [
    active ? 1 : 0,
    id,
  ])
  return { ok: true }
}

/**
 * Add a denomination the shipped set does not carry.
 *
 * For the shop whose currency this build does not know, and for the odd note a
 * set misses. Refused rather than silently merged when the value already
 * exists: two rows worth 50.00 would double every count that used both, and the
 * total would still look plausible — the exact failure the UNIQUE key exists to
 * prevent, reported in words rather than as a database error.
 */
export async function addDenomination(
  siteId: number,
  input: { label: string; value: number; isNote: boolean },
): Promise<SaveResult> {
  const label = input.label.trim()
  if (!label) return { ok: false, error: 'Give the denomination a name — "R50", "$20".' }
  if (label.length > 24) return { ok: false, error: 'That name is too long — 24 characters at most.' }
  if (!Number.isFinite(input.value) || input.value <= 0) {
    return { ok: false, error: 'A denomination must be worth more than nothing.' }
  }

  const { code } = await currencyState(siteId)

  const existing = await siteQuery<Row>(
    siteId,
    'SELECT id, label FROM cash_denominations WHERE currency_code = ? AND value = ? LIMIT 1',
    [code, input.value.toFixed(4)],
  )
  if (existing.length > 0) {
    return {
      ok: false,
      error: `${String(existing[0].label)} is already worth that much. Two rows of the same value would double every count.`,
    }
  }

  /* Sorted into place by value rather than appended: the grid is counted
     largest-first, and a new row at the bottom would be counted out of order. */
  const above = await siteQuery<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM cash_denominations
      WHERE currency_code = ? AND value > ?`,
    [code, input.value.toFixed(4)],
  )
  const position = (Number(above[0]?.n ?? 0) + 1) * 10

  await siteQuery(
    siteId,
    `INSERT INTO cash_denominations (label, value, currency_code, is_note, position, is_active)
     VALUES (?,?,?,?,?,1)`,
    [label, input.value.toFixed(4), code, input.isNote ? 1 : 0, position],
  )
  return { ok: true }
}
