import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getLoyaltySettings, listMembers, listTiers, getLiability } from '@/lib/site/loyalty'
import { PageHeader, PageBody, StatStrip, StatTile, Callout, LinkTabs } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { MembersClient, type MemberRowView } from './MembersClient'
import { LOYALTY_TABS } from './tabs'

export const dynamic = 'force-dynamic'

function when(date: Date | null): string {
  if (!date) return ''
  return new Date(date).toLocaleDateString('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export default async function LoyaltyPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('loyalty.view')

  const [settings, members, tiers, liability] = await Promise.all([
    getLoyaltySettings(siteId),
    listMembers(siteId),
    listTiers(siteId),
    getLiability(siteId),
  ])

  const rows: MemberRowView[] = members.rows.map((row) => ({
    customerId: row.customerId,
    code: row.code,
    name: row.name,
    phone: row.phone,
    points: row.points,
    pointsValue: row.pointsValue,
    walletBalance: row.walletBalance,
    tierName: row.tierName,
    tierColor: row.tierColor,
    qualifyingSpend: row.qualifyingSpend,
    vouchersReady: row.vouchersReady,
    lastActivity: when(row.lastActivityAt),
  }))

  return (
    <>
      <PageHeader
        title="Loyalty"
        subtitle="Points, tiers, punch cards and what the programme owes."
      />
      <PageBody>
        <LinkTabs items={LOYALTY_TABS} value="members" />

        {!settings.enabled && (
          <Callout tone="warning">
            The programme is switched off, so nothing is earning at the till. Turn it on under
            Programme once the rates are right.
          </Callout>
        )}

        <StatStrip columns={4}>
          <StatTile label="Members" value={liability.members.toLocaleString()} hint="holding points" />
          <StatTile
            label="Points outstanding"
            value={Math.floor(liability.points).toLocaleString()}
          />
          <StatTile
            label="Worth"
            value={formatMoney(liability.pointsValue)}
            hint="what the points would cost in goods"
            tone={liability.pointsValue > 0 ? 'warning' : 'default'}
          />
          <StatTile
            label="Wallet float"
            value={formatMoney(liability.walletFloat)}
            hint="money already taken"
            tone={liability.walletFloat > 0 ? 'warning' : 'default'}
          />
        </StatStrip>

        <MembersClient
          rows={rows}
          truncated={members.truncated}
          canAdjust={can(capabilities, 'loyalty.adjust')}
          tierNames={tiers.filter((t) => t.isActive).map((t) => t.name)}
        />
      </PageBody>
    </>
  )
}
