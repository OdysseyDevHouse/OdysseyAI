import Image from 'next/image'
import { ShieldCheck } from '@/components/ui/icons'
import LoginForm from './login/LoginForm'
import LocalLoginForm from './login/LocalLoginForm'
import { localSiteId } from '@/lib/localSignIn'
import styles from './login.module.css'

/**
 * The landing page and the real sign-in. Authenticates against cp2_users in the
 * control database; on success the session opens the user's default site.
 *
 * ── EXCEPT ON A SHOP'S OWN MACHINE ─────────────────────────────────────────
 *
 * A local Electron install has no control database to ask. Its staff were
 * created on the machine and exist nowhere else, so it signs in with a name and
 * a PIN against the shop's own `users` table — see lib/localSignIn.ts, and
 * docs/plans/database-setup-app.md for why the model settled that way.
 *
 * Decided on the SERVER, from whether this machine has been told which shop it
 * is. A client-side check would flash the wrong form on every load, and the
 * wrong form here is one whose credentials cannot work.
 *
 * Presentation is a pixel-for-pixel port of the Odyssey POS login so the two
 * products share one front door — hence the local CSS module rather than the
 * UI kit. See the note at the top of login.module.css; the other screens built
 * on LoginScreen (/change-password, /select-site) still use the design tokens.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; kicked?: string }>
}) {
  const { next, kicked } = await searchParams
  const local = await localSiteId()

  return (
    <div className={styles.wrapper}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <Image
            src="/logo-full.png"
            alt="Odyssey Point of Sale"
            width={1109}
            height={304}
            className={styles.logo}
            priority
            unoptimized
          />
          <h1 className={styles.title}>Welcome back</h1>
          <p className={styles.subtitle}>
            {local ? 'Sign in with your name and PIN' : 'Sign in to your back office'}
          </p>
        </div>

        {/* WHY they are back here, when they did not ask to be.
            `requireSession` sets this after finding the session was superseded.
            Without it, being dropped at the login screen mid-task is
            indistinguishable from the app having broken — and the natural
            response to that is to sign in again, which would displace whoever
            legitimately holds the seat and start a loop. */}
        {kicked === '1' && (
          <div className={styles.notice} role="status">
            You were signed out because this account signed in on another device.
          </div>
        )}

        {local ? <LocalLoginForm /> : <LoginForm next={next ?? ''} />}

        <div className={styles.secureNote}>
          <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
          Secure and protected
        </div>
      </div>
    </div>
  )
}
