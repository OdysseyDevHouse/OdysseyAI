import 'server-only'

/**
 * The PLATFORM's own PayFast credentials — Odyssey collecting from its tenants.
 *
 * Not to be confused with a tenant shop's gateway, which collects from that
 * shop's own customers and lives encrypted in the shop's database (see
 * src/lib/site/payments.ts). These are one set of credentials for the whole
 * platform, so they belong with the deploy secrets and not in a table any
 * support user could open.
 *
 * ── THIS IS THE ONLY PLACE PAYFAST_* IS READ ───────────────────────────────
 *
 * Nothing else in the codebase touches those variables, so when billing is
 * misconfigured there is exactly one file to look at.
 *
 * ── WHY IT REFUSES RATHER THAN LIMPS ───────────────────────────────────────
 *
 * The previous system did not validate the notify URL. An empty one was
 * silently stripped from the form, PayFast fell back to whatever the dashboard
 * had, and billing stopped working with no error anywhere — payments taken,
 * nothing recorded, and no way to tell from inside the app. So the rules below
 * throw, naming the variable, and the billing screen asks first (via
 * `platformPayFastStatus`) so a customer sees "not configured" rather than a
 * checkout button that leads nowhere.
 */

export type PlatformPayFastConfig = {
  merchantId: string
  merchantKey: string
  passphrase: string
  sandbox: boolean
  /** Where PayFast posts the notification. The only thing that proves payment. */
  notifyUrl: string
  /** Where the customer's browser lands. Neither proves anything. */
  returnUrl: string
  cancelUrl: string
}

function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

/**
 * Sandbox unless the variable is exactly "false".
 *
 * Failing TOWARD sandbox is the safe direction: a typo means no real money
 * moves, rather than real money moving against a half-configured account. The
 * cost is that "why did nothing get charged" has a boring answer, which is why
 * `describeMode()` below exists for the settings screen to display.
 */
function isSandbox(): boolean {
  return env('PAYFAST_SANDBOX') !== 'false'
}

/**
 * Is this URL one PayFast can actually reach?
 *
 * A production notify URL pointing at localhost is the precise shape of "the
 * money arrived and the callback went nowhere" — it looks configured, it
 * passes a non-empty check, and it can never work.
 */
function urlProblem(name: string, value: string, sandbox: boolean): string | null {
  if (!value) return `${name} is not set`

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return `${name} is not a valid URL`
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${name} must be an http(s) URL`
  }

  const local = parsed.hostname === 'localhost' || parsed.hostname.startsWith('127.')
  if (!sandbox && local) {
    return `${name} points at ${parsed.hostname}, which PayFast cannot reach`
  }

  return null
}

/** Everything wrong with the current configuration, in the order to fix it. */
function problems(): string[] {
  const sandbox = isSandbox()
  const found: string[] = []

  const merchantId = env('PAYFAST_MERCHANT_ID')
  if (!merchantId) found.push('PAYFAST_MERCHANT_ID is not set')
  // Same check the store gateway makes on its own merchant id: PayFast ids are
  // numeric, and a pasted-in key here fails much later and much less clearly.
  else if (!/^\d+$/.test(merchantId)) found.push('PAYFAST_MERCHANT_ID must be digits only')

  if (!env('PAYFAST_MERCHANT_KEY')) found.push('PAYFAST_MERCHANT_KEY is not set')

  // Not optional for subscriptions, and it must match the merchant account.
  if (!env('PAYFAST_PASSPHRASE')) {
    found.push('PAYFAST_PASSPHRASE is not set (set the same value in the PayFast dashboard)')
  }

  const notify = urlProblem('PAYFAST_NOTIFY_URL', env('PAYFAST_NOTIFY_URL'), sandbox)
  if (notify) found.push(notify)

  const ret = urlProblem('PAYFAST_RETURN_URL', env('PAYFAST_RETURN_URL'), sandbox)
  if (ret) found.push(ret)

  const cancel = urlProblem('PAYFAST_CANCEL_URL', env('PAYFAST_CANCEL_URL'), sandbox)
  if (cancel) found.push(cancel)

  return found
}

/**
 * Ask before offering a customer a checkout button.
 *
 * Non-throwing, so a screen can render an honest "billing is not set up yet"
 * instead of a button that explodes when pressed.
 */
export function platformPayFastStatus(): { ok: true; sandbox: boolean } | { ok: false; missing: string[] } {
  const missing = problems()
  return missing.length ? { ok: false, missing } : { ok: true, sandbox: isSandbox() }
}

/** The config, or a throw naming exactly what is wrong. */
export function platformPayFast(): PlatformPayFastConfig {
  const missing = problems()
  if (missing.length) {
    throw new Error(`PayFast is not configured for platform billing: ${missing.join('; ')}`)
  }

  return {
    merchantId: env('PAYFAST_MERCHANT_ID'),
    merchantKey: env('PAYFAST_MERCHANT_KEY'),
    passphrase: env('PAYFAST_PASSPHRASE'),
    sandbox: isSandbox(),
    notifyUrl: env('PAYFAST_NOTIFY_URL'),
    returnUrl: env('PAYFAST_RETURN_URL'),
    cancelUrl: env('PAYFAST_CANCEL_URL'),
  }
}

/** For a settings screen: which account money would actually go to. */
export function describeMode(): string {
  return isSandbox()
    ? 'Sandbox — no real money moves.'
    : `Live — collecting to merchant ${env('PAYFAST_MERCHANT_ID')}.`
}
