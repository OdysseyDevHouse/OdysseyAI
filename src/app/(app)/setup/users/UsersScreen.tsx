'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Card,
  DataTable,
  Badge,
  Modal,
  Field,
  Input,
  Select,
  Switch,
  Checkbox,
  Icons,
  TableToolbar,
  useToast,
  type Column,
} from '@/components/ui'
import type { SiteUser, UserType } from '@/lib/site/users'
import { saveUserAction, clearPinAction, clearTotpAction, revokeAccessAction } from './actions'

type Role = { id: number; name: string; isOwner: boolean }
type Rep = { id: number; name: string }
type SiteOption = { id: number; name: string; code: string }

/**
 * The people list.
 *
 * Two kinds of user share it because they are the same question — "who may do
 * something here" — and splitting them into two screens would ask an owner to
 * know which tab a person is on before they can find them.
 *
 * What separates them is the ACCESS column, not their placement: a POS-only
 * user shows a PIN and nothing else, a back-office user shows both. That is
 * also exactly the distinction the form asks about first, so the two read the
 * same way round.
 */
export default function UsersScreen({
  users,
  roles,
  reps,
  sites,
  currentSiteId,
  currentUserId,
}: {
  users: SiteUser[]
  roles: Role[]
  reps: Rep[]
  sites: SiteOption[]
  currentSiteId: number
  currentUserId: number
}) {
  const [editing, setEditing] = useState<SiteUser | null>(null)
  const [adding, setAdding] = useState(false)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function withPin(user: SiteUser) {
    startTransition(async () => {
      const result = await clearPinAction(user.id)
      if (!result.ok) return toast.error(result.error)
      toast.success(result.message)
      router.refresh()
    })
  }

  function revoke(user: SiteUser) {
    startTransition(async () => {
      const result = await revokeAccessAction(user.id)
      if (!result.ok) return toast.error(result.error)
      toast.success(result.message)
      router.refresh()
    })
  }

  function stripTotp(user: SiteUser) {
    startTransition(async () => {
      const result = await clearTotpAction(user.id)
      if (!result.ok) return toast.error(result.error)
      toast.success(result.message)
      router.refresh()
    })
  }

  const columns: Column<SiteUser>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (u) => u.name,
      cell: (u) => (
        <div>
          <div className="font-medium text-ink">
            {u.name}
            {u.id === currentUserId && <span className="ml-2 text-xs text-muted">(you)</span>}
          </div>
          {u.email && <div className="text-xs text-muted">{u.email}</div>}
        </div>
      ),
    },
    {
      key: 'access',
      header: 'Signs in with',
      sortValue: (u) => u.userType,
      cell: (u) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {u.userType === 'back_office' ? (
            <Badge tone="brand">Back office</Badge>
          ) : (
            <Badge tone="default">Till only</Badge>
          )}
          {u.hasPin ? (
            <Badge tone="success">PIN set</Badge>
          ) : (
            <Badge tone="warning">No PIN</Badge>
          )}
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      sortValue: (u) => u.roleName ?? '',
      cell: (u) =>
        u.roleName ? (
          <span className="text-ink-2">{u.roleName}</span>
        ) : (
          // Deny-by-default makes this a real state, not a cosmetic gap: they
          // can sign in and do nothing at all until someone picks a role.
          <Badge tone="danger">No role</Badge>
        ),
    },
    {
      key: 'rep',
      header: 'Sales rep',
      sortValue: (u) => u.salesRepName ?? '',
      cell: (u) => <span className="text-muted">{u.salesRepName ?? '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (u) => (u.isActive ? 1 : 0),
      cell: (u) =>
        u.isActive ? (
          <Badge tone="success">Active</Badge>
        ) : (
          <Badge tone="danger">Inactive</Badge>
        ),
    },
  ]

  return (
    <>
      <TableToolbar
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icons.Plus size={16} />
            Add user
          </Button>
        }
      />

      <Card>
        <DataTable
          columns={columns}
          rows={users}
          getRowKey={(u) => u.id}
          actions={(u) => (
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Edit ${u.name}`}
                onClick={() => setEditing(u)}
              >
                <Icons.Pencil size={15} />
              </Button>
              {u.hasPin && u.userType === 'back_office' && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  disabled={pending}
                  aria-label={`Clear PIN for ${u.name}`}
                  title="Clear PIN"
                  onClick={() => withPin(u)}
                >
                  <Icons.KeyRound size={15} />
                </Button>
              )}
              {/* The 2FA lockout recovery: their authenticator is gone, an
                  owner clears the requirement, they sign in and re-enrol. */}
              {u.userType === 'back_office' && u.controlUserId !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  disabled={pending}
                  aria-label={`Clear two-factor for ${u.name}`}
                  title="Clear two-factor (lost authenticator)"
                  onClick={() => stripTotp(u)}
                >
                  <Icons.ShieldCheck size={15} />
                </Button>
              )}
              {u.id !== currentUserId && u.isActive && (
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  disabled={pending}
                  aria-label={`Remove ${u.name} from this store`}
                  title="Remove access to this store"
                  onClick={() => revoke(u)}
                >
                  <Icons.Ban size={15} />
                </Button>
              )}
            </div>
          )}
          empty={{
            title: 'Nobody can sign in yet',
            hint: 'Add the people who work here — a till user needs only a PIN.',
            action: (
              // Secondary: the toolbar's Add user above stays the one primary.
              <Button variant="secondary" onClick={() => setAdding(true)}>
                <Icons.Plus size={15} />
                Add user
              </Button>
            ),
          }}
        />
      </Card>

      {(adding || editing) && (
        <UserForm
          user={editing}
          roles={roles}
          reps={reps}
          sites={sites}
          currentSiteId={currentSiteId}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      )}
    </>
  )
}

function UserForm({
  user,
  roles,
  reps,
  sites,
  currentSiteId,
  onClose,
}: {
  user: SiteUser | null
  roles: Role[]
  reps: Rep[]
  sites: SiteOption[]
  currentSiteId: number
  onClose: () => void
}) {
  const [name, setName] = useState(user?.name ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [userType, setUserType] = useState<UserType>(user?.userType ?? 'pos_only')
  const [roleId, setRoleId] = useState<string>(user?.roleId ? String(user.roleId) : '')
  const [repId, setRepId] = useState<string>(user?.salesRepId ? String(user.salesRepId) : '')
  const [pin, setPin] = useState('')
  const [password, setPassword] = useState('')
  const [isActive, setIsActive] = useState(user?.isActive ?? true)
  const [siteIds, setSiteIds] = useState<number[]>(
    user?.controlUserId ? sites.map((s) => s.id) : [currentSiteId],
  )
  const [controlRole, setControlRole] = useState<'owner' | 'manager' | 'staff'>('staff')
  const [error, setError] = useState<string | null>(null)

  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const isBackOffice = userType === 'back_office'

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await saveUserAction(user?.id ?? null, {
        name,
        email: email.trim() || null,
        userType,
        roleId: roleId ? Number(roleId) : null,
        salesRepId: repId ? Number(repId) : null,
        // An empty box means "leave the existing PIN alone", which is why this
        // is null rather than '' — the two mean different things downstream.
        pin: pin.trim() || null,
        isActive,
        control: isBackOffice
          ? {
              password: password.trim() || null,
              siteIds,
              defaultSiteId: siteIds[0] ?? null,
              role: controlRole,
            }
          : undefined,
      })

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
      title={user ? `Edit ${user.name}` : 'Add a user'}
      description="A till user needs only a PIN. A back office user also signs in with an email address."
      size="lg"
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
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jan Bezuidenhout" />
        </Field>

        <Field
          label="What can they use?"
          hint="A till user has no way into the back office at all."
        >
          <Select value={userType} onChange={(e) => setUserType(e.target.value as UserType)}>
            <option value="pos_only">Point of sale only</option>
            <option value="back_office">Back office and point of sale</option>
          </Select>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Role" hint="What they may do. Without one they can do nothing.">
            <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">No role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Sales rep" hint="Links till lines to a commission record.">
            <Select value={repId} onChange={(e) => setRepId(e.target.value)}>
              <option value="">Not a rep</option>
              {reps.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label={user?.hasPin ? 'New till PIN' : 'Till PIN'}
          hint={
            user?.hasPin
              ? 'Leave blank to keep the current PIN. 4 or 6 digits, unique to this person.'
              : '4 or 6 digits. It identifies them at the till, so it must be unique here.'
          }
        >
          <Input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="••••"
            className="max-w-[10rem]"
          />
        </Field>

        {isBackOffice && (
          <>
            <Field label="Email address" hint="What they type to sign in to the back office.">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jan@example.co.za"
              />
            </Field>

            <Field
              label={user?.controlUserId ? 'New password' : 'Password'}
              hint={
                user?.controlUserId
                  ? 'Leave blank to keep the current one. They will be asked to change any password you set.'
                  : 'At least 10 characters. They will be asked to change it when they first sign in.'
              }
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>

            <Field
              label="Stores they may open"
              hint="One back office account can cover several stores."
            >
              <div className="flex flex-col gap-2 rounded-control border border-border p-3">
                {sites.map((s) => (
                  <label key={s.id} className="flex items-center gap-2.5 text-sm">
                    <Checkbox
                      checked={siteIds.includes(s.id)}
                      onChange={(e) =>
                        setSiteIds((current) =>
                          e.target.checked
                            ? [...current, s.id]
                            : current.filter((id) => id !== s.id),
                        )
                      }
                    />
                    <span className="text-ink">{s.name}</span>
                    <span className="text-xs text-muted">{s.code}</span>
                  </label>
                ))}
              </div>
            </Field>

            <Field
              label="Control panel role"
              hint="Their level in the control panel. What they may do inside a store is set by the role above."
            >
              <Select
                value={controlRole}
                onChange={(e) => setControlRole(e.target.value as 'owner' | 'manager' | 'staff')}
              >
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
                <option value="owner">Owner</option>
              </Select>
            </Field>
          </>
        )}

        <Switch
          checked={isActive}
          onChange={setIsActive}
          label="Active"
          hint="Switch off to stop them signing in without deleting anything."
        />
      </div>
    </Modal>
  )
}
