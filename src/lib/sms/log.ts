import type { SmsProvider } from './types'

/**
 * The development provider: prints instead of sending, always succeeds.
 *
 * The seam every test injects, and what a site selects while trying the
 * feature out — messages appear in the server log, nobody's phone rings, and
 * every consumer path (dunning legs, layby reminders, statement notes) runs
 * for real.
 */
export function logSmsProvider(sink: (line: string) => void = console.log): SmsProvider {
  return {
    name: 'log',
    async send(to, body) {
      sink(`[sms:log] to ${to}: ${body}`)
      return { ok: true, id: `log-${Date.now().toString(36)}` }
    },
  }
}
