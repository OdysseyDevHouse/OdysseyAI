import { Store } from '@/components/ui/icons'
import type { ReactNode } from 'react'

/**
 * The branding shell around a login form. Shared by the static screen on `/`
 * and the wired one on `/login` so the two can't drift apart visually.
 */
export default function LoginScreen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-brand text-white">
            <Store size={22} />
          </div>
          <h1 className="text-xl font-semibold text-ink">OdysseyAI</h1>
          <p className="text-sm text-muted">Point of sale back office</p>
        </div>

        <div className="rounded-card border border-border bg-surface p-6 shadow-sm">{children}</div>

        <p className="mt-5 text-center text-xs text-muted">
          Point of Sale (Pty) Ltd
        </p>
      </div>
    </main>
  )
}
