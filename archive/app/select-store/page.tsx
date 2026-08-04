import { redirect } from 'next/navigation'
import { Store as StoreIcon, ChevronRight } from 'lucide-react'
import { requireSession } from '@/lib/auth'
import { listStores } from '@/lib/lookups'
import { selectStoreAction } from './actions'

export const dynamic = 'force-dynamic'

export default async function SelectStorePage() {
  const session = await requireSession()
  // Store users already have their store fixed on the account.
  if (session.storeId !== null) redirect('/dashboard')
  if (session.role !== 'platform_admin') redirect('/login')

  const stores = await listStores()

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-brand text-white">
            <StoreIcon size={22} />
          </div>
          <h1 className="text-lg font-semibold text-ink">Choose a store</h1>
          <p className="text-sm text-muted">Signed in as {session.email}</p>
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-surface">
          {stores.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted">
              No stores exist yet. Run <code>npm run db:seed</code> to create one.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {stores.map((s) => (
                <li key={s.id}>
                  <form action={selectStoreAction}>
                    <input type="hidden" name="storeId" value={s.id} />
                    <button
                      type="submit"
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-surface-2"
                    >
                      <span>
                        <span className="block text-sm text-ink">{s.name}</span>
                        <span className="block text-xs text-muted">
                          {s.code} · {s.status}
                        </span>
                      </span>
                      <ChevronRight size={16} className="text-muted" />
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  )
}
