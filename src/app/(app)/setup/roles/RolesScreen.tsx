'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  Switch,
  Modal,
  Field,
  Input,
  Textarea,
  Badge,
  Icons,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
} from '@/components/ui'
import type { RoleSummary, RoleMatrix } from '@/lib/site/permissions'
import {
  createRoleAction,
  updateRoleAction,
  deleteRoleAction,
  setCapabilityAction,
} from '../users/actions'

type Group = {
  key: string
  label: string
  capabilities: { key: string; label: string; hint: string }[]
}

/**
 * The role × capability grid.
 *
 * Saves on each tick rather than behind a Save button: there is one boolean per
 * cell, the change is instantly reversible, and a form that batches thirty
 * checkboxes into one submit invites someone to walk away mid-edit believing
 * they had granted something.
 *
 * Grouped by module and collapsed by default because the full grid is thirty-
 * odd rows. Showing all of them at once is how a permissions screen becomes a
 * thing nobody reads before ticking.
 *
 * The owner column is shown but locked. Seeing that an owner has everything is
 * the point — it is what makes "who can put this back?" answerable.
 */
export default function RolesScreen({
  roles,
  matrix,
  groups,
}: {
  roles: RoleSummary[]
  matrix: RoleMatrix
  groups: Group[]
}) {
  const [local, setLocal] = useState(matrix)
  const [open, setOpen] = useState<Set<string>>(new Set([groups[0]?.key].filter(Boolean) as string[]))
  const [editing, setEditing] = useState<RoleSummary | null>(null)
  const [adding, setAdding] = useState(false)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function toggle(roleId: number, capability: string, next: boolean) {
    const previous = local[roleId]?.[capability] ?? false
    setLocal((current) => ({
      ...current,
      [roleId]: { ...current[roleId], [capability]: next },
    }))

    startTransition(async () => {
      const result = await setCapabilityAction(roleId, capability, next)
      if (!result.ok) {
        // Put the tick back where it was — a checkbox that stays changed after
        // a refused save is a lie about what the server holds.
        setLocal((current) => ({
          ...current,
          [roleId]: { ...current[roleId], [capability]: previous },
        }))
        toast.error(result.error)
        return
      }
      router.refresh()
    })
  }

  function removeRole(role: RoleSummary) {
    startTransition(async () => {
      const result = await deleteRoleAction(role.id)
      if (!result.ok) return toast.error(result.error)
      toast.success(result.message)
      router.refresh()
    })
  }

  const toggleGroup = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Icons.Plus size={16} />
          Add role
        </Button>
      </div>

      {/* The roles themselves, before the grid — you cannot tick a box for a
          role you have not created, so the list comes first. */}
      <Card>
        <CardHeader title="Roles" description="Named after the job, not the billing relationship." />
        <div className="overflow-x-auto">
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH}>Role</th>
                <th className={TABLE_TH}>People</th>
                <th className={`${TABLE_TH} text-right`}>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.id} className={TABLE_ROW}>
                  <td className={TABLE_TD}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink">{role.name}</span>
                      {role.isOwner && <Badge tone="brand">Every permission</Badge>}
                    </div>
                    {role.description && (
                      <div className="text-xs text-muted">{role.description}</div>
                    )}
                  </td>
                  <td className={TABLE_TD}>
                    <span className="text-ink-2">{role.userCount}</span>
                  </td>
                  <td className={`${TABLE_TD} text-right`}>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Rename ${role.name}`}
                        onClick={() => setEditing(role)}
                      >
                        <Icons.Pencil size={15} />
                      </Button>
                      {!role.isOwner && (
                        <Button
                          variant="danger-ghost"
                          size="sm"
                          iconOnly
                          disabled={pending}
                          aria-label={`Delete ${role.name}`}
                          onClick={() => removeRole(role)}
                        >
                          <Icons.Trash size={15} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {groups.map((group) => {
        const expanded = open.has(group.key)
        return (
          <Card key={group.key}>
            {/* Not a <Button>: this is a full-width disclosure row that must
                fill the card header, which button chrome would fight. */}
            <button
              data-kit-ok
              type="button"
              onClick={() => toggleGroup(group.key)}
              aria-expanded={expanded}
              className="flex w-full items-center gap-2 px-6 py-4 text-left transition hover:bg-surface-2"
            >
              <Icons.ChevronDown
                size={16}
                className={`shrink-0 text-muted transition-transform ${expanded ? '' : '-rotate-90'}`}
              />
              <span className="font-medium text-ink">{group.label}</span>
              <span className="text-xs text-muted">{group.capabilities.length} permissions</span>
            </button>

            {expanded && (
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Permission</th>
                      {roles.map((role) => (
                        <th key={role.id} className={`${TABLE_TH} text-right`}>
                          {role.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.capabilities.map((capability) => (
                      <tr key={capability.key} className={TABLE_ROW}>
                        <td className={TABLE_TD}>
                          <div className="text-ink">{capability.label}</div>
                          <div className="text-xs text-muted">{capability.hint}</div>
                        </td>
                        {roles.map((role) => (
                          <td key={role.id} className={`${TABLE_TD} text-right`}>
                            <div className="flex justify-end">
                              {role.isOwner ? (
                                <span title="The owner role always has every permission.">
                                  <Icons.Check size={16} className="text-success" />
                                </span>
                              ) : (
                                <Switch
                                  checked={local[role.id]?.[capability.key] ?? false}
                                  disabled={pending}
                                  onChange={(next) => toggle(role.id, capability.key, next)}
                                  ariaLabel={`${capability.label} for ${role.name}`}
                                />
                              )}
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )
      })}

      {(adding || editing) && (
        <RoleForm
          role={editing}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      )}
    </>
  )
}

function RoleForm({ role, onClose }: { role: RoleSummary | null; onClose: () => void }) {
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = role
        ? await updateRoleAction(role.id, name, description)
        : await createRoleAction(name, description)

      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={role ? `Rename ${role.name}` : 'Add a role'}
      description="Give it the name people here would actually use for the job."
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && (
          <div className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm">
            <Icons.StatusWarning size={16} className="mt-0.5 shrink-0 text-danger" />
            <span className="text-ink">{error}</span>
          </div>
        )}

        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Supervisor" />
        </Field>

        <Field label="Description" hint="Optional. What this role is for.">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Runs the front counter and can authorise discounts."
          />
        </Field>
      </div>
    </Modal>
  )
}
