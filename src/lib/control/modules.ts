import 'server-only'
import { cache } from 'react'
import type { RowDataPacket } from 'mysql2'
import type { PoolConnection } from 'mysql2/promise'
import { query, queryOne, transaction } from '@/lib/db'
import { toNum } from '@/lib/decimals'
import { periodEnd } from '@/lib/billing/period'
import { billableDeviceCount } from './devices'

/**
 * What a site has BOUGHT.
 *
 * ── THIS IS NOT A PERMISSION ────────────────────────────────────────────────
 *
 * A module answers "does this business pay for this feature". A capability
 * answers "is this person allowed to use it". They are orthogonal and both are
 * required: buying Loyalty must not hand every cashier the member balances, and
 * granting `loyalty.view` must not conjure a feature the shop never bought.
 *
 * Keep them apart at the call site too — `requireModuleCapability()` in auth.ts
 * asks both, in that order, because "your shop has not bought this" and "your
 * role does not include this" send the reader to two different people.
 *
 * ── WHY THE RULE LIVES HERE ─────────────────────────────────────────────────
 *
 * Same reason devices.ts gives for its own: "held today" reads as three date
 * conditions but is one question, asked from the nav, from a page guard and
 * from a server action. Three copies would be three chances to disagree.
 *
 * ── WHY IT FAILS OPEN ───────────────────────────────────────────────────────
 *
 * If the control database cannot be read, every module is treated as held and
 * `degraded` is set. That is deliberate, and it is a different trade from the
 * one requireDevice.ts makes even though it lands in the same place.
 *
 * Modules gate the BACK OFFICE. A blip that hid Customers, Job Cards and the
 * Online Store would not look like a licence problem to the person it happened
 * to — it would look like the application had eaten half of itself, on a screen
 * they were working in a moment ago. Handing out a few minutes of unpaid
 * Loyalty is a far smaller failure than that.
 *
 * The revenue is protected elsewhere regardless: a customer cannot provision a
 * module for themselves, and the WRITE path below fails CLOSED — a change that
 * could not be recorded must never look like it succeeded.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * The catalogue. These strings are PERSISTED, so they are permanent — renaming
 * one orphans every row that carries it.
 *
 * No dots, deliberately: `loyalty.view` is a capability and `loyalty` is a
 * module, and the two get passed to similarly-shaped predicates. Making them
 * look different is the cheapest guard against one being handed to the other.
 */
export const MODULE_KEYS = [
  'starter',
  'inventory_advanced',
  'multi_branch',
  'customers',
  'online_store',
  'loyalty',
  'job_cards',
  'accounting',
] as const

export type ModuleKey = (typeof MODULE_KEYS)[number]

/**
 * Always held, never sold separately, cannot be removed.
 *
 * It is in the price book because it appears on the bill, but it is not
 * something a screen ever gates on: every site has it by definition, so
 * `has(e, 'starter')` is always true and a guard written against it would be
 * dead code that reads like a real check.
 */
export const BASE_MODULE: ModuleKey = 'starter'

/**
 * POS device licences: a QUANTITY, not a feature.
 *
 * Deliberately outside ModuleKey. Nothing gates on it — cp2_devices is the
 * authority for whether a till may trade, and this key exists only so the
 * licences appear as a line on the same bill as everything else.
 */
export const DEVICE_MODULE_KEY = 'pos_device'

/** Human names for the catalogue. The billing screen and /upgrade share these. */
export const MODULE_LABELS: Record<ModuleKey, string> = {
  starter: 'Starter Pack',
  inventory_advanced: 'Advanced Inventory',
  multi_branch: 'Multi-Branch',
  customers: 'Customers',
  online_store: 'Online Store',
  loyalty: 'Loyalty',
  job_cards: 'Job Cards',
  accounting: 'Accounting',
}

export type AccountStatus = 'trial' | 'active' | 'suspended' | 'closed'

export type ModuleEntitlements = {
  /** Every module live for this site today. */
  readonly held: ReadonlySet<ModuleKey>
  /** module -> its last day, for the "ends 31 August" chip. Only set ones appear. */
  readonly endingOn: ReadonlyMap<ModuleKey, string>
  /** Billed AND enforced till licences — one number, read from cp2_devices. */
  readonly deviceCount: number
  readonly accountId: number | null
  readonly accountStatus: AccountStatus | null
  /**
   * The control database could not be read, and `held` is a guess that says yes
   * to everything. Surface it rather than swallowing it: a persistent outage is
   * otherwise a persistent free upgrade that nobody finds out about.
   */
  readonly degraded: boolean
  /**
   * These entitlements came from the machine's own LEASE, not from the control
   * database — a local-backend desktop install carrying on through an outage
   * with what it was last told.
   *
   * Distinct from `degraded`, which is the unbounded guess. A leased result is
   * a remembered fact with a known age and a known expiry: it says no to a
   * module the shop never bought, and it stops entirely when the lease runs
   * out. Screens use it to show "last checked on Tuesday" rather than
   * pretending the answer is live.
   */
  readonly leased?: boolean
}

/** The one predicate. */
export function has(e: ModuleEntitlements, key: ModuleKey): boolean {
  return e.held.has(key)
}

/** For a screen reachable by more than one module. */
export function hasAny(e: ModuleEntitlements, keys: readonly ModuleKey[]): boolean {
  return keys.some((k) => e.held.has(k))
}

/**
 * The predicate the menu and the hub catalogues take.
 *
 * Accepts a plain string because a NavItem's `module` field is typed `string`,
 * not `ModuleKey` — nav.ts must not import from the control database to
 * describe a menu. An unrecognised key answers false, so a typo hides the entry
 * rather than quietly granting it.
 */
export function holder(e: ModuleEntitlements): (module: string) => boolean {
  return (module: string) => (e.held as ReadonlySet<string>).has(module)
}

/** Today, as the APP's date. See the note on the query below. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

const EVERYTHING = new Set<ModuleKey>(MODULE_KEYS)

function degradedResult(): ModuleEntitlements {
  return {
    held: EVERYTHING,
    endingOn: new Map(),
    deviceCount: 0,
    accountId: null,
    accountStatus: null,
    degraded: true,
  }
}

/**
 * What this site holds today.
 *
 * ── PER-REQUEST, NOT PER-PROCESS, AND NEVER IN THE TOKEN ────────────────────
 *
 * Memoised with React's `cache()`, so a render that reaches requireSiteUser()
 * from the layout, the page and three server components pays for one query
 * rather than five, and the memo dies with the request.
 *
 * Not a TTL cache: the app runs multi-process, so a 60-second window means two
 * tabs disagreeing about whether Loyalty is on, and a downgrade boundary that
 * lands at a different moment for each worker.
 *
 * Not the session token either. session.ts rebuilds its payload field by field
 * and silently drops anything unmapped — but the stronger reason is that a
 * 12-hour token would mean an upgrade paid for at 09:00 does not work until the
 * customer signs out and back in. Entitlements are re-read per request for the
 * same reason capabilities are.
 */
export const entitlementsForSite = cache(async (siteId: number): Promise<ModuleEntitlements> => {
  const today = todayIso()

  try {
    /* The date is bound as a parameter computed HERE, not CURDATE().
       Comparing against the database's clock while every other date in this app
       is the app server's produces a module that lapses an hour early — the
       same reasoning devices.ts gives for its expiry check, and the same fix. */
    const rows = await query<Row>(
      `SELECT sm.module_key, sm.quantity, sm.starts_on, sm.ends_on,
              ba.id AS account_id, ba.status AS account_status
         FROM cp2_site_modules sm
         LEFT JOIN cp2_billing_account_sites bas ON bas.site_id = sm.site_id
         LEFT JOIN cp2_billing_accounts ba ON ba.id = bas.account_id
        WHERE sm.site_id = ?
          AND sm.starts_on <= ?
          AND (sm.ends_on IS NULL OR sm.ends_on >= ?)
        ORDER BY sm.module_key, sm.starts_on DESC`,
      [siteId, today, today],
    )

    const account = await queryOne<Row>(
      `SELECT ba.id, ba.status
         FROM cp2_billing_account_sites bas
         JOIN cp2_billing_accounts ba ON ba.id = bas.account_id
        WHERE bas.site_id = ?
        LIMIT 1`,
      [siteId],
    )

    const accountId = account ? Number(account.id) : null
    const accountStatus = account ? (String(account.status) as AccountStatus) : null

    const held = new Set<ModuleKey>()
    const endingOn = new Map<ModuleKey, string>()
    const seen = new Set<string>()

    for (const r of rows) {
      const key = String(r.module_key)
      /* Rows are ordered by start date descending, so the first one for a
         module is the current one. Two live rows should not exist — the write
         path closes the old before opening the new — but if a double-submit
         ever produced a pair, billing one module twice is the failure to
         avoid, so the later start silently wins here and in pricing. */
      if (seen.has(key)) continue
      seen.add(key)

      if (!isModuleKey(key)) continue // pos_device, or a key from a future release
      held.add(key)
      if (r.ends_on) endingOn.set(key, String(r.ends_on).slice(0, 10))
    }

    /* A suspended account keeps the base and loses the add-ons.
       Nothing writes 'suspended' yet — but unlike the fail-open case above this
       is a decision somebody made, not a fault, and the point of suspension is
       that it takes effect. The base survives so the owner can still reach the
       screen where they settle up, matching why sites.ts lets a suspended site
       be opened at all. */
    if (accountStatus === 'suspended' || accountStatus === 'closed') {
      held.clear()
      endingOn.clear()
    }

    // Every site has the base, including one whose row predates this feature.
    held.add(BASE_MODULE)

    const result: ModuleEntitlements = {
      held,
      endingOn,
      deviceCount: await billableDeviceCount(siteId),
      accountId,
      accountStatus,
      degraded: false,
    }

    /* A real answer, so record it. This is the ONLY thing that renews a lease,
       and it is deliberately fire-and-forget: a shop must never be stopped by
       a failure to write down something it already knows. */
    void recordLease(siteId, result)

    return result
  } catch (err) {
    /* ── THE CONTROL DATABASE IS UNREACHABLE ──────────────────────────────
       On a cloud install this is a blip of seconds and the docblock above
       applies: allow everything rather than let the back office eat half of
       itself mid-task.
       A local-backend desktop install is the other case. There this is the
       ordinary state of a machine with no internet, it lasts as long as the
       line is down, and failing open forever is not degradation — it is an
       unlicensed product that works perfectly. If that machine holds a lease,
       it trades on what it was last told, until the lease runs out. */
    const leased = await leasedEntitlements(siteId)
    if (leased) return leased

    // No lease: the original trade, unchanged, said out loud.
    console.error('[modules] could not read entitlements; allowing everything', err)
    return degradedResult()
  }
})

/**
 * Write the lease, if this machine keeps one.
 *
 * Imported lazily because lease.ts imports this module's types, and a static
 * cycle between them would be resolved differently by the server and the
 * bundler. Also keeps the lease off the critical path of a cloud request that
 * will never read one.
 */
async function recordLease(siteId: number, e: ModuleEntitlements): Promise<void> {
  if (!keepsLease()) return
  try {
    const { writeLease } = await import('@/lib/licence/lease')
    const { deviceSerialForLease, licenceStatusForLease } = await import('@/lib/licence/leaseSubject')
    await writeLease({
      siteId,
      deviceSerial: await deviceSerialForLease(siteId),
      licenceStatus: await licenceStatusForLease(siteId),
      held: e.held,
      endingOn: e.endingOn,
      accountStatus: e.accountStatus,
    })
  } catch {
    /* Never let bookkeeping break a request that already succeeded. A missed
       write costs a lease that expires earlier than it might have, which is
       the safe direction to be wrong in. */
  }
}

/**
 * What the lease says, when the control database cannot answer.
 *
 * Returns null when there is no lease to read — a cloud install, a site that
 * has not run migration 178, or a machine that has never once made contact —
 * and the caller then falls back to the historical fail-open.
 */
async function leasedEntitlements(siteId: number): Promise<ModuleEntitlements | null> {
  if (!keepsLease()) return null
  try {
    const { readLease, leaseState } = await import('@/lib/licence/lease')
    const lease = await readLease(siteId)
    const state = leaseState(lease)

    /* Expired is NOT handled here. An out-of-lease machine must be stopped at
       the gate, with a screen that explains itself and offers the unlock — not
       by silently having every module vanish, which is precisely the "the app
       ate itself" failure the fail-open exists to prevent. The gate reads the
       same lease and blocks; entitlements stay permissive so that the screens
       it does allow through still render. */
    if (state.status !== 'current') return null

    return {
      held: state.lease.held,
      endingOn: state.lease.endingOn,
      /* Not carried on the lease: device COUNT is a billing input, and a stale
         one would misprice an invoice. Nothing gates on it, so zero is honest
         here in a way a remembered number would not be. */
      deviceCount: 0,
      accountId: null,
      accountStatus: state.lease.accountStatus,
      degraded: false,
      leased: true,
    }
  } catch {
    return null
  }
}

/**
 * Does this installation keep a lease at all?
 *
 * Only a desktop build does. A cloud install reaches the control database over
 * the same network as everything else it needs, so a lease there would be a
 * table that is written on every request and read on none.
 */
function keepsLease(): boolean {
  return process.env.APP_MODE === 'desktop'
}

function isModuleKey(key: string): key is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(key)
}

/**
 * Which of these sites hold `key` today.
 *
 * For cross-store work, where the question is asked about the other end of an
 * operation rather than about the caller. Multi-Branch needs it on BOTH sites:
 * a store that declined the module must neither send a product edit nor receive
 * one, or "declined" would only mean "declined in one direction".
 *
 * ── NO LEASE HERE, DELIBERATELY ─────────────────────────────────────────────
 *
 * entitlementsForSite() falls back to the machine's lease when the control
 * database is unreachable. This cannot, and should not try.
 *
 * A lease records what ONE machine was told about ITS OWN site. It says nothing
 * about a sibling store, and a desktop install holds no database but its own —
 * so there is nothing local to consult about the other end of a cross-store
 * operation.
 *
 * That leaves the historical fail-open below, and it is the right answer for a
 * different reason than it is elsewhere: cross-store work already requires
 * reaching the OTHER site's database, which a machine that cannot reach the
 * control database almost certainly cannot reach either. The operation fails on
 * its own merits a moment later, with an error about the store it could not
 * reach rather than a misleading one about a module nobody withdrew.
 */
export async function allHold(siteIds: number[], key: ModuleKey): Promise<Set<number>> {
  if (siteIds.length === 0) return new Set()
  const today = todayIso()

  try {
    const placeholders = siteIds.map(() => '?').join(',')
    const rows = await query<Row>(
      `SELECT DISTINCT site_id
         FROM cp2_site_modules
        WHERE site_id IN (${placeholders})
          AND module_key = ?
          AND starts_on <= ?
          AND (ends_on IS NULL OR ends_on >= ?)`,
      [...siteIds, key, today, today],
    )
    return new Set(rows.map((r) => Number(r.site_id)))
  } catch (err) {
    // Fail open, consistently with entitlementsForSite.
    console.error('[modules] could not read group entitlements; allowing all', err)
    return new Set(siteIds)
  }
}

export type BillingAccount = {
  id: number
  name: string
  billingEmail: string | null
  billingContact: string | null
  vatNumber: string | null
  billingDay: number
  status: AccountStatus
  currency: string
}

export type AccountSite = {
  siteId: number
  siteCode: string
  displayName: string
}

/** The account a site is billed to. Null when nothing has been set up yet. */
export const accountForSite = cache(async (siteId: number): Promise<BillingAccount | null> => {
  const row = await queryOne<Row>(
    `SELECT ba.id, ba.name, ba.billing_email, ba.billing_contact, ba.vat_number,
            ba.billing_day, ba.status, ba.currency
       FROM cp2_billing_account_sites bas
       JOIN cp2_billing_accounts ba ON ba.id = bas.account_id
      WHERE bas.site_id = ?
      LIMIT 1`,
    [siteId],
  )
  if (!row) return null
  return toAccount(row)
})

function toAccount(row: Row): BillingAccount {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    billingEmail: (row.billing_email as string | null) ?? null,
    billingContact: (row.billing_contact as string | null) ?? null,
    vatNumber: (row.vat_number as string | null) ?? null,
    billingDay: Number(row.billing_day ?? 1),
    status: String(row.status ?? 'trial') as AccountStatus,
    currency: String(row.currency ?? 'ZAR'),
  }
}

/**
 * Every site on an account.
 *
 * Callers that render this to a user must intersect it with the sites that user
 * may actually open — an account is a billing fact, not an access grant, and a
 * screen listing all ten stores of a group would otherwise let a single-store
 * manager see the other nine. The billing page does that intersection.
 */
export async function sitesForAccount(accountId: number): Promise<AccountSite[]> {
  const rows = await query<Row>(
    `SELECT s.id, s.site_code, s.company_name, s.trading_name
       FROM cp2_billing_account_sites bas
       JOIN cp2_sites s ON s.id = bas.site_id
      WHERE bas.account_id = ?
      ORDER BY s.company_name, s.id`,
    [accountId],
  )
  return rows.map((r) => ({
    siteId: Number(r.id),
    siteCode: String(r.site_code ?? ''),
    displayName: String(r.trading_name || r.company_name || ''),
  }))
}

/** A site's module rows as the billing screen lists them — including ended ones. */
export type Holding = {
  siteId: number
  moduleKey: string
  quantity: number
  startsOn: string
  endsOn: string | null
  agreedPrice: number | null
}

/** Live holdings for several sites at once, for the billing screen's grid. */
export async function holdingsForSites(siteIds: number[]): Promise<Holding[]> {
  if (siteIds.length === 0) return []
  const today = todayIso()
  const placeholders = siteIds.map(() => '?').join(',')

  const rows = await query<Row>(
    `SELECT site_id, module_key, quantity, starts_on, ends_on, agreed_price
       FROM cp2_site_modules
      WHERE site_id IN (${placeholders})
        AND starts_on <= ?
        AND (ends_on IS NULL OR ends_on >= ?)
      ORDER BY site_id, module_key, starts_on DESC`,
    [...siteIds, today, today],
  )

  // Latest start wins, as in entitlementsForSite — so a stray overlapping pair
  // shows one line on the bill rather than charging for two.
  const seen = new Set<string>()
  const out: Holding[] = []
  for (const r of rows) {
    const siteId = Number(r.site_id)
    const moduleKey = String(r.module_key)
    const dedupe = `${siteId}:${moduleKey}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)

    out.push({
      siteId,
      moduleKey,
      quantity: Number(r.quantity ?? 1),
      startsOn: String(r.starts_on).slice(0, 10),
      endsOn: r.ends_on ? String(r.ends_on).slice(0, 10) : null,
      agreedPrice: r.agreed_price === null ? null : toNum(r.agreed_price),
    })
  }
  return out
}

/**
 * Till licences: what a store PAYS for, and what may actually trade.
 *
 * Two numbers on purpose. `requested` is the order the billing screen took;
 * `provisioned` counts the cp2_devices rows that pass the same entitlement test
 * the till itself is held to. Between ordering and payment they differ, and the
 * screen says so — see sql/tickets/009_requested_devices.sql for why this is
 * not simply a count of the register.
 */
export type DeviceOrder = {
  siteId: number
  requested: number
  provisioned: number
  /** Set when an increase is awaiting payment. */
  pendingFrom: string | null
}

export async function deviceOrdersFor(siteIds: number[]): Promise<DeviceOrder[]> {
  if (siteIds.length === 0) return []
  const placeholders = siteIds.map(() => '?').join(',')

  const [orders, provisioned] = await Promise.all([
    query<Row>(
      `SELECT site_id, requested, pending_from FROM cp2_site_device_orders
        WHERE site_id IN (${placeholders})`,
      [...siteIds],
    ),
    Promise.all(siteIds.map((id) => billableDeviceCount(id))),
  ])

  const byId = new Map(orders.map((o) => [Number(o.site_id), o]))
  return siteIds.map((siteId, i) => {
    const row = byId.get(siteId)
    return {
      siteId,
      /* No row means nobody has been through the billing screen yet. One till
         is the honest default: the Starter Pack includes it, so the shop is not
         billed for it either way, and zero would read as "cannot sell". */
      requested: row ? Number(row.requested) : 1,
      provisioned: provisioned[i] ?? 0,
      pendingFrom: row?.pending_from ? String(row.pending_from).slice(0, 10) : null,
    }
  })
}

/**
 * Record how many tills a store is buying.
 *
 * An INCREASE is marked pending: it is an order, not a licence, and nothing may
 * trade on it until payment confirms and `provisionDevices` runs. A DECREASE
 * takes effect at once and clears any pending flag — handing a licence back is
 * not a purchase and needs nobody's approval.
 */
export async function setRequestedDevices(
  siteId: number,
  requested: number,
  actor: ChangeActor,
): Promise<ModuleChange> {
  const want = Math.max(1, Math.min(99, Math.floor(requested)))
  const today = todayIso()

  return transaction(async (tx) => {
    const [existing] = await tx.execute(
      'SELECT requested FROM cp2_site_device_orders WHERE site_id = ? FOR UPDATE',
      [siteId],
    )
    const current = Number((existing as Row[])[0]?.requested ?? 1)
    const increasing = want > current

    await tx.execute(
      `INSERT INTO cp2_site_device_orders (site_id, requested, pending_from, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE requested = VALUES(requested),
                               pending_from = VALUES(pending_from),
                               updated_by = VALUES(updated_by)`,
      [siteId, want, increasing ? today : null, actor.name ?? actor.email ?? null],
    )

    return { ok: true as const, effectiveOn: today }
  })
}

/**
 * Turn a PAID-FOR order into licences that may actually trade.
 *
 * ── THE ONE PLACE THIS REPO WRITES cp2_devices ROWS ─────────────────────────
 *
 * Everywhere else the rule holds: the register belongs to the v2 backend and
 * this app only reads it. The exception is deliberate and narrow — a licence is
 * created here ONLY after payment has been confirmed, which is what stops the
 * stepper being a way to licence tills for free.
 *
 * Call it from whatever confirms payment. Today that is an owner-only button on
 * the billing screen; when the gateway lands, the webhook calls this same
 * function and the button goes away. Nothing else about it changes.
 *
 * Rows are created UNCLAIMED (`serial_number` NULL) — a paid spot with no
 * machine in it yet, which is exactly what a till is allowed to claim.
 */
export async function provisionDevices(
  siteId: number,
  actor: ChangeActor,
): Promise<{ ok: true; created: number; released: number } | { ok: false; error: string }> {
  return transaction(async (tx) => {
    const [orderRows] = await tx.execute(
      'SELECT requested FROM cp2_site_device_orders WHERE site_id = ? FOR UPDATE',
      [siteId],
    )
    const order = (orderRows as Row[])[0]
    if (!order) return { ok: false as const, error: 'That store has no till order to confirm.' }

    const want = Number(order.requested)

    const [liveRows] = await tx.execute(
      `SELECT id, serial_number FROM cp2_devices
        WHERE site_id = ? AND status = 'active'
          AND (is_paid = 1 OR (expiry_date IS NOT NULL AND expiry_date >= CURDATE()))
        ORDER BY serial_number IS NULL DESC, id DESC`,
      [siteId],
    )
    const live = liveRows as Row[]
    let created = 0
    let released = 0

    if (want > live.length) {
      for (let i = live.length; i < want; i++) {
        await tx.execute(
          `INSERT INTO cp2_devices (site_id, device_name, serial_number, status, is_paid)
           VALUES (?, ?, NULL, 'active', 1)`,
          [siteId, `Till ${i + 1}`],
        )
        created++
      }
    } else if (want < live.length) {
      /* Retire the UNCLAIMED spots first — ordered above so they come first.
         Retiring a claimed one would stop a till that is trading right now, and
         a shop reducing its licence count is not asking for that. If every
         remaining licence is claimed, the reduction stops here and the shop
         releases a machine itself under Setup → Tills. */
      for (const row of live) {
        if (live.length - released <= want) break
        if (row.serial_number) continue
        await tx.execute("UPDATE cp2_devices SET status = 'inactive' WHERE id = ?", [row.id])
        released++
      }
    }

    await tx.execute('UPDATE cp2_site_device_orders SET pending_from = NULL WHERE site_id = ?', [
      siteId,
    ])

    await logChange(tx, {
      accountId: null,
      siteId,
      key: DEVICE_MODULE_KEY,
      action: 'quantity_changed',
      effectiveOn: todayIso(),
      actor,
    })

    return { ok: true as const, created, released }
  })
}

/** module_key -> unit price today. Feeds the pure pricing function. */
export async function currentPrices(): Promise<Record<string, number>> {
  const today = todayIso()
  const rows = await query<Row>(
    `SELECT module_key, unit_price, effective_from
       FROM cp2_module_prices
      WHERE effective_from <= ?
        AND (effective_to IS NULL OR effective_to >= ?)
      ORDER BY module_key, effective_from DESC`,
    [today, today],
  )

  // First row per module wins: latest effective_from. The unique key stops two
  // prices starting on the same day, but two open-ended rows with different
  // start dates are expressible, and "whichever the optimiser returned" is not
  // an acceptable answer to what something costs.
  const book: Record<string, number> = {}
  for (const r of rows) {
    const key = String(r.module_key)
    if (key in book) continue
    book[key] = toNum(r.unit_price)
  }
  return book
}

/* ── Writes ─────────────────────────────────────────────────────────────────
 *
 * These fail CLOSED, unlike the reads above. A module change that could not be
 * recorded must not report success: the customer would believe they had bought
 * something, and nothing would be billed or granted.
 */

export type ModuleChange = { ok: true; effectiveOn: string } | { ok: false; error: string }

export type ChangeActor = { name: string | null; email: string | null }

/**
 * Add a module. Takes effect IMMEDIATELY — upgrades are not made to wait.
 *
 * If a row exists that is merely scheduled to end, this cancels the removal
 * rather than opening a second row: the customer never lost access, so there is
 * nothing to restart, and their agreed price survives untouched.
 */
export async function addModule(
  siteId: number,
  key: ModuleKey,
  actor: ChangeActor,
  accountId: number | null,
): Promise<ModuleChange> {
  if (key === BASE_MODULE) {
    return { ok: false, error: 'The Starter Pack is part of every store’s plan.' }
  }

  const today = todayIso()

  return transaction(async (tx) => {
    const [existing] = await tx.execute(
      `SELECT id, ends_on FROM cp2_site_modules
        WHERE site_id = ? AND module_key = ?
          AND starts_on <= ?
          AND (ends_on IS NULL OR ends_on >= ?)
        ORDER BY starts_on DESC LIMIT 1
        FOR UPDATE`,
      [siteId, key, today, today],
    )
    const live = (existing as Row[])[0]

    if (live) {
      if (!live.ends_on) return { ok: true as const, effectiveOn: today } // already held
      await tx.execute('UPDATE cp2_site_modules SET ends_on = NULL WHERE id = ?', [live.id])
      await logChange(tx, {
        accountId,
        siteId,
        key,
        action: 'removal_cancelled',
        effectiveOn: today,
        actor,
      })
      return { ok: true as const, effectiveOn: today }
    }

    /* agreed_price stays NULL so the row takes today's book price. Pinning it
       here would freeze a new sale at a rate nobody negotiated; grandfathering
       is a deliberate act, applied to existing rows. */
    await tx.execute(
      `INSERT INTO cp2_site_modules (site_id, module_key, quantity, starts_on, created_by)
       VALUES (?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE ends_on = NULL`,
      [siteId, key, today, actor.name ?? actor.email ?? null],
    )
    await logChange(tx, { accountId, siteId, key, action: 'added', effectiveOn: today, actor })

    return { ok: true as const, effectiveOn: today }
  })
}

/**
 * Remove a module at the END of the period the customer has already paid for.
 *
 * Access continues until then. No proration, no credit note, and nothing to run
 * on the night — see the note on cp2_site_modules in the migration for why the
 * absence of a scheduled job is the point rather than a shortcut.
 */
export async function scheduleRemoval(
  siteId: number,
  key: ModuleKey,
  actor: ChangeActor,
  accountId: number | null,
  billingDay: number,
): Promise<ModuleChange> {
  if (key === BASE_MODULE) {
    return { ok: false, error: 'The Starter Pack cannot be removed.' }
  }

  const today = todayIso()
  const endsOn = periodEnd(today, billingDay)

  return transaction(async (tx) => {
    const [existing] = await tx.execute(
      `SELECT id FROM cp2_site_modules
        WHERE site_id = ? AND module_key = ?
          AND starts_on <= ?
          AND (ends_on IS NULL OR ends_on >= ?)
        ORDER BY starts_on DESC LIMIT 1
        FOR UPDATE`,
      [siteId, key, today, today],
    )
    const live = (existing as Row[])[0]
    if (!live) return { ok: true as const, effectiveOn: endsOn } // not held; nothing to do

    await tx.execute('UPDATE cp2_site_modules SET ends_on = ? WHERE id = ?', [endsOn, live.id])
    await logChange(tx, {
      accountId,
      siteId,
      key,
      action: 'scheduled_removal',
      effectiveOn: endsOn,
      actor,
    })

    return { ok: true as const, effectiveOn: endsOn }
  })
}

type LogInput = {
  accountId: number | null
  siteId: number
  key: string
  action: 'added' | 'scheduled_removal' | 'removal_cancelled' | 'quantity_changed' | 'removed'
  effectiveOn: string
  actor: ChangeActor
}

async function logChange(tx: PoolConnection, input: LogInput): Promise<void> {
  await tx.execute(
    `INSERT INTO cp2_module_change_log
       (account_id, site_id, module_key, action, effective_on, actor_name, actor_email)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.accountId,
      input.siteId,
      input.key,
      input.action,
      input.effectiveOn,
      input.actor.name,
      input.actor.email,
    ],
  )
}

/**
 * Re-exported so callers that already import from here get the same date the
 * server writes, rather than reimplementing "end of period" a second time.
 */
export { periodEnd } from '@/lib/billing/period'
