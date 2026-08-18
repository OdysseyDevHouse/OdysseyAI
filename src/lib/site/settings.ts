import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne } from '../siteDb'
import { toNum } from '../decimals'
import { DEFAULT_MAX_CANCELLATION_FEE_PCT } from '../laybyRules'
import { PICTURE_FONTS } from '../generatedPicture'

/**
 * The site settings KV.
 *
 * The table has existed since 001_products.sql with exactly one reader
 * (getCostBasis) and NO writer at all — every value in it was put there by a
 * migration. Sales needs to change settings from a screen, so this is that
 * writer.
 *
 * Reads are DEFENSIVE by design, following getCostBasis: a missing row, an
 * empty string or a value nobody recognises all fall back to the documented
 * default rather than throwing. A setting is configuration, and configuration
 * that can crash a till is worse than configuration that is wrong.
 *
 * What belongs here: single scalar values a store owner changes and nothing
 * joins to. What does NOT: anything with behaviour attached (tender types),
 * anything queried in bulk (numbering), or anything needing its own columns.
 * Those earn tables.
 */

/** Every setting the app reads, with its default. One list, so nothing is invented at a call site. */
export const SETTING_DEFAULTS = {
  cost_basis: 'average',
  /**
   * Which way a forced price ending moves — 'up', 'down' or 'nearest'.
   *
   * Not a detail: on a .99 ending, R14.32 becomes R14.99 rounding up and
   * R13.99 rounding down, and stores genuinely differ. Up protects margin,
   * down never charges above what the rule worked out, nearest stays closest.
   */
  price_ending_direction: 'up',
  /** Cash denomination the DRAWER rounds to. Never rounds the invoice. */
  sales_cash_rounding: '0.05',
  /** Nothing on or before this date may be voided, edited or backdated. */
  vat_period_locked_to: '',
  /** Whether a finalised invoice may be corrected. Off until reverse-and-repost exists. */
  sales_allow_finalised_edit: '0',

  /* ── Auto-numbered master data ─────────────────────────────────────────
     Whether a new customer, supplier or product gets its code suggested from
     the matching sequence instead of being typed. Off by default so a store
     with an existing coding scheme keeps it — see 062_master_data_codes.sql.
     The suggestion stays editable; these switch the default, not the field. */
  autocode_customer: '0',
  autocode_supplier: '0',
  autocode_product: '0',
  barcode_variable_prefix: '2',
  barcode_plu_length: '5',
  barcode_value_divisor: '100',
  /** How far a drawer may be out before an explanation is required at cash-up. */
  cashup_variance_tolerance: '5.00',

  /* ── Receiving guards ──────────────────────────────────────────────────
     Two checks at the moment a GRV is posted. Both are about the same thing:
     a receipt is the ONLY act that writes average_cost, and a keying error
     here is silent — it does not throw, it just prices next quarter's GP
     report wrong. */

  /**
   * How far the keyed lines may differ from the supplier's invoice total
   * before the receipt is refused.
   *
   * Small on purpose. This catches a transposed 91 for 19, a line entered
   * twice, a case cost keyed as a unit cost — the errors that otherwise reach
   * the ledger and are found when the supplier queries the payment. Cents of
   * tolerance because a supplier's own rounding can differ from ours by one.
   *
   * Only applies when a total is actually given: receiving without the invoice
   * in hand stays possible, and is the common case for a delivery note.
   */
  purchase_invoice_tolerance: '0.10',

  /**
   * Percentage a unit cost may move from the last one paid before the screen
   * warns.
   *
   * A WARNING, never a refusal: prices genuinely move, and a buyer who knows
   * the supplier put 30% on is better placed than this setting. It exists so
   * that R1,000 keyed for R100 is noticed while the invoice is still in hand
   * rather than in next month's margin report. Zero switches it off.
   */
  purchase_cost_change_warn_pct: '20',

  /**
   * What an order may total before somebody else has to sign it off.
   *
   * VAT-inclusive, because that is the figure the business actually pays and
   * the one written on the order. A threshold read excluding VAT would let
   * every order through at 15% over whatever number the owner typed.
   *
   * ZERO IS OFF, and is the default — the same convention
   * purchase_cost_change_warn_pct uses. A shop of three people does not want
   * a second signature on a case of milk, and a control that arrives switched
   * on is a control that gets switched off in a hurry on the first busy
   * morning, usually for good.
   *
   * Enforced in issueOrder(), not on the screen: issuing is what commits the
   * business to the spend, and a button hidden in the UI is a suggestion.
   */
  purchase_approval_threshold: '0',
  /**
   * What a cash-up reconciles.
   *
   * 'terminal' — the drawer in a register, counted by whoever is on it. Retail.
   * 'user'     — a person and their own float, across whatever tills they
   *              worked. Hospitality, where twenty waiters share ten registers
   *              and "which of the six people on till 4 is short" has no answer.
   *
   * Defaults to 'terminal' so an existing store keeps behaving as it did.
   */
  cashup_mode: 'terminal',
  /*
   * NO `pos_mode` SETTING ANY MORE.
   *
   * What kind of till a screen is belongs to the TILL, not the shop: a
   * merchant runs a wholesale trade desk on the invoicing screen and a retail
   * front counter on the retail screen, under one company. One answer per site
   * put one of those halves on the wrong screen every day it traded.
   *
   * It is now `terminals.pos_mode` — see sql/site/180_terminal_pos_mode.sql and
   * `setTerminalPosMode` in lib/site/terminals.ts. Removed from this map rather
   * than left as an unread default, because a default here is a value that
   * looks authoritative and decides nothing.
   */
  /**
   * How many times a cashier may undo within one basket.
   *
   * ── WHY A LIMIT AT ALL ────────────────────────────────────────────────
   *
   * Undo removes a line that was already rung up. One or two is a mis-scan being
   * corrected, which is ordinary and should not need anybody's permission. A dozen
   * is a basket being taken apart, and the difference between those two is the
   * whole reason this setting exists — a shop that wants the second one noticed
   * sets a low number, and the till then says no rather than quietly obliging.
   *
   * Counted PER BASKET, not per shift: the allowance resets when the basket
   * clears, because the mistake being corrected belongs to the sale in front of
   * the cashier. A per-shift count would leave the last customer of the day
   * unable to fix a scan because of one at nine in the morning.
   *
   * '0' means no limit, which is what every till did before this setting existed —
   * but the default is 2, deliberately. A limit nobody set is a limit nobody
   * thought about, and the honest default for a control is the one that controls.
   * A shop that disagrees sets it to 0 and is back where it started.
   *
   * Whether an undo is ALLOWED and whether it is RECORDED are separate: every
   * undo is written to the audit log regardless of this number. See recordUndo.
   */
  pos_undo_limit: '2',
  /**
   * Whether a service charge applies only to a TABLE's bill.
   *
   * ON by default, and that default is the careful one: a percentage added to a R600
   * takeaway or a retail basket is a charge the customer did not expect and did not agree
   * to, and it would start appearing the moment a shop configured its first tier. A
   * restaurant gets service charges where they belong; a retail shop never sees the
   * feature at all.
   *
   * '1' or '0' rather than a boolean, matching every other flag in this table.
   */
  tips_tables_only: '1',
  /**
   * Warn at the tender pad when the basket holds more than the shop has.
   *
   * ── WHY THIS IS A SETTING AND NOT A RULE ──────────────────────────────────
   *
   * Plenty of shops do not track stock at all — the counts in the system are
   * approximate, nobody reconciles them, and a till that argued about them would
   * be wrong several times a day in front of customers. For those shops this is
   * noise, and noise at the payment step is worse than useless: it teaches
   * cashiers to dismiss warnings without reading them.
   *
   * OFF by default, so no existing shop suddenly starts being questioned about
   * figures it has never maintained.
   *
   * ── WHY AT THE TENDER AND NOT AT THE LINE ─────────────────────────────────
   *
   * Stock moves between somebody starting a sale and paying for it: another till
   * sells the last one, a delivery lands, a return comes back. Checking as lines
   * are added answers the question at the least useful moment — the answer is
   * stalest exactly when it matters most. The last moment before money changes
   * hands is the honest one.
   *
   * ── AND WHY IT NEVER APPLIES OFFLINE ──────────────────────────────────────
   *
   * A disconnected till cannot know what anybody else has sold. Warning from a
   * cached figure would be a guess presented as a fact, and refusing the sale
   * would stop the shop trading over a number the till cannot verify. So the
   * check is skipped entirely offline and the stock movement posts at sync —
   * see the till's finalise path.
   */
  pos_warn_out_of_stock: '0',
  /**
   * Whether each person must be clocked on before they may trade.
   *
   * ── WHAT THIS IS, AND WHAT THE SHIFT GATE ALREADY DOES ────────────────────
   *
   * They are different questions and both are worth asking:
   *
   *   THE SHIFT is the DRAWER. In terminal mode it is opened once, by whoever
   *   starts the day, and every cashier afterwards trades on it. That gate is
   *   unconditional and stays that way — a sale rung up with no shift banks
   *   into no reconciliation.
   *
   *   THIS is the PERSON. The till is open, the drawer is counted, and the
   *   question is whether the individual now standing at it is on duty. After
   *   the first cashier of the day the shift gate has no opinion about that at
   *   all, which is precisely the hole this fills.
   *
   * So with this on, signing in with a PIN that has no open time entry gets a
   * gate rather than the sale screen, and the way past it is to clock on.
   *
   * ── WHY IT IS OFF BY DEFAULT ──────────────────────────────────────────────
   *
   * Because turning it on means a cashier who forgets to clock in cannot sell,
   * and at 07:00 with a queue the person who can fix that is a manager. That is
   * the right trade for a shop running payroll off these hours and an expensive
   * one for a shop that does not — and nobody should inherit it by upgrade.
   *
   * Someone without `staff.clock` is never gated: their hours are not what this
   * records, so demanding they clock on would lock out the very people the
   * capability exists to exempt. See `tillShiftStatusAction`.
   */
  pos_force_clock_in: '0',
  /**
   * Whether a till with no connection may still sell ON ACCOUNT.
   *
   * ── WHAT IS ACTUALLY BEING DECIDED ────────────────────────────────────────
   *
   * An account sale needs the customer's credit limit and their live balance,
   * and both live on the server. `offlineBlockedTender` therefore refuses the
   * account tender outright when the line is down — which is correct, and for a
   * counter shop costs almost nothing: 82% of finalised invoices on this
   * database carry no account tender at all and go through offline today.
   *
   * The other 18% is the problem this setting exists for. A trade counter whose
   * server has died is a shop that cannot serve its ACCOUNT customers — the
   * regulars, the ones with a vehicle outside — while cash customers are served
   * normally. For some shops that is the right answer and for others it is
   * absurd, and the difference is not something software can work out.
   *
   * ── WHY IT DEFAULTS TO OFF ────────────────────────────────────────────────
   *
   * Turning it ON means the till sells against a limit it cannot verify. A
   * customer who was at their ceiling before the line dropped can keep buying,
   * and the shop finds out when the queue syncs. That is a real credit risk
   * somebody has to accept deliberately — so an existing shop's behaviour does
   * not change until an owner decides it should.
   *
   * ── AND WHY IT IS NOT A CEILING ───────────────────────────────────────────
   *
   * A per-sale rand cap was the obvious refinement and is deliberately not
   * here. It reads as protection while providing very little: nothing stops a
   * customer making four sales under the cap, and a limit the till cannot check
   * is not made checkable by adding a second number it also cannot check
   * against the first. The honest choice is whether the shop trusts its account
   * customers when the server is down, which is one question with two answers.
   */
  pos_offline_account_sales: '0',
  /**
   * Lay-by cancellation fee, as a percentage of the FULL price.
   *
   * Defaults to zero deliberately. Section 62 of the Consumer Protection Act
   * caps it at 1% and only permits it where the fee was disclosed to the
   * customer before they signed — so a system that defaulted to charging one
   * would put a store in breach on its first lay-by. See laybyRules.ts.
   */
  layby_cancellation_fee_pct: '0',
  /** How long a customer has to pay off a lay-by, in days. */
  layby_default_days: '90',
  /** Printed on the customer's copy. The fee must appear here to be chargeable. */
  layby_terms_text: '',
  /**
   * The store's own ceiling on a cancellation fee, as a percentage.
   *
   * A house rule, not a statute. Section 62(6) lets the Minister prescribe a
   * maximum and none is set in the Act, so this defaults conservatively and
   * can be raised by a store with advice supporting it.
   */
  layby_max_fee_pct: '1',

  /**
   * The smallest deposit that may be taken, as a percentage of the document
   * total. Zero means any amount.
   *
   * Defaults to zero because a shop taking R50 against a R5 000 quote is doing
   * ordinary business, and a system that refused it would be inventing a rule
   * the store never asked for. Measured against the DOCUMENT rather than the
   * payment, so a second small deposit on top of a large first one still
   * passes. See depositRules.ts.
   */
  deposit_min_pct: '0',
  /**
   * Whether a deposit may be taken without naming a customer.
   *
   * On by default: the money is held against the document, not against an
   * account, so a walk-in deposit is coherent and needs no debtor record. A
   * store that wants every deposit traceable to a person can turn it off.
   */
  deposit_allow_walkin: '1',

  /**
   * How long a quote's prices stand, in days.
   *
   * 30 is the ordinary commercial term. Zero means quotes never expire, for a
   * business that would rather not chase validity.
   */
  quote_validity_days: '30',
  /** Printed at the foot of a quote. Blank until a store writes its own terms. */
  quote_terms_text: '',

  /**
   * Whether credit notes claw commission back at all.
   *
   * Off by default: a return that earns nobody a clawback means the business
   * carries every refund while the salesperson keeps the commission on a sale
   * that came undone. Some shops choose that deliberately — hence the switch.
   */
  commission_exclude_returns: '0',
  /**
   * Charge a clawback to the rep on the ORIGINAL sale, not to whoever
   * processed the refund. On by default: without it the person who happens to
   * work the returns desk accumulates everybody else's negatives.
   */
  commission_returns_original_rep: '1',
  /**
   * Pay lay-by commission only once it is paid up. On by default: a lay-by
   * that lapses was never a sale, and paying at take-on means clawing it back.
   */
  commission_layby_on_completion: '1',

  /* ── Loyalty ───────────────────────────────────────────────────────────
     The programme's rates and policy. Tiers, punch cards and vouchers are
     rows in their own tables — only the scalars a store owner types into a
     form live here. Defaults documented in lib/loyaltyRules.ts, which is
     where the arithmetic that consumes them lives; these must agree with
     LOYALTY_DEFAULTS. Off until a store opens its programme. */
  loyalty_enabled: '0',
  /** Rand of spend that earns one point. R1 = 1 point. */
  loyalty_earn_rate: '1',
  /** Points needed to fund R1 off a sale. 10 makes a point worth 10c. */
  loyalty_redeem_rate: '10',
  /** A floor on redemption, so the till is not asked to spend three points. */
  loyalty_min_redeem_points: '0',
  /** Whether an already-discounted line still earns. */
  loyalty_earn_on_discounted: '1',
  /** never | activity (idle balance lapses) | earn (each batch ages out). */
  loyalty_expiry_mode: 'activity',
  loyalty_expiry_months: '12',
  /** rolling (a moving window) | lifetime (everything ever spent). */
  loyalty_tier_basis: 'rolling',
  loyalty_tier_window_months: '12',
  /** Months an earned tier survives a fall in spend, so a quiet month does
      not demote someone on a Tuesday. */
  loyalty_tier_grace_months: '12',

  /** Months a gift card stays redeemable after activation. 0 = never expires.
      The CPA prescribes at least three years, hence 36. */
  gift_card_validity_months: '36',

  /* ── Low-stock alert digest ────────────────────────────────────────────
     A scheduled email of everything below its minimum at the main location.
     Empty address = the feature is off. last_sent is STATE, written by the
     tick — kept here rather than its own table because one datetime is not
     a schema. */
  low_stock_alert_email: '',
  low_stock_alert_hours: '24',
  low_stock_alert_last_sent: '',

  /* ── Staff pay multipliers ─────────────────────────────────────────────
     What an hour outside ordinary time costs, as a multiple of the ordinary
     rate. The defaults are the BCEA figures and most stores will never touch
     them — but a bargaining council agreement can set higher rates, and a
     store bound by one needs to be able to say so. The arithmetic that
     consumes these lives in staffCost.ts; the bands themselves are worked out
     in timesheetModel.ts, which is rate-agnostic. */
  /** Section 10 — overtime, above the ordinary week. */
  staff_overtime_multiplier: '1.5',
  /** Section 16(1) — Sunday work, for somebody who does not ordinarily work Sundays. */
  staff_sunday_multiplier: '2',
  /** Section 16(2) — Sunday work, for somebody who does. See user_employment.works_sundays. */
  staff_sunday_ordinary_multiplier: '1.5',
  /** Section 18(2)(a) — a public holiday that is not an ordinary working day. */
  staff_holiday_multiplier: '2',

  /* ── Document numbering ────────────────────────────────────────────────
     See sql/site/064_pos_numbering.sql and lib/site/numbering.ts. */

  /**
   * 'terminal' or 'site'.
   *
   * 'terminal' gives every till its own invoice sequence, numbered
   * INV_01_02_000097, so a till can trade offline indefinitely — it allocates
   * locally with nothing reserved and nothing to run out of. Each till's own run
   * is gapless, at the cost of there being no single company-wide run.
   *
   * 'site' is one shared sequence, which is how every store numbered before this
   * existed. A till then cannot number a sale offline at all.
   *
   * Defaults to 'site' HERE, deliberately, even though the migration seeds
   * 'terminal' for stores it touches: a default is what an unmigrated or
   * hand-edited site falls back to, and falling back to the behaviour a store
   * already had is the only safe direction.
   */
  sales_number_scope: 'site',

  /**
   * This store's number inside the group, as it appears in an invoice number.
   *
   * Twenty branches each number their first till 01, so without this every branch
   * issues INV_01_000097 and a group report has twenty rows claiming one invoice
   * number. uq_doc_number cannot catch it — each site has its own database and its
   * own copy of that index.
   *
   * Frozen once the store has issued anything; see setStoreNumber().
   */
  store_number: '01',

  /** The priority a new job card starts on. */
  job_default_priority: 'normal',

  /**
   * The service products labour and travel are billed through.
   *
   * Blank until a business picks one. Labour and travel reach an invoice as
   * ordinary product_type = 'service' lines, which is what lets them go through
   * the same posting path as a part while moving no stock — so these name which
   * product plays each part rather than the module inventing one.
   */
  job_labour_product_id: '',
  job_travel_product_id: '',

  /**
   * What a kilometre is charged at.
   *
   * Blank rather than a guessed number: a rate nobody has set must read as unset,
   * not as R0.00 quietly billing nothing for every trip.
   */
  job_travel_rate_per_km: '',

  /**
   * Whether work may start before the customer has accepted the quote.
   *
   * Off by default. The commonest real case is a technician already on site
   * finding a second fault, and refusing outright would strand them — so this
   * exists for the businesses that genuinely gate work on a signature, and
   * everybody else is unaffected.
   */
  job_require_quote_acceptance: '0',

  /** How long a visit is assumed to take when nobody says. */
  job_default_visit_minutes: '60',

  /**
   * Where a schedule lane starts and stops being drawn, and the bounds of the
   * outside-hours warning.
   *
   * Deliberately a pair of times rather than a per-day table: this is not whether
   * the business is open, and a shop that works Saturdays draws the same lane.
   */
  job_day_starts: '07:00',
  job_day_ends: '17:00',

  /**
   * Minutes to leave between two visits for the same person.
   *
   * A flat allowance, NOT a computed drive time — nothing in this app talks to a
   * distance provider, and a figure invented per pair of addresses would be
   * guessing dressed as arithmetic. This catches the case that bites (two visits
   * booked back to back across town); the real travel-time check waits for a
   * provider.
   */
  job_travel_gap_minutes: '30',

  /** What a kilometre costs the business, as against what it is charged at. */
  job_travel_cost_per_km: '',

  /**
   * How a claimed distance becomes a chargeable one: the block to round to, or
   * 0 to charge the verified figure exactly.
   *
   * To the NEAREST block, not up. The PRD's own worked example rounds 29.1 to 29,
   * so rounding up would contradict the document this was built from — and a
   * business that bills every 21.1km trip as 25 is charging for kilometres nobody
   * drove. See chargeableKm() in jobStatusModel.
   */
  job_travel_round_to: '1',

  /** A floor per trip, so a 400m call-out does not bill nothing. Blank for none. */
  job_travel_minimum_km: '',

  /** How far past the estimate a claim may go before it needs a signature, as a %. */
  job_travel_tolerance_pct: '20',

  /**
   * Straight-line distance times this is the road estimate.
   *
   * 1.30 is the ordinary ratio in a built-up area. A setting because a rural
   * region is nearer 1.15 and a mountain pass considerably worse — and because
   * this is the number that decides whether the tolerance check is fair.
   */
  job_travel_road_factor: '1.30',

  /* ── The week the SLA clock runs on ──────────────────────────────────────
   *
   * An SLA promise of "4 hours" means four BUSINESS hours, so the business has
   * to say when it is open. One week for the whole business, not one per policy:
   * urgent and normal disagreeing about when Tuesday starts is not a feature,
   * and four copies is four chances to typo.
   */

  /** Mon..Sun mask, 1 = open. The shape report_schedules.days_of_week uses. */
  job_sla_trading_days: '1111100',

  /** HH:MM. The SLA clock does not run before this. */
  job_sla_opens_at: '08:00',

  /** HH:MM. Work left at closing resumes at the next opening. */
  job_sla_closes_at: '17:00',

  /**
   * Do public holidays stop the clock?
   *
   * On by default: the safe default is the one that does not breach somebody for
   * a day the doors were locked. A business trading through Christmas turns it
   * off deliberately.
   */
  job_sla_skip_holidays: '1',

  /* ── Headlines, tasks and checks ─────────────────────────────────────────── */

  /**
   * Must every job name at least one headline?
   *
   * OFF by default, deliberately: turning it on before any headline exists would
   * make creating a job impossible, and migration 114 seeds none.
   */
  job_headline_required: '0',

  /**
   * Does an unanswered REQUIRED task or check stop a job being closed?
   *
   * On by default. The whole reason to mark an item required is that the business
   * will not sign the job off without it, and a required flag that does nothing
   * teaches people the marking is decorative.
   */
  job_items_block_close: '1',

  /**
   * Do a headline's standard parts become job lines automatically?
   *
   * OFF. Offering them is safe; adding a billable line because somebody picked a
   * dropdown is how a customer gets charged for a filter nobody fitted.
   */
  job_headline_autoparts: '0',

  /* ── Customer equipment ─────────────────────────────────────────────────── */

  /**
   * What happens when a serial matches equipment already on file for the same
   * customer: 'warn' or 'block'.
   *
   * WARN by default. Section 18.3 of the PRD is explicit that plenty of equipment
   * has no legible serial, and a hard block would stop somebody recording a real
   * second unit whose plate happens to read the same.
   */
  asset_duplicate_action: 'warn',

  /**
   * Roll an asset's next service date forward when a job closes against it.
   *
   * On by default: a service interval nobody acts on is decoration, and this is
   * the one thing that turns it into a worklist.
   */
  asset_auto_next_service: '1',

  /* ── Recurring jobs ─────────────────────────────────────────────────────── */

  /**
   * How many missed periods one tick will raise before giving up and saying so.
   *
   * 24, matching the contracts cap. Past two years of outstanding periods
   * something is wrong that raising them all would make worse rather than better,
   * and the truncation is REPORTED rather than silently applied.
   */
  job_series_catchup_cap: '24',

  /* ── Evidence on checks ─────────────────────────────────────────────────── */

  /**
   * Pixel width of a captured signature PNG. Height follows the pad aspect.
   *
   * 600 is legible on a printed job sheet without storing a megabyte per
   * signature — and a signature is stored per job, so the cost is per visit.
   */
  job_signature_width: '600',

  /**
   * What the customer is agreeing to, shown above the pad.
   *
   * A setting rather than a string in the component because it is a declaration
   * the business makes, and the wording is the sort of thing an insurer or an
   * industry body dictates. A mark on a screen with nothing stating what it
   * means is not worth capturing.
   */
  job_signature_statement:
    'I confirm the work described on this job card has been completed to my satisfaction.',

  /**
   * Which sign-off a job must carry before it can close (159).
   *
   *   none      recorded when it happens, blocks nothing
   *   customer  the customer must have signed
   *   both      neither signature may be missing
   *
   * Three values rather than two flags, because two flags allow "technician
   * only", which nobody asks for: a technician signature exists to accompany a
   * customer's, not to stand in for one.
   *
   * Defaults to none, and 159 seeds the same. A business that has been closing
   * jobs for months must not find every one of them refused the morning after a
   * migration — switching this on is a decision somebody makes.
   */
  job_signoff_required: 'none',

  /**
   * Whether a technician may ask for a part the shop does not have (162, §28).
   *
   * ON by default, unlike almost every other switch here. The refusal it
   * replaces — "BRK-PAD-01 has only 0 in Main Store" — is already in front of
   * people with nowhere to go from it, so a feature that fixes that and ships
   * switched off fixes nothing. A business that would rather people phoned can
   * turn it off.
   */
  job_part_requests_enabled: '1',

  /**
   * Whether a missed promise tells a named manager (164, §17.5).
   *
   * OFF by default, unlike the part requests above. Escalation names a person
   * and tells them somebody else is late; switching that on for every existing
   * site the morning after a migration would be filling somebody else's bell,
   * unasked. A policy also needs BOTH a delay and a person before anything
   * fires, so this switch is the outer of two deliberate acts.
   */
  job_sla_escalation_enabled: '0',

  /* ── Tickets (165) ───────────────────────────────────────────────────────── */

  /**
   * How many tickets one person may have running at once. 0 means no cap.
   *
   * ── WHY THIS IS A SETTING AND JOB TIME IS AN INDEX ────────────────────────
   *
   * `jobTime.ts` enforces one-open-timer in the DATABASE, through a generated
   * column, and its header explains why that can never be relaxed: once two
   * overlapping rows exist, no migration can restore the constraint without
   * choosing which of somebody's hours to delete — and the failure it prevents
   * is an hour billed twice.
   *
   * Ticket time is never billed. So the failure that justified an unrelaxable
   * index does not exist here, and a configurable cap is safe — which is
   * fortunate, because no index can express "at most N" anyway.
   *
   * Defaults to 0, because a cap that switched itself on at some arbitrary
   * number the morning after a migration would start refusing work nobody asked
   * it to refuse.
   */
  ticket_max_running_per_user: '0',

  /* ── Who is on a job, and who hears about it ────────────────────────────── */

  /**
   * Whether job emails go out at all.
   *
   * ON by default, unlike almost every other switch here — because nothing
   * happens unless somebody explicitly put a person on a job. The surprising
   * behaviour would be adding a follower and having them told nothing.
   */
  job_notify_enabled: '1',

  /**
   * Which moments send mail. Three, not everything that changes.
   *
   * A notification on every edit trains people to filter the lot into a folder
   * they never open — at which point the feature is worse than absent, because
   * everybody believes they were told. A list rather than three columns so a
   * fourth moment is a settings change, not a migration.
   */
  job_notify_events: 'assigned,status,closed',

  /**
   * Whether an assignee is emailed when work is given to them.
   *
   * Separate from the follower switch because it is a different promise: a
   * follower opted in, an assignee has been handed something.
   */
  job_notify_assignee: '1',

  /* ── The three time-based automations (121) ─────────────────────────────── */

  /**
   * Escalate a breached SLA to the owner and followers.
   *
   * ON, because the SLA data has existed since phase 8 and nothing ever acted on
   * it. A breach worklist nobody is told about is one nobody opens.
   */
  job_auto_escalate: '1',

  /** Remind the assigned technician the evening before a booked visit. */
  job_auto_visit_reminder: '1',

  /** How many hours ahead a visit is reminded about. 16 catches tomorrow morning. */
  job_auto_visit_hours: '16',

  /**
   * Raise the draft invoice when a job closes with billable lines.
   *
   * OFF, and the only one of the three that is. The others send an email, where a
   * wrong one is noise; this creates paperwork against a real customer account,
   * and a job closed by mistake leaves an invoice somebody must find and void.
   * It raises a DRAFT — finalising stays a human act through the one posting
   * engine.
   */
  job_auto_invoice: '0',

  /*
   * ── SMS (137) ──────────────────────────────────────────────────────────
   * '' = off, 'log' = print to the server log (trying it out), 'smsportal' =
   * the real gateway. The credentials live here as plain settings rows — the
   * setup screen says so out loud and renders them masked.
   */
  sms_provider: '',
  sms_client_id: '',
  sms_client_secret: '',

  /** Text the customer when their statement has been emailed. */
  statement_sms_notify: '0',

  /** How many days before a layby's due date the reminder sweep picks it up. */
  layby_reminder_days: '7',

  /** The layby reminder template. Tokens: {customer} {number} {due_date} {balance} {company}. */
  layby_reminder_sms:
    'Hi {customer}, a friendly reminder: your lay-by {number} at {company} is due by {due_date}. Balance: {balance}.',

  /** The line at the bottom of every till slip — returns policy, a thank-you. */
  receipt_footer_text: '',

  /**
   * The business's logo, for the letterhead on printed documents.
   *
   * The generated disk name from lib/uploads.ts (a UUID plus an extension) —
   * never a path and never the name the browser sent, both of which are
   * attacker-controlled. Empty means no logo, which every template handles by
   * printing nothing rather than a broken image.
   *
   * A scalar belongs here rather than in a table: it is one answer per site
   * that nothing joins to. The stationery TEMPLATES earned a table because they
   * carry behaviour (validation, draft/published, one-active-per-type); "which
   * file is our logo" carries none.
   */
  document_logo_file: '',

  /**
   * Ask the customer to rate the work when a job closes.
   *
   * OFF, and for a stronger reason than the automations above: switching this on
   * emails every customer whose job closes, from this business's own address.
   * That is a decision about how a company talks to its customers, and a default
   * must never make it on their behalf.
   */
  job_feedback_enabled: '0',

  /** The opening line of that email. Editable, because voice differs. */
  job_feedback_intro: 'Thank you for your business. How did we do?',

  /**
   * Accept job requests from a public URL.
   *
   * OFF, and this is the most consequential switch in the module: it opens a
   * write endpoint to anybody with the link. What makes that safe is that a
   * request is INERT — it becomes a job only when a person accepts it — but the
   * default must still be off.
   */
  job_intake_enabled: '0',

  /** What the form says above the fields. */
  job_intake_blurb: 'Tell us what you need and we will come back to you.',

  /** How many requests one phone number may send in a day. 0 means no cap. */
  job_intake_max_per_phone: '3',

  /** Whether the form offers the kinds of work this business does. */
  job_intake_show_headlines: '1',

  /**
   * The customer portal.
   *
   * OFF, and the most consequential switch in the module: it shows a customer
   * their own commercial history — jobs, quotes, invoices — over the internet.
   * Nothing about it should ever be on by default.
   */
  portal_enabled: '0',

  /** A customer may write on their own job. Their words are always visible. */
  portal_allow_comments: '1',

  /** A customer may attach a photo to their own job. */
  portal_allow_uploads: '1',

  /**
   * A customer may accept a quote themselves.
   *
   * OFF, unlike the other two, because it is the only one that is legally
   * meaningful: it settles what was agreed and for how much. The other two add
   * words and pictures.
   */
  portal_allow_quote_accept: '0',

  /** How many files a customer may put on one job. A ceiling, not a target. */
  portal_max_uploads_per_job: '10',

  /**
   * Typeface for generated till icons — the initial-on-a-gradient pictures
   * offered on the product screen when a product has no icon to upload.
   *
   * A PICTURE_FONTS id from lib/generatedPicture. Blank means "never chosen",
   * which fontById() reads as Inter. Site-wide rather than per product on
   * purpose: a till whose buttons are set in eight different faces looks
   * broken, not varied — the gradient is what distinguishes one product from
   * the next.
   */
  generate_picture_font: '',
} as const

export type SettingKey = keyof typeof SETTING_DEFAULTS

export async function getSetting(siteId: number, key: SettingKey): Promise<string> {
  const row = await siteQueryOne<RowDataPacket & { setting_value: string | null }>(
    siteId,
    'SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1',
    [key],
  )
  const value = row?.setting_value
  return value === null || value === undefined ? SETTING_DEFAULTS[key] : value
}

/** Several at once, so a screen needs one round trip rather than seven. */
export async function getSettings(
  siteId: number,
  keys: readonly SettingKey[],
): Promise<Record<string, string>> {
  if (keys.length === 0) return {}

  const rows = await siteQuery<RowDataPacket & { setting_key: string; setting_value: string | null }>(
    siteId,
    `SELECT setting_key, setting_value FROM settings
      WHERE setting_key IN (${keys.map(() => '?').join(',')})`,
    [...keys],
  )

  const found = new Map(rows.map((r) => [r.setting_key, r.setting_value]))
  const result: Record<string, string> = {}
  for (const key of keys) {
    const value = found.get(key)
    result[key] = value === null || value === undefined ? SETTING_DEFAULTS[key] : value
  }
  return result
}

export async function getNumericSetting(siteId: number, key: SettingKey): Promise<number> {
  return toNum(await getSetting(siteId, key), toNum(SETTING_DEFAULTS[key]))
}

export async function getBooleanSetting(siteId: number, key: SettingKey): Promise<boolean> {
  return (await getSetting(siteId, key)) === '1'
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Writes one setting.
 *
 * Upsert rather than update: a site migrated before a setting existed has no
 * row for it, and failing to save because of that would be baffling.
 */
export async function setSetting(
  siteId: number,
  key: SettingKey,
  value: string,
): Promise<SaveResult> {
  const invalid = validateSetting(key, value)
  if (invalid) return { ok: false, error: invalid }

  await siteExecute(
    siteId,
    `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, value],
  )
  return { ok: true }
}

/**
 * Per-key validation.
 *
 * Settings are typed only by convention — the column is a VARCHAR — so this is
 * the only thing standing between a typo on a setup screen and a till that
 * rounds to the nearest R5.
 */
export function validateSetting(key: SettingKey, value: string): string | null {
  switch (key) {
    case 'receipt_footer_text':
      return value.length <= 500 ? null : 'The slip footer is capped at 500 characters.'

    case 'cost_basis':
      return value === 'average' || value === 'last'
        ? null
        : "Cost basis must be 'average' or 'last'."

    /* The two receiving guards. Both had no case here until they became
       editable — an unvalidated key falls through to `default` and saves
       whatever it is given, which was harmless while the only writer was a
       migration and is not once a text box points at it. */

    case 'purchase_invoice_tolerance': {
      const tolerance = Number(value)
      if (!Number.isFinite(tolerance) || tolerance < 0) {
        return 'The tolerance cannot be negative.'
      }
      /* Cents, not rands. This check exists to catch a transposed digit or a
         case cost keyed as a unit cost; a tolerance of R50 would wave through
         exactly those errors while still looking configured. */
      if (tolerance > 10) return 'A tolerance above R10 would let a keying error through.'
      return null
    }

    case 'purchase_cost_change_warn_pct': {
      const pct = Number(value)
      // Zero is meaningful: it switches the warning off for a shop whose costs
      // genuinely move on every delivery.
      if (!Number.isFinite(pct) || pct < 0) return 'The percentage cannot be negative.'
      if (pct > 1000) return 'A threshold that high would never warn about anything.'
      return null
    }

    case 'purchase_approval_threshold': {
      const amount = Number(value)
      // Zero is meaningful: it switches approval off entirely, which is the
      // default and the right answer for a shop where everyone is the owner.
      if (!Number.isFinite(amount) || amount < 0) return 'The amount cannot be negative.'
      return null
    }

    case 'price_ending_direction':
      return value === 'up' || value === 'down' || value === 'nearest'
        ? null
        : "Price ending direction must be 'up', 'down' or 'nearest'."

    case 'sales_cash_rounding': {
      const amount = Number(value)
      if (!Number.isFinite(amount) || amount < 0) return 'Cash rounding must be zero or more.'
      // A denomination above 10c would round a sale by more than 5c, which
      // nobody intends and every customer notices.
      if (amount > 0.1) return 'Cash rounding cannot be more than 10c.'
      return null
    }

    case 'vat_period_locked_to':
      // Empty means no period is locked, which is the default state.
      return value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? null
        : 'Enter a date as yyyy-mm-dd, or leave it blank.'

    case 'sales_number_scope':
      return value === 'terminal' || value === 'site'
        ? null
        : "Numbering scope must be 'terminal' or 'site'."

    // Only ids the generator actually offers reach the table. An unknown value
    // would silently render as Inter for ever, which reads as "the setting is
    // broken" rather than "that font does not exist".
    case 'generate_picture_font':
      return value === '' || PICTURE_FONTS.some((f) => f.id === value)
        ? null
        : 'That is not one of the fonts the picture generator offers.'

    // Digits only, and never zero. This lands in a legal document number, so a
    // stray letter here would print on an invoice — and 'store 0' reads as
    // "no store" to anyone comparing group reports.
    case 'store_number':
      return /^\d{1,4}$/.test(value) && Number(value) >= 1
        ? null
        : 'The store number must be 1 to 4 digits, e.g. 01.'

    case 'sales_allow_finalised_edit':
    case 'autocode_customer':
    case 'autocode_supplier':
    case 'autocode_product':
      return value === '0' || value === '1' ? null : 'That setting must be on or off.'

    case 'layby_cancellation_fee_pct': {
      const pct = Number(value)
      if (!Number.isFinite(pct) || pct < 0) return 'The fee must be zero or more.'
      // Sanity only. The real ceiling is layby_max_fee_pct, checked by the
      // caller against the store's own policy — section 62(6) leaves the
      // maximum to regulation rather than fixing one, so this file must not
      // claim a statutory figure it cannot point at.
      if (pct > 100) return 'A fee cannot exceed the price of the goods.'
      return null
    }

    case 'layby_max_fee_pct': {
      const pct = Number(value)
      if (!Number.isFinite(pct) || pct < 0) return 'The ceiling must be zero or more.'
      if (pct > 100) return 'A ceiling above 100% is meaningless.'
      return null
    }

    case 'layby_default_days': {
      const days = Number(value)
      if (!Number.isInteger(days) || days < 1) return 'Enter a number of days, at least one.'
      if (days > 730) return 'Two years is the longest a lay-by can run here.'
      return null
    }

    case 'layby_terms_text':
      // Free text, and blank is meaningful: no terms means no disclosed fee,
      // which means no fee may be charged. cancelLayby enforces that.
      return value.length > 4000 ? 'The terms are too long to print.' : null

    case 'barcode_variable_prefix':
      return /^\d{1,2}$/.test(value) ? null : 'The prefix must be one or two digits.'

    case 'barcode_plu_length': {
      const length = Number(value)
      return Number.isInteger(length) && length >= 3 && length <= 7
        ? null
        : 'PLU length must be between 3 and 7 digits.'
    }

    case 'barcode_value_divisor': {
      const divisor = Number(value)
      // 100 means the embedded value is in cents; 1000 means grams.
      return divisor === 1 || divisor === 10 || divisor === 100 || divisor === 1000
        ? null
        : 'Divisor must be 1, 10, 100 or 1000.'
    }

    case 'cashup_variance_tolerance': {
      const tolerance = Number(value)
      if (!Number.isFinite(tolerance) || tolerance < 0) return 'Tolerance cannot be negative.'
      // A large tolerance quietly defeats the point of counting the drawer.
      if (tolerance > 500) return 'A tolerance above 500 would hide real shortages.'
      return null
    }

    case 'pos_undo_limit': {
      const limit = Number(value)
      if (!Number.isInteger(limit) || limit < 0) {
        return 'The undo limit must be a whole number, or 0 for no limit.'
      }
      /* Not a correctness bound — a hundred undos on one basket is already past
         any limit worth setting, so a bigger number is somebody meaning "off"
         and typing it the long way. 0 is the way to say that. */
      return limit > 99 ? 'Use 0 for no limit rather than a very large number.' : null
    }

    /* A flag, so only the two values this table uses everywhere else. Validated rather
       than coerced: a stray 'true' would read as ON by the !== '0' test and as OFF by any
       future reader that compared to '1', which is the kind of disagreement that surfaces
       months later as a service charge on a takeaway. */
    case 'tips_tables_only':
    case 'pos_warn_out_of_stock':
    case 'pos_offline_account_sales':
      return value === '1' || value === '0' ? null : 'That setting must be 1 or 0.'

    case 'cashup_mode':
      return value === 'terminal' || value === 'user'
        ? null
        : "Cash-up mode must be 'terminal' or 'user'."

    // The two rates are guarded here as well as in cleanSettings, because this
    // is the only check a direct setSetting() call passes through. A zero or
    // negative rate divides by zero in the earn arithmetic.
    case 'loyalty_earn_rate': {
      const rate = Number(value)
      return Number.isFinite(rate) && rate > 0 ? null : 'Rand per point must be more than zero.'
    }

    case 'loyalty_redeem_rate': {
      const rate = Number(value)
      return Number.isFinite(rate) && rate > 0 ? null : 'Points per rand must be more than zero.'
    }

    case 'loyalty_min_redeem_points': {
      const floor = Number(value)
      return Number.isFinite(floor) && floor >= 0
        ? null
        : 'The minimum to redeem cannot be negative.'
    }

    case 'loyalty_expiry_mode':
      return value === 'never' || value === 'activity' || value === 'earn'
        ? null
        : "Expiry mode must be 'never', 'activity' or 'earn'."

    case 'loyalty_tier_basis':
      return value === 'rolling' || value === 'lifetime'
        ? null
        : "Tier basis must be 'rolling' or 'lifetime'."

    case 'low_stock_alert_hours': {
      const hours = Number(value)
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
        return 'Between 1 and 168 hours — once a week at the slowest.'
      }
      return null
    }

    case 'loyalty_expiry_months':
    case 'loyalty_tier_window_months':
    case 'loyalty_tier_grace_months':
    case 'gift_card_validity_months': {
      const months = Number(value)
      if (!Number.isFinite(months) || months < 0) return 'That must be zero or more months.'
      // Beyond a decade the policy is indistinguishable from "never", and a
      // typo of an extra digit is far more likely than a genuine 100-year rule.
      if (months > 120) return 'Choose 120 months or fewer.'
      return null
    }

    case 'staff_overtime_multiplier':
    case 'staff_sunday_multiplier':
    case 'staff_sunday_ordinary_multiplier':
    case 'staff_holiday_multiplier': {
      const multiplier = Number(value)
      if (!Number.isFinite(multiplier)) return 'Enter a multiplier, such as 1.5.'
      // Below 1 would pay an overtime hour LESS than an ordinary one, which no
      // agreement may do — the BCEA rates are a floor, not a default to argue
      // down from. Above 5 is a decimal point in the wrong place.
      if (multiplier < 1) return 'A multiplier below 1 would pay overtime less than ordinary time.'
      if (multiplier > 5) return 'That multiplier looks like a typo. Five times is the ceiling here.'
      return null
    }

    default:
      return null
  }
}

/**
 * Whether a date falls inside a locked period.
 *
 * The single guard behind void, credit and any future edit. Without it someone
 * will void a March invoice in July, after the VAT return went in, and the
 * first anyone hears of it is from an auditor.
 *
 * TWO SOURCES, and every caller gets both:
 *
 *   `vat_period_locked_to` — the original site-wide floor. Locks everything on
 *   or before one date. Still honoured, so nothing that relied on it changed.
 *
 *   `period_locks` — the table added in 037, which can express "February is
 *   closed while March is open", carries a reason, and records who closed it.
 *   Only HARD locks refuse here; a soft lock is a warning and this function
 *   returns a boolean with nowhere to put one.
 *
 * The table is queried directly rather than through periodLocks.ts because that
 * module imports this one — going the other way would be a cycle.
 *
 * LEGACY: no production path calls this any more — every posting guard now
 * goes through periodLocks.guardPosting()/isLocked() with a scope, which
 * honours the same setting. This stays only as the boolean compatibility shim
 * the period-locks suite proves against; new code must not import it.
 */
export async function isPeriodLocked(siteId: number, date: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false

  const lockedTo = await getSetting(siteId, 'vat_period_locked_to')
  if (lockedTo && date <= lockedTo) return true

  // A missing table means 037 has not run on this site yet; treat that as
  // unlocked rather than failing every posting path.
  const row = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    `SELECT id FROM period_locks
      WHERE unlocked_at IS NULL AND lock_type = 'hard'
        AND ? BETWEEN period_from AND period_to
      LIMIT 1`,
    [date],
  ).catch(() => null)

  return row !== null
}
