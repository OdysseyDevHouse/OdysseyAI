# Loyalty members — a file of their own, central across a group

> **BUILT.** All six steps are done and applied to all 22 dev sites. This
> document is now a record of the reasoning rather than a proposal — the
> *(today)* markers describe how things were BEFORE, and the decisions below
> are what shipped. Where the build diverged from the plan it is marked
> **AS BUILT** at that point.
>
> The migration numbers actually used differ from those reserved here:
> `052_loyalty.sql` was rewritten in place (no `206_loyalty_members.sql`),
> the sharing flag is `sql/tickets/017_share_loyalty.sql`, and
> `208_drop_customer_loyalty_number.sql` removes the old column. Gift cards
> followed in `sql/tickets/018_share_gift_cards.sql` and
> `sql/site/209_shared_gift_cards.sql`.
>
> Verified by `scripts/test-loyalty.ts` (116 assertions),
> `test-gift-cards.ts`, and eight probes: `probe-member-sale`,
> `probe-member-states`, `probe-loyalty-screens`, `probe-loyalty-reports`,
> `probe-loyalty-only-sharing`, `probe-loyalty-switch`,
> `probe-shared-gift-cards` and `probe-gift-card-entity`.

## Where this starts

Loyalty is not a thin layer over customers. It is already ~2,550 lines —
`loyalty.ts` (1,208), `loyaltyCards.ts` (903), `loyaltyWallet.ts` (438) and
`loyaltyRules.ts` (440) — with four admin screens, POS wiring at eight points in
`salesPosting.ts`, two report sources and a 677-line test suite.

What it is *not* is a file. `loyalty_members` exists *(today)* but carries no id
of its own — `sql/site/052_loyalty.sql:53-84`, `PRIMARY KEY (customer_id)`, and
the header says why:

> *"Keyed BY customer_id rather than carrying its own id: there is exactly one
> loyalty standing per customer, and a surrogate key would allow two."*

That reasoning was right for what it assumed. This plan changes the assumption,
so the reasoning goes with it.

### What is already done, and must not be re-done

Migrations 199, 200 and 201 already fought the hard half of centralisation.
`201_loyalty_central.sql` converted the programme configuration off local row
ids and onto **portable keys** — `loyalty_cards.reward_product_code`,
`loyalty_card_items.product_code` / `department_name`,
`loyalty_vouchers.reward_product_code`. Its header states the goal plainly:

> *"Loyalty becomes one programme for the whole group."*

That conversion is correct and survives this plan **as a design, not as a
migration**. Product ids are per-database and mean nothing across stores;
product codes are how this system already identifies "the same product"
everywhere. The new `052` adopts the code-and-name columns as its native shape.

### The one thing that blocks the goal

Loyalty is central *(today)* **only by riding on the customer file's owner**.
Every read and write goes through `customerQuery` / `customerTransaction` /
`customerDbPrefix` from `customerDb.ts` — 51 such calls across the three
modules. `customerDb.ts:38-44` even names loyalty as a member of the
"customer cluster" that these wrappers are safe for.

So the shape you can have today is: **shared customers ⇒ shared loyalty**, and
nothing else. Ten stores with independent debtors books cannot share one
programme, which is exactly the case this plan is for.

---

## The decisions

### 1. A member is its own row, optionally linked to a customer

`loyalty_members` gets `id` and `member_number`, and `customer_id` becomes a
**nullable link**. Four states are legal and all four are ordinary:

| Member | Customer | Means |
|---|---|---|
| yes | null | A walk-in who joined with a cell number. Never a debtor. |
| yes | set | An account holder who is also on the programme. |
| null | set | An account holder who never joined. |
| null | null | A walk-in sale. |

`customer_id` gets a `UNIQUE` key so one customer cannot hold two memberships —
the guarantee the old composite PK was buying, kept without the coupling.

> **`UNIQUE` does not constrain `NULL`.** That is the point here: many members
> may have `customer_id IS NULL`, and MariaDB permits it. It is also the trap —
> a "default" row keyed on a nullable column silently duplicates. There is no
> default member, so this is safe, but the uniqueness of the *link* is enforced
> and the uniqueness of *anything else* is not.

### 2. `member_number` is the identity, and it is group-wide

`customers.loyalty_number` *(today)* is what the till matches on —
`tillCustomers.ts:260`, `customers.ts:303`, and the import spec at
`import/specs/customers.ts:157`. It moves to `loyalty_members.member_number`.

**Keep `customers.loyalty_number` as a column? No — drop it.** Two columns
holding the same claim is how they drift. The till search changes to reach the
member file instead. This is a deliberate reversal of what I said in the first
pass of this review: with no live data there is no back-compat argument, and
carrying a duplicate identifier purely to avoid touching one `WHERE` clause is
the wrong trade.

### 3. Loyalty gets its own owner resolution

A new `shares_loyalty` flag on `cp2_store_group_members`, beside
`shares_customers` and `shares_suppliers` (`sql/tickets/015_share_customers.sql:52`),
and a `loyaltyOwnerSite()` in `storeGroups.ts` mirroring `customerOwnerSite()`
(`storeGroups.ts:313`).

Then `src/lib/site/loyaltyDb.ts` — `loyaltyQuery`, `loyaltyQueryOne`,
`loyaltyExecute`, `loyaltyTransaction`, `loyaltyDbPrefix`, `branchDbPrefix` —
modelled directly on `customerDb.ts`. Its header must carry the same two
warnings that file earned:

- These are for statements touching the **loyalty cluster alone**. A statement
  that also joins a branch table (`sales_documents`, `tender_types`, `products`)
  needs the *prefix*, not a different connection. Reaching for the wrong one
  moves the whole query to the owner and silently returns nothing.
- A database name cannot be a bound parameter, so it is concatenated — and
  therefore validated against `SAFE_DB_NAME` and **refused** rather than escaped.

**The switches are independent, and that is the whole point.** `shares_loyalty`
is its own column, resolved by its own helper, so a group may run ten separate
debtors books against **one** loyalty programme. That combination is impossible
today and is the reason this plan exists.

**Settings must follow the owner too.** `getLoyaltySettings` reads ten keys via
`getSettings(siteId, …)` (`loyalty.ts:68`) against the *caller's* site. Left
alone, every branch keeps its own earn rate while sharing one balance — which is
precisely the incoherence `201`'s header calls out about per-branch tiers:

> *"Gold could mean R50,000 at one branch and R30,000 at another, measured
> against one shared spend figure. Nobody would describe that as a loyalty
> programme."*

So `getLoyaltySettings` / `saveLoyaltySettings` resolve to the loyalty owner.
This is easy to miss and fails silently, so it gets its own test.

### 4. The till carries two attachments, not one

This is the largest piece of new work and the reason the estimate does not
shrink further.

*(Today)* `PosShell.tsx` holds a single `state.customer` that does double duty:
it authorises account credit **and** identifies the loyalty earner. It is read at
`PosShell.tsx:1173`, `:1475`, `:1576`, `:1644`, `:1834`, `:1957` — and
`SalePane.tsx:245` labels the button *"For account sales and loyalty"*, which is
the coupling stated out loud in the UI.

Under option (a) these separate:

- `state.customer` — account credit, terms, price structure. Unchanged.
- `state.member` — points, wallet, stamps, vouchers. New.

Attaching one may *offer* the other when they are linked ("this account is
member M-10432 — attach?"), but neither implies the other. `salesPosting` takes
`memberId` alongside `customerId`, and the loyalty block at
`salesPosting.ts:918-1000` and `:1199-1260` keys off `memberId`.

**The refusal message changes.** `salesPosting.ts:268` currently says
*"Attach a customer before using loyalty."* It becomes *"Attach a member before
using loyalty."* — a different instruction, because now there is something else
to attach.

### 5. How a store is told to use head office's loyalty

The switch lives where the customer one already does: **Setup → Linked stores**,
in the "Master files" section of each branch's card
(`StoreCard.tsx:315-321` *(today)*). Loyalty adds a second switch beside it —
**"Use head office's loyalty programme."**

Head office gets **no switch**. It *is* the file, and `StoreCard.tsx:261-272`
already handles that case with a statement instead of a control:

> *"The group's customer and supplier files live here. Switch them on at each
> branch that should use them, on the cards below."*

That sentence grows to mention loyalty.

#### The preconditions are NOT a copy of the customer ones

`sharedFileRefusal` (`storeGroups.ts:857`) enforces three gates before a branch
may join the shared customer file. Two carry over unchanged. **One does not, and
copying it blindly would be wrong.**

| Gate | Customers *(today)* | Loyalty |
|---|---|---|
| Same database server | Required | **Required** — the design rests on a cross-database join being cheap |
| Joining store must be empty | Of customers | **Of members** — two member files cannot be auto-merged either |
| Separate companies refused | Refused outright | **Open question — see below** |

The legal-entity gate refuses sharing when `legal_entity = 'several'`, because
*"a balance settled at one store would be money collected by another."* That is
exactly right for a debtors book.

For loyalty it splits in two:

- **Points** are not a receivable. Franchise groups routinely run one programme
  across separately-owned stores, and refusing that would block a legitimate and
  common shape.
- **The wallet is real money** the shopper handed over. It has precisely the
  customer-file problem — topped up at store 3, spent at store 7, and store 3 is
  a different company holding the float.

My reading is to gate the **wallet**, not the programme: separate companies may
share points, tiers and punch cards, and a shared wallet is refused with a
message that says why. That is a product decision rather than a technical one,
so it is question 5 below rather than a settled part of this plan.

#### The switch ships LAST

`StoreCard.tsx:322-350` records what happens when a sharing switch ships ahead of
the code behind it. The supplier switch is **hidden, not disabled**, because the
flag saved correctly and `supplierOwnerSite()` resolved correctly while none of
the purchasing modules knew about it:

> *"switching it on pointed a branch at head office's supplier file while every
> purchasing query kept reading the branch's own empty tables: no suppliers in
> the list, no orders raisable, no invoices matchable. Not a subtle wrong answer
> — purchasing simply stops."*

Loyalty would fail identically if the switch appeared before step 3 of the order
of work is finished. So the switch is built **last**, and until then
`shares_loyalty` exists as a column with no UI. The same note applies about the
form field: an unrendered switch reads as `false` and would quietly turn sharing
off for anyone who had it on, so the action must not send a field it does not
render.

### 6. Enrolment is a real flow

A member has to be able to come into existence at the till, in under ten
seconds, from a cell number. That means:

- `enrolMember(siteId, actor, { memberNumber?, name, phone, email? })` —
  allocates a number when none is scanned.
- A **link** / **unlink** action against a customer.
- A members list screen at `/loyalty` (replacing the current customer-derived
  `MembersClient.tsx`), with search on number, name and phone.

`member_number` allocation should follow the existing numbering machinery rather
than inventing a counter. Worth confirming against `docs/numbering.md` during
build — noted as an open question rather than assumed.

---

## What gets deleted

With no live sites, migrations are rewritten rather than layered.

| File | Fate |
|---|---|
| `sql/site/052_loyalty.sql` | **Rewritten** in place, member-centric, adopting 201's code-and-name columns natively |
| `sql/site/199_loyalty_shared_split.sql` | **Deleted** — drops FKs the new 052 never creates |
| `sql/site/200_loyalty_stamp_origin.sql` | **Deleted** — folded into the new 052 |
| `sql/site/201_loyalty_central.sql` | **Deleted** — its columns become 052's native shape |

That removes ~450 lines of migration commentary describing a shape that will no
longer exist. The reasoning worth keeping — points-are-a-ledger,
tier-standing-is-spend-not-points, wallet-stays-separate, and 201's
portable-key argument — **moves into the new 052 header**. It is the most
valuable thing in those files and must not be lost with them.

> **Migrations are recorded by name.** Editing an applied `052_loyalty.sql` does
> nothing on a site that already has it. Every dev site needs its loyalty tables
> dropped and the file re-run, or re-provisioning. **This is a question for
> Tiaan before any schema work starts** — it is the one step that touches
> existing dev databases.

---

## The new schema

```
loyalty_members
  id              INT UNSIGNED AUTO_INCREMENT  PK
  member_number   VARCHAR(60)   NOT NULL       UNIQUE
  customer_id     INT UNSIGNED  NULL           UNIQUE   -- the optional link
  name            VARCHAR(160)  NOT NULL
  phone           VARCHAR(40)   NULL           KEY
  email           VARCHAR(190)  NULL
  is_active       TINYINT(1)    NOT NULL DEFAULT 1
  points_balance  DECIMAL(12,4)                -- cache of SUM(loyalty_ledger.points)
  wallet_balance  DECIMAL(12,4)                -- cache of SUM(loyalty_wallet.amount)
  tier_id / tier_since / tier_review_date
  joined_at / last_activity_at
```

`loyalty_ledger`, `loyalty_wallet`, `loyalty_stamps`, `loyalty_vouchers`:
`customer_id` → `member_id`, FK to `loyalty_members`.

**The unique keys must be carried across carefully.** They are not decoration —
each one is a concurrency guarantee with a comment explaining the race it stops:

- `uq_ledger_document_earn (document_id, entry_type)` — *"a SELECT … FOR UPDATE
  cannot lock a row that does not exist yet, so two concurrent first-ever awards
  would both find nothing and both insert."*
- `uq_wallet_document_spend (document_id, entry_type)`
- `uq_stamp_sale (card_id, origin_site_id, member_id, document_id, stamp_seq)` —
  note `origin_site_id` from `200`, which must survive.

**No FK from loyalty tables to `customers` or `sales_documents`.** Under a
separate loyalty owner those tables are in another database, and
`197_shared_customer_file.sql` already established that a key cannot span the
boundary and that repointing is unavailable because one schema must serve both a
sharing and a non-sharing store. `document_id` becomes a code-validated
reference, exactly as `loyalty_stamps.document_id` already did in `200`.

---

## Order of work — all six done

Estimated 6–8 days. Each step below is marked with what actually landed.

1. ✅ **Schema** — rewrite `052`, delete `199`/`200`/`201`, add
   `sql/tickets/018_share_loyalty.sql`. Re-run against dev sites.
2. ✅ **`loyaltyDb.ts` + `loyaltyOwnerSite()`** — including the
   settings resolution from decision 3.
3. ✅ **Port the three modules** — ~64 `customer_id` occurrences in SQL
   strings, plus the exported API: `getMember`, `awardSaleLoyalty`,
   `redeemPointsForSale`, `adjustPoints`, `reverseSaleLoyalty`, `expirePoints`,
   wallet top-ups. `tsc` catches nearly all of it.
4. ✅ **Till, enrolment and screens** — decisions 4 and 6, plus the
   members list and the customer-side tab.
5. ✅ **Reports** — `catalog.ts:4137` (`loyaltyLedger`) and `:4180`
   (`loyaltyMembers`), which currently join `customers` directly.
6. ✅ **The sharing switch** — `StoreCard.tsx`, `linked-stores/actions.ts`
   and the loyalty arm of `sharedFileRefusal`. **Last, deliberately** — see
   decision 5. Until this step the column exists with no UI, which is the safe
   state, not an unfinished one.

### Verification

- `scripts/test-loyalty.ts` (677 lines) is the safety net and needs porting
  alongside step 3, not after it.
- A new test for the four member/customer states in decision 1.
- A new test that a branch with `shares_loyalty` but **not** `shares_customers`
  reads the owner's members and its **own** customers. This is the whole point
  of the plan and nothing else exercises it.
- `scripts/test-shared-customer-queries.ts` (528 lines) is the model for that.
- **Watch for vacuous assertions.** A check over an empty member list proves
  nothing; each test prints what it saw.

---

## Open questions for Tiaan

1. ~~**Dev database reset**~~ — **ANSWERED: drop-and-recreate.**
   `scripts/reset-loyalty-schema.mjs` drops the loyalty tables per site and
   re-runs `052`, which was necessary because migrations are recorded BY NAME
   and editing an applied file does nothing. Run against all 22 sites.

   One lesson worth keeping: it was run once BEFORE the code was ready, and
   dropping `customers.loyalty_number` broke seven suites that had nothing to
   do with loyalty — `createCustomer` wrote the column. The drop was deferred
   to `208`, alongside the eight sites that read it.
2. ~~**Gift cards**~~ — **ANSWERED: a separate piece, straight after this one.**

   `gift_cards.customer_id` has the same FK to `customers`
   (`147_gift_cards.sql:23`, constraint at `:35`) and therefore the same
   boundary problem loyalty just had.

   It is NOT the same fix, though, and that is why it stays separate. A gift
   card is BEARER value — whoever holds it spends it, which is why
   `customer_id` is nullable and why most cards carry no customer at all. The
   loyalty wallet is NAMED value belonging to a member. So gift cards need no
   member link: they need the FK dropped and an `origin_site_id`, which is much
   smaller than what loyalty required.

   Deferred rather than folded in because it is ~60 code sites and 14 touch
   points in `salesPosting`, and conflating the two would make a large change
   larger while making neither easier to review.
3. ~~**`member_number` format**~~ — **ANSWERED: sequential, through the existing
   numbering machinery.** Same gap-checking and audit as every other numbered
   thing. A pre-printed card is entered as an override rather than being the
   number itself.
4. ~~**The customer screen's Loyalty tab**~~ — **ANSWERED: the button.**
   `JoinLoyaltyPanel.tsx`. It takes the account's own name and phone rather than
   asking for them again, since retyping them on the screen that exists to link
   the two is how they drift apart.

   **AS BUILT:** the tab has THREE states, not two. A bare null could not
   distinguish "has not joined a running programme" — offer enrolment — from
   "the programme is switched off", where that button could not work. So
   `programmeEnabled` travels alongside the null.

   What it replaced was worse than an empty state: the tab rendered "Loyalty
   could not be loaded for this customer", which was reasonable when every
   customer WAS a member and became a warning shown for the commonest case.
5. ~~**Separate companies and the wallet**~~ — **ANSWERED, and not the way this
   plan read it.** Built in `sql/tickets/017_share_loyalty.sql` and
   `loyaltyWalletRefusal()`.

   Separate companies may share the programme — `loyaltyOwnerSite()` does not
   inherit the `legal_entity = 'one'` gate, which is what makes the franchise
   case possible at all. The wallet is a per-group SWITCH rather than a
   refusal: off by default (the answer needing no settlement agreement between
   the companies), surfaced on Setup → Linked stores only under "separate
   companies", with the consequence stated beside it.

   An option rather than my recommended refusal because it is a commercial
   decision the owner is entitled to make — a group with a settlement agreement
   has already made it. What the software owes them is the trade stated at the
   moment of choosing rather than discovered at a till.

6. **ANSWERED — attaching a customer at the till AUTO-ATTACHES their linked
   member**, rather than offering it. Fewer taps, and reversible: the member can
   be detached without detaching the customer. Decision 4 left this open.

---

## What the build found that this plan did not

Recorded because each was invisible to `tsc` and survived a careful read. The
pattern is worth more than the list: **a rename that compiles is not a rename
that works**, and nothing here was caught by the type checker.

### The spend could not stay inside the sale's transaction

The largest divergence, and the plan did not see it. `redeemPointsForSale` and
`spendWalletForSale` took the sale's `tx` and threw, so an unaffordable
redemption rolled the whole sale back. Under a shared programme those rows are
in another database and no transaction reaches them — the old arrangement did
not degrade, it failed outright.

Rebuilt rather than relocated: every refusal is asked BEFORE the sale opens
(`loyaltySpendRefusal`), and the deduction is written after it commits. What is
lost is stated where the code does it — a crash in between leaves goods sold and
a balance untouched. That is recoverable from the document; a till that cannot
sell to a member at all is not.

Gift cards inherited the same restructure and lost less, because their guard was
never the transaction: `UPDATE … WHERE balance >= ?` is arbitrated by the
database wherever the row lives.

### Four queries addressed a table shape that no longer existed

`loyalty_members` moved from being keyed on `customer_id` to its own `id`, so
`WHERE member_id = ?` matched a column that was gone — in **both `FOR UPDATE`
locks**, which are the entire defence against two tills spending one balance.
Two upserts also had to become updates: a cache refresh must not be able to
manufacture a nameless member.

### `origin_site_id` was missing from the customer link

`loyalty_members.customer_id` alone is ambiguous when loyalty is shared and
customers are not — twenty branches each have their own customer 41, and
`uq_member_customer` would have refused the second branch's enrolment, telling a
cashier that a customer they had never seen was already a member. The unique key
covers the pair.

### The report engine only knew two owners

Both loyalty sources declared `ownedBy: 'customer'`, which routes to the wrong
database whenever the flags differ — and they are independent by design. The
members report also joined customers with `INNER JOIN … always`, which silently
dropped every walk-in from the report that counts the programme. Proved rather
than argued: restoring it takes the probe from 4 rows to 2, with no error.

### Training mode had a hole per shared file

It refused a store sharing customers or suppliers and let a loyalty-sharing one
straight through, then the same again for gift cards. Practice sales would have
earned real points on real cards, and issued real stored value, in the group's
live scheme — where the watermark cannot reach to remove them.

### Gift cards, once shared, could be stranded by joining

The join gate counted members and stopped. A branch with no members but a box of
issued cards passed it, joined, and its cards became unfindable at every till.
Now refused, with a negative control proving it is the cards doing the refusing.

### And one bug that predated all of this

Three of the four group `SELECT`s omitted `shares_loyalty_wallet`, so
`listGroups` — which the Linked stores screen reads — returned it false however
it had been saved. The wallet switch would have rendered unchecked after being
turned on.
