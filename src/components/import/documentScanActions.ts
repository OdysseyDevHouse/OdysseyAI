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
 * The sibling of readLinesAction, and guarded the same way: this reads the
 * product catalogue and returns nothing the calling screen could not already
 * see. Nothing is written, so purchasing.edit is the right boundary — the same
 * right needed to key the lines by hand.
 */
export async function scanDocumentAction(input: {
  filename: string
  /** Base64 PDF bytes. A PDF cannot survive being read as text. */
  base64: string
  /** The supplier already chosen on screen, when there is one. */
  supplierId?: number | null
}): Promise<ScanResult> {
  const ctx = await actorForAny('purchasing.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error }

  return scanPurchaseDocument(
    ctx.siteId,
    { name: input.filename, base64: input.base64 },
    input.supplierId ?? null,
  )
}

/** Whether the button should offer itself at all. */
export async function scanConfiguredAction(): Promise<boolean> {
  const ctx = await actorForAny('purchasing.edit')
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
