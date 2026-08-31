import SetupWizard from './SetupWizard'

/**
 * OdysseyAI Database Setup — the wizard's landing screen.
 *
 * ── WHY IT LIVES HERE AND NOT UNDER (app) ─────────────────────────────────
 *
 * `(app)/layout.tsx` calls requireSession() and wraps its children in
 * DesktopLicenceGate. Neither applies to a program that runs BEFORE the shop's
 * software exists: there is no session to require, no licence to check, and no
 * database to ask about either. A wizard behind that layout would redirect to a
 * login form whose users table has not been created yet.
 *
 * So it sits at the app root, alongside /login and /select-site, which are
 * outside that layout for the same reason.
 *
 * ── A SHELL, DELIBERATELY ─────────────────────────────────────────────────
 *
 * Everything with behaviour is in SetupWizard, which is a client component
 * because it drives the Electron bridge. This stays a server component so the
 * route costs nothing before that loads, and so the page's shape — one narrow
 * column, centred — is decided somewhere a step cannot accidentally change it.
 */
export const metadata = { title: 'Odyssey Database Setup' }

export default function DatabaseSetupPage() {
  return (
    <main className="bg-canvas flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <SetupWizard />
      </div>
    </main>
  )
}
