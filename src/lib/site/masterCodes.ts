import 'server-only'
import { nextMasterCode, previewMasterCode, type CodeDocType } from './sequences'
import { getBooleanSetting } from './settings'

/**
 * Auto-numbered customer, supplier, product and till codes.
 *
 * ── WHERE THIS RUNS ──────────────────────────────────────────────────────
 *
 * Inside createCustomer / createSupplier / createProduct / createTerminal, NOT
 * in the server action behind the form. The form is one way a customer gets
 * created; the till's quick-add is another, and an import is a third. Filling
 * the code in at the action would leave the other two still demanding one,
 * which is the bug this feature exists to remove.
 *
 * ── WHY A BLANK CODE IS THE TRIGGER ──────────────────────────────────────
 *
 * The setting decides whether a code is OFFERED; the blank decides whether one
 * is TAKEN. That split is what makes the code overridable — the new-customer
 * form pre-fills the preview, and a user who types over it submits a non-blank
 * code that this function leaves untouched.
 *
 * It also means the sequence is not consumed by a form the user overrode. The
 * preview shown on the form claims nothing (see previewMasterCode); only a
 * genuinely blank code reaching this point advances the counter.
 *
 * ── WHY VALIDATION MUST RUN AFTER, NOT BEFORE ────────────────────────────
 *
 * validateCustomer rejects a blank code. Auto-numbering has to fill it in
 * first or every auto-numbered save would fail on "A customer code is
 * required" — so callers resolve, then validate. Getting this order wrong is
 * silent when the setting is off, which is exactly how it would ship broken.
 */

/** The setting that switches each type on. */
const SETTING_FOR: Record<
  CodeDocType,
  'autocode_customer' | 'autocode_supplier' | 'autocode_product' | 'autocode_terminal'
> = {
  customer: 'autocode_customer',
  supplier: 'autocode_supplier',
  product: 'autocode_product',
  terminal: 'autocode_terminal',
}

/**
 * Returns the code to save: what the user typed, or the next one from the
 * sequence when they left it blank and auto-numbering is on.
 *
 * Never throws and never returns a blank it invented — if the sequence row is
 * missing (a site that has not run 062) it hands back the empty string and
 * lets the caller's own validation produce the ordinary "a code is required"
 * message. A setup gap should not read as a mysterious save failure.
 */
export async function resolveMasterCode(
  siteId: number,
  docType: CodeDocType,
  typed: string | undefined | null,
): Promise<string> {
  const code = (typed ?? '').trim()
  if (code) return code

  if (!(await getBooleanSetting(siteId, SETTING_FOR[docType]))) return ''

  return (await nextMasterCode(siteId, docType)) ?? ''
}

/**
 * The code to pre-fill a new-entity form with, or null to leave it blank.
 *
 * Claims nothing — see previewMasterCode. Two people opening the form together
 * see the same suggestion and the second saves under the next code up.
 */
export async function suggestedMasterCode(
  siteId: number,
  docType: CodeDocType,
): Promise<string | null> {
  if (!(await getBooleanSetting(siteId, SETTING_FOR[docType]))) return null
  return previewMasterCode(siteId, docType)
}
