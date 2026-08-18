import { PURCHASE_ORDER_DEFAULT } from './defaults/purchaseOrder'
import { validateTemplate } from './validate'

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

export const DEFAULT_TEMPLATES: Record<string, string> = {
  purchase_order: PURCHASE_ORDER_DEFAULT,
}

export type Resolved = {
  body: string
  source: 'custom' | 'default'
  /** Why the custom template was not used, when one existed but was rejected. */
  rejected?: string
}

export function resolveTemplate(docTypeKey: string, custom: string | null): Resolved {
  const fallback = DEFAULT_TEMPLATES[docTypeKey] ?? ''

  if (!custom || custom.trim() === '') return { body: fallback, source: 'default' }

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
