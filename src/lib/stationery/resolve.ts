import { PURCHASE_ORDER_BLOCKS } from './defaults/purchaseOrderBlocks'
import { INVOICE_BLOCKS } from './defaults/invoiceBlocks'
import { DELIVERY_NOTE_BLOCKS } from './defaults/deliveryNoteBlocks'
import type { DocumentSpec } from './blocks'
import { PURCHASE_ORDER_DEFAULT } from './defaults/purchaseOrder'
import { INVOICE_DEFAULT } from './defaults/invoice'
import { DELIVERY_NOTE_DEFAULT } from './defaults/deliveryNote'
import { SLIP_DEFAULT, serialiseSlip } from './slip'
import { validateTemplate } from './validate'
import { parseSpec } from './blocks'
import { compileDocument } from './compile'

/**
 * Which template a document actually prints from.
 *
 * ── NOTHING IS EVER UNPRINTABLE ───────────────────────────────────────────
 *
 * A purchase order that will not print because someone mis-edited a template
 * last Tuesday is a worse failure than a purchase order that prints in the
 * house style. So resolution always ends somewhere:
 *
 *   1. the site's active template for this document type
 *   2. the template we ship
 *
 * and a custom template that no longer VALIDATES is skipped rather than
 * rendered. That last step is the reason validation runs here and not only at
 * save: the required set can grow after a template was stored — a change in the
 * law, or a field we should have demanded from the start — and the honest
 * answer to "this saved document is no longer lawful" is to print the default
 * and say so, not to print something that will come back.
 *
 * The reason is returned rather than logged, so the setup screen can show the
 * site WHY their design is not on the page. A silent fallback would have people
 * editing a template that is not being used.
 */

/**
 * The shipped BLOCK design per document, where one exists.
 *
 * A lookup rather than a check at the call site: the setup page used to ask
 * `key === 'purchase_order'`, which meant every new designable document needed
 * an edit there as well as a default here — and forgetting the second one gives
 * a shop the HTML editor with no explanation.
 *
 * A document missing from this map has no visual design to fork, and the screen
 * correctly falls back to markup. That is the honest answer for the till slip,
 * whose blocks are ESC/POS and have their own designer.
 */
export const DEFAULT_SPECS: Record<string, DocumentSpec> = {
  purchase_order: PURCHASE_ORDER_BLOCKS,
  invoice: INVOICE_BLOCKS,
  delivery_note: DELIVERY_NOTE_BLOCKS,
}

export const DEFAULT_TEMPLATES: Record<string, string> = {
  purchase_order: PURCHASE_ORDER_DEFAULT,
  invoice: INVOICE_DEFAULT,
  delivery_note: DELIVERY_NOTE_DEFAULT,
  /* The slip's default is a block spec, not markup — serialised so this map
     stays one shape and the designer can hand it straight to the editor. */
  slip: serialiseSlip(SLIP_DEFAULT),
}

export type Resolved = {
  body: string
  source: 'custom' | 'default'
  /** Why the custom template was not used, when one existed but was rejected. */
  rejected?: string
}

/**
 * How the stored body is written. Absent means markup, which is what every row
 * predating the visual designer holds.
 */
export type StoredFormat = 'html' | 'blocks' | 'slip'

export function resolveTemplate(
  docTypeKey: string,
  custom: string | null,
  format: StoredFormat = 'html',
): Resolved {
  const fallback = DEFAULT_TEMPLATES[docTypeKey] ?? ''

  if (!custom || custom.trim() === '') return { body: fallback, source: 'default' }

  /*
   * A block document is JSON, so it becomes markup here — before validation,
   * because what must be checked is what will PRINT.
   *
   * A spec that no longer parses falls back rather than throwing: the visual
   * designer's whole promise is that a stored design keeps working, and a
   * document that will not print is worse than one that prints plainly.
   */
  if (format === 'blocks') {
    const spec = parseSpec(custom, docTypeKey)
    if (!spec) {
      return { body: fallback, source: 'default', rejected: 'That design could not be read.' }
    }
    custom = compileDocument(spec, docTypeKey)
    if (custom.trim() === '') return { body: fallback, source: 'default' }
  }

  const check = validateTemplate(docTypeKey, custom)
  if (!check.ok) {
    const blocking = check.errors.filter((e) => e.kind === 'missing-required')
    // Only a REQUIRED failure is worth refusing to print over. An unknown token
    // renders empty and a misplaced one renders empty — both are cosmetic, and
    // dropping a whole design because of one stale token would be the
    // "survives a field being renamed" rule broken.
    if (blocking.length > 0) {
      return {
        body: fallback,
        source: 'default',
        rejected: blocking.map((e) => e.message).join(' '),
      }
    }
  }

  return { body: custom, source: 'custom' }
}
