'use client'

import { useState } from 'react'
import { Button } from '@/components/ui'

/**
 * The form that carries the payer to PayFast.
 *
 * A plain form POST with hidden fields, in the order the signature was built
 * over. Nothing here is secret: merchant_id and merchant_key are the public half
 * of the credentials, and the signature — computed server-side with the
 * passphrase, which never leaves the server — binds them to an amount we chose.
 *
 * Client-side only for the submitting state. The button disables itself on
 * click, because a double-submit on a payment form is how a customer ends up
 * with two payment attempts and one very confusing statement.
 */
export default function PayForm({
  action,
  fields,
}: {
  action: string
  fields: Record<string, string>
}) {
  const [submitting, setSubmitting] = useState(false)

  return (
    <form action={action} method="post" onSubmit={() => setSubmitting(true)} className="mt-6">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Taking you to PayFast…' : 'Pay now'}
      </Button>
    </form>
  )
}
