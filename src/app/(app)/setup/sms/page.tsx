import { requireCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { SMS_SECRET_MASK } from '@/lib/sms/types'
import { PageHeader, PageBody } from '@/components/ui'
import SmsSettingsForm from './SmsSettingsForm'

export const dynamic = 'force-dynamic'

/**
 * Text messages.
 *
 * Email has no setup page (SMTP is env-driven, set once per install by whoever
 * hosts it) — SMS gets one because the credentials belong to the SHOP: each
 * site signs up with SMSPortal itself, pays per message itself, and pastes its
 * own keys here.
 */
export default async function SmsSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const settings = await getSettings(siteId, [
    'sms_provider',
    'sms_client_id',
    'sms_client_secret',
    'statement_sms_notify',
    'layby_reminder_days',
    'layby_reminder_sms',
  ])

  const provider =
    settings.sms_provider === 'smsportal' || settings.sms_provider === 'log'
      ? settings.sms_provider
      : ''

  return (
    <>
      <PageHeader
        title="Text messages"
        subtitle="The provider that sends them, and the reminders that use it."
      />
      <PageBody>
        <SmsSettingsForm
          settings={{
            provider,
            clientId: settings.sms_client_id ?? '',
            // The secret never travels to the browser — the form gets the mask
            // when one is stored, and only a changed value is written back.
            clientSecret: settings.sms_client_secret ? SMS_SECRET_MASK : '',
            statementNotify: settings.statement_sms_notify === '1',
            laybyReminderDays: Number(settings.layby_reminder_days) || 7,
            laybyReminderSms: settings.layby_reminder_sms ?? '',
          }}
        />
      </PageBody>
    </>
  )
}
