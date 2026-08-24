import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listCards } from '@/lib/site/loyaltyCards'
import { siteQuery } from '@/lib/siteDb'
import { PageHeader, PageBody, LinkTabs } from '@/components/ui'
import { CardsClient, type DepartmentOption, type ProductOption } from './CardsClient'
import { LOYALTY_TABS } from '../tabs'

export const dynamic = 'force-dynamic'

export default async function CardsPage() {
  const { siteId, capabilities } = await requireModuleCapability('loyalty', 'loyalty.view')

  const [cards, departments, products] = await Promise.all([
    listCards(siteId),
    siteQuery<{ id: number; name: string }>(
      siteId,
      'SELECT id, name FROM departments ORDER BY name',
    ),
    // Capped: the reward picker is a select, and a shop with 40 000 products
    // would render an unusable list and a very large page.
    siteQuery<{ id: number; code: string; description: string }>(
      siteId,
      `SELECT id, code, description FROM products
        WHERE is_archived = 0 ORDER BY description LIMIT 500`,
    ),
  ])

  return (
    <>
      <PageHeader title="Punch cards" subtitle="Buy a few, get one free — what fills a card and what it pays out." />
      <PageBody>
        <LinkTabs items={LOYALTY_TABS} value="cards" />
        <CardsClient
          cards={cards}
          departments={departments as DepartmentOption[]}
          products={products as ProductOption[]}
          canEdit={can(capabilities, 'loyalty.edit')}
        />
      </PageBody>
    </>
  )
}
