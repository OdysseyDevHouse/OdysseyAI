'use client'

import { useState } from 'react'
import { Button, Card, CardBody, CardHeader, Icons, Input, useToast } from '@/components/ui'

/**
 * The URL a technician pastes into their own calendar.
 *
 * ── COLLAPSED BY DEFAULT ───────────────────────────────────────────────────
 *
 * This is set up once and then never opened again, so it must not take room
 * from the jobs above it. It is also the one thing on this screen that is not
 * an action — everything else is something to do today.
 *
 * ── AND THE URL IS TREATED AS A SECRET ─────────────────────────────────────
 *
 * Anybody holding it can read this person's schedule — customer names, addresses
 * and times — until the secret is rotated. So it is hidden until asked for, and
 * the card says plainly what it is rather than leaving somebody to paste it into
 * a group chat.
 */
export default function CalendarSubscribe({ url }: { url: string }) {
  const toast = useToast()
  const [shown, setShown] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Copied. Paste it into your calendar as a subscription.')
    } catch {
      // Clipboard access is refused on an insecure origin and in some embedded
      // browsers. The field is already on screen and selectable, so say that
      // rather than failing silently.
      toast.error('Could not copy it — select the address and copy it by hand.')
    }
  }

  return (
    <Card>
      <CardHeader
        title="Put your jobs in your own calendar"
        description="A read-only feed of your visits, for Google, Outlook or Apple Calendar."
        action={
          <Button variant="secondary" onClick={() => setShown((v) => !v)}>
            <Icons.CalendarClock size={15} />
            {shown ? 'Hide the address' : 'Show the address'}
          </Button>
        }
      />
      {shown && (
        <CardBody>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Input value={url} readOnly onFocus={(e) => e.target.select()} />
            </div>
            <Button variant="secondary" onClick={copy}>
              <Icons.Copy size={15} />
              Copy
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Add it as a subscribed calendar, not an import — an import is a one-off copy that
            never updates. Treat the address like a password: anybody who has it can see where
            you are going.
          </p>
        </CardBody>
      )}
    </Card>
  )
}
