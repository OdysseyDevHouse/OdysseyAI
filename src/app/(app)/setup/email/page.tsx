import { requireCapability, requireSite } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { mailConfig } from '@/lib/mail'
import { PageHeader, PageBody } from '@/components/ui'
import EmailSettingsClient from './EmailSettingsClient'
import { SMTP_PASS_MASK } from './actions'

export const dynamic = 'force-dynamic'

/**
 * The mail account this shop's documents are sent from.
 *
 * ── WHAT THIS SCREEN EXISTS TO FIX ──────────────────────────────────────────
 *
 * Mail was read from the ENVIRONMENT — one account for the whole process. On a
 * self-hosted install that is fine and remains the fallback. On the cloud, one
 * server hosts many businesses, so every one of them sent from the same
 * address and none could configure their own: a customer's invoice arrived
 * from us rather than from the shop that issued it.
 *
 * ── THE PASSWORD NEVER REACHES THE BROWSER ──────────────────────────────────
 *
 * The form is given a mask, not the value. An unchanged mask is not written
 * back, so opening this page and pressing Save cannot corrupt a working
 * password. Same discipline as the SMS secret next door.
 */
export default async function EmailSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')
  const site = await requireSite()

  const settings = await getSettings(siteId, [
    'smtp_host',
    'smtp_port',
    'smtp_user',
    'smtp_pass',
    'smtp_secure',
    'mail_from',
  ])

  /*
   * Whether the PROCESS has an account, which is what a shop with nothing of
   * its own is currently sending through. Read here so the screen can say which
   * of the two is in force — the difference decides whose name is on the
   * invoice, and it should not be a thing somebody has to deduce.
   *
   * Only whether one exists. The host and password of the system account are
   * not this shop's business.
   */
  const systemFallback = mailConfig() !== null

  return (
    <>
      <PageHeader
        title="Email"
        subtitle="The mail account your invoices, statements and orders are sent from."
      />
      <PageBody>
        <EmailSettingsClient
          initial={{
            host: settings.smtp_host,
            port: settings.smtp_port || '587',
            user: settings.smtp_user,
            /* The mask stands in for a stored password, and '' means none is
               set — the two are different claims and the screen shows both. */
            pass: settings.smtp_pass ? SMTP_PASS_MASK : '',
            /* Empty has never been written: fall back to the port guess, which
               is what mailConfigFor does when reading it. */
            secure: settings.smtp_secure === '1' || (settings.smtp_secure === '' && settings.smtp_port === '465'),
            from: settings.mail_from,
          }}
          systemFallback={systemFallback}
          /* Somewhere sensible to send the test — the address the shop already
             gave as its own. Editable; it is only a default. */
          suggestedTestAddress={site.email ?? ''}
        />
      </PageBody>
    </>
  )
}
