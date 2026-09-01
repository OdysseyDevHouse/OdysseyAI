'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  CardFooter,
  CardHeader,
  DataTable,
  Badge,
  Modal,
  Field,
  Input,
  Select,
  Switch,
  Checkbox,
  Icons,
  EmptyState,
  RowTile,
  Skeleton,
  TableToolbar,
  ToolbarSearch,
  useToast,
  type Column,
} from '@/components/ui'
import type { SiteUser, UserType } from '@/lib/site/users'
import {
  saveUserAction,
  clearPinAction,
  clearTotpAction,
  revokeAccessAction,
  listMobileDevicesAction,
  revokeMobileDeviceAction,
} from './actions'

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
  const [phonesFor, setPhonesFor] = useState<SiteUser | null>(null)
  const [search, setSearch] = useState('')
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

  /* Narrowed by the search box in the toolbar. Name, email and role, because
     those are the three things somebody knows about the person they are looking
     for — "the Sipho one", "the @gmail address", "the cashiers". */
  const query = search.trim().toLowerCase()
  const visible = query
    ? users.filter((u) =>
        [u.name, u.email ?? '', u.roleName ?? ''].some((f) => f.toLowerCase().includes(query)),
      )
    : users

  const columns: Column<SiteUser>[] = [
    {
      key: 'name',
      header: 'User',
      sortValue: (u) => u.name,
      cell: (u) => (
        <div className="flex items-center gap-3">
          {/* Findable by shape rather than by reading — worth its 26px on any
              list of people (see odyssey-craft). The colour derives from the
              name, so it is stable across renders and sorts. */}
          <RowTile label={u.name} />
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">
              {u.name}
              {u.id === currentUserId && <span className="ml-2 text-xs text-muted">(you)</span>}
            </div>
            {/* The ROLE under the name, not the email — the email has a column
                of its own now, and repeating it here said the same thing twice
                while the role was three columns away from the person. */}
            <div className="truncate text-xs text-muted">
              {u.roleName ?? 'No role'}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'email',
      header: 'Email address',
      sortValue: (u) => u.email ?? '',
      cell: (u) =>
        u.email ? (
          <span className="truncate text-sm text-brand">{u.email}</span>
        ) : (
          /* A till-only user legitimately has none — they sign in with a PIN.
             Not a gap to fill, so it stays quiet rather than warning. */
          <span className="text-sm text-faint">—</span>
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
          <Badge tone="brand">{u.roleName}</Badge>
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
      <Card>
        <CardHeader
          icon={<Icons.Users size={18} />}
          title="Users"
          description="Everyone who may sign in — at the till, in the back office, or both."
        />

        {/* Inside the card, above its own table, rather than floating above it:
            the search and the actions operate THIS list, and a toolbar sitting
            outside read as page-level chrome that happened to sit nearby. */}
        <TableToolbar
          inCard
          actions={
            <>
              {/* Roles & permissions is no longer a tile of its own in the setup
                  hub — it is reached from here, because "who may sign in" and
                  "what they may do" are one job and were two front doors to it.
                  Secondary, so Add user stays the screen's one primary. */}
              <ButtonLink href="/setup/roles" variant="secondary">
                <Icons.KeyRound size={16} />
                Roles &amp; permissions
              </ButtonLink>
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Icons.Plus size={16} />
                Add user
              </Button>
            </>
          }
        >
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder="Search users…"
            aria-label="Search users"
          />
        </TableToolbar>

        <DataTable
          columns={columns}
          rows={visible}
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
              {/* Their phones. Same gate as two-factor above and for the same
                  reason: the mobile app signs in with an email and a password,
                  so a till-only user has nothing to list. */}
              {u.userType === 'back_office' && u.controlUserId !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  disabled={pending}
                  aria-label={`Mobile devices for ${u.name}`}
                  title="Mobile devices"
                  onClick={() => setPhonesFor(u)}
                >
                  <Icons.Smartphone size={15} />
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
          /* Two different empties, and the screen says which. A search that
             matched nothing is not the same as a shop with no users, and
             offering "Add user" to somebody who has simply mistyped a name is
             an answer to a question they did not ask. */
          empty={
            query
              ? {
                  title: `No user matches “${search.trim()}”`,
                  hint: 'Try part of a name, an email address, or a role.',
                  icon: <Icons.Search size={28} strokeWidth={1.75} />,
                  action: (
                    <Button variant="secondary" onClick={() => setSearch('')}>
                      Clear search
                    </Button>
                  ),
                }
              : {
                  title: 'Nobody can sign in yet',
                  hint: 'Add the people who work here — a till user needs only a PIN.',
                  action: (
                    // Secondary: the toolbar's Add user above stays the one primary.
                    <Button variant="secondary" onClick={() => setAdding(true)}>
                      <Icons.Plus size={15} />
                      Add user
                    </Button>
                  ),
                }
          }
        />

        {/* What the table is showing, against what there is — the half a count
            cannot give on its own once a search can narrow it. */}
        {visible.length > 0 && (
          <CardFooter className="justify-start">
            <span className="text-xs text-muted">
              {query
                ? `Showing ${visible.length} of ${users.length} ${users.length === 1 ? 'user' : 'users'}`
                : `${users.length} ${users.length === 1 ? 'user' : 'users'}`}
            </span>
          </CardFooter>
        )}
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

      {phonesFor && (
        <MobileDevicesDialog user={phonesFor} onClose={() => setPhonesFor(null)} />
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
  const [mobile, setMobile] = useState(user?.mobile ?? '')
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
        mobile: mobile.trim() || null,
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
      /* A long form: the default 60vh cap made it read through a letterbox with
         empty desktop above and below. Still a MAX, so a short one stays short. */
      bodyGrows
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

        {/* Deliberately OUTSIDE the back-office block below, unlike the email
            address. A till-only technician is precisely the person a text about
            today's work needs to reach, and they have no email to sign in with.
            Optional for everyone — a number is how somebody is reached, never
            how they are identified. */}
        <Field
          label="Mobile number"
          hint="For job messages by SMS or WhatsApp. Optional."
        >
          <Input
            type="tel"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            placeholder="082 123 4567"
            className="max-w-[14rem]"
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

type MobileDevice = { id: number; platform: string; label: string; lastSeenAt: string | null }

/**
 * One person's signed-in phones, and the button that cuts one off.
 *
 * ── WHY A DIALOG AND NOT A COLUMN ───────────────────────────────────────────
 *
 * Because almost every row would be empty. Most staff will never install the
 * app, and a column that is blank for nine users out of ten spends width on
 * nothing while pushing the ones that matter — name, access, role — closer
 * together. The question "which phones does this person have" is asked rarely
 * and deliberately, which is exactly what a dialog is for.
 *
 * Loaded when it opens rather than with the page: the list is a control-database
 * read per user, and doing it for everybody on a screen nobody may open would
 * be dozens of queries to answer a question nobody asked.
 */
function MobileDevicesDialog({ user, onClose }: { user: SiteUser; onClose: () => void }) {
  const [devices, setDevices] = useState<MobileDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  useEffect(() => {
    let live = true
    listMobileDevicesAction(user.id).then((result) => {
      if (!live) return
      if (!result.ok) setError(result.error)
      else setDevices(result.devices)
    })
    /* A dialog closed before the read lands must not set state on a component
       that is gone — and worse, must not show the PREVIOUS person's phones if
       it is reopened on somebody else in the meantime. */
    return () => {
      live = false
    }
  }, [user.id])

  function revokeOne(device: MobileDevice) {
    startTransition(async () => {
      const result = await revokeMobileDeviceAction(user.id, device.id)
      if (!result.ok) return toast.error(result.error)
      toast.success(result.message)
      setDevices((current) => (current ?? []).filter((d) => d.id !== device.id))
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Mobile devices — ${user.name}`}
      description="Phones and tablets signed in to the mobile app."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {error ? (
        <Callout tone="warning">{error}</Callout>
      ) : devices === null ? (
        <div className="flex flex-col gap-2 py-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : devices.length === 0 ? (
        <EmptyState
          icon={<Icons.Smartphone size={22} />}
          title="No devices signed in"
          hint="Nothing to do here until this person signs in on the mobile app."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {devices.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface-2 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-ink">{d.label}</div>
                <div className="text-xs text-muted">
                  {d.platform === 'ios' ? 'iPhone or iPad' : 'Android'}
                  {' · '}
                  {d.lastSeenAt ? `last used ${relativeDay(d.lastSeenAt)}` : 'never used'}
                </div>
              </div>
              <Button
                variant="danger-ghost"
                size="sm"
                disabled={pending}
                onClick={() => revokeOne(d)}
              >
                Sign out
              </Button>
            </div>
          ))}
          {/* Said once, under the list, rather than in every toast: a revoked
              device stops being able to sign in AGAIN immediately, but a session
              it already holds runs its twelve hours out. Someone dealing with a
              stolen phone needs to know that to decide about the password. */}
          <p className="px-1 pt-1 text-xs text-muted">
            Signing out stops a device getting a new session. One it already holds keeps
            working for up to twelve hours — change the password too if the device was stolen.
          </p>
        </div>
      )}
    </Modal>
  )
}

/** "today", "yesterday", or a plain date — enough to spot the one nobody uses. */
function relativeDay(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'unknown'
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return then.toLocaleDateString()
}
