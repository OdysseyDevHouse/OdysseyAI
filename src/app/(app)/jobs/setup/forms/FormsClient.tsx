'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  TextLink,
  useToast,
} from '@/components/ui'
import { TABLE, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import { createFormAction, setActiveAction } from './actions'
import type { JobForm } from '@/lib/site/jobForms'

/**
 * The list of forms, and where a new one starts.
 *
 * ── WHAT THE BADGE COLUMN IS SAYING ────────────────────────────────────────
 *
 * A form is in one of four states and they are not a progression, so they read
 * as separate facts rather than a status pill: it may be live, it may have an
 * unpublished draft, it may be both, and it may be retired. "Live v2 · draft"
 * is the common and useful case — somebody is working on v3 while v2 is what
 * jobs are being asked.
 */
export default function FormsClient({ forms }: { forms: JobForm[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isPublic, setIsPublic] = useState(false)

  const live = forms.filter((f) => f.isActive)
  const retired = forms.filter((f) => !f.isActive)

  function create() {
    if (!name.trim()) {
      toast.error('A form needs a name.')
      return
    }
    start(async () => {
      const result = await createFormAction({
        name,
        description: description.trim() || null,
        isPublic,
      })
      if (result.ok) {
        setAdding(false)
        setName('')
        setDescription('')
        setIsPublic(false)
        // Straight into the builder: a form with no fields is not a thing
        // anybody wanted, it is a step on the way to one.
        router.push(`/jobs/setup/forms/${result.id}`)
      } else {
        toast.error(result.error)
      }
    })
  }

  function toggleActive(form: JobForm) {
    start(async () => {
      const result = await setActiveAction(form.id, !form.isActive)
      if (result.ok) {
        toast.success(form.isActive ? `${form.name} retired.` : `${form.name} is back.`)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function rows(list: JobForm[]) {
    return (
      <table className={TABLE}>
        <thead>
          <tr>
            <th className={TABLE_TH}>Form</th>
            <th className={TABLE_TH}>State</th>
            <th className={TABLE_TH}>Filled in</th>
            <th className={TABLE_TH} />
          </tr>
        </thead>
        <tbody>
          {list.map((form) => (
            <tr key={form.id}>
              <td className={TABLE_TD}>
                <div className="flex flex-col gap-0.5">
                  <TextLink href={`/jobs/setup/forms/${form.id}`}>{form.name}</TextLink>
                  {form.description && (
                    <span className="text-xs text-muted">{form.description}</span>
                  )}
                </div>
              </td>
              <td className={TABLE_TD}>
                <div className="flex flex-wrap items-center gap-1.5">
                  {form.liveVersionId !== null ? (
                    <Badge tone="success">Live v{form.liveVersion}</Badge>
                  ) : (
                    <Badge tone="neutral">Never published</Badge>
                  )}
                  {form.draftVersionId !== null && <Badge tone="warning">Draft</Badge>}
                  {form.isPublic && <Badge tone="brand">Customers see it</Badge>}
                </div>
              </td>
              <td className={TABLE_TD}>
                {form.responseCount > 0 ? (
                  <span className="text-ink-2">
                    {form.responseCount} {form.responseCount === 1 ? 'time' : 'times'}
                  </span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className={TABLE_TD}>
                <Button variant="ghost" size="sm" onClick={() => toggleActive(form)} disabled={pending}>
                  {form.isActive ? 'Retire' : 'Bring back'}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Forms"
          description="Attached to a job headline, they appear on every job of that kind."
          action={
            <Button onClick={() => setAdding(true)} disabled={pending}>
              New form
            </Button>
          }
        />
        <CardBody>
          {live.length === 0 ? (
            <EmptyState
              icon={<Icons.FileText size={20} />}
              title="No forms yet"
              hint="A form is what a technician fills in on site — readings, checks, a commissioning report."
            />
          ) : (
            rows(live)
          )}
        </CardBody>
      </Card>

      {retired.length > 0 && (
        <Card>
          <CardHeader
            title="Retired"
            description="No longer offered on new jobs. Their answers are kept — a submitted response is evidence, so a form with responses is never deleted."
          />
          <CardBody>{rows(retired)}</CardBody>
        </Card>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="New form">
        <div className="flex flex-col gap-4">
          <Field label="What is it called" hint="What a technician sees at the top of the form.">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Commissioning report"
              maxLength={190}
            />
          </Field>
          <Field label="What it is for" hint="Optional. Shown under the name on the list.">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={400}
            />
          </Field>
          {/* Checkbox is a native input, so the hint lives beside it rather
              than as a prop — see Field.tsx. */}
          <div className="flex flex-col gap-1">
            <Checkbox
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              label="Customers may see this one"
            />
            <span className="text-xs text-muted">
              Off by default. A form is an internal record until somebody decides otherwise.
            </span>
          </div>
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" onClick={() => setAdding(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={create} disabled={pending}>
              {pending ? 'Creating…' : 'Create and add fields'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
