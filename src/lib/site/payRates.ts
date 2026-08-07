import 'server-only'
import { getSettings } from './settings'
import { BCEA_MULTIPLIERS, type PayMultipliers } from '../timesheetModel'
import { toNum } from '../decimals'

/**
 * What this store pays for an hour outside ordinary time.
 *
 * The BCEA figures are the defaults and the great majority of stores will
 * never change them. A bargaining council agreement can set higher rates,
 * though, and before this existed the multipliers were constants in
 * `timesheetModel.ts` with no way for such a store to say so.
 *
 * Read in one round trip rather than four, because the cost report asks for
 * these once per run and a settings read per multiplier would be three
 * needless queries.
 */
export async function payMultipliers(siteId: number): Promise<PayMultipliers> {
  const values = await getSettings(siteId, [
    'staff_overtime_multiplier',
    'staff_sunday_multiplier',
    'staff_sunday_ordinary_multiplier',
    'staff_holiday_multiplier',
  ])

  // toNum falls back on anything unparseable, so a hand-edited settings row
  // cannot make a wage bill NaN. Same defensive posture as settings.ts itself:
  // configuration that is wrong beats configuration that crashes a report.
  return {
    overtime: toNum(values.staff_overtime_multiplier, BCEA_MULTIPLIERS.overtime),
    sunday: toNum(values.staff_sunday_multiplier, BCEA_MULTIPLIERS.sunday),
    sundayOrdinary: toNum(
      values.staff_sunday_ordinary_multiplier,
      BCEA_MULTIPLIERS.sundayOrdinary,
    ),
    holiday: toNum(values.staff_holiday_multiplier, BCEA_MULTIPLIERS.holiday),
  }
}
