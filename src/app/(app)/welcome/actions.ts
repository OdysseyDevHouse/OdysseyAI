'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { setSetting, type SettingKey } from '@/lib/site/settings'
import { setLogo } from '@/lib/site/documentLogo'
import {
  createVatRate,
  updateVatRate,
  createPriceStructure,
  updatePriceStructure,
} from '@/lib/site/pricingSetup'
import { updateSiteDetails, getSite, SITE_DETAIL_LIMITS, type SiteDetails } from '@/lib/sites'
import { finishOnboarding, markStepDone, type StepKey } from '@/lib/site/onboarding'

/**
 * The first-run wizard — the server half.
 *
 * ── EVERY ACTION IS A BOUNDARY, NOT A CONVENIENCE ───────────────────────────
 *
 * Same posture as the setup screens these steps mirror: `actorFor('setup.edit')`
 * on every single one. A wizard is a screen a brand-new user is walked through,
 * which makes it exactly the screen somebody is most likely to reach with the
 * wrong permissions — and none of these endpoints care that the caller arrived
 * from the wizard rather than by constructing a POST.
 *
 * ── NOTHING HERE INVENTS A WRITE ────────────────────────────────────────────
 *
 * Each action calls the same function the permanent setup screen calls. That is
 * the rule this file is built around: the wizard asks the questions in a
 * friendlier order, and the answers land through validation that already
 * exists. A `setSetting` here refuses exactly what a `setSetting` on the
 * Purchasing screen refuses.
 */

export type StepResult = { ok: true } | { ok: false; error: string }

/**
 * Record progress and report the real outcome.
 *
 * Marking the step is deliberately NOT allowed to fail the save. The settings
 * are already written by the time this runs, and telling somebody their tax
 * rates did not save because a progress counter did not update would be a lie
 * that makes them do it twice.
 */
async function completed(siteId: number, step: StepKey): Promise<StepResult> {
  await markStepDone(siteId, step).catch(() => {})
  revalidatePath('/welcome')
  return { ok: true }
}

/**
 * Write a batch of settings, stopping at the first refusal.
 *
 * Sequential rather than parallel for the reason the purchasing screen gives:
 * one failure must stop the rest, so a typo in a later field cannot leave an
 * earlier one changed with nothing on screen saying which took.
 */
async function writeSettings(
  siteId: number,
  writes: readonly (readonly [SettingKey, string])[],
): Promise<StepResult> {
  for (const [key, value] of writes) {
    const result = await setSetting(siteId, key, value)
    if (!result.ok) return result
  }
  return { ok: true }
}

/* ── STEP: YOUR STORE ──────────────────────────────────────────────────────
 *
 * The details and the logo are two different writes to two different places —
 * the control database and this shop's own disk — and they are kept as two
 * actions for the reason store-info/actions.ts spells out at length: a local
 * store may not edit its own details but may always change its own letterhead.
 * Folding them together would make the logo unsettable on exactly the installs
 * that can still set it. */

/**
 * Field labels for the length check below — a refusal has to name the field it
 * is about, or a person with eleven boxes on screen has to guess which one.
 */
const DETAIL_LABELS: Record<keyof SiteDetails, string> = {
  companyName: 'Registered company name',
  tradingName: 'Trading name',
  registrationNumber: 'Company registration number',
  vatNumber: 'VAT number',
  address1: 'Address line 1',
  address2: 'Address line 2',
  address3: 'Address line 3',
  postalCode: 'Postal code',
  phone: 'Telephone',
  email: 'Email address',
  contactName: 'Contact person',
}

/**
 * Refuse what MySQL would silently truncate.
 *
 * Checked here rather than left to the column, for the reason store-info spells
 * out: an over-long VAT number is TRUNCATED rather than refused, and then
 * prints wrong on every tax invoice after that.
 */
function tooLong(details: SiteDetails): string | null {
  for (const [key, limit] of Object.entries(SITE_DETAIL_LIMITS) as [
    keyof SiteDetails,
    number,
  ][]) {
    const value = details[key]
    if (typeof value === 'string' && value.length > limit) {
      return `${DETAIL_LABELS[key]} must be ${limit} characters or fewer.`
    }
  }
  return null
}

export async function saveStoreDetailsAction(details: SiteDetails): Promise<StepResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  if (!details.companyName?.trim()) {
    return { ok: false, error: 'A registered company name is required.' }
  }
  const overlong = tooLong(details)
  if (overlong) return { ok: false, error: overlong }

  /* Re-read from the site's own row rather than trusting a flag from the
     client. A disabled form is a courtesy; this is the check.
     ── A LOCAL STORE IS NARROWED, NOT REFUSED ──────────────────────────────
     Refusing the whole step would be the easy reading of the rule in
     store-info/actions.ts and the wrong one: a local store MAY still set its
     own VAT number, and without one `whyTaxRateRefused` blocks it from putting
     a product on a tax rate at all — so the shop this wizard exists for could
     not price its catalogue. The posted address is IGNORED rather than blanked,
     exactly as the store-info action does it. */
  const site = await getSite(ctx.siteId)
  const isCloud = site === null || site.connectionType === 'cloud'

  let toSave = details
  if (!isCloud && site) {
    /* Started from what the site already says it is, so an unchanged column
       carries its real value — `updateSiteDetails` writes every one of them,
       and building this from the form would post a possibly-stale mirror back
       over anything support changed since. */
    toSave = {
      companyName: site.companyName,
      tradingName: site.tradingName,
      registrationNumber: site.registrationNumber,
      vatNumber: details.vatNumber,
      address1: site.address1,
      address2: site.address2,
      address3: site.address3,
      postalCode: site.postalCode,
      phone: site.phone,
      email: site.email,
      contactName: site.contactName,
    }
  }

  const saved = await updateSiteDetails(ctx.siteId, toSave, ctx.actor.userId)
  if (!saved) return { ok: false, error: 'Could not save your store details. Please try again.' }

  /* The company name and address are drawn in the app chrome and on every
     document template, so the whole layout is revalidated rather than one page. */
  revalidatePath('/', 'layout')
  return completed(ctx.siteId, 'store')
}

export async function saveLogoAction(formData: FormData): Promise<StepResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const file = formData.get('logo')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Choose an image file to upload.' }
  }

  const result = await setLogo(ctx.siteId, file)
  if (!result.ok) return result

  revalidatePath('/', 'layout')
  return { ok: true }
}

/* ── STEP: MONEY AND TAX WORDING ─────────────────────────────────────────── */

export async function saveMoneyAction(input: {
  currencyCode: string
  currencySymbol: string
  taxLabel: string
}): Promise<StepResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const written = await writeSettings(ctx.siteId, [
    ['currency_code', input.currencyCode],
    ['currency_symbol', input.currencySymbol],
    ['tax_label', input.taxLabel],
  ])
  if (!written.ok) return written

  /* The tax label heads table columns and slip lines across the app, and the
     currency reaches the cash-up denominations. Neither is scoped to one page. */
  revalidatePath('/', 'layout')
  return completed(ctx.siteId, 'money')
}

/* ── STEP: TAX RATES ──────────────────────────────────────────────────────
 *
 * The wizard edits the rates that are already there and adds new ones; it never
 * deletes. A fresh site is seeded with a default rate, and the common case is
 * confirming its percentage rather than building a tax table from nothing.
 *
 * Deletion is left to the setup screen on purpose: `deleteVatRate` has to
 * consider the products pointing at a rate, and a wizard that quietly removed a
 * rate with stock on it would be doing the one thing this flow must not. */

export async function saveTaxRatesAction(input: {
  rates: {
    id: number | null
    code: string
    name: string
    rate: number
    isDefault: boolean
  }[]
}): Promise<StepResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  for (const row of input.rates) {
    const shared = {
      vatType: 'sales' as const,
      code: row.code.trim().toUpperCase(),
      name: row.name.trim(),
      rate: row.rate,
      isDefault: row.isDefault,
      isActive: true,
    }

    const result =
      row.id === null
        ? await createVatRate(ctx.siteId, shared)
        : await updateVatRate(ctx.siteId, row.id, shared)

    if (!result.ok) return result
  }

  revalidatePath('/setup/pricing')
  revalidatePath('/products')
  return completed(ctx.siteId, 'tax')
}

/* ── STEP: PRICE TYPES ───────────────────────────────────────────────────── */

export async function savePriceTypesAction(input: {
  structures: { id: number | null; name: string; isDefault: boolean }[]
}): Promise<StepResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  for (const row of input.structures) {
    const shared = { name: row.name.trim(), isDefault: row.isDefault, isActive: true }

    const result =
      row.id === null
        ? await createPriceStructure(ctx.siteId, shared)
        : await updatePriceStructure(ctx.siteId, row.id, shared)

    if (!result.ok) return result
  }

  revalidatePath('/setup/pricing')
  revalidatePath('/products')
  return completed(ctx.siteId, 'pricing')
}

/* ── STEP: COSTING ───────────────────────────────────────────────────────── */

export async function saveCostingAction(input: { costBasis: string }): Promise<StepResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const written = await writeSettings(ctx.siteId, [['cost_basis', input.costBasis]])
  if (!written.ok) return written

  /* The same three the purchasing screen refreshes — the basis is read by the
     receiving screen and baked into the till catalogue's margin figures. */
  revalidatePath('/setup/purchasing')
  revalidatePath('/purchasing/receive')
  revalidatePath('/products')
  return completed(ctx.siteId, 'costing')
}

/* ── STEP: DECIMALS ──────────────────────────────────────────────────────── */

export async function saveDecimalsAction(input: {
  qtyDecimals: string
  costDecimals: string
}): Promise<StepResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const written = await writeSettings(ctx.siteId, [
    ['qty_decimals', input.qtyDecimals],
    ['cost_decimals', input.costDecimals],
  ])
  if (!written.ok) return written

  /* Read by the app layout into `setDisplayPrecision` for the whole tree, so
     anything short of the layout leaves stale precision on every other screen. */
  revalidatePath('/', 'layout')
  return completed(ctx.siteId, 'decimals')
}

/* ── THE STEPS THAT ONLY POINT SOMEWHERE ─────────────────────────────────────
 *
 * Numbering, locations, tenders, people and import each have a real screen with
 * more in it than a wizard step should try to reproduce — a numbering scheme
 * has per-document-type rules, and the import screen is a whole flow of its
 * own. Rebuilding a cut-down version of those inside the wizard would give a
 * shop two places to set the same thing that disagree about what is legal.
 *
 * So those steps send somebody to the real screen and record that they went.
 * `markStepDone` here means "you have been shown this", which is the honest
 * claim — the wizard cannot know whether they added a location once they are
 * on the locations screen, and pretending otherwise would put a tick against
 * work that was never done. */

export async function acknowledgeStepAction(step: StepKey): Promise<StepResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  return completed(ctx.siteId, step)
}

/**
 * Stop the redirect — both "I have finished" and "not now" land here.
 *
 * See `finishOnboarding`: the Setup hub keeps offering the wizard either way,
 * because the unfinished steps are still recorded against the other key.
 */
export async function dismissOnboardingAction(): Promise<StepResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  await finishOnboarding(ctx.siteId)
  revalidatePath('/', 'layout')
  return { ok: true }
}
