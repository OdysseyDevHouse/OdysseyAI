import { requireSession } from '@/lib/auth'
import { totpStatus } from '@/lib/twoFactor'
import { PageHeader, PageBody } from '@/components/ui'
import SecurityScreen from './SecurityScreen'

export const dynamic = 'force-dynamic'

/**
 * The visitor's OWN sign-in security — two-factor on and off.
 *
 * Session-only, no capability: this reads and writes only the visitor's own
 * cp2_user_totp row, and a capability here would let an owner forbid people
 * from protecting their own login — backwards.
 */
export default async function SecurityPage() {
  const session = await requireSession()
  const status = await totpStatus(session.userId)

  return (
    <>
      <PageHeader
        title="Sign-in security"
        subtitle="Two-factor puts a six-digit code from your phone between a stolen password and your account."
      />
      <PageBody>
        <SecurityScreen enabled={status.enabled} email={session.email} />
      </PageBody>
    </>
  )
}
