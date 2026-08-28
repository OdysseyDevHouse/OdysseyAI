import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listGiftCards, giftCardLiability } from '@/lib/site/giftCards'
import { formatMoney } from '@/lib/decimals'
import { PageHeader, PageBody, StatStrip, StatTile, Icons } from '@/components/ui'
import GiftCardsClient from './GiftCardsClient'

export const dynamic = 'force-dynamic'

/**
 * The gift card book.
 *
 * The liability tile is the figure the accountant reconciles against account
 * 2500: what the shop is holding for bearers, straight off the card balances.
 * Selling and redeeming happen at the till; this screen is stock, history and
 * the expiry sweep.
 */
export default async function GiftCardsPage() {
  const { siteId, capabilities } = await requireCapability('giftcards.view')
  const canManage = can(capabilities, 'giftcards.manage')

  const [cards, liability] = await Promise.all([
    listGiftCards(siteId, { limit: 500 }),
    giftCardLiability(siteId),
  ])

  const active = cards.filter((c) => c.status === 'active')
  const pending = cards.filter((c) => c.status === 'pending')

  return (
    <>
      <PageHeader
        title="Gift cards"
        subtitle="Stored value the shop is holding. Cards sell and redeem at the till; this is the book behind them."
      />
      <PageBody>
        {/* Each tile carries its subject's glyph. Without one StatTile renders
            no medallion and no divider — the label and figure alone, which is
            what made this strip read as three bare numbers rather than the
            tiles every other list screen shows.

            Colour is spent on MEANING, not decoration. The liability is money
            the shop owes its customers, so its medallion is money-coloured
            while the figure stays plain ink — `iconTone` rather than `tone`,
            because the balance is not an exception to act on, it is simply
            what is on the books. The other two are plain. */}
        <StatStrip columns={3}>
          <StatTile
            label="Held for bearers"
            value={formatMoney(liability)}
            hint="Live balances — the figure account 2500 mirrors"
            iconTone="success"
            icon={<Icons.Coins size={20} />}
          />
          <StatTile
            label="Active cards"
            value={String(active.length)}
            hint={active.length ? 'Sold and still carrying value' : 'None in circulation'}
            icon={<Icons.Gift size={20} />}
          />
          <StatTile
            label="Unsold stock"
            value={String(pending.length)}
            hint="Pre-generated cards waiting to sell"
            icon={<Icons.Package size={20} />}
          />
        </StatStrip>

        <GiftCardsClient
          cards={cards.map((c) => ({
            id: c.id,
            code: c.code,
            status: c.status,
            initialValue: c.initialValue,
            balance: c.balance,
            expiresOn: c.expiresOn,
            activatedDocNumber: c.activatedDocNumber,
            note: c.note,
          }))}
          canManage={canManage}
        />
      </PageBody>
    </>
  )
}
