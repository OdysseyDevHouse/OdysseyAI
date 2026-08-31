'use client'

import { Button } from './Button'
import { Input } from './Field'
import { useToast } from './Toast'
import * as Icons from './icons'

/**
 * A read-only link with a Copy button.
 *
 * ── IT WAS ALREADY IN FIVE SCREENS ─────────────────────────────────────────
 *
 * The booking link, the storefront link, the calendar subscription, the API
 * key and the portal link are all the same object: a URL somebody has to get
 * out of this app and into an email, a website or a printed page. Each had its
 * own copy of the markup and its own try/catch, and they had already drifted on
 * the thing that matters most — what happens when the copy FAILS.
 *
 * ── THE FAILURE IS THE REASON THIS IS A COMPONENT ─────────────────────────
 *
 * `navigator.clipboard` throws when the page is not in a secure context, which
 * on a shop counter is the ordinary case rather than the exotic one: a till
 * reached over the local network on plain http. So the input is always there,
 * always readable, and always selectable — the button is the convenience, not
 * the mechanism. A version that only had a button would be a dead end on
 * exactly the machines this software runs on.
 */
export function CopyLink({
  value,
  label = 'Copy',
  copiedMessage = 'Link copied.',
  className = '',
}: {
  value: string
  /** The button's text. "Copy" unless a screen has two of these. */
  label?: string
  copiedMessage?: string
  className?: string
}) {
  const toast = useToast()

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Input
        value={value}
        readOnly
        className="flex-1"
        // Selects the whole URL on focus, so keyboard copy works without a
        // careful drag — the fallback path when the button cannot.
        onFocus={(e) => e.currentTarget.select()}
      />
      <Button
        variant="secondary"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value)
            toast.success(copiedMessage)
          } catch {
            toast.info('Select the link and copy it.')
          }
        }}
      >
        <Icons.Copy size={15} />
        {label}
      </Button>
    </div>
  )
}
