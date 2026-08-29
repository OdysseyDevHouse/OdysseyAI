'use server'

import { actorForAny } from '@/lib/auth'
import {
  isScanConfigured,
  rememberSupplierCode,
  scanPurchaseDocument,
  type ScanResult,
} from '@/lib/import/documentScan'

/**
 * Reading a supplier's PDF for whichever purchasing screen asked.
 *
 * ── WHY THIS ONE IS NOT purchasing.edit ─────────────────────────────────────
 *
 * Its sibling readLinesAction reads a spreadsheet, returns nothing the calling
 * screen could not already see, and writes nothing — so purchasing.edit, the
 * right needed to key the lines by hand, is the right boundary for it.
 *
 * This one SPENDS. Every scan draws real money from the shop's AI wallet, and
 * "may receive stock" is not the same question as "may spend". A shop with six
 * receiving clerks may well want all six keying lines and only the manager
 * burning credit, which purchasing.edit cannot express.
 *
 * So it takes its own capability, exactly as reports.ai does against
 * reports.build. Note the consequence on the day this ships: purchasing.ai
 * starts ungranted, so existing non-owner roles lose the scan button until
 * somebody ticks it in Setup → Roles. Owners are unaffected — isOwner
 * short-circuits every check.
 */
export async function scanDocumentAction(input: {
  filename: string
  /** Base64 PDF bytes. A PDF cannot survive being read as text. */
  base64: string
  /** The supplier already chosen on screen, when there is one. */
  supplierId?: number | null
}): Promise<ScanResult> {
  const ctx = await actorForAny('purchasing.ai')
  if ('ok' in ctx) return { ok: false, error: ctx.error }

  return scanPurchaseDocument(
    ctx.siteId,
    { name: input.filename, base64: input.base64 },
    input.supplierId ?? null,
    ctx.actor.userId,
  )
}

/** Whether the button should offer itself at all. */
export async function scanConfiguredAction(): Promise<boolean> {
  const ctx = await actorForAny('purchasing.ai')
  if ('ok' in ctx) return false
  return isScanConfigured()
}

/**
 * Records the product a buyer picked for an unmatched line.
 *
 * Fire-and-forget from the dialog's point of view: the line goes into the grid
 * whether or not this succeeds, because the delivery is standing at the door
 * and a failed write of a convenience mapping must not block receiving it.
 */
export async function rememberSupplierCodeAction(input: {
  supplierId: number
  productId: number
  supplierCode: string
}): Promise<{ ok: boolean }> {
  const ctx = await actorForAny('purchasing.edit')
  if ('ok' in ctx) return { ok: false }

  try {
    await rememberSupplierCode(
      ctx.siteId,
      input.supplierId,
      input.productId,
      input.supplierCode,
    )
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
