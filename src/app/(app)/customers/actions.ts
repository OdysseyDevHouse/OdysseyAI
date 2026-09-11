'use server'

import { toAccountType } from '@/lib/accountTypes'
import { toStatementCycle } from '@/lib/statementCycles'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { safeReturnTo } from '@/lib/returnTo'
import {
  requireActor,
  actorForModule,
  actorForModuleOrThrow,
  actorForOrThrow,
} from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { verifyOverrideToken } from '@/lib/overrideToken'
import { setValues } from '@/lib/site/customFields'
import type { CustomFieldEntity } from '@/lib/customFieldModel'
import {
  createCustomer,
  updateCustomer,
  deleteCustomer,
  renameCustomerCode,
  bulkUpdateCustomers,
  toCustomerStatus,
  possibleDuplicates,
  duplicateWarning,
  getCustomer,
  type BulkChange,
  type BulkResult,
  type Customer,
  type CustomerInput,
} from '@/lib/site/customers'
/* The dropdowns the dialog form renders. Same sources `/customers/new` reads
   server-side — one action so a Client Component can have them too. */
import {
  listCustomerGroups,
  listSalesReps,
  listCustomerCategories,
  type CustomerGroup,
  type SalesRep,
} from '@/lib/site/customerLookups'
import { listPriceStructures } from '@/lib/site/lookups'
import { suggestedMasterCode } from '@/lib/site/masterCodes'
import {
  saveCustomerAddress,
  deleteCustomerAddress,
  type CustomerAddressInput,
} from '@/lib/site/customerAddresses'

export type CustomerFormState = {
  error: string | null
  /**
   * "This might already be on file" — a cell number or email already used by
   * another account.
   *
   * Distinct from `error`, and the difference is the whole design: an error
   * means the save was refused, this means it was PAUSED and pressing Save
   * again will go through. A duplicate code is an error, because the code is
   * unique and there is nothing to decide; a shared cell number is this,
   * because a husband and wife on one mobile are two real customers.
   *
   * The form echoes it back as `confirmedDuplicate` on the next submit, which
   * is what makes the second press mean "yes, I read it".
   */
  duplicateWarning?: string | null
  /**
   * Everything that was typed, so the form can put it back.
   *
   * The customer form's inputs are UNCONTROLLED — defaultValue, read out of
   * FormData on submit — which is right for a form that either saves and
   * redirects or fails outright. A warning does neither: it returns to the same
   * mounted form, React re-renders, and every defaultValue snaps back to what
   * it held when the page loaded.
   *
   * Measured rather than assumed. Driving the real screen over CDP, the second
   * press posted `code= name= ack=1` — an empty form that then failed
   * validation on a blank name, so the warning made the customer harder to
   * create rather than easier.
   *
   * Only set alongside duplicateWarning. A successful save redirects and a
   * refused one keeps the live DOM values, because neither re-keys the inputs.
   */
  values?: Record<string, string> | null
}

/**
 * The submitted form as plain strings, for echoing back with a warning.
 *
 * Files and the acknowledgement itself are dropped: the ack is re-rendered from
 * the warning, and a File has no defaultValue to restore.
 */
function formValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (key === 'confirmedDuplicate') continue
    if (typeof value === 'string') values[key] = value
  }
  return values
}

function optionalId(form: FormData, key: string): number | null {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function num(form: FormData, key: string, fallback = 0): number {
  const raw = String(form.get(key) ?? '').trim()
  if (!raw) return fallback
  // A comma decimal is what a South African keyboard produces; accept it rather
  // than silently reading "1,50" as 1.
  const n = Number(raw.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : fallback
}

function text(form: FormData, key: string): string | null {
  return String(form.get(key) ?? '').trim() || null
}

function readInput(form: FormData): CustomerInput {
  return {
    code: String(form.get('code') ?? ''),
    name: String(form.get('name') ?? ''),
    status: toCustomerStatus(form.get('status')) ?? 'active',
    statusReason: text(form, 'statusReason'),
    accountType: toAccountType(form.get('accountType')),
    contactName: text(form, 'contactName'),
    email: text(form, 'email'),
    phone: text(form, 'phone'),
    addressLine1: text(form, 'addressLine1'),
    addressLine2: text(form, 'addressLine2'),
    city: text(form, 'city'),
    postalCode: text(form, 'postalCode'),
    vatNumber: text(form, 'vatNumber'),
    groupId: optionalId(form, 'groupId'),
    repId: optionalId(form, 'repId'),
    category: text(form, 'category'),
    paymentTermsDays: num(form, 'paymentTermsDays', 30),
    // Only the anchor field for the chosen cycle is rendered, so the other
    // posts nothing and falls back to its default — which is what we want.
    statementCycle: toStatementCycle(form.get('statementCycle')),
    statementAnchorDay: num(form, 'statementAnchorDay', 0),
    statementAnchorDate: text(form, 'statementAnchorDate'),
    creditLimit: num(form, 'creditLimit', 0),
    dailyLimit: num(form, 'dailyLimit', 0),
    monthlyLimit: num(form, 'monthlyLimit', 0),
    // A Checkbox posts nothing when off, so absence means false — same as
    // interestEnabled below.
    autoEmailInvoices: form.get('autoEmailInvoices') !== null,
    priceStructureId: optionalId(form, 'priceStructureId'),
    // Blank means NO standing discount — distinct from an explicit 0.
    discountPct: String(form.get('discountPct') ?? '').trim()
      ? num(form, 'discountPct', 0)
      : null,
    // A Switch posts nothing when off, so absence means false.
    interestEnabled: form.get('interestEnabled') !== null,
    interestRatePct: num(form, 'interestRatePct', 0),
    interestGraceDays: num(form, 'interestGraceDays', 0),
    notes: text(form, 'notes'),
  }
}

export async function saveCustomerAction(
  _prev: CustomerFormState,
  form: FormData,
): Promise<CustomerFormState> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  /*
   * The duplicate check, before either write.
   *
   * Skipped once the person has seen the warning and pressed Save again — the
   * hidden field carries that acknowledgement back. Without the skip the same
   * warning would reappear forever and the account could never be created,
   * which is worse than no check at all.
   *
   * It runs on EDIT as well as create: changing a customer's cell number to one
   * another account already uses is the same mistake arriving by a different
   * road. excludeId keeps an unchanged save from warning about itself.
   */
  if (form.get('confirmedDuplicate') === null) {
    const matches = await possibleDuplicates(
      siteId,
      { phone: input.phone, email: input.email },
      idRaw ? Number(idRaw) : undefined,
    )
    if (matches.length > 0) {
      return {
        error: null,
        duplicateWarning: duplicateWarning(matches),
        values: formValues(form),
      }
    }
  }

  const result = idRaw
    ? await updateCustomer(siteId, actor, Number(idRaw), input)
    : await createCustomer(siteId, actor, input)

  if (!result.ok) return { error: result.error }

  revalidatePath('/customers')

  /* Saving keeps you ON the account — it is not necessarily the end of the
     edit. What it must not do is lose the list that sent you here: the
     redirect rebuilds the URL from scratch, so without carrying `from` the
     Back arrow silently reverts to the whole book on the first save. */
  const back = safeReturnTo(form.get('returnTo'))
  redirect(
    `/customers/${result.id}?saved=1${back ? `&from=${encodeURIComponent(back)}` : ''}`,
  )
}

export async function deleteCustomerAction(form: FormData): Promise<void> {
  const ctx = await actorForModuleOrThrow('customers', 'customers.edit')
  const { siteId, actor } = ctx
  const id = Number(form.get('id'))
  if (!Number.isFinite(id) || id <= 0) redirect('/customers')

  const back = safeReturnTo(form.get('returnTo'))

  const result = await deleteCustomer(siteId, actor, id)
  if (!result.ok) {
    // Round-tripped through the URL because a fire-and-redirect action has no
    // form state to return into — the detail page renders it as a banner.
    redirect(
      `/customers/${id}?error=${encodeURIComponent(result.error)}` +
        (back ? `&from=${encodeURIComponent(back)}` : ''),
    )
  }

  revalidatePath('/customers')
  /* Back to the LIST, since the account is gone — and to the filtered one:
     deleting one of twelve is exactly when the other eleven should still be
     on screen. */
  redirect(back ? `${back}${back.includes('?') ? '&' : '?'}deleted=1` : '/customers?deleted=1')
}

/**
 * Applies one change to many accounts.
 *
 * Returns the outcome rather than redirecting, so the list screen can report
 * "38 updated, 2 skipped" with the reasons — a bulk action that silently drops
 * rows is worse than one that refuses outright.
 */
export async function bulkUpdateCustomersAction(
  ids: number[],
  change: BulkChange,
): Promise<BulkResult> {
  const ctx = await actorForModuleOrThrow('customers', 'customers.edit')
  const { siteId, actor } = ctx
  const result = await bulkUpdateCustomers(siteId, actor, ids, change)
  revalidatePath('/customers')
  return result
}

/* ── The same form, opened from a till or an invoice ─────────────────────── */

/**
 * Everything the customer form needs to render, fetched in one call.
 *
 * The dialog versions of this form are Client Components, so they cannot do
 * what `/customers/new` does and read these server-side. One action rather than
 * five keeps it to a single round trip when the dialog opens — a cashier with a
 * customer at the counter should not watch five spinners resolve.
 *
 * `sales.till` rather than `customers.edit`: this only lists groups and reps to
 * put in a dropdown, and the person opening the dialog may well be about to
 * fetch a manager to authorise the save. Refusing them the FORM would mean the
 * manager has to sign in twice — once to see the fields, once to save them.
 */
export type CustomerFormLookups = {
  groups: CustomerGroup[]
  reps: SalesRep[]
  categories: string[]
  structures: { id: number; name: string }[]
  /** Null when auto-numbering is off — the code field is then typed by hand. */
  suggestedCode: string | null
}

export async function customerFormLookupsAction(): Promise<CustomerFormLookups> {
  const { siteId } = await actorForOrThrow('sales.till')

  const [groups, reps, categories, structures, suggestedCode] = await Promise.all([
    listCustomerGroups(siteId),
    listSalesReps(siteId),
    listCustomerCategories(siteId),
    listPriceStructures(siteId),
    suggestedMasterCode(siteId, 'customer'),
  ])

  return {
    groups,
    reps,
    categories,
    structures: structures.map((s) => ({ id: s.id, name: s.name })),
    suggestedCode,
  }
}

/**
 * One customer, for the edit dialog to open on.
 *
 * `getTillCustomer` is not enough: `TillCustomer` is deliberately lean — no
 * email, no address, no notes (see tillCustomers.ts) — and a form seeded from
 * it would render those fields blank and then SAVE the blanks over what was
 * there. The full record or nothing.
 */
export async function getCustomerForDialogAction(id: number): Promise<Customer | null> {
  const { siteId } = await actorForOrThrow('sales.till')
  return getCustomer(siteId, id)
}

/**
 * Saving the customer form when it is a dialog rather than a page.
 *
 * ── WHY NOT `saveCustomerAction` ──────────────────────────────────────────
 *
 * That one ends in `redirect()`. In a dialog a redirect either navigates the
 * whole till away from a half-rung-up sale or, in an iframe, silently lands on
 * a page the opener cannot read — and either way the caller never learns the id
 * of the customer just created, which is the entire point of creating one here:
 * to attach it to the sale in front of you.
 *
 * So this returns the outcome. Everything else is deliberately the SAME
 * function: `readInput` maps the identical 30 fields, `createCustomer` and
 * `updateCustomer` are the same write path, and `possibleDuplicates` is the
 * same check. A second form that drifts from the real one is the failure this
 * is written to avoid.
 *
 * ── THE OVERRIDE ──────────────────────────────────────────────────────────
 *
 * A cashier without `customers.edit` gets a manager's PIN pad instead of a
 * refusal, and the token it mints widens THIS call only — two minutes, one
 * capability, verified server-side rather than trusted from the client. The
 * pattern and the reasoning are `withOverride` in (app)/sales/actions.ts.
 *
 * The module is still checked first and is NOT overridable: a shop that has not
 * licensed Customers cannot be PIN'd into it.
 */
export type CustomerDialogResult =
  | { ok: true; id: number; name: string }
  | { ok: false; error: string }
  /** Paused, not refused — the same two-press confirm the page form uses. */
  | { ok: false; duplicateWarning: string }

export async function saveCustomerFromDialogAction(
  form: FormData,
  overrideToken?: string,
): Promise<CustomerDialogResult> {
  const ctx = await actorForModule('customers', 'customers.view')
  if ('ok' in ctx) return ctx
  const { siteId, actor, capabilities } = ctx

  /*
   * The gate is `customers.edit`, widened by a verified manager token.
   *
   * Checked here rather than by asking `actorForModule` for it, because a
   * refusal must be distinguishable from a module problem: the client turns
   * THIS into a PIN pad, and turning "Customers is not licensed" into a PIN pad
   * would ask a manager to authorise something no PIN can fix.
   */
  let allowed = can(capabilities, 'customers.edit')
  if (!allowed && overrideToken) {
    allowed = (await verifyOverrideToken(siteId, overrideToken, 'customers.edit')) !== null
  }
  if (!allowed) {
    return {
      ok: false,
      error: 'You do not have permission to add or edit customers. Ask a manager to authorise it.',
    }
  }

  const idRaw = String(form.get('id') ?? '').trim()
  const input = readInput(form)

  // The same pause the page form applies, and skipped the same way once the
  // person has seen it and pressed Save again.
  if (form.get('confirmedDuplicate') === null) {
    const matches = await possibleDuplicates(
      siteId,
      { phone: input.phone, email: input.email },
      idRaw ? Number(idRaw) : undefined,
    )
    if (matches.length > 0) {
      return { ok: false, duplicateWarning: duplicateWarning(matches) }
    }
  }

  const result = idRaw
    ? await updateCustomer(siteId, actor, Number(idRaw), input)
    : await createCustomer(siteId, actor, input)

  if (!result.ok) return { ok: false, error: result.error }

  /* The back office is a different window that may be sitting on the list. It
     costs nothing here and means a clerk who adds an account at the counter
     sees it in Customers without a hard refresh. */
  revalidatePath('/customers')

  return { ok: true, id: result.id, name: input.name.trim() }
}

/* ── The address book (132) ──────────────────────────────────────────────── */

export type AddressActionResult = { ok: true; message: string } | { ok: false; error: string }

export async function saveCustomerAddressAction(
  customerId: number,
  input: CustomerAddressInput,
  id?: number,
): Promise<AddressActionResult> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await saveCustomerAddress(siteId, actor, customerId, input, id)
  if (!result.ok) return result

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: id ? 'Address saved.' : 'Address added.' }
}

export async function deleteCustomerAddressAction(
  customerId: number,
  id: number,
): Promise<AddressActionResult> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await deleteCustomerAddress(siteId, actor, customerId, id)
  if (!result.ok) return result

  revalidatePath(`/customers/${customerId}`)
  return { ok: true, message: 'Address removed.' }
}

/**
 * The custom fields on a customer.
 *
 * Guarded on customers.edit — the field DEFINITIONS are a setup decision, but
 * filling one in is editing the customer, which is what this capability means.
 */
export async function setCustomerCustomValuesAction(
  entity: CustomFieldEntity,
  entityId: number,
  values: { fieldId: number; value: string | null }[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('customers', 'customers.edit')
  if ('ok' in ctx) return { ok: false, error: ctx.error }
  // Pinned, as on the job: the shared panel passes the entity from the client,
  // so trusting it here would let a customers.edit holder write job fields.
  if (entity !== 'customer') return { ok: false, error: 'That is not a customer field.' }

  const result = await setValues(ctx.siteId, ctx.actor, 'customer', entityId, values)
  if (result.ok) revalidatePath(`/customers/${entityId}`)
  return result
}

/**
 * Renames a customer's account code.
 *
 * Its own capability rather than customers.edit: the code is what appears on
 * every statement and remittance the account has ever been sent, and changing
 * one is a structural act rather than a correction to a detail.
 */
export async function renameCustomerCodeAction(form: FormData): Promise<void> {
  const ctx = await actorForModuleOrThrow('customers', 'customers.rename_code')
  const { siteId, actor } = ctx
  const id = Number(form.get('id'))
  const code = String(form.get('code') ?? '')

  if (!Number.isFinite(id) || id <= 0) redirect('/customers')

  const back = safeReturnTo(form.get('returnTo'))
  const from = back ? `&from=${encodeURIComponent(back)}` : ''

  const result = await renameCustomerCode(siteId, actor, id, code)
  if (!result.ok) {
    redirect(`/customers/${id}?error=${encodeURIComponent(result.error)}${from}`)
  }

  revalidatePath('/customers')
  revalidatePath(`/customers/${id}`)
  redirect(`/customers/${id}?renamed=${encodeURIComponent(result.from)}${from}`)
}
