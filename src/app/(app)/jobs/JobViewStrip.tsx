'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Field,
  Icons,
  Input,
  Modal,
  Switch,
  TextLink,
  useToast,
  buttonClass,
} from '@/components/ui'
import type { JobView, ViewFilters } from '@/lib/site/jobViews'
import { saveJobViewAction, deleteJobViewAction } from './actions'

/**
 * Named filter sets, pinned above the job list.
 *
 * ── A VIEW IS A SAVED URL ──────────────────────────────────────────────────
 *
 * It stores the filters, never the jobs — so "my overdue work" is right every
 * time it is opened rather than a list somebody has to maintain. The strip
 * therefore renders each view as a plain link to the job list with those filters
 * applied, which means back, forward, bookmarking and sharing all work for free.
 *
 * ── SAVE APPEARS ONLY WHEN THERE IS SOMETHING TO SAVE ──────────────────────
 *
 * Filtering the list is what makes the button meaningful; on an unfiltered list
 * it would save "everything", which is the list itself. So it is hidden until at
 * least one filter is on, and the server refuses the empty case as well.
 */
export default function JobViewStrip({
  views,
  current,
  activeViewId,
  currentUserId,
}: {
  views: JobView[]
  /** The filters currently applied, so Save this view knows what to store. */
  current: ViewFilters
  activeViewId: number | null
  currentUserId: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [pinned, setPinned] = useState(true)

  const hasFilters = Object.keys(current).length > 0

  function save() {
    start(async () => {
      const result = await saveJobViewAction({
        id: null,
        name,
        filters: current,
        isShared: shared,
        isPinned: pinned,
      })
      if (result.ok) {
        toast.success('View saved.')
        setNaming(false)
        setName('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove(view: JobView) {
    start(async () => {
      const result = await deleteJobViewAction(view.id)
      if (result.ok) {
        toast.success(`"${view.name}" deleted.`)
        // Off the view being deleted, or the page would still be filtered by it.
        if (activeViewId === view.id) router.push('/jobs')
        else router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const pinnedViews = views.filter((v) => v.isPinned)

  if (pinnedViews.length === 0 && !hasFilters) return null

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {pinnedViews.map((view) => {
          const params = new URLSearchParams()
          Object.entries(view.filters).forEach(([k, v]) => v && params.set(k, v))
          params.set('view', String(view.id))
          const active = activeViewId === view.id
          return (
            <span key={view.id} className="inline-flex items-center">
              <TextLink
                href={`/jobs?${params.toString()}`}
                className={
                  active
                    ? 'rounded-control bg-brand-soft px-2.5 py-1 text-sm font-medium text-brand'
                    : 'rounded-control px-2.5 py-1 text-sm text-ink-2 hover:bg-surface-2'
                }
              >
                {view.name}
                {view.isShared && (
                  <Badge tone="neutral" className="ml-1.5">
                    shared
                  </Badge>
                )}
              </TextLink>
              {/* Only your own, and only the one you are looking at — a delete
                  button on every chip turns a row of shortcuts into a minefield. */}
              {active && (view.ownerUserId === currentUserId || view.isShared) && (
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Delete the view ${view.name}`}
                  disabled={pending}
                  onClick={() => remove(view)}
                >
                  <Icons.Trash size={14} />
                </Button>
              )}
            </span>
          )
        })}

        {hasFilters && activeViewId === null && (
          <button
            type="button"
            className={buttonClass({ variant: 'ghost', size: 'sm' })}
            onClick={() => setNaming(true)}
          >
            <Icons.Plus size={14} />
            Save this view
          </button>
        )}
      </div>

      <Modal
        open={naming}
        onClose={() => setNaming(false)}
        title="Save this view"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setNaming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending || !name.trim()}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Saves the filters, not the jobs — so it stays right as work comes and goes.
          </p>
          <Field label="Call it">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My overdue work"
              maxLength={80}
            />
          </Field>
          <Switch checked={pinned} onChange={setPinned} label="Pin it above the list" />
          <Switch
            checked={shared}
            onChange={setShared}
            label="Let everybody use it"
            hint="Sharing a view does not share the jobs — people still see only what they may see."
          />
        </div>
      </Modal>
    </>
  )
}
