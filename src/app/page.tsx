import Image from 'next/image'
import { ShieldCheck } from '@/components/ui/icons'
import LoginForm from './login/LoginForm'
import styles from './login.module.css'

/**
 * The landing page and the real sign-in. Authenticates against cp2_users in the
 * control database; on success the session opens the user's default site.
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
          <p className={styles.subtitle}>Sign in to your back office</p>
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

        <LoginForm next={next ?? ''} />

        <div className={styles.secureNote}>
          <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
          Secure and protected
        </div>
      </div>
    </div>
  )
}
