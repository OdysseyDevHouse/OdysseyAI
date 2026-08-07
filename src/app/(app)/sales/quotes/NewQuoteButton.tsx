'use client'

import { useTransition } from 'react'
import { Button, Icons } from '@/components/ui'
import { newQuoteAction } from './actions'

/**
 * Starts a quote.
 *
 * A server action rather than a link, because a quote needs a row before it can
 * be edited — the editor works on a saved document, exactly as invoicing does.
 * The validity date is stamped at creation from the site default.
 */
export function NewQuoteButton() {
  const [pending, startTransition] = useTransition()

  return (
    <Button disabled={pending} onClick={() => startTransition(() => newQuoteAction())}>
      <Icons.Plus size={15} />
      {pending ? 'Starting…' : 'New quote'}
    </Button>
  )
}
