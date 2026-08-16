import type { QuickKeySection } from '@/lib/quickKeys'

/**
 * Starter sets, for a till with no keys on it yet.
 *
 * ── WHY A BLANK CANVAS IS THE WRONG FIRST RUN ─────────────────────────────
 *
 * A shop opening this screen for the first time gets an empty bar and a rail of
 * twenty-five actions, and has to know which six a till actually needs before it can
 * begin. That is knowledge about POS, not about their shop — so the app should supply
 * it. A starter lays down a working till in one press, which the shop then edits: rename
 * it, recolour it, take it apart. Every key here is an ordinary key with nothing special
 * about it.
 *
 * ── SLUGS, NOT CAPTIONS ───────────────────────────────────────────────────
 *
 * A template names its action by slug, which is what binds the key to what it does —
 * so a shop renaming "Cash up" to "Close the till" breaks nothing.
 *
 * ── AND WHY THESE ARE NOT THE REFERENCE POS'S SETS ────────────────────────
 *
 * The older system's starters cannot be copied over: several of their slugs
 * (`payout`, `cash-out`, `kick-drawer`, `end-shift`, `print-labels`) have no
 * counterpart in this app's catalogue, and its restaurant set puts `cashup` on the
 * tables bar — which this app refuses, because closing a shift under an open table is
 * exactly the mistake `noTables` exists to prevent. These are built from this app's own
 * 25 actions and obey its own rules.
 */

export type TemplateKey = {
  /** A QUICK_KEY_ACTIONS slug. */
  action: string
  /** Which bar it lands on. Ignored when `group` is set — a group has a bar of its own. */
  section: QuickKeySection
  colourToken?: string
  /** Put it inside this template group rather than straight on the bar. */
  group?: string
}

export type TemplateGroup = {
  caption: string
  icon: string
  colourToken?: string
  section: QuickKeySection
}

export type StarterTemplate = {
  key: string
  label: string
  /** What the set is for, in the shop's words — shown on the choice. */
  description: string
  hospitalityOnly?: boolean
  groups: TemplateGroup[]
  keys: TemplateKey[]
}

/* Named for what they signal rather than for the hue, so the intent survives a
   restyle of the palette. */
const DESTRUCTIVE = 'tile-2'
const MONEY = 'tile-4'
const ADMIN = 'tile-6'

/**
 * The supervisor folder every till already has.
 *
 * Applying a template ADOPTS it rather than making a second one — `createQuickKeyGroup`
 * matches on the signature, and `g:supervisor` is already on the bar by the time this
 * screen has rendered once. Its caption and icon therefore have to match
 * `ensureSupervisorGroup` exactly.
 */
const SUPERVISOR: TemplateGroup = {
  caption: 'Supervisor',
  icon: 'ShieldCheck',
  colourToken: 'tile-4',
  section: 'main',
}

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    key: 'retail',
    label: 'A shop counter',
    description:
      'The six a cashier reaches for, plus the restricted ones filed under Supervisor.',
    groups: [SUPERVISOR],
    keys: [
      /* The everyday six. Deliberately short: a starter that fills the bar leaves a
         shop deleting keys before it can add its own, and the first thing anybody
         wants to put on a till is their own best-selling product. */
      { action: 'price-enquiry', section: 'main' },
      { action: 'save-sale', section: 'main' },
      { action: 'view-saved-sales', section: 'main' },
      { action: 'undo', section: 'main' },
      { action: 'reprint-last-slip', section: 'main' },
      { action: 'customer-payment', section: 'main', colourToken: MONEY },

      /* Behind the folder: everything that reverses money or closes the day. Not
         because the folder is a lock — it grants nothing, and each key still asks for
         its own right — but because they are the keys a cashier should have to mean
         to press. */
      { action: 'void-sale', section: 'main', group: 'Supervisor', colourToken: DESTRUCTIVE },
      { action: 'refund', section: 'main', group: 'Supervisor', colourToken: DESTRUCTIVE },
      {
        action: 'global-discount',
        section: 'main',
        group: 'Supervisor',
        colourToken: DESTRUCTIVE,
      },
      { action: 'price-change', section: 'main', group: 'Supervisor', colourToken: DESTRUCTIVE },
      { action: 'cashup', section: 'main', group: 'Supervisor', colourToken: ADMIN },
    ],
  },
  {
    key: 'hospitality',
    label: 'A restaurant',
    description:
      'Bill, tip, move and split on the tables bar — the counter keys stay on the main one.',
    hospitalityOnly: true,
    groups: [SUPERVISOR],
    keys: [
      /* The tables bar is what a waiter sees with a bill open, so it holds the four
         acts that only make sense there. `cashup` and `clock-in-out` are deliberately
         NOT here — see the noTables flag, which the server enforces too. */
      { action: 'bill-print', section: 'tables' },
      { action: 'add-tip', section: 'tables', colourToken: MONEY },
      { action: 'table-transfer', section: 'tables' },
      { action: 'split-table', section: 'tables' },
      { action: 'send-to-kitchen', section: 'tables' },

      // And the counter bar keeps the ordinary sale keys, for takeaways and the till.
      { action: 'price-enquiry', section: 'main' },
      { action: 'undo', section: 'main' },
      { action: 'reprint-last-slip', section: 'main' },
      { action: 'customer-payment', section: 'main', colourToken: MONEY },

      { action: 'void-sale', section: 'main', group: 'Supervisor', colourToken: DESTRUCTIVE },
      { action: 'refund', section: 'main', group: 'Supervisor', colourToken: DESTRUCTIVE },
      {
        action: 'global-discount',
        section: 'main',
        group: 'Supervisor',
        colourToken: DESTRUCTIVE,
      },
      { action: 'cashup', section: 'main', group: 'Supervisor', colourToken: ADMIN },
    ],
  },
]
