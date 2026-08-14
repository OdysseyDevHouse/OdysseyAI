# Gap-closing run — consolidated report

**Branch:** `worktree-gap-closing-run` (worktree at `.claude/worktrees/gap-closing-run`)
**Scope:** the full approved plan — every phase, whole product except job cards.
**Verification server:** the worktree's own dev server runs on **http://localhost:4200** (the one on :4100 is the main checkout's). Sign in there to click through everything below.

---

## What was built, phase by phase

### Phase 0 — Integrity fixes
- **Layby sequence registered** (`layby` in `OWN_TABLE_TYPES`, migration renamed `layby_number` → `document_number`): `verifySequence('layby')` now reports honestly — confirmed clean on both sites in the final sweep.
- **Ad-hoc cashbook captures mirror to the GL** (`mirrorBankTransaction`, category picker on the capture form; transfers post one balanced journal; voids reverse).
- **Cash-up drawer variance journalises** at shift close (`mirrorCashup` vs seeded 6910 *Cash over and short*). Payouts/payins/drops deliberately do not post (free-text reasons; the variance math already includes them).
- **Period locks unified** on `guardPosting` — scoped locks stop over-refusing, messages say who/why; soft-locked offline sales post with an audit entry instead of quarantining.
- **Purchase document audit** (`purchase_document_audit` table; finalise/void/issue/cancel rows written in-transaction).

### Phase 4 — POS defects
- **Offline scale-barcode bug fixed** — `posOffline/catalog.ts findByCode` now parses variable barcodes, so price/weight-embedded barcodes work offline.
- Stale `HOSPITALITY_UNBUILT` strings removed (split-table, add-tip ship).
- **Prompt-to-weigh** wired into the till (qty prompt for scale items).

### Phase 1 — Reporting
- **GL report-builder sources** `journalLines` and `glAccounts` (reuse `reports.financial`), CASE-split debit/credit fields, time buckets.
- **Bucketed age-analysis templates** (Current/30/60/90/120+) for customers and suppliers; the flat template ids kept (they're load-bearing in favourites/schedules).
- Built-ins: `gl-detail`, `gl-by-account`, `account-balances`.

### Phase 2 — Accounting features
- **Cash flow statement** (indirect method) at `/accounting/cash-flow` — reconciles by construction, `year_end` batches excluded, unrecognised subtypes land in an "other" bucket rather than vanishing.
- **Budgets** (`gl_budgets`, per-account × month grid, copy-from-prior/actuals, spread; income statement gained a vs-budget mode).
- **Recurring journals** (draft-by-default with per-schedule auto-post; `postDraft`/`discardDraft` added to journals.ts; button-generated like recurring expenses).

### Phase 3 — Customer features
- **Per-customer pricing overrides** — customer → group → site-default price-structure resolution through `TillCustomer`; standing discount capped at `max_discount_pct` so it can never brick a till.
- **Customer addresses** (`customer_addresses`, one default per kind, addresses tab, delivery picker writes the invoice's snapshot column, checkout prefill).
- **Email an invoice** (PDF attach, pay link, `document_audit` 'emailed' rows, resend-aware dialog).
- **SMS layer** (`src/lib/sms/` with SMSPortal adapter + log provider; dunning levels gained channel/SMS body; layby reminders; statement-emailed SMS note; `/setup/sms` page).
- **Custom fields (3.5)** — the record-screen work already existed in the other session's uncommitted tree; the portal card + test-suite remainder is still **deferred** (see "Waiting on the other session").

### Phase 5 — POS operations
Document-level discount (permission-gated), receipted returns + exchange at the till, till cash management (open/close shift, float, payout/payin/drop), discount codes at the till, supervisor override-in-place with dedicated `pos_override` audit rows, table transfer + bill print.

### Phase 6 — Receipts & printing
80mm slip layout + print/reprint/email/gift receipt, and the **ESC/POS bridge**: network-socket transport, drawer kick (the dead `opens_cash_drawer` setting finally consumed), kitchen ticket printing for send-to-kitchen.

### Phase 7 — Inventory
Label/shelf-talker printing (Code 128 rendered in-house, batch runs from price schedules/GRVs), multiple barcodes per product, stock intelligence (`/reports/stock-intel`: true aging from movement history, ABC, stock turn, sell-through + dead-stock templates), cycle-count programmes on stock takes, mix-and-match + **multibuy** specials tiers, price history for all price writes, catalogue export shaped for re-import + supplier price-file import.

### Phase 9 — Gift cards
Sellable bearer cards: signed `gift_card_events` ledger + cached balance, activation DR tender / CR 2500 (no revenue), redemption as a tender through `finaliseDocument`, balance enquiry quick-key, expiry sweep to breakage (4910), full till guards (no discounts, no VAT, card-cannot-pay-for-card), and — found by this work's GL≡subledger assertion — **`mirrorSaleReversal`, which fixed a systemic pre-existing hole: voided sales left their GL journals standing** for *all* sales, not just gift cards.

### Phase 8 — Batch/lot/expiry
One hook (`applyBatchMovementTx`) inside `recordMovement`, so all ~47 stock call sites — offline sync included — keep lot invariants by construction. FEFO allocation (expired last, logged when sold), expiry capture at GRV, returns land back in the exact lot via the document line, GRV-void backout with part-sold refusal, `/stock/batches` screen with trace + write-off, expiring-soon view, `reconcileBatches` invariants on the reconciliation page. Batch products sell offline; allocation happens at sync.

### Phase 10 — Online store
Password reset (hashed single-use tokens), statements + invoice PDFs in the account, **pay account balance online** via the existing `debtor_invoice` rails, address book + checkout picker, gift-card and voucher redemption at checkout (full-cover gift orders invoice themselves), online-order refunds, "notify me when back in stock" (rides the baskets tick, claim-before-send), faceted filtering (department/brand/price band applied before the 120 cap), storefront gift-card balance checker + footer link.

### Phase 11 — Platform hardening
- **2FA (TOTP)** — hand-rolled RFC 6238 verified against the RFC vectors; encrypted secrets, single-use codes via a conditional `last_used_step` update, pending-2FA cookie so a password alone is never a session, own-account `/security` screen, admin "reset 2FA" on the users screen, owner recovery documented.
- **Audit screen** (`/setup/audit`, own `setup.audit` capability): activity log with search/entity/actor filters + keyset pagination, and the new control-DB **sign-in log** (`cp2_signin_log`, written fail-soft on success/failure/lockout).
- **Backups**: `scripts/backup.mjs` (per-site `mysqldump --single-transaction` + `uploads/` tar, retention, manifest) + `docs/backup.md` runbook. Dry-run verified against all 3 databases. **`ENCRYPTION_KEY`/`SESSION_SECRET` must be backed up separately** — the runbook says so.
- **Low-stock digest email** on `/api/alerts/tick` (`LOW_STOCK_CRON_SECRET`), claim-before-send.
- **Bonus fix**: `reorderSuggestions`' below-minimum basis filtered *after* its SQL `LIMIT`, so any capped consumer silently dropped late-alphabet shortages (this dev DB has 24k below-minimum rows). It now prefilters in SQL and ranks by shortfall, so a truncated list keeps its *worst* rows.

### Phase 12 — Platform large items
- **Cross-site reporting** (`/group`, `/group/income-statement`): group overview (today/month/GP/stock per store + totals) and a consolidated P&L merged by account **code**, a column per store, dash (not zero) where an account doesn't exist. A store is included only when you can open it *and* your role there grants the screen; excluded stores are named with reasons; an unreachable store renders a warning chip instead of blanking the page. Honest footer: inter-store sales are not eliminated.
- **Notification centre**: bell in the top bar with live unread badge, popover feed, mark-all-read, `/notifications` full feed. One row per event with a capability audience, per-user read state, visibility decided at read time from your own capabilities. Producers (all post-commit, all fail-soft): online order placed, sale voided, GRV received, low-stock digest. 90-day lazy retention.
- **Public API + webhooks**: read-only `/api/v1` (products, customers, sales documents, stock levels, reports-by-id through the engine) behind hash-only keys (`odk_<site>_<prefix>_<secret>`, shown once), closed scopes that can never project cost or financials — the engine strips cost/margin columns from keys exactly as it does junior users. In-process token-bucket rate limiting (honestly single-instance). Outbound webhooks (`order.placed` in-transaction, `order.paid`, `sale.finalised`, `sale.voided`) signed `t=<unix>,v1=<HMAC-SHA256(secret, t.body)>`, delivered by `/api/webhooks/tick` (`WEBHOOK_CRON_SECRET`) on a 1/5/30/120/720-minute ladder ending dead, with redelivery of the frozen payload. Managed at `/setup/api` (new `setup.api` capability).

---

## Verification

- **Every test suite** (129 `test:*` scripts) ran in this final sweep; all pass except the two pre-existing items below. That includes the 44-check gift-card suite, the 44-check batch suite, all sales/purchasing/GL posting suites, and the new group-reporting / notifications / public-api / webhooks suites.
- **`npx tsc --noEmit` clean**, **check-ui-kit clean** on every touched screen, **test:navigation fully green**, **test:permissions green** except the three pre-existing failures below.
- **Reconciliation (run solo):** ledger healthy on both sites (no unbalanced batches, no missing journals, trial balance difference 0); bank balances, customer balances and batch invariants clean on both sites; all five document sequences clean on site 2.
- **Live end-to-end API smoke** against :4200: 401 without a key, scoped 403, no cost leakage in any payload, hidden columns reported on report runs, revocation effective immediately.
- **CDP browser pass** on the worktree server: group overview, consolidated P&L, notifications feed (full of real events the test suites produced), `/setup/api`, `/setup/audit`, `/security` — screenshots in `.screenshots-wt/`. Earlier phases' screens were verified during their phases.
- **New env vars to set in production:** `WEBHOOK_CRON_SECRET`, `LOW_STOCK_CRON_SECRET` (plus crontab lines documented in each tick route's header).

## Decisions taken along the way (the load-bearing ones)

1. **Gift card = tender, not voucher** — money is already in; redemption rides `sales_tenders`; GL through the ordinary tender mapping to 2500.
2. **Batch hook lives inside `recordMovement`** — lot choice is machine-decidable (FEFO) and that function is the single stock gate, so every caller keeps the invariants for free, offline included.
3. **Notifications: one row per event + read-time capability filtering**, not per-recipient fan-out — role changes take effect immediately and nothing goes stale.
4. **Public API is read-only** — every write path is actor-attributed with heavy invariants; machine writes need idempotency + synthetic-actor design nothing required. Integrations read; changes arrive by webhook.
5. **Consolidated P&L merges by account code with no eliminations** — stated on the page footer.
6. **Voided-sale GL reversal** (`sale_void` batches) applied to all sales going forward; no historical backfill (per plan: no live customers).
7. **Digest/notification cadence rides one claim** (`low_stock_alert_last_sent`) — the bell can never fire more often than the digest.

## Known pre-existing issues (not introduced by this run, left untouched)

- **test:permissions — 3 failures** that live in the other session's "Checkin" commits: `sales/page.tsx` unguarded, three `api/jobs/*` tick/calendar routes unguarded, and a stale role-mention comment in `setup/laybys/actions.ts`.
- **test:builder-ui — 2 failures** (outline names resolve `undefined`): identical against the main tree's server, which contains none of this run's commits; this run never touched the builder.
- **Control-account drift** on the reconciliation screen (site 1: debtors/creditors vs GL by millions; site 2: R35 / R793.50): the subledgers predate the GL and the plan explicitly chose **no historical backfill**. Expected until go-live starts from clean books.
- **Site 1 invoice/PO/GRV sequence gaps** (6,001 / 180 / 779 of ~100k+ issued): months of dev test litter from suites that pre-date the sequence-cleanup discipline. Site 2 is fully clean, which is the evidence the *code* numbers correctly.
- **Stock drift**: site 2's 54 rows are the burger-joint demo seed (stock set to 40 with no opening movements). Site 1 has two leaked `SP*78023902` "Split test" fixtures from an old crashed run — each referenced by a document line, so cleaning them means deleting documents; flagged rather than done.

## Deferred (recorded, not forgotten)

- **3.5 custom-fields portal card + promoted test suite** — the other session's 127–131 work is still uncommitted in the main tree; touching those files would violate the parallel-session protocol.
- **Migration number prefix collision**: main tree took 129–131 (job intake/portal) while this branch used 130+ for other things — filenames differ so the runner applies both, but the numbering overlaps; worth a renumber when the trees merge.
- 2FA: QR-code rendering (manual secret entry ships; every authenticator accepts it) and recovery codes.
- Storefront checkout browser-drive (dev store is switched off; the flows are covered by `test:online-phase10` at the lib level with documented SKIPs).
- Arbitrary-amount pay-balance online (needs a `payment_intents` ENUM extension), PayFast API refunds, free-item vouchers online, gift partial-cover online.
- USB/serial ESC/POS transports (network sockets ship), credit-note slip route, offline slip loyalty/footer/COPY block, kitchen void notices.
- Webhooks for stock levels (poll `/api/v1/stock-levels`; per-movement events would spam from inside the hottest path), and a due-now fast path for delivery (lag currently equals the tick interval).
- Last-backup-age tile, jobs/* UTC-date cosmetics.
