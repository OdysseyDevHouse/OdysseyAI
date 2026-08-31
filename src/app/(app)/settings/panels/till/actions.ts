'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import { getNumericSetting, getSettings, setSetting } from '@/lib/site/settings'
import { getSite } from '@/lib/sites'
import {
  setBackdrop,
  clearBackdrop,
  backdropUrl,
  stockBackdropUrl,
} from '@/lib/site/posSignInArt'

/**
 * How the tills BEHAVE — as opposed to which tills there are.
 *
 * Split out of /setup/terminals when these seven panels moved to the "Till" tab
 * of /settings. That screen keeps the register list, the licences and the phone
 * unlock: what a till IS, and what it is allowed to run on. This file is what
 * every till DOES once somebody is signed in, and every setting here is
 * shop-wide rather than per machine — see the note on the undo limit for why
 * that distinction is the one that decides which file a setting belongs in.
 *
 * `TerminalActionResult` is re-declared rather than imported across the split:
 * the two files no longer share a screen, and an import back into /setup would
 * be the coupling this move exists to remove.
 */
export type TerminalActionResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * How many times a cashier may undo within one basket.
 *
 * ── WHY THE LIMIT IS SET HERE AND NOT ON THE TILL ─────────────────────────
 *
 * It is a control ON the cashier, so it cannot be a control the cashier holds.
 * `setup.edit` is the same right that adds a till or renames a register, and a
 * cashier who found this on the POS could raise their own allowance the moment it
 * refused them — which would make the whole setting theatre.
 *
 * Applies to every till in the shop, not to the register it happens to be set
 * from. The question a shop is answering is "how much quiet removal are we
 * comfortable with", and that has one answer per business rather than one per
 * machine.
 */
export async function setUndoLimitAction(limit: number): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  /* Validated by `setSetting` against the same rule the till reads through — see
     settings.ts. Passing the number as a string because that is what the settings
     table stores; a number here would be coerced somewhere less obvious. */
  const saved = await setSetting(ctx.siteId, 'pos_undo_limit', String(limit))
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/settings')
  return {
    ok: true,
    message: limit === 0 ? 'Undo is now unlimited.' : `Cashiers may undo ${limit} times per sale.`,
  }
}


/**
 * Whether the till says anything when a basket outruns the shelf.
 *
 * ── WHY THIS IS OPTIONAL AT ALL ───────────────────────────────────────────
 *
 * A shop that does not maintain its counts would be questioned several times a
 * day about figures nobody has ever reconciled. That does not make the shop
 * careless — plenty of trades genuinely do not track stock — but it does make
 * the warning noise, and noise at the payment step is worse than silence: a
 * cashier who dismisses a warning fifty times stops reading the fifty-first.
 *
 * Shop-wide rather than per till, like the undo limit and for the same reason:
 * "do we care about stock" has one answer per business.
 */
export async function setWarnOutOfStockAction(on: boolean): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setSetting(ctx.siteId, 'pos_warn_out_of_stock', on ? '1' : '0')
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/settings')
  return {
    ok: true,
    message: on
      ? 'The till will warn when a sale outruns stock on hand.'
      : 'The till will no longer mention stock at the payment step.',
  }
}

/**
 * Whether each person must be clocked on before the till will trade.
 *
 * Distinct from the shift gate, which is unconditional — see
 * `pos_force_clock_in` in settings.ts for why both exist.
 */
export async function setForceClockInAction(on: boolean): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setSetting(ctx.siteId, 'pos_force_clock_in', on ? '1' : '0')
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/settings')
  return {
    ok: true,
    message: on
      ? 'Cashiers must now clock on before they can ring up a sale.'
      : 'Cashiers can trade without clocking on.',
  }
}

/**
 * Whether the till makes a noise when something is rung up.
 *
 * Shop-wide, like the rules around it. The till applies the retail-and-
 * hospitality-only half itself, from its own mode — see `pos_scan_sounds`.
 */
export async function setScanSoundsAction(on: boolean): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setSetting(ctx.siteId, 'pos_scan_sounds', on ? '1' : '0')
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/settings')
  revalidatePath('/pos')
  return {
    ok: true,
    message: on
      ? 'Retail and hospitality tills will beep on a scan.'
      : 'The tills will ring up in silence.',
  }
}

/**
 * Whether the till returns to the PIN pad after every transaction.
 *
 * Shop-wide rather than per till, like the rules above it. The question it
 * settles — "is a slip's cashier name worth anything" — has one answer per
 * business, and a shop that shares one till usually shares all of them.
 */
export async function setReturnToLoginAction(on: boolean): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setSetting(ctx.siteId, 'pos_return_to_login', on ? '1' : '0')
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/settings')
  /* The till reads this at page load — see pos/page.tsx, where it ships with
     the rest of the shell's rules. Without this a machine already open keeps
     yesterday's answer until somebody reloads it. */
  revalidatePath('/pos')
  return {
    ok: true,
    message: on
      ? 'The till will return to the PIN pad after every sale.'
      : 'The till will stay signed in between sales.',
  }
}

/**
 * How long a till may sit untouched before it signs the operator out.
 *
 * Takes SECONDS, with 0 meaning never. The screen offers a list of durations
 * because those are the ones anybody wants; the storage is the raw number so a
 * shop asking for something off the list is a settings edit rather than a
 * deploy. See `pos_idle_logout_seconds`.
 */
export async function setIdleLogoutAction(seconds: number): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  /* Trunc rather than trust: this comes off a client select, and a fractional
     or NaN value would reach validateSetting as a string it would refuse with
     a message about whole numbers that the person never typed. */
  const whole = Math.trunc(Number(seconds))
  if (!Number.isFinite(whole)) {
    return { ok: false, error: 'Choose how long the till may sit untouched.' }
  }

  const saved = await setSetting(ctx.siteId, 'pos_idle_logout_seconds', String(whole))
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/settings')
  revalidatePath('/pos')
  return {
    ok: true,
    message:
      whole > 0
        ? `The till will sign out after ${describeIdle(whole)} of inactivity.`
        : 'The till will stay signed in however long it sits.',
  }
}

/** "30 seconds", "2 minutes" — for the sentence the save reports back. */
function describeIdle(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`
  const minutes = seconds / 60
  const rounded = Number.isInteger(minutes) ? minutes : Math.round(minutes * 10) / 10
  return `${rounded} minute${rounded === 1 ? '' : 's'}`
}

/**
 * Whether a disconnected till may still sell ON ACCOUNT.
 *
 * ── WHAT THE OWNER IS ACTUALLY AGREEING TO ────────────────────────────────
 *
 * That the till may extend credit against a limit it cannot check. A customer
 * at their ceiling when the line dropped can keep buying, and the shop finds
 * out when the queue syncs. There is no way to make that safe — a stale balance
 * is stale — so the only honest thing is to say so and let somebody decide.
 *
 * The messages below are worded as consequences rather than as state, because
 * "Offline account sales are on" tells an owner what they clicked and not what
 * it means.
 *
 * Shop-wide, like the stock warning and the undo limit: "do we trust our
 * account customers when the server is down" has one answer per business, not
 * one per till.
 */
export async function setOfflineAccountSalesAction(on: boolean): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const saved = await setSetting(ctx.siteId, 'pos_offline_account_sales', on ? '1' : '0')
  if (!saved.ok) return { ok: false, error: saved.error }

  revalidatePath('/settings')
  return {
    ok: true,
    message: on
      ? 'A till with no connection may now put a sale on account — against the balance it last saw.'
      : 'A till with no connection will refuse account sales until the line is back.',
  }
}

/* ── The sign-in screen's backdrop ───────────────────────────────────────── */

/**
 * Upload the picture behind the till's sign-in screen.
 *
 * `setup.edit` rather than `setup.stationery`, which gates the document logo:
 * that permission is about what PRINTS, and this is about what a machine on the
 * shop floor displays. They are the same job in a small shop and different
 * people in a large one, and the till screens are already this permission's.
 */
export async function uploadSignInBackdropAction(
  form: FormData,
): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const file = form.get('backdrop')
  if (!(file instanceof File)) return { ok: false, error: 'Choose an image to upload.' }

  const result = await setBackdrop(ctx.siteId, file)
  if (!result.ok) return result

  revalidatePath('/settings')
  /* Names where it shows up. A manager who has just uploaded a picture is not
     standing at a till, so "saved" alone leaves them with no way to tell
     whether it worked without walking to one. */
  revalidatePath('/pos')
  return { ok: true, message: 'Backdrop uploaded. Tills show it on the sign-in screen.' }
}

export async function clearSignInBackdropAction(): Promise<TerminalActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await clearBackdrop(ctx.siteId)
  if (!result.ok) return result

  revalidatePath('/settings')
  revalidatePath('/pos')
  return { ok: true, message: 'Backdrop removed. Tills show the standard background.' }
}

/**
 * What the seven panels render, in one read.
 *
 * New with the move out of /setup/terminals: those panels were fed by that
 * page's own server reads. As a TAB of /settings there is no page of its own,
 * so the panel asks for its state when opened — see `usePanelData`.
 *
 * One action rather than seven, because the panel needs all of it before it can
 * render anything, and seven round trips would each pay the same auth check.
 */
export type TillPanelState =
  | {
      ok: true
      undoLimit: number
      warnOutOfStock: boolean
      offlineAccountSales: boolean
      forceClockIn: boolean
      returnToLogin: boolean
      idleLogoutSeconds: number
      scanSounds: boolean
      signInBackdrop: string
      signInStock: string
    }
  | { ok: false; error: string }

export async function loadTillSettingsAction(): Promise<TillPanelState> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  /* The site's type decides which stock backdrop the panel previews. The old
     page got it free from `requireCapability`, which hands it back alongside the
     id; `actorFor` — the action-safe variant that returns rather than redirects
     — does not, so it is read here. Null is a real answer (an unclassified
     shop) and `stockBackdropUrl` falls back on it. */
  const site = await getSite(siteId)

  /* A shop-wide till rule rather than a per-register one — see setUndoLimitAction.
     Absent or unreadable means no limit, matching what the POS itself does with a
     setting it cannot read: fail open rather than start refusing corrections. */
  const undoLimit = await getNumericSetting(siteId, 'pos_undo_limit')
  const flags = await getSettings(siteId, [
    /* Absent means OFF — the opposite default to most flags here, because a shop
       that does not maintain its counts would be questioned about them all day.
       See pos_warn_out_of_stock in settings.ts. */
    'pos_warn_out_of_stock',
    /* Absent means OFF, and that default is load-bearing: turning this on means a
       till may extend credit against a limit it cannot check, which nobody should
       inherit by upgrade. See pos_offline_account_sales. */
    'pos_offline_account_sales',
    /* Absent means OFF. Turning it on can stop a cashier trading, which is not a
       rule anybody should inherit by upgrade — see pos_force_clock_in. */
    'pos_force_clock_in',
    /* When the till hands itself back to the PIN pad. Both absent means OFF: they
       cost a PIN entry per sale, which at a single-operator counter buys nothing
       — see pos_return_to_login and pos_idle_logout_seconds. */
    'pos_return_to_login',
    'pos_idle_logout_seconds',
    'pos_scan_sounds',
  ])

  return {
    ok: true,
    undoLimit: Number.isFinite(undoLimit) && (undoLimit ?? 0) > 0 ? Number(undoLimit) : 0,
    warnOutOfStock: flags.pos_warn_out_of_stock === '1',
    offlineAccountSales: flags.pos_offline_account_sales === '1',
    forceClockIn: flags.pos_force_clock_in === '1',
    returnToLogin: flags.pos_return_to_login === '1',
    /* Clamped the same way the till itself clamps it: this drives a select whose
       options are whole seconds, and a malformed row must present as Never rather
       than as a blank control with no option selected. */
    idleLogoutSeconds: Math.max(0, Math.trunc(Number(flags.pos_idle_logout_seconds)) || 0),
    scanSounds: flags.pos_scan_sounds === '1',
    /* '' where the shop has uploaded nothing, which is the common case and the
       panel's designed state rather than an empty one. */
    signInBackdrop: await backdropUrl(siteId),
    /* What the till shows when this shop has uploaded nothing — which is what the
       panel's empty frame has to draw, or it is a preview of something that does
       not happen. See stockBackdropUrl. */
    signInStock: stockBackdropUrl(site?.siteTypeId ?? null),
  }
}
