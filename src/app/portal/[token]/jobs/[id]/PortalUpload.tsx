'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icons } from '@/components/ui'
import { portalUploadAction } from '../../actions'

/**
 * A customer sends a photo of the problem.
 *
 * ── capture="environment" ON A PHONE ───────────────────────────────────────
 *
 * Opens the rear camera rather than the photo library, which is what somebody
 * standing in front of a leak actually wants. On a desktop it falls back to a
 * file picker, so nothing is lost by asking for it.
 *
 * The accept list here is a CONVENIENCE, not the guard — a file picker's accept
 * attribute is a suggestion the browser may ignore and a script can bypass
 * entirely. portalUpload re-checks the extension on the server.
 */
export default function PortalUpload({
  token,
  jobId,
  remaining,
}: {
  token: string
  jobId: number
  /** How many more this customer may send. Zero hides the control. */
  remaining: number
}) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (remaining <= 0) return null

  function pick(file: File) {
    setError(null)
    const form = new FormData()
    form.set('file', file)
    start(async () => {
      const result = await portalUploadAction(token, jobId, form)
      if (result.ok) {
        if (input.current) input.current.value = ''
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <div className="mt-3">
      {/* The real input is hidden behind a kit button — a bare file input cannot
          be styled to match, and this is the only screen that needs one. */}
      <input
        data-kit-ok
        ref={input}
        type="file"
        accept="image/*,.pdf"
        capture="environment"
        className="hidden"
        disabled={pending}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) pick(file)
        }}
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => input.current?.click()}
      >
        <Icons.Upload size={15} />
        {pending ? 'Sending…' : 'Send a photo'}
      </Button>
      <p className="mt-1 text-xs text-muted">
        A picture or a PDF, up to 10MB. {remaining} more allowed for this job.
      </p>
      {error && (
        <p className="mt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
