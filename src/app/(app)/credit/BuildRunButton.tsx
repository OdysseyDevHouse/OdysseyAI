'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button, ButtonLink, useToast } from '@/components/ui'
import { buildRunAction } from './actions'

/**
 * Builds a dunning run.
 *
 * When a draft already exists this becomes a link to it rather than a second
 * build. Two live drafts is how the same account gets two final demands from
 * two different runs on the same afternoon.
 */
export function BuildRunButton({
  hasDraft,
  draftId,
}: {
  hasDraft: boolean
  draftId: number | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState(false)

  if (hasDraft && draftId !== null) {
    return <ButtonLink href={`/credit/runs/${draftId}`}>Review draft run</ButtonLink>
  }

  function build() {
    setBusy(true)
    start(async () => {
      const result = await buildRunAction({})
      setBusy(false)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      if (result.runId) router.push(`/credit/runs/${result.runId}`)
      else router.refresh()
    })
  }

  return (
    <Button onClick={build} disabled={pending || busy}>
      {pending || busy ? 'Assessing…' : 'Build reminder run'}
    </Button>
  )
}
