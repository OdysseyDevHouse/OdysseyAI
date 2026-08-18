import { requireCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { SMS_SECRET_MASK, WHATSAPP_SECRET_MASK } from '@/lib/sms/types'
import { PageHeader, PageBody } from '@/components/ui'
import SmsSettingsForm from './SmsSettingsForm'
import WhatsAppSettingsForm from './WhatsAppSettingsForm'

export const dynamic = 'force-dynamic'

/**
 * Text messages and WhatsApp.
 *
 * Both on one screen because from the shop's side they are one decision — how
 * we reach somebody on their phone — and a second page would mean discovering
 * WhatsApp by accident.
 *
 * Email has no setup page (SMTP is env-driven, set once per install by whoever
 * hosts it) — these get one because the credentials belong to the SHOP: each
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
    'whatsapp_enabled',
    'whatsapp_phone_id',
    'whatsapp_token',
  ])

  const provider =
    settings.sms_provider === 'smsportal' || settings.sms_provider === 'log'
      ? settings.sms_provider
      : ''

  return (
    <>
      <PageHeader
        title="Text messages & WhatsApp"
        subtitle="How this shop reaches people on their phone — text messages and WhatsApp."
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

        <WhatsAppSettingsForm
          settings={{
            enabled: settings.whatsapp_enabled === '1',
            phoneId: settings.whatsapp_phone_id ?? '',
            // Masked for the same reason the SMS secret is: the token never
            // travels to the browser, and an untouched mask means "keep it".
            token: settings.whatsapp_token ? WHATSAPP_SECRET_MASK : '',
          }}
        />
      </PageBody>
    </>
  )
}
