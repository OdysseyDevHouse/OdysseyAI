import 'server-only'
import { getSettings } from './settings'
import { smsPortalProvider } from '../sms/smsportal'
import { logSmsProvider } from '../sms/log'
import type { SmsProvider } from '../sms/types'

/**
 * The site's SMS provider, from settings. Null when none is configured —
 * every consumer treats that as "skip with a recorded reason", never as a
 * failure: a run must not break because a channel is not set up.
 */
export async function getSmsProvider(siteId: number): Promise<SmsProvider | null> {
  const settings = await getSettings(siteId, ['sms_provider', 'sms_client_id', 'sms_client_secret'])

  switch (settings.sms_provider) {
    case 'log':
      return logSmsProvider()
    case 'smsportal': {
      const clientId = settings.sms_client_id?.trim()
      const secret = settings.sms_client_secret?.trim()
      if (!clientId || !secret) return null
      return smsPortalProvider(clientId, secret)
    }
    default:
      return null
  }
}

export async function isSmsConfigured(siteId: number): Promise<boolean> {
  return (await getSmsProvider(siteId)) !== null
}
