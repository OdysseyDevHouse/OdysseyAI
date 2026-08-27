import 'server-only'
import {
  nextMasterCode,
  previewMasterCode,
  previewMasterCodes,
  type CodeDocType,
} from './sequences'
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
 * ── WHAT TRIGGERS A CLAIM ────────────────────────────────────────────────
 *
 * The setting decides whether a code is OFFERED; what arrives here decides
 * whether one is TAKEN. Two things ask for the next code:
 *
 *   - a blank code, which is a caller with no opinion — the till's quick-add,
 *     an import row with an empty column, a user who cleared the field; and
 *   - a code equal to the preview the form pre-filled, which is a user who
 *     looked at the suggestion and accepted it.
 *
 * The second case is the common one and used to be missed. previewMasterCode
 * claims nothing, so the form's pre-filled PRD00001 arrived here as an
 * ordinary typed code, was left untouched, and the counter never moved. Every
 * new product was offered PRD00001, and the second one saved collided with the
 * first. Accepting the suggestion has to advance the sequence, or the
 * suggestion is a trap.
 *
 * Anything else is a code the user genuinely chose, and is left alone.
 *
 * The preview is re-read here at save time rather than carried from the form
 * in a hidden field. A hidden field is a claim the client makes about what it
 * was shown, and a client that got it wrong would burn a number on every save
 * of a hand-typed code.
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

  // Auto-numbering off: whatever arrived is the code, blank included — the
  // caller's own validation then produces "a code is required".
  if (!(await getBooleanSetting(siteId, SETTING_FOR[docType]))) return code

  if (code) {
    const preview = await previewMasterCode(siteId, docType)
    // Compared case-insensitively because the codes are: a user who retyped
    // the suggestion in lower case accepted it, they did not invent one.
    if (!preview || preview.toLowerCase() !== code.toLowerCase()) return code
  }

  // Blank, or the suggestion accepted. Either way claim a real one — falling
  // back to whatever arrived if the sequence cannot produce one, so a setup
  // gap reads as the ordinary "a code is required" rather than a lost save.
  return (await nextMasterCode(siteId, docType)) ?? code
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

/**
 * The codes to pre-fill a form that creates `count` entities at once.
 *
 * Claims nothing — see previewMasterCodes. Returns [] when auto-numbering is
 * off for this type, which is the caller's cue to leave the boxes blank and
 * make the user type their own; the server refuses a blank code either way.
 */
export async function suggestedMasterCodes(
  siteId: number,
  docType: CodeDocType,
  count: number,
): Promise<string[]> {
  if (!(await getBooleanSetting(siteId, SETTING_FOR[docType]))) return []
  return previewMasterCodes(siteId, docType, count)
}
