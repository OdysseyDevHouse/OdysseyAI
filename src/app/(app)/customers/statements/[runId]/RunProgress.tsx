'use client'

import { useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Icons, useToast } from '@/components/ui'
import { retryRunAction } from '../actions'

/**
 * Keeps a running batch's figures fresh, and offers a retry once it stops.
 *
 * Polls with router.refresh() rather than opening a socket: the page is already
 * a Server Component that reads the counts, so refreshing re-runs that query
 * and React reconciles the difference. A few seconds of staleness on a batch
 * job nobody is watching closely is not worth a second transport.
 *
 * Polling stops the moment the run finishes — a screen that keeps hitting the
 * server forever is how a dashboard left open overnight becomes a load problem.
 */
export default function RunProgress({
  runId,
  status,
  failedCount,
}: {
  runId: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  failedCount: number
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const toast = useToast()

  const inFlight = status === 'pending' || status === 'running'

  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => router.refresh(), 3000)
    return () => clearInterval(timer)
  }, [inFlight, router])

  function retry() {
    startTransition(async () => {
      const result = await retryRunAction(runId)
      if (result.ok) {
        toast.success(result.message)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  if (inFlight) {
    return (
      <span className="flex items-center gap-2 text-sm text-muted">
        <Icons.Spinner size={15} className="animate-spin" />
        Sending…
      </span>
    )
  }

  if (failedCount > 0) {
    return (
      <Button variant="secondary" onClick={retry} disabled={pending}>
        <Icons.Refresh size={15} />
        {pending ? 'Retrying…' : `Retry ${failedCount} failed`}
      </Button>
    )
  }

  return null
}
