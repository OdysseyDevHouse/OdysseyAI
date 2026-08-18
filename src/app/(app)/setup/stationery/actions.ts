'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, requireSite } from '@/lib/auth'
import {
  saveTemplate,
  setActive,
  resetToDefault,
  deleteTemplate,
  discardDraft,
} from '@/lib/site/stationeryTemplates'
import { isDocType } from '@/lib/stationery/catalog'
import { sanitiseTemplate, unsupportedIn } from '@/lib/stationery/sanitise'
import { validateTemplate } from '@/lib/stationery/validate'
import { renderTemplate } from '@/lib/stationery/render'
import { purchaseOrderPreview } from '@/lib/stationery/preview'
import { setLogo, clearLogo } from '@/lib/site/documentLogo'

/**
 * The stationery designer's server half.
 *
 * ── THIS IS THE BOUNDARY, NOT THE SCREEN ──────────────────────────────────
 *
 * Every action re-checks setup.stationery through actorFor. A hidden menu entry
 * is not a boundary and neither is a disabled button: an action is callable by
 * anyone who can construct a POST, so the capability is asserted here, on the
 * server, every single time.
 *
 * Sanitising and validating happen one layer down, in
 * lib/site/stationeryTemplates.ts, so they cannot be skipped by a future caller
 * that reaches the store some other way.
 */

export type ActionResult = { ok: true; message: string; id?: number } | { ok: false; error: string }

export async function saveTemplateAction(input: {
  id?: number
  docType: string
  name: string
  body: string
  asDraft?: boolean
}): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  if (!isDocType(input.docType)) return { ok: false, error: 'Unknown document type.' }

  const result = await saveTemplate(
    ctx.siteId,
    {
      docType: input.docType,
      name: input.name,
      body: input.body,
      asDraft: input.asDraft,
    },
    ctx.actor,
    input.id,
  )
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return {
    ok: true,
    id: result.id,
    message: input.asDraft ? 'Draft saved.' : 'Template saved.',
  }
}

/**
 * Make a template the one that prints.
 *
 * Deliberately a separate action from saving. Saving is "I am working on this";
 * activating is "this is what my suppliers will now receive", and a screen that
 * did both on one button would make the second happen by accident.
 */
export async function setActiveAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const result = await setActive(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return { ok: true, id, message: 'This design is now used when the document prints.' }
}

export async function resetToDefaultAction(docType: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const result = await resetToDefault(ctx.siteId, docType)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return { ok: true, message: 'Back to the standard layout. Your designs are still here.' }
}

export async function deleteTemplateAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const result = await deleteTemplate(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return { ok: true, message: 'Template deleted.' }
}

/**
 * Render a template the designer is typing, against this site's own data.
 *
 * ── WHY THE SERVER RENDERS THE PREVIEW ────────────────────────────────────
 *
 * The preview must be the SAME bytes the print route produces, or it is a
 * decoration that lies at exactly the moment someone trusts it. Rendering here
 * means one sanitiser, one validator, one renderer and one set of real values —
 * a browser-side preview would be a second implementation whose whole job is to
 * agree with this one.
 *
 * It also means the preview honours the CALLER's capabilities, so a designer
 * without products.cost sees the blank cost column their staff will see rather
 * than a filled one that misleads them.
 */
export async function previewTemplateAction(input: {
  docType: string
  body: string
}): Promise<
  | { ok: true; html: string; label: string; warnings: string[] }
  | { ok: false; error: string }
> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  if (!isDocType(input.docType)) return { ok: false, error: 'Unknown document type.' }
  if (input.docType !== 'purchase_order') {
    return { ok: false, error: 'That document cannot be previewed yet.' }
  }

  const site = await requireSite()

  // Cleaned first, then rendered — so the preview shows what would actually be
  // STORED, not what was typed. A designer whose <script> silently vanishes at
  // save should see it vanish here.
  const clean = sanitiseTemplate(input.body)
  const check = validateTemplate(input.docType, clean)

  const source = await purchaseOrderPreview(ctx.siteId, {
    name: site.displayName,
    vatNumber: site.vatNumber,
    registrationNumber: site.registrationNumber,
    address1: site.address1,
    address2: site.address2,
    address3: site.address3,
    postalCode: site.postalCode,
    phone: site.phone,
    email: site.email,
  })

  const html = renderTemplate(clean, input.docType, {
    ...source.input,
    capabilities: ctx.capabilities,
  })

  const dropped = unsupportedIn(input.body)

  return {
    ok: true,
    html,
    label: source.label,
    warnings: [
      ...check.errors.map((e) => e.message),
      ...(dropped.length
        ? [`These tags are not allowed and were removed: ${dropped.join(', ')}.`]
        : []),
    ],
  }
}

/**
 * Upload the business's logo.
 *
 * Takes a FormData rather than a typed object because a File cannot cross a
 * server-action boundary any other way. The bytes are proved to be a picture by
 * magic-byte sniffing in lib/uploads.ts — an .svg renamed to .png dies there,
 * which matters more here than elsewhere: an SVG executes script when opened
 * from the same origin, and this file is rendered into a document.
 */
export async function uploadLogoAction(form: FormData): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const file = form.get('logo')
  if (!(file instanceof File)) return { ok: false, error: 'Choose an image to upload.' }

  const result = await setLogo(ctx.siteId, file)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return { ok: true, message: 'Logo uploaded.' }
}

export async function clearLogoAction(): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const result = await clearLogo(ctx.siteId)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return { ok: true, message: 'Logo removed. Documents will print without one.' }
}

export async function discardDraftAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const result = await discardDraft(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return { ok: true, id, message: 'Draft discarded.' }
}
