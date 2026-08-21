import 'server-only'
import { giftCardOwnerSite } from '../storeGroups'
import { sharedFileDb } from './sharedFileDb'

/**
 * Reading and writing gift cards, wherever they live.
 *
 * The mechanics are in sharedFileDb.ts — this file is the resolver plus names.
 * Read that one for the wrapper-versus-prefix rule, which is the thing that
 * goes wrong.
 *
 * ── WHICH DATABASE, AND WHY IT IS NOT SIMPLY "THE LOYALTY ONE" ───────────
 *
 * Gift cards follow `shares_loyalty`: a shop asking for one card scheme is
 * asking for one card scheme, and two switches would let points travel while
 * stored value did not.
 *
 * But giftCardOwnerSite is NOT an alias for loyaltyOwnerSite, and the gap
 * between them is the whole point. Loyalty is exempt from the legal-entity
 * gate, because points cost nothing to honour and were never anybody's money.
 * A gift card is cash the shopper handed over — sold at store 3 and spent at
 * store 7, store 3 holds money store 7 gave goods for. So a group of separate
 * companies that has not agreed to pool stored value resolves to its OWN
 * cards, even while its loyalty programme is shared.
 *
 * See sql/tickets/018_share_gift_cards.sql and giftCardOwnerSite.
 *
 * ── THE TABLES THIS COVERS ───────────────────────────────────────────────
 *
 * gift_cards and gift_card_events, which always move together — the FK between
 * them is the one that survived 209 precisely because they are never in
 * different databases.
 *
 * A statement naming sales_documents, tender_types or shifts alongside them is
 * MIXED and wants giftCardDbPrefix instead. cashupDeclaration is the live
 * example.
 */
const db = sharedFileDb('gift cards', giftCardOwnerSite)

export const giftCardQuery = db.query
export const giftCardQueryOne = db.queryOne
export const giftCardExecute = db.execute
export const giftCardTransaction = db.transaction
export const giftCardDbPrefix = db.dbPrefix
export const giftCardBranchDbPrefix = db.branchDbPrefix
