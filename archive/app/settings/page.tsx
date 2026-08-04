import { requireSession, requireStoreId } from '@/lib/auth'
import { getStore, listVatRates } from '@/lib/lookups'
import { PageHeader, Card } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const session = await requireSession()
  const storeId = await requireStoreId()
  const [store, vatRates] = await Promise.all([getStore(storeId), listVatRates(storeId)])

  const rows: [string, string][] = [
    ['Store', store?.name ?? '—'],
    ['Store code', store?.code ?? '—'],
    ['Currency', store?.currency ?? '—'],
    ['Timezone', store?.timezone ?? '—'],
    ['Signed in as', `${session.name} (${session.email})`],
    ['Role', session.role.replace('_', ' ')],
  ]

  return (
    <>
      <PageHeader title="Settings" subtitle="Store configuration and your account." />

      <div className="grid gap-4 p-6 lg:grid-cols-2">
        <Card>
          <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-ink">
            Store
          </h2>
          <dl className="divide-y divide-border">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 px-4 py-2.5 text-sm">
                <dt className="text-muted">{label}</dt>
                <dd className="text-right text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card>
          <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-ink">
            VAT rates
          </h2>
          <ul className="divide-y divide-border">
            {vatRates.map((v) => (
              <li key={v.id} className="flex justify-between gap-4 px-4 py-2.5 text-sm">
                <span className="text-ink">
                  {v.name}
                  {v.isDefault && <span className="ml-2 text-xs text-muted">default</span>}
                </span>
                <span className="numeric text-ink">{v.rate}%</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  )
}
