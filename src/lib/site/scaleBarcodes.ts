import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import type { ScaleBarcodeRule } from '../barcodes'

/**
 * The scale barcode shapes a shop can read.
 *
 * ── WHY THERE IS MORE THAN ONE ────────────────────────────────────────────
 *
 * A shop floor is not one scale. A grocer runs several, replaces one, or takes
 * deliveries pre-labelled by a supplier whose machine prints a different prefix
 * and a different PLU length. With a single stored shape the shop has to pick
 * which of its scales works; everything off the other one scans as an unknown
 * barcode, with no price and nothing on screen saying why.
 *
 * The columns are the legacy system's, on purpose — see
 * sql/site/249_scale_barcode_rules.sql. `pluLength` is its STOCK CODE column.
 */

export type ScaleRule = ScaleBarcodeRule & {
  id: number
  position: number
  isActive: boolean
}

type Row = RowDataPacket & {
  id: number
  prefix: string
  plu_length: number
  has_check_digit: number
  value_length: number
  decimals: number
  position: number
  is_active: number
}

function toRule(r: Row): ScaleRule {
  return {
    id: r.id,
    prefix: String(r.prefix),
    pluLength: Number(r.plu_length),
    hasCheckDigit: !!r.has_check_digit,
    valueLength: Number(r.value_length),
    decimals: Number(r.decimals),
    position: Number(r.position),
    isActive: !!r.is_active,
  }
}

/**
 * Every rule, in the shop's own order.
 *
 * `position` orders them, which is what `rulesByPrecedence` then keeps as the
 * tie-break between two prefixes of the same length. Ordering here rather than
 * leaving it to the database's natural order is what makes an ambiguous pair
 * resolve the same way on every till.
 */
export async function listScaleRules(siteId: number): Promise<ScaleRule[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, prefix, plu_length, has_check_digit, value_length, decimals, position, is_active
       FROM scale_barcode_rules
      ORDER BY position, id`,
  )
  return rows.map(toRule)
}

/**
 * The rules a TILL should read with — active ones only.
 *
 * Separate from `listScaleRules` because the setup screen must show a paused
 * rule and the scanner must not use one. Folding the filter into the caller
 * would put the same `.filter()` in the online path, the offline path and the
 * catalog endpoint, where one of the three would eventually be forgotten.
 */
export async function activeScaleRules(siteId: number): Promise<ScaleBarcodeRule[]> {
  const all = await listScaleRules(siteId)
  return all.filter((r) => r.isActive)
}

export type ScaleRuleInput = {
  prefix: string
  pluLength: number
  hasCheckDigit: boolean
  valueLength: number
  decimals: number
  isActive?: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * What a rule may say.
 *
 * The bounds are not arbitrary. A prefix longer than four digits starts eating
 * the PLU; a PLU outside 3–7 digits is not a shape any scale prints; and
 * decimals above 3 would read a price as a thousandth of what it is. Each of
 * those is a silent MISPRICE rather than an error, which is why they are
 * refused at the edge rather than clamped quietly.
 */
export function validateScaleRule(input: ScaleRuleInput): string | null {
  if (!/^\d{1,4}$/.test(input.prefix.trim())) {
    return 'The prefix must be one to four digits.'
  }
  if (!Number.isInteger(input.pluLength) || input.pluLength < 3 || input.pluLength > 7) {
    return 'The stock code length must be between 3 and 7 digits.'
  }
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 3) {
    return 'Decimals must be between 0 and 3.'
  }
  /* 0 is "any length" rather than a length of zero — the shape a rule carried
     over from the old single setting has, because that setting never recorded
     one. Anything else must at least have room for what it describes. */
  if (!Number.isInteger(input.valueLength) || input.valueLength < 0 || input.valueLength > 18) {
    return 'The value length must be between 0 and 18.'
  }
  if (input.valueLength > 0) {
    const needed = input.prefix.trim().length + input.pluLength + (input.hasCheckDigit ? 1 : 0) + 1
    if (input.valueLength < needed) {
      return `A barcode of ${input.valueLength} digits has no room for a prefix, a ${input.pluLength}-digit stock code and a value.`
    }
  }
  return null
}

/**
 * Would this rule take barcodes off one already saved?
 *
 * Two rules sharing a prefix AND a length is not an error — a shop may be mid
 * way through replacing a scale — but it is worth saying out loud, because the
 * second one can never fire and nothing else would ever mention it.
 */
export async function shadowedBy(
  siteId: number,
  input: ScaleRuleInput,
  excludeId?: number,
): Promise<ScaleRule | null> {
  const all = await listScaleRules(siteId)
  const prefix = input.prefix.trim()
  return (
    all.find(
      (r) =>
        r.id !== excludeId &&
        r.prefix === prefix &&
        r.valueLength === input.valueLength,
    ) ?? null
  )
}

export async function createScaleRule(siteId: number, input: ScaleRuleInput): Promise<SaveResult> {
  const invalid = validateScaleRule(input)
  if (invalid) return { ok: false, error: invalid }

  const clash = await shadowedBy(siteId, input)
  if (clash) {
    return {
      ok: false,
      error: `A rule for prefix ${clash.prefix} at that length already exists. Edit it rather than adding a second — the second could never be reached.`,
    }
  }

  const rows = await siteQuery<RowDataPacket & { p: number }>(
    siteId,
    `SELECT COALESCE(MAX(position), -1) AS p FROM scale_barcode_rules`,
  )
  const next = Number(rows[0]?.p ?? -1) + 1

  const res = await siteExecute(
    siteId,
    `INSERT INTO scale_barcode_rules
       (prefix, plu_length, has_check_digit, value_length, decimals, position, is_active)
     VALUES (?,?,?,?,?,?,?)`,
    [
      input.prefix.trim(),
      input.pluLength,
      input.hasCheckDigit ? 1 : 0,
      input.valueLength,
      input.decimals,
      next,
      input.isActive === false ? 0 : 1,
    ],
  )
  return { ok: true, id: res.insertId }
}

export async function updateScaleRule(
  siteId: number,
  id: number,
  input: ScaleRuleInput,
): Promise<SaveResult> {
  const invalid = validateScaleRule(input)
  if (invalid) return { ok: false, error: invalid }

  const clash = await shadowedBy(siteId, input, id)
  if (clash) {
    return {
      ok: false,
      error: `A rule for prefix ${clash.prefix} at that length already exists.`,
    }
  }

  await siteExecute(
    siteId,
    `UPDATE scale_barcode_rules
        SET prefix = ?, plu_length = ?, has_check_digit = ?, value_length = ?,
            decimals = ?, is_active = ?
      WHERE id = ?`,
    [
      input.prefix.trim(),
      input.pluLength,
      input.hasCheckDigit ? 1 : 0,
      input.valueLength,
      input.decimals,
      input.isActive === false ? 0 : 1,
      id,
    ],
  )
  return { ok: true, id }
}

export async function deleteScaleRule(siteId: number, id: number): Promise<SaveResult> {
  await siteExecute(siteId, `DELETE FROM scale_barcode_rules WHERE id = ?`, [id])
  return { ok: true, id }
}
