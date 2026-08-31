'use server'

import { revalidatePath } from 'next/cache'
import { actorFor, requireSite } from '@/lib/auth'
import { setLogo, clearLogo } from '@/lib/site/documentLogo'
import { updateSiteDetails, SITE_DETAIL_LIMITS, type SiteDetails } from '@/lib/sites'
import { setSetting } from '@/lib/site/settings'

/**
 * My store information — the server half.
 *
 * ── THIS IS THE BOUNDARY, NOT THE SCREEN ────────────────────────────────────
 *
 * Same posture as the stationery designer beside it. Every action re-checks the
 * capability through `actorFor`, and the cloud-only rule is re-decided here
 * from the site's own row rather than trusted from a prop: a disabled form is a
 * courtesy to the person reading it, and an action is callable by anyone who
 * can construct a POST.
 *
 * ── WHY THE LOGO IS NOT GATED THE SAME WAY AS THE DETAILS ───────────────────
 *
 * The details live in the control database and the logo lives on this shop's
 * own disk, and that difference is the whole rule. A local shop that cannot
 * reach the control panel can still change its own letterhead, because nothing
 * about that write leaves the building. See `whyLocked` below.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * Why this shop may not edit its details, or null when it may.
 *
 * ── WHY connection_type AND NOT "can I reach the control database" ──────────
 *
 * A local site with a working line CAN reach cp2_sites, and letting it write
 * there whenever the line happens to be up is the worst version of this: the
 * shop edits its address on Tuesday, is offline on Wednesday, and the mirror it
 * reads from is the copy written by the last successful READ. Whether an edit
 * sticks would depend on the weather.
 *
 * The mirror is designed to flow one way — control panel → shop — and this
 * keeps it that way. A local shop's details are changed in the control panel by
 * the people who can see both sides of that copy.
 */
function whyLocked(connectionType: string): string | null {
  if (connectionType === 'cloud') return null
  return (
    'This store keeps its own database, so its details are held in the control panel and ' +
    'changed there. Your logo is stored on this machine and can still be changed here.'
  )
}

/**
 * ── THE ONE THING A LOCAL STORE MAY STILL CHANGE ABOUT ITSELF ───────────────
 *
 * Its VAT number, and only that.
 *
 * The rule above exists because the mirror flows ONE WAY — control panel →
 * shop — and a local store writing back would make "did my edit stick" depend
 * on whether the line happened to be up. That reasoning is sound and stands for
 * the address, the trading name and the rest.
 *
 * It is the wrong answer for the VAT number, for a reason that is about the
 * product rather than the plumbing: a shop cannot put a product on a tax rate
 * until it has one (see whyTaxRateRefused), so a local store with no VAT number
 * captured cannot price its own catalogue and has to telephone somebody to be
 * allowed to. That is not a sensible thing to ask of a shop that owns its own
 * database.
 *
 * ── SO IT IS UNLOCKED, AND GATED ON BEING ONLINE INSTEAD ────────────────────
 *
 * The write goes to cp2_sites exactly as a cloud store's does — one number in
 * one place — and it simply cannot be made while the line is down. That keeps
 * the mirror one-directional: nothing is ever written locally and reconciled
 * later, so there is no race to lose. The next successful `getSite` refreshes
 * the copy on its own (lib/sites.ts writes the mirror on every read), which is
 * why nothing here has to push it.
 *
 * The cost is a window of one page render where a store that edits and then
 * immediately loses its line holds a mirror one edit stale. A VAT number is
 * captured about once in a shop's life, and `revalidatePath('/', 'layout')`
 * below closes it on the very next render.
 */
/*
 * Typed as the literal keys rather than `(keyof SiteDetails)[]`, which is what
 * lets the overlay below typecheck: `companyName` is a `string` and the nullable
 * fields are `string | null`, so a loop over the WIDE key type has to assume it
 * might be assigning null to the one field that cannot take it. Naming the keys
 * exactly also means adding one here is a deliberate act — this list is a
 * security boundary, and it should not be possible to widen it by accident.
 */
const LOCAL_EDITABLE = ['vatNumber'] as const satisfies readonly (keyof SiteDetails)[]

/** Empty means "not set" — a column holding '' would print as a blank line. */
function trimToNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

const LABELS: Record<keyof SiteDetails, string> = {
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
 * Read the form into a `SiteDetails`, or say what is wrong with it.
 *
 * Length is checked against the real column widths rather than left to the
 * database, because MySQL TRUNCATES rather than refusing — a VAT number one
 * character too long would be silently saved wrong and then printed on every
 * tax invoice. Refusing is the only safe answer.
 */
function readDetails(form: FormData): { ok: true; details: SiteDetails } | { ok: false; error: string } {
  const companyName = trimToNull(form.get('companyName'))
  if (!companyName) {
    return { ok: false, error: 'A registered company name is required — it prints on every document.' }
  }

  const details: SiteDetails = {
    companyName,
    tradingName: trimToNull(form.get('tradingName')),
    registrationNumber: trimToNull(form.get('registrationNumber')),
    vatNumber: trimToNull(form.get('vatNumber')),
    address1: trimToNull(form.get('address1')),
    address2: trimToNull(form.get('address2')),
    address3: trimToNull(form.get('address3')),
    postalCode: trimToNull(form.get('postalCode')),
    phone: trimToNull(form.get('phone')),
    email: trimToNull(form.get('email')),
    contactName: trimToNull(form.get('contactName')),
  }

  for (const [key, limit] of Object.entries(SITE_DETAIL_LIMITS) as [keyof SiteDetails, number][]) {
    const value = details[key]
    if (value && value.length > limit) {
      return { ok: false, error: `${LABELS[key]} is too long — ${limit} characters at most.` }
    }
  }

  /*
   * Deliberately the shallowest possible check. This address is where a
   * customer's invoice is emailed FROM, so a typo matters, but an address is
   * only ever proved by delivering to it — and a stricter pattern here would
   * refuse valid addresses while still admitting wrong ones.
   */
  if (details.email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(details.email)) {
    return { ok: false, error: 'That email address does not look right.' }
  }

  return { ok: true, details }
}

/**
 * Save the shop's own details to the control database.
 *
 * A cloud store saves everything. A local one saves `LOCAL_EDITABLE` — today
 * the VAT number alone — and every other field is taken from the row that is
 * already there rather than from the form, so a posted address is ignored
 * rather than trusted. See LOCAL_EDITABLE for why that one field is different.
 */
export async function saveStoreDetailsAction(form: FormData): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  // Re-read from the site's own row: the client is not asked what kind it is.
  const site = await requireSite()
  const locked = whyLocked(site.connectionType)

  const parsed = readDetails(form)
  if (!parsed.ok) return parsed

  if (locked) {
    /*
     * ── THE LOCAL PATH: ONE FIELD, AND THE REST TAKEN FROM THE MIRROR ───────
     *
     * Built by starting from what the site already says it is and overlaying
     * only the permitted keys. The other direction — taking the form and
     * blanking what is not allowed — is the one that loses data: a local store
     * reading its details out of a possibly-stale mirror would post that copy
     * back and overwrite anything support changed since.
     *
     * `updateSiteDetails` writes every column, so the unchanged ones have to
     * carry their real current values rather than nulls.
     */
    const current: SiteDetails = {
      companyName: site.companyName,
      tradingName: site.tradingName,
      registrationNumber: site.registrationNumber,
      vatNumber: site.vatNumber,
      address1: site.address1,
      address2: site.address2,
      address3: site.address3,
      postalCode: site.postalCode,
      phone: site.phone,
      email: site.email,
      contactName: site.contactName,
    }
    const merged = { ...current }
    for (const key of LOCAL_EDITABLE) merged[key] = parsed.details[key]

    /* Nothing to do — and saying so beats a success message for a write that
       would change nothing, which is what a local store gets if it edits the
       address fields the screen already showed it as read-only. */
    const touched = LOCAL_EDITABLE.some((key) => merged[key] !== current[key])
    if (!touched) {
      return { ok: false, error: locked }
    }

    let localChanged: boolean
    try {
      localChanged = await updateSiteDetails(site.id, merged, ctx.actor.userId)
    } catch (err) {
      /*
       * THE OFFLINE CASE, and the whole reason this field is gated on being
       * online rather than written locally and reconciled later. Reported as
       * what it is: there is nothing wrong with what they typed.
       */
      console.error('[store-info] could not save the VAT number', err)
      return {
        ok: false,
        error:
          'Your VAT number is kept with your store details in the control panel, so this ' +
          'needs an internet connection. Connect and try again — nothing else on this ' +
          'screen requires one.',
      }
    }

    if (!localChanged) {
      return { ok: false, error: 'This store could not be updated. It may have been archived.' }
    }

    /* The number prints on every tax invoice and gates the product tax rates,
       so the whole authenticated tree is stale — not merely this screen. The
       mirror refreshes itself on the next getSite, which this forces. */
    revalidatePath('/', 'layout')
    return { ok: true, message: 'VAT number saved.' }
  }

  let changed: boolean
  try {
    changed = await updateSiteDetails(site.id, parsed.details, ctx.actor.userId)
  } catch (err) {
    /*
     * The control database is across a line, even for a cloud site. Reported as
     * what it is rather than as a validation failure, so nobody edits the form
     * looking for the mistake — there isn't one.
     */
    console.error('[store-info] could not save site details', err)
    return {
      ok: false,
      error: 'Could not reach the control panel to save this. Check your connection and try again.',
    }
  }

  if (!changed) {
    return { ok: false, error: 'This store could not be updated. It may have been archived.' }
  }

  /*
   * The details print on documents and head the app shell, so the whole
   * authenticated tree is stale — not merely this screen.
   */
  revalidatePath('/', 'layout')
  return { ok: true, message: 'Store information saved.' }
}

/**
 * Upload the business's logo.
 *
 * A FormData rather than a typed object because a File cannot cross a server
 * action boundary any other way. The bytes are proved to be a picture by
 * magic-byte sniffing in lib/uploads.ts — an .svg renamed to .png dies there,
 * which matters because this file is rendered into documents.
 *
 * Gated on `setup.edit`, not `setup.stationery`. That capability exists because
 * stationery is MARKUP a person types which leaves the building on a customer's
 * invoice; choosing which picture is the shop's logo is not that, and the
 * person who keeps the shop's details right is the person who has its logo.
 */
export async function uploadLogoAction(form: FormData): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const file = form.get('logo')
  if (!(file instanceof File)) return { ok: false, error: 'Choose an image to upload.' }

  const result = await setLogo(ctx.siteId, file)
  if (!result.ok) return result

  // Both screens show it, and the designer renders it into its live preview.
  revalidatePath('/setup/store-info')
  revalidatePath('/setup/stationery')
  return { ok: true, message: 'Logo uploaded.' }
}

/**
 * What this shop calls its sales tax.
 *
 * ── SEPARATE FROM THE DETAILS SAVE, AND NOT BY ACCIDENT ─────────────────────
 *
 * They sit on one screen and are two different writes to two different
 * databases: the details go to cp2_sites across a line, the label goes to this
 * site's own `settings`. Folding them into one button would mean a local store
 * with no connection could not change the label either — and there is no reason
 * it should not, since nothing about that write leaves the building.
 *
 * So EVERY store may set this, cloud or local, online or not. It is the one
 * piece of the tax identity that is genuinely local. See lib/site/taxIdentity.ts.
 */
export async function saveTaxLabelAction(label: string): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await setSetting(ctx.siteId, 'tax_label', label.trim())
  if (!result.ok) return { ok: false, error: result.error }

  /* The word appears on screens, documents, slips and report headings across
     the whole app, so nothing narrower than the layout would be honest. */
  revalidatePath('/', 'layout')
  return { ok: true, message: `Tax is now called "${label.trim()}" throughout.` }
}

export async function clearLogoAction(): Promise<ActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await clearLogo(ctx.siteId)
  if (!result.ok) return result

  revalidatePath('/setup/store-info')
  revalidatePath('/setup/stationery')
  return { ok: true, message: 'Logo removed. Documents will print without one.' }
}
