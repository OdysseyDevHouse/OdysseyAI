'use server'

import { revalidatePath } from 'next/cache'
import { qrContextFor, samplePayUrl } from '@/lib/site/qrLinks'
import { setSetting } from '@/lib/site/settings'
import { canTakePayments } from '@/lib/site/payments'
import { logActivity } from '@/lib/site/activityLog'
import { cleanCustomUrl, resolveQrUrl, whyNoUrl } from '@/lib/stationery/qrTarget'
import { actorFor, requireSite } from '@/lib/auth'
import {
  saveTemplate,
  setActive,
  resetToDefault,
  deleteTemplate,
  discardDraft,
  copyTemplate,
} from '@/lib/site/stationeryTemplates'
import { isDocType } from '@/lib/stationery/catalog'
import { sanitiseTemplate, unsupportedIn } from '@/lib/stationery/sanitise'
import { validateTemplate } from '@/lib/stationery/validate'
import { renderTemplate } from '@/lib/stationery/render'
import {
  purchaseOrderPreview,
  invoicePreview,
  deliveryNotePreview,
  statementPreview,
  sampleReceipt,
} from '@/lib/stationery/preview'
import { parseSlip, validateSlip } from '@/lib/stationery/slip'
import { parseSpec, validateSpec } from '@/lib/stationery/blocks'
import { compileBlocks, compileDocument, supportsBlocks } from '@/lib/stationery/compile'
import { slipPreviewHtml, slipBlockHtml } from '@/lib/stationery/slipHtml'
import {
  pictureIds,
  addImage,
  removeImage,
  listImages,
  imageLabel,
} from '@/lib/site/stationeryImages'

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

/** A copy hands back the whole new row, so the list can show it without a refetch. */
export type CopyActionResult =
  | {
      ok: true
      message: string
      id: number
      docType: string
      name: string
      body: string
      format: 'html' | 'slip' | 'blocks'
    }
  | { ok: false; error: string }

export async function saveTemplateAction(input: {
  id?: number
  docType: string
  name: string
  body: string
  format?: 'html' | 'slip' | 'blocks'
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
      format: input.format,
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
 * Copy a design — to a new name here, or onto another document.
 *
 * Guarded like every other write on this screen: the action is the real
 * boundary, and a copy creates a row exactly as a save does. Reading the source
 * happens inside the site's own connection, so a caller cannot name a design
 * belonging to a site they are not signed in to.
 */
export async function copyTemplateAction(input: {
  id: number
  targetDocType: string
  name: string
}): Promise<CopyActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the copy a name.' }

  const result = await copyTemplate(ctx.siteId, input.id, input.targetDocType, name, ctx.actor)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  // The message names what was dropped or added — see describeCopy. It is the
  // point of the feature, not a courtesy.
  return {
    ok: true,
    message: result.message,
    id: result.id,
    docType: result.docType,
    name: result.name,
    body: result.body,
    format: result.format,
  }
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
/**
 * The sample data a document previews against.
 *
 * ── ONE PLACE, BECAUSE TWO WAS ALREADY WRONG ──────────────────────────────
 *
 * The markup preview and the block preview each carried their own copy of this
 * branch, and both said "invoice, or else a purchase order". So a delivery note
 * previewed against products with prices on them, and a statement against an
 * order — neither of which has anything to do with the document being designed.
 *
 * Sample data rather than the shop's own for these two, deliberately: a statement
 * needs debt spread across the age ladder and a delivery note needs a part
 * delivery, and picking a real one that happens to have neither teaches a
 * designer nothing about the layout.
 */
async function previewFor(
  docType: string,
  siteId: number,
  letterhead: Parameters<typeof purchaseOrderPreview>[1],
) {
  if (docType === 'invoice') return invoicePreview(siteId, letterhead)
  if (docType === 'delivery_note') return deliveryNotePreview(siteId, letterhead)
  if (docType === 'statement') return statementPreview(siteId, letterhead)
  return purchaseOrderPreview(siteId, letterhead)
}

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

  const site = await requireSite()

  /*
   * A slip is previewed as the ROLL, not as a page: rendered from the block
   * spec by the same component the print route uses, so what the designer sees
   * is what comes out of the browser — and, through slipSpec.ts, what comes out
   * of the thermal head.
   */
  if (input.docType === 'slip') {
    const spec = parseSlip(input.body)
    if (!spec) return { ok: false, error: 'That slip design cannot be read.' }

    const check = validateSlip(spec)
    const receipt = sampleReceipt(site.displayName, site.vatNumber, await qrContextFor(ctx.siteId, samplePayUrl(ctx.siteId)))

    return {
      ok: true,
      html: slipPreviewHtml(spec, receipt),
      label: 'A sample sale, on 80mm paper.',
      warnings: check.errors,
    }
  }

  // Cleaned first, then rendered — so the preview shows what would actually be
  // STORED, not what was typed. A designer whose <script> silently vanishes at
  // save should see it vanish here.
  const clean = sanitiseTemplate(input.body)
  const check = validateTemplate(input.docType, clean)

  const letterhead = {
    name: site.displayName,
    vatNumber: site.vatNumber,
    registrationNumber: site.registrationNumber,
    address1: site.address1,
    address2: site.address2,
    address3: site.address3,
    postalCode: site.postalCode,
    phone: site.phone,
    email: site.email,
  }

  const source = await previewFor(input.docType, ctx.siteId, letterhead)

  const html = renderTemplate(clean, input.docType, {
    ...source.input,
    capabilities: ctx.capabilities,
    pictures: await pictureIds(ctx.siteId),
    qr: await qrContextFor(ctx.siteId, samplePayUrl(ctx.siteId)),
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
 * Render a BLOCK design, one fragment per block.
 *
 * The visual canvas draws each block in its own selectable box, so it needs
 * them apart. Rendered here rather than in the browser for the same reason the
 * markup preview is: this goes through the real compiler, the real token
 * catalog and the real renderer, so what a designer drags around is what prints
 * — including a cost column that is blank because they lack products.cost.
 *
 * Also returns the WHOLE document, because the page-level style rules (the ones
 * that hide an empty row) live outside any single block.
 */
export async function previewBlocksAction(input: {
  docType: string
  spec: string
}): Promise<
  | { ok: true; blocks: Record<string, string>; label: string; warnings: string[] }
  | { ok: false; error: string }
> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  if (!isDocType(input.docType)) return { ok: false, error: 'Unknown document type.' }
  if (!supportsBlocks(input.docType)) {
    return { ok: false, error: 'That document cannot be designed visually.' }
  }

  const spec = parseSpec(input.spec, input.docType)
  if (!spec) return { ok: false, error: 'That design cannot be read.' }

  const site = await requireSite()
  const letterhead = {
    name: site.displayName,
    vatNumber: site.vatNumber,
    registrationNumber: site.registrationNumber,
    address1: site.address1,
    address2: site.address2,
    address3: site.address3,
    postalCode: site.postalCode,
    phone: site.phone,
    email: site.email,
  }

  const source = await previewFor(input.docType, ctx.siteId, letterhead)

  const fragments = compileBlocks(spec, input.docType)
  // Read once for the whole design rather than per block: a page of seventeen
  // blocks would otherwise ask the same question seventeen times.
  const pictures = await pictureIds(ctx.siteId)
  const qr = await qrContextFor(ctx.siteId, samplePayUrl(ctx.siteId))
  const blocks: Record<string, string> = {}
  for (const [id, markup] of Object.entries(fragments)) {
    blocks[id] = renderTemplate(markup, input.docType, {
      ...source.input,
      capabilities: ctx.capabilities,
      pictures,
      qr,
    })
  }

  /*
   * Structure first, then the law — against the compiled whole, exactly as the
   * save path checks it. A designer should see "this cannot be saved yet"
   * while they are still looking at the block that causes it.
   */
  const structure = validateSpec(spec, input.docType)
  const legal = validateTemplate(input.docType, compileDocument(spec, input.docType))

  /*
   * ── A QR WITH NOWHERE TO POINT ──────────────────────────────────────────
   *
   * It prints nothing, deliberately — a square that scans to a dead host is
   * worse than none. But a designer who placed one and sees blank paper is
   * owed the reason, and the preview is where they are looking. Said once per
   * target rather than once per block, so three review QRs are one sentence.
   */
  const qrProblems = new Set<string>()
  for (const b of spec.blocks) {
    if (b.kind !== 'qr') continue
    const target = b.qrTarget ?? 'store'
    if (resolveQrUrl(target, b.qrUrl, qr)) continue

    /*
     * "This document" is the one target that is EXPECTED to be empty here.
     *
     * The preview runs on sample data — there is no real invoice, so there is
     * no real pay link — and the square appears on the actual print. Leading
     * with "your QR code has nothing to point at" made a working block read as
     * broken, which is how somebody deletes it and loses the feature.
     *
     * Every other target is a genuine problem the designer must fix here, and
     * keeps the blunt sentence.
     */
    const isSample = target === 'doc' && qr.appUrl !== null
    qrProblems.add(
      isSample
        ? whyNoUrl(target, qr, true)
        : `Your QR code has nothing to point at. ${whyNoUrl(target, qr)}`,
    )
  }

  return {
    ok: true,
    blocks,
    label: source.label,
    warnings: [...structure.errors, ...legal.errors.map((e) => e.message), ...qrProblems],
  }
}

/**
 * Turn a block design into markup, so it can be edited by hand.
 *
 * ── IT ONLY GOES THIS WAY ─────────────────────────────────────────────────
 *
 * Compiling blocks to markup is a function; recovering blocks from markup is a
 * parser, and a parser is exactly what this whole design exists to avoid — a
 * customer hand-edits one thing, their markup stops being parseable, and their
 * document becomes undraggable. So the conversion is one-way, the screen says
 * so before it happens, and the block version is left as a saved design that
 * can be made active again.
 *
 * The compiled markup is handed BACK rather than written: it lands in the
 * editor as unsaved work, so a shop that converts by accident closes the screen
 * and nothing has changed. Converting and saving are two decisions.
 */
/**
 * Each block of a slip design, rendered on its own.
 *
 * ── THE SLIP CANVAS'S EQUIVALENT OF previewBlocksAction ───────────────────
 *
 * The A4 designer draws every block in its own selectable box and needs them
 * apart rather than joined; a slip designer that lets a shop click the business
 * name ON THE SLIP needs exactly the same thing.
 *
 * Deliberately the same `block` function slipPreviewHtml uses, for the reason
 * that whole design rests on: a canvas showing something the roll would not
 * print is the failure this avoids.
 *
 * ── EMPTY MEANS "PRINTS NOTHING TODAY", NOT "BROKEN" ──────────────────────
 *
 * A VAT number on a non-vendor, a customer on a cash sale, a gift note on an
 * ordinary slip. The canvas still shows those blocks — they are part of the
 * design and must stay selectable and movable — but it labels them rather than
 * drawing an empty box the shop cannot explain.
 */
export async function previewSlipBlocksAction(input: {
  spec: string
}): Promise<
  | { ok: true; blocks: string[]; label: string; warnings: string[] }
  | { ok: false; error: string }
> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const spec = parseSlip(input.spec)
  if (!spec) return { ok: false, error: 'That slip design cannot be read.' }

  const site = await requireSite()
  const receipt = sampleReceipt(site.displayName, site.vatNumber, await qrContextFor(ctx.siteId, samplePayUrl(ctx.siteId)))

  return {
    ok: true,
    blocks: slipBlockHtml(spec, receipt),
    label: 'A sample sale, on 80mm paper.',
    warnings: validateSlip(spec).errors,
  }
}

export async function toMarkupAction(input: {
  docType: string
  spec: string
}): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  if (!isDocType(input.docType)) return { ok: false, error: 'Unknown document type.' }

  const spec = parseSpec(input.spec, input.docType)
  if (!spec) return { ok: false, error: 'That design cannot be read.' }

  // Through the sanitiser, like anything else that becomes a template — the
  // compiler is trusted, but the html blocks inside the spec are not.
  const body = sanitiseTemplate(compileDocument(spec, input.docType))
  if (body.trim() === '') return { ok: false, error: 'That design compiles to nothing.' }

  return { ok: true, body }
}

/*
 * ── THE LOGO ACTIONS MOVED ──────────────────────────────────────────────────
 *
 * uploadLogoAction and clearLogoAction now live in
 * setup/store-info/actions.ts, beside the name and address the logo prints next
 * to. Which picture is the shop's logo is one of the shop's own DETAILS, not a
 * property of any document — and `setup.stationery` guards something narrower
 * than that: markup a person types which leaves the building on a customer's
 * invoice.
 *
 * They are deleted rather than left as unused exports. An exported server
 * action is a live endpoint whether or not a screen calls it, so leaving them
 * here would keep a second front door open onto the same file, gated on a
 * different capability from the one that now owns it.
 *
 * The designer still SHOWS the logo — a letterhead being laid out has to — and
 * links across to change it.
 */

export async function discardDraftAction(id: number): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const result = await discardDraft(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return { ok: true, id, message: 'Draft discarded.' }
}

/* ── the shop's pictures ─────────────────────────────────────────────────── */

export type PictureInfo = {
  id: number
  label: string
  filename: string
  sizeBytes: number
}

export type PictureListResult =
  | { ok: true; message: string; pictures: PictureInfo[] }
  | { ok: false; error: string }

/**
 * Upload a picture for use on documents.
 *
 * Guarded like every other write here — see the header. The whole list comes
 * back rather than just the new row: the designer shows a gallery, and a client
 * that patched its own copy would drift from the server the first time two
 * tabs were open.
 */
export async function uploadPictureAction(form: FormData): Promise<PictureListResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const file = form.get('picture')
  if (!(file instanceof File)) return { ok: false, error: 'Choose a picture to upload.' }
  const label = String(form.get('label') ?? '')

  const result = await addImage(ctx.siteId, file, label, ctx.actor)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return { ok: true, message: 'Picture uploaded.', pictures: await picturesFor(ctx.siteId) }
}

/**
 * Delete a picture.
 *
 * Designs pointing at it are NOT rewritten — see removeImage. A block naming a
 * picture that has gone prints nothing, which is the same thing that happens
 * when the file itself goes missing, and is already handled by every renderer.
 */
export async function deletePictureAction(id: number): Promise<PictureListResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const result = await removeImage(ctx.siteId, id)
  if (!result.ok) return result

  revalidatePath('/setup/stationery')
  return {
    ok: true,
    message: 'Picture deleted. Any design using it will print without it.',
    pictures: await picturesFor(ctx.siteId),
  }
}

async function picturesFor(siteId: number): Promise<PictureInfo[]> {
  const images = await listImages(siteId)
  return images.map((i) => ({
    id: i.id,
    label: imageLabel(i),
    filename: i.filename,
    sizeBytes: i.sizeBytes,
  }))
}

/**
 * Where a "scan to rate us" QR points.
 *
 * Typed once here rather than into every design that wants one: a shop putting
 * the same square on its invoice, its quote and its till slip should change the
 * address in one place when it moves.
 *
 * Cleaned through the same function the designer and the renderers use, so an
 * address this accepts is one they will encode — and an address they would
 * refuse is refused here, where a person can see why.
 */
export async function saveReviewUrlAction(url: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const trimmed = url.trim()
  if (trimmed === '') {
    const cleared = await setSetting(ctx.siteId, 'document_review_url', '')
    if (!cleared.ok) return cleared
    revalidatePath('/setup/stationery')
    return { ok: true, message: 'Review link cleared. A QR pointing at it will print nothing.' }
  }

  const clean = cleanCustomUrl(trimmed)
  if (!clean) {
    return { ok: false, error: 'That is not an https web address.' }
  }

  const saved = await setSetting(ctx.siteId, 'document_review_url', clean)
  if (!saved.ok) return saved

  revalidatePath('/setup/stationery')
  return { ok: true, message: 'Review link saved.' }
}

/**
 * Which documents carry a "pay online" link.
 *
 * ── WHY THIS LIVES BESIDE THE REVIEW LINK ─────────────────────────────────
 *
 * Both decide what a QR square on this shop's paper points at, and both are
 * changed by the person designing the stationery. Putting the pay switches on
 * the online-store screen — where the gateway itself is configured — would hide
 * them behind the `online_store` MODULE, and a shop with no storefront still
 * emails invoices and posts statements. The gateway is a storefront concern;
 * what goes on an invoice is not.
 *
 * ── ALL FOUR ARE SEPARATE ─────────────────────────────────────────────────
 *
 * They are genuinely different decisions made by different people. A business
 * will happily put a pay button on an emailed invoice while wanting nothing on
 * a printed till slip, because the slip is handed to somebody who has already
 * paid. One switch would force all of it.
 *
 * Audited, because turning these on changes what every customer of this
 * business receives from it.
 */
export async function savePayLinkSettingsAction(input: {
  invoices: boolean
  statements: boolean
  laybys: boolean
  quotes: boolean
}): Promise<ActionResult> {
  const ctx = await actorFor('setup.stationery')
  if ('ok' in ctx) return ctx

  const pairs = [
    ['pay_link_on_invoices', input.invoices],
    ['pay_link_on_statements', input.statements],
    ['pay_link_on_laybys', input.laybys],
    ['pay_link_on_quotes', input.quotes],
  ] as const

  for (const [key, on] of pairs) {
    const saved = await setSetting(ctx.siteId, key, on ? '1' : '0')
    if (!saved.ok) return saved
  }

  const on = pairs.filter(([, v]) => v).map(([k]) => k.replace('pay_link_on_', ''))
  await logActivity(ctx.siteId, ctx.actor, {
    entity: 'setting',
    entityId: null,
    action: 'pay_links',
    detail: on.length ? `Pay links on: ${on.join(', ')}` : 'Pay links off everywhere',
  }).catch(() => undefined)

  revalidatePath('/setup/stationery')

  /*
   * The gateway is checked SEPARATELY from the switch, and said out loud.
   *
   * payLinksEnabled() requires both, so a shop can turn these on with no
   * gateway connected and see nothing appear on any document — which looks
   * exactly like a broken feature. Saying so here is the difference between a
   * setting that seems ignored and one that explains itself.
   */
  const usable = await canTakePayments(ctx.siteId)
  if (on.length > 0 && !usable) {
    return {
      ok: true,
      message:
        'Saved — but no payment account is connected yet, so nothing will appear until one is. See Online store → Payments.',
    }
  }

  return { ok: true, message: on.length ? 'Pay links saved.' : 'Pay links turned off.' }
}
