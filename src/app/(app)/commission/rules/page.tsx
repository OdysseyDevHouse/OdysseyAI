import { redirect } from 'next/navigation'
import { requireSiteUser } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listRules } from '@/lib/site/commission'
import { listUsers } from '@/lib/site/users'
import { listDepartments } from '@/lib/site/departments'
import { siteQuery } from '@/lib/siteDb'
import { PageHeader, PageBody, Card, Icons } from '@/components/ui'
import RulesScreen from './RulesScreen'

export const dynamic = 'force-dynamic'

export default async function CommissionRulesPage() {
  const { site, capabilities } = await requireSiteUser()
  if (!can(capabilities, 'commission.edit')) redirect('/not-allowed')

  const [rules, users, departments, brands, suppliers] = await Promise.all([
    listRules(site.id),
    listUsers(site.id),
    listDepartments(site.id),
    siteQuery<{ id: number; name: string }>(
      site.id,
      'SELECT id, name FROM brands WHERE is_active = 1 ORDER BY name',
    ),
    siteQuery<{ id: number; name: string }>(
      site.id,
      // Suppliers carry a status enum rather than a boolean; 'active' and
      // 'on_hold' are both still tradeable, and a rule may name either.
      `SELECT id, name FROM suppliers WHERE status IN ('active','on_hold')
        ORDER BY name LIMIT 500`,
    ),
  ])

  return (
    <>
      <PageHeader
        title="Commission rules"
        subtitle="What each person earns, and on which sales"
      />

      <PageBody>
        <RulesScreen
          rules={rules}
          users={users
            .filter((u) => u.isActive)
            .map((u) => ({ id: u.id, name: u.name }))}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          brands={brands.map((b) => ({ id: b.id, name: b.name }))}
          suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
        />

        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="text-sm">
              <p className="font-medium text-ink">One rule pays each line — never two.</p>
              <p className="text-muted">
                The lowest priority number that matches wins, and rules do not stack. Every figure
                is calculated excluding VAT and after discount. Paying on profit means a discount
                comes out of the salesperson’s own commission; paying on turnover means it does
                not.
              </p>
            </div>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
