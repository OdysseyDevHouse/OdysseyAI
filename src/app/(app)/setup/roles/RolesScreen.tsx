'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Card,
  CardHeader,
  DataTable,
  Checkbox,
  SegmentedControl,
  Switch,
  Modal,
  Field,
  Input,
  TableToolbar,
  Textarea,
  Badge,
  Icons,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  type Column,
} from '@/components/ui'
import type { RoleSummary, RoleMatrix } from '@/lib/site/permissions'
import {
  createRoleAction,
  updateRoleAction,
  deleteRoleAction,
  setCapabilityAction,
  setCapabilitiesAction,
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
 * ONE ROLE AT A TIME, chosen by the segmented control. A column per role reads
 * nicely at three roles and becomes an unscrollable wall at eight — capping the
 * grid to the role being edited keeps its width constant however many roles a
 * store invents.
 *
 * Grouped by module and collapsed by default because the full grid is thirty-
 * odd rows. Showing all of them at once is how a permissions screen becomes a
 * thing nobody reads before ticking.
 *
 * The owner role is selectable but locked. Seeing that an owner has everything
 * is the point — it is what makes "who can put this back?" answerable.
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
  const [selectedId, setSelectedId] = useState<number | null>(roles[0]?.id ?? null)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  // Falls back to the first role so deleting the selected one never strands
  // the grid on a role that no longer exists.
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0]

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

  /**
   * Every permission in one section, on or off together.
   *
   * Sent as ONE call rather than a loop over toggle(): a section is up to
   * eleven switches, and a half-applied grant is the one failure mode a
   * permissions screen must not have. The optimistic paint and the rollback
   * therefore cover the whole group too.
   */
  function toggleGroupCapabilities(roleId: number, group: Group, next: boolean) {
    const keys = group.capabilities.map((capability) => capability.key)
    const previous = local[roleId] ?? {}

    setLocal((current) => ({
      ...current,
      [roleId]: {
        ...current[roleId],
        ...Object.fromEntries(keys.map((key) => [key, next])),
      },
    }))

    startTransition(async () => {
      const result = await setCapabilitiesAction(roleId, keys, next)
      if (!result.ok) {
        setLocal((current) => ({
          ...current,
          [roleId]: {
            ...current[roleId],
            ...Object.fromEntries(keys.map((key) => [key, previous[key] ?? false])),
          },
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

  const roleColumns: Column<RoleSummary>[] = [
    {
      key: 'role',
      header: 'Role',
      sortable: true,
      sortValue: (role) => role.name,
      cell: (role) => (
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{role.name}</span>
            {role.isOwner && <Badge tone="brand">Every permission</Badge>}
          </div>
          {role.description && <div className="text-xs text-muted">{role.description}</div>}
        </div>
      ),
    },
    {
      key: 'people',
      header: 'People',
      numeric: true,
      sortable: true,
      sortValue: (role) => role.userCount,
      cell: (role) =>
        role.userCount === 0 ? (
          // A role nobody holds is usually a leftover — worth a flag, not a 0
          // that reads identically to every other number at scanning speed.
          <Badge tone="warning">Unused</Badge>
        ) : (
          role.userCount
        ),
    },
  ]

  return (
    <>
      <TableToolbar
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icons.Plus size={16} />
            Add role
          </Button>
        }
      />

      {/* The roles themselves, before the grid — you cannot tick a box for a
          role you have not created, so the list comes first. */}
      <Card>
        <CardHeader title="Roles" description="Named after the job, not the billing relationship." />
        <DataTable
          columns={roleColumns}
          rows={roles}
          getRowKey={(role) => role.id}
          actions={(role) => (
            <>
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
            </>
          )}
          empty={{
            title: 'No roles yet',
            hint: 'Add one for each job people actually do here — cashier, supervisor, bookkeeper.',
            action: (
              <Button variant="secondary" onClick={() => setAdding(true)}>
                <Icons.Plus size={15} />
                Add role
              </Button>
            ),
          }}
        />
      </Card>

      {/* Anchored here rather than on a group card: the search indexes "Manager
          override", and the answer to that is the role picker plus the grid
          under it, not any one permission group. Landing on the picker is
          landing on the question "which role may do this". */}
      {selected && (
        <TableToolbar id="role-permissions">
          <span className="text-sm text-muted">Permissions for</span>
          <SegmentedControl
            aria-label="Role to edit"
            value={String(selected.id)}
            onChange={(next) => setSelectedId(Number(next))}
            options={roles.map((role) => ({ value: String(role.id), label: role.name }))}
          />
        </TableToolbar>
      )}

      {selected &&
        groups.map((group) => {
          const expanded = open.has(group.key)
          /* The owner reads as fully granted without any rows behind it, so the
             count comes off the flag rather than the matrix — see the switches
             below, which do the same. */
          const granted = selected.isOwner
            ? group.capabilities.length
            : group.capabilities.filter((c) => local[selected.id]?.[c.key]).length
          const all = granted === group.capabilities.length

          return (
            <Card key={group.key}>
              {/* The disclosure and the select-all are SIBLINGS, not nested:
                  a checkbox inside the header button would be a control inside
                  a control, and every click on it would also expand the card. */}
              <div className="flex items-center gap-3 pr-6">
                {/* Not a <Button>: this is a full-width disclosure row that must
                    fill the card header, which button chrome would fight. */}
                <button
                  data-kit-ok
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={expanded}
                  className="flex min-w-0 flex-1 items-center gap-2 px-6 py-4 text-left transition hover:bg-surface-2"
                >
                  <Icons.ChevronDown
                    size={16}
                    className={`shrink-0 text-muted transition-transform ${expanded ? '' : '-rotate-90'}`}
                  />
                  <span className="font-medium text-ink">{group.label}</span>
                  {/* The count of what is ON, not just how many exist: it is
                      what a collapsed section is being scanned for, and it
                      makes the select-all's state readable without opening. */}
                  <span className="shrink-0 text-xs text-muted">
                    {granted} of {group.capabilities.length}
                  </span>
                </button>

                <Checkbox
                  className="shrink-0"
                  checked={all}
                  /* Some-but-not-all — the dash. */
                  indeterminate={granted > 0 && !all}
                  disabled={selected.isOwner || pending}
                  onChange={(e) =>
                    toggleGroupCapabilities(selected.id, group, e.target.checked)
                  }
                  label={<span className="text-xs text-muted">All</span>}
                  aria-label={
                    selected.isOwner
                      ? `${group.label} — the owner role always has every permission`
                      : all
                        ? `Turn off every ${group.label} permission for ${selected.name}`
                        : `Turn on every ${group.label} permission for ${selected.name}`
                  }
                />
              </div>

              {expanded && (
                /* Hand-built rather than DataTable: the cells hold live
                   switches, so it wears the shared table skin instead. */
                <div className="overflow-x-auto">
                  <table className={TABLE}>
                    <thead>
                      <tr className={TABLE_HEAD_ROW}>
                        <th className={TABLE_TH}>Permission</th>
                        <th className={`${TABLE_TH} w-28 text-right`}>{selected.name}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.capabilities.map((capability) => (
                        <tr key={capability.key} className={TABLE_ROW}>
                          <td className={TABLE_TD}>
                            <div className="text-ink">{capability.label}</div>
                            <div className="text-xs text-muted">{capability.hint}</div>
                          </td>
                          <td className={`${TABLE_TD} text-right`}>
                            <div className="flex justify-end">
                              {/* Locked on, not hidden: an owner's switch that
                                  looks editable but refuses would be a lie. */}
                              <Switch
                                checked={
                                  selected.isOwner
                                    ? true
                                    : (local[selected.id]?.[capability.key] ?? false)
                                }
                                disabled={selected.isOwner || pending}
                                onChange={(next) => toggle(selected.id, capability.key, next)}
                                ariaLabel={
                                  selected.isOwner
                                    ? `${capability.label} — the owner role always has every permission`
                                    : `${capability.label} for ${selected.name}`
                                }
                              />
                            </div>
                          </td>
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
        {error && <Callout tone="danger">{error}</Callout>}

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
