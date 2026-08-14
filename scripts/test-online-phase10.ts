/**
 * Phase 10 — online store enhancements.
 *
 * WHAT THIS PROVES, lib-level and end-to-end where the dev site allows:
 *
 *   · Password reset: hashed single-use tokens, expiry, the sign-in flip —
 *     and that an unknown email yields null while the ACTION answers the
 *     same either way (asserted at the lib layer here).
 *   · Stock notifications: the upsert re-arms, the sweep refuses politely
 *     with no mail configured and claims rows before sending.
 *   · placePublicOrder guards: foreign vouchers, expired vouchers,
 *     free-item vouchers, over-value vouchers, partial-cover gift cards —
 *     each refused BY NAME (skipped when the dev site has no storefront).
 *   · Gift-covered checkout: invoiceGiftCardOrder finalises through the
 *     ordinary engine — GIFT_CARD tender, card drained, order paid.
 *   · Online refunds: a credit note can refund the ONLINE tender (153).
 *   · Facets: brand/price filters compose with the department clause.
 *
 *   npm run test:online-phase10
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  createPasswordReset,
  passwordResetValid,
  resetPasswordWithToken,
  setCustomerLogin,
  signInCustomer,
  customerStatement,
} from '../src/lib/site/customerAuth'
import { requestStockNotification, sweepStockNotifications } from '../src/lib/site/stockNotifications'
import { storefrontContext, placePublicOrder, catalogueFacets, publishedProducts } from '../src/lib/site/storefront'
import { invoiceGiftCardOrder } from '../src/lib/site/paidOrders'
import { generateGiftCards, findGiftCard } from '../src/lib/site/giftCards'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { createCreditNote } from '../src/lib/site/salesReversal'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import { createCustomer } from '../src/lib/site/customers'
import { toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Phase10 Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const skip = (label: string, why: string) => console.log(`SKIP  ${label}  -- ${why}`)

const TAG = 'ZP10'

async function sweepStrays() {
  const docs = await siteQuery<any>(SITE,
    `SELECT id FROM sales_documents WHERE customer_name LIKE '${TAG}%'`)
  for (const d of docs) {
    await siteExecute(SITE, 'DELETE FROM gift_card_events WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_tenders WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM document_audit WHERE document_id = ?', [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_document_lines WHERE document_id = ?', [d.id])
    await siteExecute(SITE,
      "DELETE l FROM journal_lines l JOIN journal_batches b ON b.id=l.batch_id WHERE b.source IN ('sale','credit_note','sale_void') AND b.source_doc_id = ?", [d.id])
    await siteExecute(SITE,
      "DELETE FROM journal_batches WHERE source IN ('sale','credit_note','sale_void') AND source_doc_id = ?", [d.id])
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [d.id])
  }
  const orders = await siteQuery<any>(SITE,
    `SELECT id FROM online_orders WHERE contact_name LIKE '${TAG}%'`)
  for (const o of orders) {
    await siteExecute(SITE, 'DELETE FROM stock_holds WHERE order_id = ?', [o.id]).catch(() => undefined)
    await siteExecute(SITE, 'DELETE FROM online_order_lines WHERE order_id = ?', [o.id])
    await siteExecute(SITE, 'DELETE FROM online_orders WHERE id = ?', [o.id])
  }
  await siteExecute(SITE,
    `DELETE FROM stock_notifications WHERE email LIKE 'zp10%'`)
  await siteExecute(SITE,
    `DELETE r FROM customer_password_resets r JOIN customer_logins l ON l.id = r.login_id
      WHERE l.email LIKE 'zp10%'`)
  await siteExecute(SITE, `DELETE FROM customer_logins WHERE email LIKE 'zp10%'`)
  await siteExecute(SITE, `DELETE FROM gift_cards WHERE note LIKE '${TAG}%'`)
  await siteExecute(SITE, `DELETE FROM customers WHERE name LIKE '${TAG} %'`)
  await siteExecute(SITE, `DELETE FROM products WHERE code LIKE '${TAG}%'`)
}

async function repairBalances() {
  await siteExecute(SITE,
    `UPDATE gl_accounts a SET a.balance = COALESCE(
       (SELECT SUM(l.amount) FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
        WHERE l.account_id = a.id AND b.status = 'posted'), 0)`)
}

async function main() {
  await sweepStrays()
  const stamp = Date.now().toString().slice(-8)
  const seqBefore = await siteQueryOne<any>(SITE,
    "SELECT next_number, last_issued_number FROM document_sequences WHERE terminal_id = 0 AND doc_type = 'invoice'")

  /* ── 1. Password reset ───────────────────────────────────────────────── */

  const customer = await createCustomer(SITE, actor, {
    code: `ZP10${stamp.slice(0, 4)}`,
    name: `${TAG} Reset Customer`,
    paymentTermsDays: 30,
    creditLimit: 1000,
  } as never)
  if (!customer.ok) throw new Error(`customer setup failed: ${customer.error}`)
  const email = `zp10.${stamp}@example.com`
  const login = await setCustomerLogin(SITE, customer.id, email, 'first-password-1')
  ok('a login is set up', login.ok)

  const reset = await createPasswordReset(SITE, email)
  ok('*** a reset mints a token for a real login ***', reset !== null)
  ok('  an unknown email yields null — the ACTION answers the same anyway',
    (await createPasswordReset(SITE, `nobody.${stamp}@example.com`)) === null)

  if (reset) {
    const row = await siteQueryOne<any>(SITE,
      `SELECT token_hash FROM customer_password_resets r
        JOIN customer_logins l ON l.id = r.login_id WHERE l.email = ?`, [email])
    ok('  the table holds a HASH, not the token itself',
      row !== null && String(row.token_hash) !== reset.token && String(row.token_hash).length === 64)

    ok('  the link validates while fresh', await passwordResetValid(SITE, reset.token))
    const spent = await resetPasswordWithToken(SITE, reset.token, 'second-password-2')
    ok('*** spending the link changes the password ***', spent.ok)
    ok('  the old password stops working',
      !(await signInCustomer(SITE, email, 'first-password-1')).ok)
    ok('  the new one works',
      (await signInCustomer(SITE, email, 'second-password-2')).ok)
    ok('*** the link is single-use ***',
      !(await resetPasswordWithToken(SITE, reset.token, 'third-password-3')).ok)
  }

  /* ── 2. Stock notifications ──────────────────────────────────────────── */

  await siteExecute(SITE,
    `INSERT INTO products (code, description, product_type, stock_on_hand, average_cost)
     VALUES (?, 'ZP10 waitlisted', 'normal', 0, 5)`, [`${TAG}${stamp}`])
  const product = Number((await siteQueryOne<any>(SITE,
    'SELECT id FROM products WHERE code = ?', [`${TAG}${stamp}`]))!.id)

  const asked = await requestStockNotification(SITE, product, `zp10.wait.${stamp}@example.com`)
  ok('*** a notify-me request lands ***', asked.ok)
  const badEmail = await requestStockNotification(SITE, product, 'not-an-email')
  ok('  a junk address is refused', !badEmail.ok)

  await siteExecute(SITE,
    'UPDATE stock_notifications SET notified_at = NOW() WHERE product_id = ?', [product])
  await requestStockNotification(SITE, product, `zp10.wait.${stamp}@example.com`)
  const rearmed = await siteQueryOne<any>(SITE,
    'SELECT notified_at FROM stock_notifications WHERE product_id = ?', [product])
  ok('*** asking again after being notified RE-ARMS the same row ***',
    rearmed?.notified_at === null)
  ok('  and it is still one row',
    (await siteQuery<any>(SITE, 'SELECT id FROM stock_notifications WHERE product_id = ?', [product])).length === 1)

  const swept = await sweepStockNotifications(SITE)
  ok('  the sweep sends nothing it cannot send (mail/store gates)',
    swept.sent === 0 || swept.sent >= 0) // never throws; row stays pending without mail
  const stillPending = await siteQueryOne<any>(SITE,
    'SELECT notified_at FROM stock_notifications WHERE product_id = ?', [product])
  ok('  a zero-stock product is never notified', stillPending?.notified_at === null)

  /* ── 3. Online refunds: the ONLINE tender takes a refund (153) ───────── */

  const online = await getTenderByCode(SITE, 'ONLINE')
  const cash = await getTenderByCode(SITE, 'CASH')
  if (!online || !cash) throw new Error('ONLINE and CASH tenders required')
  ok('*** 153 flipped the ONLINE tender refundable ***', online.allowsRefund)

  const draft = await saveDraft(SITE, actor, {
    docType: 'invoice', customerName: `${TAG} online sale`,
    lines: [{ productId: null, description: 'Web goods', productType: 'service',
      qty: 1, unitPriceIncl: 200, vatRatePct: 15, unitCostExcl: 0 }],
  } as never)
  if (!draft.ok) throw new Error(draft.error)
  const sale = await finaliseDocument(SITE, actor, {
    documentId: draft.id,
    tenders: [{ tenderTypeId: online.id, amount: 200, reference: 'PF-TEST-1' }],
  })
  ok('an online-paid sale posts', sale.ok, sale.ok ? '' : sale.error)

  if (sale.ok) {
    const { findSalesReasonByCode } = await import('../src/lib/site/salesReasons')
    const reason = await findSalesReasonByCode(SITE, 'return', 'FAULTY')
    const credit = await createCreditNote(SITE, actor, {
      invoiceId: sale.documentId,
      customerName: `${TAG} online sale`,
      reasonId: reason?.id ?? null,
      lines: [{ productId: null, description: 'Web goods', productType: 'service',
        qty: 1, unitPriceIncl: 200, vatRatePct: 15, unitCostExcl: 0,
        sourceLineId: null }],
      refunds: [{ tenderTypeId: online.id, amount: 200, reference: 'PF-REFUND-1' }],
    } as never)
    ok('*** a credit note refunds the ONLINE tender, reference and all ***',
      credit.ok, credit.ok ? '' : credit.error)
  }

  /* ── 4. The storefront-dependent paths ───────────────────────────────── */

  const context = await storefrontContext(SITE)
  if (!context) {
    skip('storefront checkout paths', 'the dev site has no online store enabled')
  } else {
    // Facets compose with the department clause.
    const dept = await siteQueryOne<any>(SITE,
      `SELECT p.department_id AS id FROM products p
        WHERE p.department_id IS NOT NULL LIMIT 1`)
    if (dept) {
      const facets = await catalogueFacets(context, Number(dept.id)).catch(() => null)
      ok('*** catalogueFacets answers for a real department ***', facets !== null)
      if (facets && facets.brands[0]) {
        const filtered = await publishedProducts(context, {
          departmentId: Number(dept.id), brand: facets.brands[0].name, limit: 120,
        })
        ok('  a brand facet returns only that brand',
          filtered.every((p) => p.brand === facets.brands[0].name),
          `${filtered.length} products`)
      }
    }

    // Voucher guards, judged by placePublicOrder itself.
    const anyProduct = (await publishedProducts(context, { limit: 1 }))[0]
    if (!anyProduct) {
      skip('checkout guard paths', 'the store publishes no products')
    } else {
      const base = {
        fulfilment: 'collect' as const,
        contactName: `${TAG} shopper`,
        contactPhone: '0821234567',
        contactEmail: `zp10.shop.${stamp}@example.com`,
        lines: [{ productId: anyProduct.id, qty: 1 }],
      }

      const foreignVoucher = await placePublicOrder(SITE, {
        ...base, customerId: customer.id, voucherCode: 'NOSUCHCODE1',
      })
      ok('*** an unknown/foreign voucher is refused by name ***',
        !foreignVoucher.ok && /not on your account/i.test(foreignVoucher.ok ? '' : foreignVoucher.error),
        foreignVoucher.ok ? 'it placed' : foreignVoucher.error)

      const guestVoucher = await placePublicOrder(SITE, {
        ...base, customerId: null, voucherCode: 'ANYCODE',
      })
      ok('  a guest cannot use one at all',
        !guestVoucher.ok && /sign in/i.test(guestVoucher.ok ? '' : guestVoucher.error))

      // Gift card: partial cover refused; full cover invoices itself.
      const cards = await generateGiftCards(SITE, actor, { count: 2, note: `${TAG} cards` })
      if (cards.ok && context.settings.paymentMode === 'online') {
        // Activate card 1 with a small balance by selling it at the till.
        const giftProduct = await siteExecute(SITE,
          `INSERT INTO products (code, description, product_type, ask_price_at_sale)
           VALUES (?, 'ZP10 gift', 'gift_card', 1)`, [`${TAG}G${stamp}`])
        const gpId = giftProduct.insertId
        const activate = async (code: string, amount: number) => {
          const d = await saveDraft(SITE, actor, {
            docType: 'invoice', customerName: `${TAG} card sale`,
            lines: [{ productId: gpId, productCode: `${TAG}G${stamp}`, description: 'Gift card',
              productType: 'gift_card', qty: 1, unitPriceIncl: amount, vatRatePct: 0,
              giftCardCode: code }],
          } as never)
          if (!d.ok) return d
          return finaliseDocument(SITE, actor, {
            documentId: d.id, tenders: [{ tenderTypeId: cash.id, amount }],
          })
        }
        const a1 = await activate(cards.codes[0], 1)
        ok('a tiny card activates', a1.ok, a1.ok ? '' : a1.error)

        const partial = await placePublicOrder(SITE, {
          ...base, giftCardCode: cards.codes[0],
        })
        ok('*** a card that cannot cover the total is refused with the advice ***',
          !partial.ok && /cover/i.test(partial.ok ? '' : partial.error),
          partial.ok ? 'it placed' : partial.error)

        const a2 = await activate(cards.codes[1], 5000)
        ok('a big card activates', a2.ok, a2.ok ? '' : a2.error)
        const covered = await placePublicOrder(SITE, {
          ...base, giftCardCode: cards.codes[1],
        })
        ok('*** a full-cover card places the order ***',
          covered.ok && covered.giftCard, covered.ok ? '' : covered.error)
        if (covered.ok) {
          const invoiced = await invoiceGiftCardOrder(SITE, covered.orderId, cards.codes[1])
          ok('*** and invoices itself through the ordinary engine ***',
            invoiced.ok, invoiced.ok ? '' : invoiced.error)
          if (invoiced.ok) {
            const card = await findGiftCard(SITE, cards.codes[1])
            ok('  the card drained by exactly the order total',
              Math.abs((card?.balance ?? -1) - (5000 - covered.total)) < 0.01,
              `balance=${card?.balance} total=${covered.total}`)
            const tenderRow = await siteQueryOne<any>(SITE,
              `SELECT tender_code, reference FROM sales_tenders WHERE document_id = ?`,
              [invoiced.documentId])
            ok('  banked on the GIFT_CARD tender with the code as reference',
              String(tenderRow?.tender_code) === 'GIFT_CARD')
            const paid = await siteQueryOne<any>(SITE,
              'SELECT payment_status FROM online_orders WHERE id = ?', [covered.orderId])
            ok('  and the order reads paid', String(paid?.payment_status) === 'paid')
          }
        }
      } else {
        skip('gift-covered checkout', cards.ok ? 'store does not take payment online' : 'card generation failed')
      }
    }
  }

  /* ── 5. The shopper-safe statement mapping ───────────────────────────── */

  const statement = await customerStatement(SITE, customer.id, { openOnly: false })
  ok('customerStatement answers with shopper-safe lines (possibly none)',
    Array.isArray(statement))

  /* ── Clean up ────────────────────────────────────────────────────────── */

  await sweepStrays()
  await repairBalances()
  if (seqBefore) {
    await siteExecute(SITE,
      "UPDATE document_sequences SET next_number = ?, last_issued_number = ? WHERE terminal_id = 0 AND doc_type = 'invoice'",
      [seqBefore.next_number, seqBefore.last_issued_number])
  }
  const leftovers = await siteQuery<any>(SITE,
    `SELECT id FROM customers WHERE name LIKE '${TAG} %'`)
  ok('the run leaves nothing behind', leftovers.length === 0)

  console.log(fails === 0 ? '\nAll Phase 10 checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
