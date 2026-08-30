'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId, actorFor, actorForOrThrow } from '@/lib/auth'
import { checkPricing } from '@/lib/site/priceGuard'
import {
  saveDraft,
  getDocument,
  createBlankDocument,
  type LineInput,
} from '@/lib/site/salesDocuments'
import { finaliseDocument } from '@/lib/site/salesPosting'
import { loadSaleRecord, type SaleRecordSnapshot } from '@/lib/site/saleRecord'
import { terminalForDevice } from '@/lib/site/terminals'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { serialsForInvoice } from '@/lib/site/jobSerials'
import {
  getTillCustomer,
  listCustomersForPicker,
  type TillCustomer,
} from '@/lib/site/tillCustomers'

/**
 * Invoicing actions.
 *
 * The back-office counterpart to the till's actions.ts: same engine underneath,
 * but the shape of the work is different. Here a document is captured, saved,
 * corrected and only then finalised — often across several sittings — rather
 * than rung up and tendered in one go.
 */

export type InvoiceResult = { ok: true; documentId: number } | { ok: false; error: string }

export type InvoiceLinePayload = {
  productId: number | null
  productCode: string | null
  description: string
  productType?: string
  departmentId: number | null
  salesRepUserId: number | null
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  unitCostExcl: number
}

export type InvoicePayload = {
  documentId: number
  customerId: number | null
  customerName: string | null
  priceStructureId: number | null
  documentDate: string
  /**
   * The CUSTOMER's own handle on the job — their purchase-order number, their
   * job number, whatever they quote back at you. Shown as "Customer reference".
   *
   * Never the sale's name. A draft is named by `customerName`, which is what
   * `requireName` below is about: this field belongs to the customer and is
   * free for whatever they use it for. Always optional.
   */
  reference: string | null
  /**
   * Refuse the save unless `customerName` names the document.
   *
   * Set by the Save (draft) button and nothing else. A draft is the one state
   * with no number of its own — the number is allocated at issue — so it is the
   * one state where the name is not optional. The editor asks for it in a
   * dialog before it ever gets here; this is the boundary that means a crafted
   * request cannot skip the question.
   *
   * Finalising and issuing a quote both go through the same save and both leave
   * it OFF, deliberately: each ends by allocating a document number, which is a
   * better handle than any name, and refusing to take money from a customer
   * standing at the counter over a blank text box would be absurd.
   */
  requireName?: boolean
  notes: string | null
  /**
   * Which MACHINE is capturing, not which till.
   *
   * The screen never picks a till and cannot name one: it sends the browser's
   * own device id and the server turns that into a terminal. That is the whole
   * point of sending the device rather than a terminalId — a posted invoice
   * says which register it was captured on, and nothing a client can send
   * decides that.
   *
   * Null on a browser that has never been claimed to a till. That used to be
   * fine; it is now REFUSED, because this window numbers from its till's own
   * run and a machine with no till has no run to number from. See
   * saveInvoiceAction.
   */
  deviceId: string | null
  lines: InvoiceLinePayload[]
}

function toLineInputs(lines: InvoiceLinePayload[]): LineInput[] {
  return lines.map((line) => ({
    productId: line.productId,
    productCode: line.productCode,
    description: line.description,
    productType: (line.productType ?? 'normal') as LineInput['productType'],
    departmentId: line.departmentId,
    salesRepUserId: line.salesRepUserId,
    qty: line.qty,
    unitPriceIncl: line.unitPriceIncl,
    discountPct: line.discountPct,
    vatRatePct: line.vatRatePct,
    unitCostExcl: line.unitCostExcl,
  }))
}

/** The first page of the debtors book, for a picker that has just opened. */
export async function listCustomersAction(): Promise<TillCustomer[]> {
  const ctx = await actorForOrThrow('sales.edit')
  const { siteId } = ctx
  return listCustomersForPicker(siteId, 100)
}

/**
 * The customer's credit position, fetched when one is attached.
 *
 * The finalise dialog needs the live balance to decide whether the account
 * tender may be used, and the editor is only given an id and a name.
 */
export async function getInvoiceCustomerAction(customerId: number): Promise<TillCustomer | null> {
  const ctx = await actorForOrThrow('sales.edit')
  const { siteId } = ctx
  return getTillCustomer(siteId, customerId)
}

/**
 * Starts a blank invoice and hands back its id, so the editor has a document
 * to attach lines to. Nothing is posted and no number is issued.
 */
export async function newInvoiceAction(): Promise<InvoiceResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  /* `till`, not `back_office` — see the note in saveInvoiceAction on why this
     window numbers like a counter. Set at creation as well as at save, because
     saveDraft does not rewrite `origin` on an update: a document created as
     back_office would keep that for its whole life and number from the shared
     run however it was later edited. */
  const result = await createBlankDocument(siteId, actor, 'invoice', 'till')
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/invoicing')
  return { ok: true, documentId: result.id }
}

/** Writes the document without posting it. Stock has not moved. */
export async function saveInvoiceAction(payload: InvoicePayload): Promise<InvoiceResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  // `finaliseInvoiceAction` routes through here, so both paths are covered by
  // the one check. The editor also disables the cells, but that is a courtesy
  // to the user rather than the thing that stops a crafted request.
  const refused = await checkPricing(
    siteId,
    ctx.capabilities,
    payload.priceStructureId ?? null,
    payload.lines,
  )
  if (refused) return { ok: false, error: refused }

  /*
   * ── A SAVED DRAFT MUST BE CALLABLE BY SOMETHING ─────────────────────────
   *
   * A draft is a document nobody has issued yet: it has no number — the number
   * is allocated at issue — so the only handle anyone has on it is the name it
   * was saved under. Without one the register lists a row with a dash where its
   * identity should be, and whoever parked it half an hour ago has to open
   * documents until they recognise their own lines.
   *
   * The same rule the till already keeps: parking a basket asks for a name
   * before it will save, and stores it as `customer_name`. This window parks
   * into the SAME column, so it asks the same question.
   *
   * NOT the reference. That is the customer's own number for the job and is
   * theirs to spend on whatever they like — a shop-invented name has no
   * business taking the field over.
   *
   * ── AND IT IS CHECKED HERE ──────────────────────────────────────────────
   *
   * The editor checks first and marks the field red, which is the version a
   * person actually sees. This is the boundary: it catches the crafted request,
   * and it is the one place the rule is stated once for whatever else learns to
   * park a draft here later.
   *
   * Deliberately NOT a disabled Save button. A button that will not press and
   * does not say why is the worst of the three options — the click has to be
   * allowed so it can explain itself and put the cursor in the box.
   */
  if (payload.requireName && !payload.customerName?.trim()) {
    return {
      ok: false,
      error:
        'Give this sale a name before saving it. A draft has no document number yet, ' +
        'so the name is the only way to find it again.',
    }
  }

  /*
   * Which till this invoice was captured on, resolved from the machine.
   *
   * Nobody is asked. The device id the browser sent is matched against the
   * terminal claimed to it — the same lookup the till and the clock-in screen
   * use — so an invoice captured at a register is attributed to that register
   * and the operator who is signed in, without a picker to get wrong.
   *
   * Re-resolved on every save rather than pinned when the draft was started, so
   * an invoice begun on one machine and finished on another names the one that
   * actually finished it. Finalising saves first, so this is the machine that
   * posted it.
   *
   * ── AND IT IS REQUIRED ──────────────────────────────────────────────────
   *
   * An unclaimed machine used to resolve to null and invoice anyway, on the
   * shared number run. That is what this window is not: it is a COUNTER, with
   * the same PIN gate the till has, and it numbers from its till's own run like
   * any other counter sale.
   *
   * Refusing here rather than numbering from the shared run is the honest
   * answer, and it is the same one `finaliseOffline` gives a till that has never
   * claimed a sequence. The alternative is worse than it looks: the same window
   * would issue INV_01_01_000033 on a claimed machine and INV000012 on an
   * unclaimed one, so a shop's invoice register would carry two number shapes
   * decided by which PC somebody happened to stand at.
   */
  const terminal = payload.deviceId ? await terminalForDevice(siteId, payload.deviceId) : null
  if (!terminal) {
    return {
      ok: false,
      error:
        'This machine is not claimed to a till, so it cannot issue invoices. ' +
        'Claim it in Setup → Tills, then try again.',
    }
  }

  /*
   * ── THE DOCUMENT KEEPS ITS OWN TYPE ──────────────────────────────────────
   *
   * This used to pass `docType: 'invoice'` outright, and `saveDraft` writes
   * `doc_type` on UPDATE as well as INSERT — so saving a QUOTE through this
   * editor rewrote it into an invoice. The quote screen then redirected to
   * invoicing on the next load, `getQuote` (which filters on doc_type) stopped
   * finding it, and its validity, outcome and lost-reason were orphaned on a
   * row nothing would ever read as a quote again.
   *
   * MEASURED, not reasoned: probe-quote-savebug.mjs drove the real Save button
   * on a real quote and read doc_type back as 'invoice'.
   *
   * Read from the stored document rather than taken from the payload. The
   * editor knows which kind it is showing and could send it, but then a crafted
   * request could turn an invoice into a quote — and the server already has to
   * load the document to check it is editable, so the honest answer is free.
   */
  const existing = await getDocument(siteId, payload.documentId)
  if (!existing) return { ok: false, error: 'That document no longer exists.' }

  const result = await saveDraft(
    siteId,
    actor,
    {
      docType: existing.docType,
      documentDate: payload.documentDate,
      customerId: payload.customerId,
      customerName: payload.customerName,
      priceStructureId: payload.priceStructureId,
      terminalId: terminal.id,
      terminalCode: terminal.code,
      /*
       * ── THIS WINDOW IS A COUNTER, NOT THE BACK OFFICE ──────────────────
       *
       * It was 'back_office', which routed every invoice raised here onto the
       * shared number run (migration 099) while an invoice raised at the POS
       * numbered from its till. Two number shapes from one shop, decided by
       * which screen somebody started in.
       *
       * Worse, it was not even consistent within this window: saveDraft does
       * not rewrite `origin` on an update, so a draft STARTED at the POS and
       * finalised here kept 'till' and numbered per-till, while one started
       * here numbered from the shared run.
       *
       * 099 split them to protect numbers already printed on invoices
       * customers held. It renumbers nothing to close the split going forward:
       * every document already issued keeps the number it has.
       */
      origin: 'till',
      reference: payload.reference,
      notes: payload.notes,
      lines: toLineInputs(payload.lines),
    },
    payload.documentId,
  )

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/invoicing/${payload.documentId}`)
  revalidatePath('/invoicing')
  return { ok: true, documentId: result.id }
}

/** One payment, as the finalise dialog captured it. */
export type InvoiceTenderPayload = {
  tenderTypeId: number
  /** What the customer handed over — gross, not the amount owed. */
  amount: number
  reference?: string | null
}

export type FinaliseInvoiceResult =
  | { ok: true; documentId: number; documentNumber: string; change: number }
  | { ok: false; error: string }

/**
 * Saves, then posts the invoice.
 *
 * The invoice screen takes payment the same way the till does — cash, card,
 * account or any mix of them — because a back-office invoice is not always a
 * credit sale: plenty are settled on the spot by someone standing at the
 * counter. So the tenders come from the caller and go straight to the same
 * posting engine the till uses, which is what records them in sales_tenders,
 * moves the stock and posts the debtor ledger for whatever part went on account.
 *
 * Called with no tenders it keeps the old behaviour — the whole amount on the
 * account tender — so a pure credit invoice is still one click.
 */
export async function finaliseInvoiceAction(
  payload: InvoicePayload,
  tenders?: InvoiceTenderPayload[],
): Promise<FinaliseInvoiceResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const saved = await saveInvoiceAction(payload)
  if (!saved.ok) return saved

  const document = await getDocument(siteId, saved.documentId)
  if (!document) return { ok: false, error: 'That invoice no longer exists.' }

  // Resolved server-side rather than trusted from the screen: the amount posted
  // must come from the stored lines, not from a total the browser calculated.
  const taken = tenders?.length
    ? tenders
    : await accountTenderFor(siteId, document.customerId, document.totalIncl)

  if (!Array.isArray(taken)) return taken

  // Every tender that posts to a debtor needs an account behind it, and the
  // message should name the problem rather than let the engine say "attach a
  // customer first" about a screen with no obvious place to do that.
  if (!document.customerId) {
    const types = await listTenderTypes(siteId)
    const needsAccount = taken.some(
      (t) => types.find((x) => x.id === t.tenderTypeId)?.requiresCustomer,
    )
    if (needsAccount) {
      return {
        ok: false,
        error: 'Select a customer before finalising — this payment posts to their account.',
      }
    }
  }

  /*
   * ── Serials the TECHNICIAN chose, not this screen (§31) ──────────────────
   *
   * finaliseDocument requires one serial per unit on a serial-tracked line, and
   * takes them as an input keyed by sales line. Nothing on this screen collects
   * them — so before job cards recorded them, a serial-tracked job invoice could
   * be raised and then never finalised, refused here by a person with no way to
   * answer.
   *
   * For a JOB invoice the answer already exists: the technician named the units
   * at the van, on the line they were fitting, and jobInvoicing refuses to raise
   * the draft without them. This carries that forward.
   *
   * An empty map for an ordinary counter invoice, which is exactly what was
   * passed before — undefined and {} reach the engine identically.
   */
  const serials = await serialsForInvoice(siteId, saved.documentId)

  const result = await finaliseDocument(siteId, actor, {
    documentId: saved.documentId,
    customerId: document.customerId,
    tenders: taken,
    serials,
  })

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/invoicing/${saved.documentId}`)
  revalidatePath('/invoicing')
  /* Finalising moves the invoice from the editor to the record screen, so that
     is the URL the user lands on next — it must not serve a cached draft. */
  revalidatePath(`/sales/${saved.documentId}`)
  revalidatePath('/products')
  return {
    ok: true,
    documentId: saved.documentId,
    documentNumber: result.documentNumber,
    change: result.change,
  }
}

/**
 * The whole amount on the account tender — the default when the caller took no
 * payment. Returns the error itself rather than throwing, so the caller can
 * hand it straight back to the screen.
 */
async function accountTenderFor(
  siteId: number,
  customerId: number | null,
  totalIncl: number,
): Promise<InvoiceTenderPayload[] | { ok: false; error: string }> {
  if (!customerId) {
    return {
      ok: false,
      error: 'Select an account customer before finalising — an invoice posts to their account.',
    }
  }

  const tenders = await listTenderTypes(siteId)
  const account = tenders.find((t) => t.postsToDebtor && t.isActive)
  if (!account) {
    return {
      ok: false,
      error: 'No account payment method is set up, so this invoice cannot post to the customer.',
    }
  }

  return [{ tenderTypeId: account.id, amount: totalIncl }]
}

/**
 * The finished sale, for the dialog that opens the moment an invoice posts.
 *
 * The same record the /sales/[id] screen shows, read by the same loader — an
 * operator who has just finalised should see WHAT they finalised (lines,
 * totals, how it was paid) rather than a line of text saying it worked, and
 * showing it in a dialog keeps them on the capture screen ready for the next
 * one.
 *
 * Read-only, so it asks for `sales.view`: someone allowed to look at a sale is
 * allowed to look at the one they have this second created.
 */
export async function saleRecordAction(
  documentId: number,
): Promise<SaleRecordSnapshot | null> {
  const ctx = await actorFor('sales.view')
  if ('ok' in ctx) return null
  return loadSaleRecord(ctx.siteId, documentId)
}
