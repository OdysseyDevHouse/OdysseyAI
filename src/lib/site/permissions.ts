import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'

/**
 * Who may do what.
 *
 * Permissions hang off a ROLE, and roles are defined per site (see 041). The
 * earlier version keyed on the three-value `cp2_user_sites.site_role` ENUM and
 * argued against per-user data on the grounds that a row keyed to an upstream
 * id goes stale the day someone is removed upstream. That reasoning is what
 * moved the user row into the site database rather than what stopped it: the
 * local `users` row is now the identity, so nothing upstream can silently
 * invalidate it.
 *
 * Two rules survive unchanged from that version, because both were right:
 *
 *   DENY BY DEFAULT. A missing row is a no. A permission that defaults to
 *   "allowed" is how a till ends up letting a junior cashier void yesterday's
 *   takings.
 *
 *   THE OWNER CANNOT BE REDUCED. Someone has to be able to put a permission
 *   back. The owner role holds everything implicitly — not as stored rows,
 *   which could be deleted — and the UI refuses to edit or delete it.
 */

/**
 * Capabilities, grouped by the module they guard.
 *
 * `.view` is the right to open the screens at all and is what gates the menu;
 * `.edit` is the right to change what is on them. They are separate because
 * "may look at what we paid for stock" and "may change what we charge for it"
 * are genuinely different questions, and a shop that cannot express the
 * difference ends up granting the second to get the first.
 */
export const CAPABILITY_GROUPS = [
  {
    key: 'sales',
    label: 'Sales & till',
    capabilities: [
      { key: 'sales.till', label: 'Use the till', hint: 'Sign in to the point of sale and ring up sales.' },
      { key: 'sales.view', label: 'View sales', hint: 'Open the sales list, invoices and quotes.' },
      { key: 'sales.edit', label: 'Create and edit sales', hint: 'Raise quotes, orders and invoices in the back office.' },
      { key: 'sales.void', label: 'Void a sale', hint: 'Cancel a finalised invoice on the same trading day.' },
      { key: 'sales.credit_note', label: 'Raise a credit note', hint: 'Reverse all or part of an invoice after the day it was issued.' },
      { key: 'sales.edit_finalised', label: 'Correct a finalised invoice', hint: 'Reverses and re-posts it. Leave off until the correction path is proven.' },
      { key: 'sales.discount_override', label: 'Discount beyond the product limit', hint: 'Exceed a product’s maximum discount percentage.' },
      { key: 'sales.price_override', label: 'Change a price at the till', hint: 'Sell at something other than the price structure figure.' },
      { key: 'sales.cashup', label: 'Cash up', hint: 'Close a shift and record the drawer count.' },
      // Separate from sales.cashup deliberately, and OFF for a cashier.
      //
      // Counting a drawer against a figure you can already see is copying, not
      // counting — so by default the cash-up withholds what each tender should
      // hold until a number has been committed for it. This grants the other
      // way of working: the expected figures are on screen from the start and
      // the difference resolves as you type.
      //
      // That is right for the person CHECKING a shift and wrong for the person
      // being checked, which is exactly why it is a permission rather than a
      // setting — the same screen has to behave differently for two people.
      { key: 'sales.cashup_expected', label: 'See expected figures while cashing up', hint: 'Show what each tender should hold before it is counted, instead of a blind count.' },
      // Separate from sales.cashup deliberately, and OFF for a cashier.
      //
      // Everyone who may cash up may cash up THEIR OWN drawer — that is
      // `sales.cashup`, and the till fills the owner in for them. This is the
      // right to name somebody else: to count till 3 while signed in on till 1,
      // or to close a colleague's takings when they have gone home.
      //
      // It matters because the owner is who the variance belongs to. A shift
      // signed off R200 short is a question somebody has to answer, and letting
      // any cashier put a different name on that is how the question reaches
      // the wrong person. Without this the field is filled in and locked.
      { key: 'sales.cashup_other', label: 'Cash up on behalf of someone else', hint: 'Choose whose takings are being counted, instead of only your own till or drawer.' },
      { key: 'contracts.view', label: 'View contracts', hint: 'Open recurring billing agreements and see what they have billed.' },
      { key: 'contracts.edit', label: 'Create and edit contracts', hint: 'Set up recurring billing, its products, escalation and billing day.' },
      // Separate from contracts.edit deliberately. Editing a contract changes
      // what WILL be billed and somebody can still review it; turning on
      // automatic sending means invoices post to a customer's account and reach
      // them with nobody in the loop. That is a different decision, and a shop
      // should be able to let a clerk maintain contracts without granting it.
      { key: 'contracts.auto_send', label: 'Let a contract bill and send itself', hint: 'Turn on automatic invoicing, which posts and emails with no review.' },
      // Separate from sales.view/sales.edit deliberately. Tonight's book is
      // worked by front-of-house — the person on the phone and the one seating
      // parties — and that is not the same person who may raise an invoice. A
      // shop should be able to let a host run the door without also granting
      // them the sales ledger.
      { key: 'reservations.view', label: 'View reservations', hint: 'Open the booking diary and see tonight’s tables.' },
      { key: 'reservations.edit', label: 'Take and manage bookings', hint: 'Confirm, seat and cancel bookings, and take one over the phone.' },
    ],
  },
  {
    key: 'products',
    label: 'Products',
    capabilities: [
      { key: 'products.view', label: 'View products', hint: 'Open the product list and look up prices.' },
      { key: 'products.edit', label: 'Create and edit products', hint: 'Add products, change descriptions and set prices.' },
      { key: 'products.delete', label: 'Delete products', hint: 'Remove a product from the catalogue.' },
      /* Renaming a code is not a stronger flavour of editing. A code is how
         stock is identified everywhere — on shelf labels, in supplier
         paperwork, in another store's share settings — so changing one is a
         structural act, and whoever fixes descriptions all day should not be
         able to perform it in passing. */
      { key: 'products.rename_code', label: 'Rename a stock code', hint: 'Change a product’s code. Past documents keep the old one.' },
      { key: 'products.cost', label: 'See cost prices', hint: 'View what stock was bought for, and the margin.' },
    ],
  },
  {
    key: 'customers',
    label: 'Customers',
    capabilities: [
      { key: 'customers.view', label: 'View customers', hint: 'Open the customer list and account history.' },
      { key: 'customers.edit', label: 'Create and edit customers', hint: 'Add accounts and change their details.' },
      { key: 'customers.credit', label: 'Set credit terms', hint: 'Change credit limits, terms and account locks.' },
      { key: 'customers.rename_code', label: 'Rename a customer code', hint: 'Change an account’s code. Past documents keep the old one.' },
    ],
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    capabilities: [
      { key: 'suppliers.view', label: 'View suppliers', hint: 'Open the supplier list and account history.' },
      { key: 'suppliers.edit', label: 'Create and edit suppliers', hint: 'Add suppliers and change their details.' },
      { key: 'suppliers.rename_code', label: 'Rename a supplier code', hint: 'Change a supplier’s code. Past documents keep the old one.' },
    ],
  },
  {
    key: 'purchasing',
    label: 'Purchasing',
    capabilities: [
      { key: 'purchasing.view', label: 'View purchasing', hint: 'Open orders, goods received and supplier invoices.' },
      { key: 'purchasing.edit', label: 'Create and edit purchases', hint: 'Raise orders and receive stock.' },
      { key: 'purchasing.approve', label: 'Approve large orders', hint: 'Issue orders over the approval threshold set in Setup → Purchasing.' },
      { key: 'purchasing.pay', label: 'Pay suppliers', hint: 'Allocate payments and run payment batches.' },
      /* Separate from purchasing.edit because it SPENDS. Scanning a document
         draws on the shop's AI credits, and a shop may reasonably want everyone
         receiving stock while only a supervisor spends — the same split
         reports.ai already makes against reports.build. */
      { key: 'purchasing.ai', label: 'Scan a supplier document with AI', hint: 'Read a PDF invoice or delivery note into lines. Uses a paid AI call.' },
    ],
  },
  {
    key: 'stock',
    label: 'Stock',
    capabilities: [
      { key: 'stock.view', label: 'View stock', hint: 'See quantities on hand and movement history.' },
      { key: 'stock.adjust', label: 'Adjust stock', hint: 'Write stock on or off, and count it.' },
      // Separate from stock.adjust deliberately, and OFF for whoever counts.
      //
      // A threshold that the counter can clear themselves is not a control —
      // it is a second click. The whole value of the gate is that a large
      // variance is seen by somebody who was not holding the tablet, which
      // only happens if the two rights can be held by different people.
      //
      // Same shape as sales.cashup vs sales.cashup_blind: one screen behaving
      // differently for the person being checked and the person checking.
      {
        key: 'stock.approve_variance',
        label: 'Sign off a large count variance',
        hint: 'Approve stock-take lines that cross the variance threshold, so the count can post.',
      },
      { key: 'stock.transfer', label: 'Transfer stock', hint: 'Move stock between locations or stores.' },
    ],
  },
  {
    key: 'cashbook',
    label: 'Cashbook & banking',
    capabilities: [
      { key: 'cashbook.view', label: 'View the cashbook', hint: 'Open bank accounts and their transactions.' },
      { key: 'cashbook.edit', label: 'Capture cashbook entries', hint: 'Record receipts, payments and transfers.' },
      { key: 'cashbook.reconcile', label: 'Reconcile the bank', hint: 'Match transactions against a bank statement.' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    capabilities: [
      { key: 'dashboard.view', label: 'View the dashboard', hint: 'The sales overview on the home screen.' },
      { key: 'reports.view', label: 'Run reports', hint: 'Sales, stock and account reports.' },
      { key: 'reports.financial', label: 'Run financial reports', hint: 'Turnover, margin and profitability figures.' },
      { key: 'reports.build', label: 'Build custom reports', hint: 'Compose a report from any data the user may already see, and save it for everyone.' },
      { key: 'reports.schedule', label: 'Schedule reports by email', hint: 'Send a report to people on a timer. It runs unattended, so grant it deliberately.' },
      { key: 'reports.ai', label: 'Generate a report with AI', hint: 'Describe a report in plain English and have it built. Uses a paid AI call.' },
    ],
  },
  {
    key: 'online',
    label: 'Online store',
    capabilities: [
      { key: 'online.view', label: 'View the online store', hint: 'Open online orders and store content.' },
      { key: 'online.edit', label: 'Manage the online store', hint: 'Change the storefront, content and what is listed.' },
    ],
  },
  {
    key: 'loyalty',
    label: 'Loyalty',
    capabilities: [
      { key: 'loyalty.view', label: 'View loyalty', hint: 'See members, balances, tiers and punch cards.' },
      { key: 'loyalty.edit', label: 'Set up the programme', hint: 'Change the rates, the tier ladder and the punch cards.' },
      /* Separate from `edit` on purpose: points and wallet rand are money. The
         supervisor who tunes the earn rate once a year is rarely the person who
         should be able to put 10 000 points on their own account. */
      { key: 'loyalty.adjust', label: 'Adjust balances', hint: 'Hand out points, issue vouchers and reverse a refunded sale.' },
    ],
  },
  {
    key: 'giftcards',
    label: 'Gift cards',
    capabilities: [
      { key: 'giftcards.view', label: 'View gift cards', hint: 'See cards, balances and their history.' },
      /* The loyalty.adjust separation, for the same reason: a card balance is
         money, and the person who lists cards is rarely the one who should be
         able to put value on one with no sale behind it. */
      { key: 'giftcards.manage', label: 'Manage gift cards', hint: 'Generate, adjust, cancel and expire cards.' },
    ],
  },
  {
    key: 'commission',
    label: 'Commission',
    capabilities: [
      { key: 'commission.view_own', label: 'See their own commission', hint: 'What this person earned, and on which sales.' },
      { key: 'commission.view_all', label: 'See everyone’s commission', hint: 'Every salesperson’s figures, not just their own.' },
      { key: 'commission.edit', label: 'Set commission rules', hint: 'Decide the rates, tiers and what they apply to.' },
      { key: 'commission.run', label: 'Run and lock commission', hint: 'Calculate a period and freeze it for payment.' },
    ],
  },
  {
    key: 'staff',
    label: 'Staff',
    capabilities: [
      { key: 'staff.view_own', label: 'See their own hours and leave', hint: 'What they worked, and what leave they have left.' },
      { key: 'staff.view_all', label: 'See everyone’s hours and leave', hint: 'The whole team’s attendance, not just their own.' },
      { key: 'staff.clock', label: 'Clock in and out', hint: 'Record their own start and end of day at the till.' },
      { key: 'staff.edit', label: 'Correct hours and leave', hint: 'Amend a time entry somebody got wrong, or capture leave on their behalf.' },
      { key: 'staff.approve', label: 'Approve leave and timesheets', hint: 'Sign off what gets paid.' },
      /* Split from view_all deliberately, exactly as products.cost is split
         from products.view: a supervisor checking who worked Saturday should
         not thereby learn what everybody earns. */
      { key: 'staff.cost', label: 'See pay rates and staff cost', hint: 'What each person is paid, and what they cost the business.' },
      { key: 'staff.run', label: 'Run and lock a pay period', hint: 'Freeze a period’s figures once they have been paid.' },
    ],
  },
  {
    key: 'jobs',
    label: 'Job cards',
    capabilities: [
      { key: 'jobs.view', label: 'See job cards', hint: 'Open the job list and read a job.' },
      /* Split from view, exactly as commission and staff split their own: a
         technician who must see today's work should not thereby be able to
         reassign it or change what a customer is being charged. */
      { key: 'jobs.view_own', label: 'See only their own jobs', hint: 'Just the jobs assigned to them, not the whole board.' },
      { key: 'jobs.edit', label: 'Create and change job cards', hint: 'Log a job, record what was used, and move it through the workflow.' },
      { key: 'jobs.assign', label: 'Assign jobs', hint: 'Decide who is responsible for a job.' },
      { key: 'jobs.close', label: 'Close and reopen jobs', hint: 'Sign a job off as done, or put a closed one back into play.' },
      /* Deliberately separate from close. The PRD is explicit that completing
         work, closing a job and invoicing it are three distinct events that may
         need three different people: a technician finishes, a supervisor signs
         off, the office bills. */
      { key: 'jobs.invoice', label: 'Bill a job', hint: 'Raise the invoice for the work and parts on a job.' },
      /* The decision that turns a recorded cost into money somebody pays, or
         does not. Split out because the PRD requires a technician to be able to
         record usage without seeing or setting any commercial value. */
      { key: 'jobs.bill_decide', label: 'Decide who pays', hint: 'Classify a cost as billable, internal or written off.' },

      /* ── The money, split view from change ───────────────────────────────
       *
       * PRD §26.6 asks for eight independently controlled financial rights, and
       * the shape it asks for is not "eight more switches" — it is that SEEING a
       * figure and CHANGING it are different questions. A workshop supervisor
       * checking whether a job made money is not thereby the person who decides
       * what the customer is charged for it.
       *
       * Before this split there were three keys and all of them were view-side
       * or decide-side. Changing a cost or a price rode `jobs.edit`, which is
       * the right to log work — so every technician who could record a part
       * fitted could also rewrite what it cost and what it sells for, and no
       * permission existed to say otherwise.
       *
       * Two of the pairs below are deliberately asymmetric. `jobs.profit` has
       * no change side because profit is derived and nobody sets it; markup and
       * margin likewise compute from cost and price, so the pair guards seeing
       * the analysis, not editing a stored number.
       *
       * The rule the split exists to protect is the one already enforced in
       * jobs/[id]/page.tsx: a figure somebody may not see is NOT FETCHED, not
       * merely hidden. A change key never implies its view key — granting the
       * right to set a price without the right to read the margin on it is a
       * legitimate configuration, and the screens must hold that shape. */
      { key: 'jobs.cost', label: 'See cost prices', hint: 'What the parts, labour and travel on a job cost the business.' },
      { key: 'jobs.cost_edit', label: 'Change cost prices', hint: 'Correct what a part or an hour is recorded as having cost.' },
      { key: 'jobs.price', label: 'See selling prices', hint: 'What each line on a job is being charged at.' },
      { key: 'jobs.price_edit', label: 'Change selling prices', hint: 'Set what the customer is charged for a line.' },
      { key: 'jobs.discount', label: 'Apply a discount', hint: 'Reduce a line below its selling price.' },
      { key: 'jobs.margin', label: 'See markup and margin', hint: 'The percentages between cost and selling price.' },
      { key: 'jobs.profit', label: 'See job profit', hint: 'What a job made overall, and the variance against the quote.' },
      /* Separate from jobs.invoice, which is the right to RAISE the invoice.
         This is the right to decide what goes ON it — which additional items are
         billed and which are left in the job's cost. PRD §26.4 makes that a
         review step with its own authority. */
      { key: 'jobs.invoice_select', label: 'Choose what gets invoiced', hint: 'Pick which additional items appear on the final invoice.' },
      /* Separate from invoice, per PRD §5: amending an accepted quote creates a
         new version and voids the customer's acceptance. That is a commercial
         act with a different blast radius from billing what was already agreed. */
      { key: 'jobs.quote_amend', label: 'Raise and amend quotes', hint: 'Quote a job, and supersede an accepted quote with a new version.' },

      { key: 'jobs.setup', label: 'Configure the workflow', hint: 'Statuses, boards and the job settings.' },
    ],
  },
  /*
   * Tickets are their own group, not four more rows under Job cards (165).
   *
   * A support desk and a field team are usually different people: somebody who
   * answers the phone all day needs every ticket right and no job cards at all,
   * and the reverse is just as common. Folding these into `jobs` would make
   * that impossible to express — a role could not have one without the other.
   *
   * Deliberately SHORTER than the jobs group. There is no `tickets.cost`,
   * `tickets.invoice` or `tickets.bill_decide`, because a ticket carries no
   * money. Adding them later would be the first sign this module had started
   * turning into a second job card.
   */
  {
    key: 'tickets',
    label: 'Tickets',
    capabilities: [
      { key: 'tickets.view', label: 'See tickets', hint: 'Open the ticket board and read a ticket.' },
      { key: 'tickets.edit', label: 'Create and change tickets', hint: 'Log a ticket, comment on it, and move it between lanes.' },
      /* Separate from edit, matching jobs.assign: moving a ticket between lanes
         is the day job, and deciding whose queue it lands in is not. It also
         decides whose TIME a running clock is credited to, which makes it more
         consequential here than on a job card. */
      { key: 'tickets.assign', label: 'Assign tickets', hint: 'Decide who is responsible — and whose time the clock counts.' },
      { key: 'tickets.close', label: 'Close and reopen tickets', hint: 'Mark a ticket done, or put a closed one back into play.' },
      { key: 'tickets.setup', label: 'Configure the ticket board', hint: 'Lanes, what each one does to the clock, and the ticket settings.' },
    ],
  },
  {
    key: 'setup',
    label: 'Setup',
    capabilities: [
      { key: 'setup.view', label: 'Open setup', hint: 'Reach the setup screens at all.' },
      { key: 'setup.edit', label: 'Change settings', hint: 'Numbering, tenders, terminals, price structures and the rest.' },
      { key: 'setup.users', label: 'Manage users and roles', hint: 'Add people, set PINs and decide what each role may do.' },
      /* Its own switch, not folded into setup.users: the trail is an
         owner-ish READ, and the person who manages PINs is not automatically
         the person who may read everything everyone did. */
      { key: 'setup.audit', label: 'View the audit trail', hint: 'Every change anyone made, and who signed in when.' },
      /* Its own switch for the same reason as setup.audit: an API key is
         standing access with no person behind it, and minting one should not
         come free with ordinary settings. */
      { key: 'setup.api', label: 'Manage API keys and webhooks', hint: 'Mint keys that let outside programs read this store, and choose where events are sent.' },
      /* Its own switch, like setup.audit and setup.api, and for a sharper
         reason than either: stationery is the only setting where what a person
         types is MARKUP that leaves the building on a document a customer or a
         supplier reads. Getting it wrong is a wrong invoice rather than a wrong
         screen, so "may change the VAT rate" must not come with "may redesign
         the tax invoice". */
      { key: 'setup.stationery', label: 'Design printed documents', hint: 'Change how orders, invoices and slips are laid out when they print.' },
    ],
  },
] as const

export const CAPABILITIES = CAPABILITY_GROUPS.flatMap((g) =>
  g.capabilities.map((c) => c.key),
) as readonly string[]

export type Capability = (typeof CAPABILITY_GROUPS)[number]['capabilities'][number]['key']

const CAPABILITY_SET = new Set<string>(CAPABILITIES)

export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value)
}

/** Label and hint for one capability, for the permissions grid. */
export const CAPABILITY_LABELS: Record<string, { label: string; hint: string }> =
  Object.fromEntries(
    CAPABILITY_GROUPS.flatMap((g) =>
      g.capabilities.map((c) => [c.key, { label: c.label, hint: c.hint }]),
    ),
  )

/**
 * Everything a user may do, as a set. Resolved once per request and passed
 * down, rather than re-queried per check.
 *
 * `isOwner` is carried alongside because an owner's set is "everything" —
 * including capabilities added by a future migration that no stored row could
 * anticipate.
 */
export type CapabilitySet = {
  readonly isOwner: boolean
  readonly granted: ReadonlySet<string>
}

export const NO_CAPABILITIES: CapabilitySet = { isOwner: false, granted: new Set<string>() }

/** Whether a capability set permits something. */
export function can(capabilities: CapabilitySet, capability: Capability): boolean {
  if (capabilities.isOwner) return true
  return capabilities.granted.has(capability)
}

/** Whether any of these is permitted — for a menu section with several children. */
export function canAny(capabilities: CapabilitySet, caps: readonly Capability[]): boolean {
  if (capabilities.isOwner) return true
  return caps.some((c) => capabilities.granted.has(c))
}

/**
 * What one role may do.
 *
 * A null roleId means a user with no role assigned, which is deliberately not
 * the same as an error: they exist, they can sign in, and they can do nothing
 * until someone gives them a role.
 */
export async function capabilitiesForRole(
  siteId: number,
  roleId: number | null,
): Promise<CapabilitySet> {
  if (roleId === null) return NO_CAPABILITIES

  const rows = await siteQuery<RowDataPacket & { capability: string; is_owner: number }>(
    siteId,
    `SELECT r.is_owner, rp.capability
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.allowed = 1
      WHERE r.id = ?`,
    [roleId],
  )
  if (!rows.length) return NO_CAPABILITIES

  return {
    isOwner: !!rows[0].is_owner,
    granted: new Set(rows.map((r) => r.capability).filter((c): c is string => !!c)),
  }
}

export type RoleSummary = {
  id: number
  name: string
  description: string | null
  isOwner: boolean
  isSystem: boolean
  /** How many active users hold it — the delete guard needs this. */
  userCount: number
}

export async function listRoles(siteId: number): Promise<RoleSummary[]> {
  const rows = await siteQuery<
    RowDataPacket & {
      id: number
      name: string
      description: string | null
      is_owner: number
      is_system: number
      user_count: number
    }
  >(
    siteId,
    // Most-privileged first, so the grid reads top-down the way people describe
    // a hierarchy. A plain alphabetical sort would file Cashier above Manager,
    // which makes the columns look shuffled. Roles the shop adds fall in
    // alphabetically after the seeded three.
    `SELECT r.id, r.name, r.description, r.is_owner, r.is_system,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_active = 1) AS user_count
       FROM roles r
      ORDER BY r.is_owner DESC,
               CASE WHEN r.is_system = 1 AND r.name = 'Manager' THEN 0
                    WHEN r.is_system = 1 AND r.name = 'Cashier' THEN 1
                    ELSE 2 END,
               r.name ASC`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isOwner: !!r.is_owner,
    isSystem: !!r.is_system,
    userCount: Number(r.user_count),
  }))
}

/** The whole grid: role id -> capability -> allowed. */
export type RoleMatrix = Record<number, Record<string, boolean>>

export async function capabilityMatrix(siteId: number): Promise<RoleMatrix> {
  const roles = await listRoles(siteId)
  const rows = await siteQuery<RowDataPacket & { role_id: number; capability: string; allowed: number }>(
    siteId,
    'SELECT role_id, capability, allowed FROM role_permissions',
  )

  const matrix: RoleMatrix = {}
  for (const role of roles) {
    matrix[role.id] = {}
    // An owner reads as every box ticked. The rows do not exist — that is the
    // point — so the grid is filled from the flag instead.
    for (const capability of CAPABILITIES) matrix[role.id][capability] = role.isOwner
  }
  for (const row of rows) {
    if (matrix[row.role_id] && !roles.find((r) => r.id === row.role_id)?.isOwner) {
      matrix[row.role_id][row.capability] = !!row.allowed
    }
  }
  return matrix
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Grants or revokes one capability on a role.
 *
 * The owner role is refused outright rather than being allowed to write rows
 * that `can()` would then ignore — a permissions screen that appears to save
 * something with no effect is worse than one that says no.
 */
export async function setCapability(
  siteId: number,
  roleId: number,
  capability: string,
  allowed: boolean,
): Promise<SaveResult> {
  if (!isCapability(capability)) {
    return { ok: false, error: 'That permission does not exist.' }
  }

  const role = await siteQuery<RowDataPacket & { is_owner: number }>(
    siteId,
    'SELECT is_owner FROM roles WHERE id = ? LIMIT 1',
    [roleId],
  )
  if (!role.length) return { ok: false, error: 'That role no longer exists.' }
  if (role[0].is_owner) {
    return { ok: false, error: 'The owner role keeps every permission — otherwise nobody can restore it.' }
  }

  await siteExecute(
    siteId,
    `INSERT INTO role_permissions (role_id, capability, allowed) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)`,
    [roleId, capability, allowed ? 1 : 0],
  )
  return { ok: true }
}

/**
 * Grants or revokes a whole group of capabilities on a role in one write.
 *
 * A section's "select all" is ONE decision, so it is one statement: a loop of
 * single-capability saves would leave the role half-granted if the sixth of
 * eleven failed, and a permissions screen that stops halfway is the one place
 * a partial write is least forgivable.
 */
export async function setCapabilities(
  siteId: number,
  roleId: number,
  capabilities: string[],
  allowed: boolean,
): Promise<SaveResult> {
  const wanted = [...new Set(capabilities)]
  if (!wanted.length || !wanted.every(isCapability)) {
    return { ok: false, error: 'That permission does not exist.' }
  }

  const role = await siteQuery<RowDataPacket & { is_owner: number }>(
    siteId,
    'SELECT is_owner FROM roles WHERE id = ? LIMIT 1',
    [roleId],
  )
  if (!role.length) return { ok: false, error: 'That role no longer exists.' }
  if (role[0].is_owner) {
    return { ok: false, error: 'The owner role keeps every permission — otherwise nobody can restore it.' }
  }

  await siteExecute(
    siteId,
    `INSERT INTO role_permissions (role_id, capability, allowed) VALUES ${wanted
      .map(() => '(?,?,?)')
      .join(', ')}
     ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)`,
    wanted.flatMap((capability) => [roleId, capability, allowed ? 1 : 0]),
  )
  return { ok: true }
}

export type RoleSaveResult = { ok: true; id: number } | { ok: false; error: string }

export async function createRole(
  siteId: number,
  name: string,
  description: string | null,
): Promise<RoleSaveResult> {
  const clean = name.trim()
  if (!clean) return { ok: false, error: 'Give the role a name.' }
  if (clean.length > 60) return { ok: false, error: 'That name is too long.' }

  const existing = await siteQuery<RowDataPacket>(
    siteId,
    'SELECT id FROM roles WHERE name = ? LIMIT 1',
    [clean],
  )
  if (existing.length) return { ok: false, error: 'A role with that name already exists.' }

  const res = await siteExecute(
    siteId,
    'INSERT INTO roles (name, description) VALUES (?,?)',
    [clean, description?.trim() || null],
  )
  return { ok: true, id: res.insertId }
}

export async function updateRole(
  siteId: number,
  roleId: number,
  name: string,
  description: string | null,
): Promise<SaveResult> {
  const clean = name.trim()
  if (!clean) return { ok: false, error: 'Give the role a name.' }

  const existing = await siteQuery<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM roles WHERE name = ? AND id <> ? LIMIT 1',
    [clean, roleId],
  )
  if (existing.length) return { ok: false, error: 'A role with that name already exists.' }

  await siteExecute(
    siteId,
    'UPDATE roles SET name = ?, description = ? WHERE id = ?',
    [clean, description?.trim() || null, roleId],
  )
  return { ok: true }
}

/**
 * Deletes a role.
 *
 * Refused while anyone still holds it. `users.role_id` is ON DELETE SET NULL,
 * so the delete would otherwise succeed and quietly leave those people with no
 * permissions at all — a lockout discovered at the till rather than here.
 */
export async function deleteRole(siteId: number, roleId: number): Promise<SaveResult> {
  const rows = await siteQuery<RowDataPacket & { is_owner: number; is_system: number; user_count: number }>(
    siteId,
    `SELECT r.is_owner, r.is_system,
            (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
       FROM roles r WHERE r.id = ? LIMIT 1`,
    [roleId],
  )
  if (!rows.length) return { ok: false, error: 'That role no longer exists.' }
  if (rows[0].is_owner) return { ok: false, error: 'The owner role cannot be deleted.' }
  if (Number(rows[0].user_count) > 0) {
    const n = Number(rows[0].user_count)
    return {
      ok: false,
      error: `${n} ${n === 1 ? 'person still holds' : 'people still hold'} this role. Move them to another role first.`,
    }
  }

  await siteExecute(siteId, 'DELETE FROM roles WHERE id = ?', [roleId])
  return { ok: true }
}
