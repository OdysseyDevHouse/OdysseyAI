'use client'

import { useState } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  DataTable,
  Badge,
  Modal,
  Field,
  Input,
  Select,
  Checkbox,
  Tabs,
  useToast,
  type Column,
} from '@/components/ui'
import {
  createApiKeyAction,
  revokeApiKeyAction,
  createEndpointAction,
  setEndpointActiveAction,
  rotateEndpointSecretAction,
  deleteEndpointAction,
  redeliverAction,
  sendTestPingAction,
} from './actions'

/**
 * API keys + webhooks, one screen with three tabs — the machine door.
 *
 * The one hard UI rule here: a freshly minted key or secret is shown ONCE, in
 * a modal that says so, and never again — the server only keeps the hash.
 */

type KeyRow = {
  id: number
  name: string
  keyPrefix: string
  scopes: string[]
  createdBy: string
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
  expiresAt: string | null
  expired: boolean
}

type EndpointRow = {
  id: number
  url: string
  events: string[]
  isActive: boolean
  lastSuccessAt: string | null
  lastFailureAt: string | null
}

type ReferenceRow = {
  method: string
  path: string
  scope: string
  summary: string
}

type DeliveryRow = {
  id: number
  endpointUrl: string
  event: string
  status: 'pending' | 'delivered' | 'dead'
  attempts: number
  lastStatusCode: number | null
  lastError: string | null
  createdAt: string
}

const SCOPES = [
  { key: 'products:read', label: 'Read products' },
  { key: 'customers:read', label: 'Read customers' },
  { key: 'sales:read', label: 'Read sales documents' },
  { key: 'stock:read', label: 'Read stock levels' },
  { key: 'suppliers:read', label: 'Read suppliers' },
  { key: 'purchases:read', label: 'Read purchase documents (includes cost prices)' },
  { key: 'gl:read', label: 'Read journals & GL (financial data)' },
  { key: 'gift-cards:read', label: 'Look up gift-card balances' },
  { key: 'reports:run', label: 'Run reports' },
]

const EVENTS = [
  { key: 'order.placed', label: 'Online order placed' },
  { key: 'order.paid', label: 'Online order paid' },
  { key: 'order.status_changed', label: 'Online order status changed' },
  { key: 'sale.finalised', label: 'Sale finalised' },
  { key: 'sale.voided', label: 'Sale voided' },
  { key: 'customer.created', label: 'Customer created' },
  { key: 'grv.received', label: 'Goods received' },
  { key: 'stock.low', label: 'Stock low (digest cadence)' },
]

export default function ApiScreen({
  keys,
  endpoints,
  deliveries,
  reference,
}: {
  keys: KeyRow[]
  endpoints: EndpointRow[]
  deliveries: DeliveryRow[]
  reference: ReferenceRow[]
}) {
  const toast = useToast()
  const [tab, setTab] = useState('keys')

  /* ── New key dialog ──────────────────────────────────────────────────── */
  const [keyOpen, setKeyOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [keyScopes, setKeyScopes] = useState<Set<string>>(new Set())
  const [keyExpiry, setKeyExpiry] = useState('')
  const [busy, setBusy] = useState(false)
  /** The once-only reveal — a key or a webhook secret, straight from a mint. */
  const [reveal, setReveal] = useState<{ title: string; value: string } | null>(null)

  const mintKey = async () => {
    setBusy(true)
    const result = await createApiKeyAction({
      name: keyName,
      scopes: [...keyScopes],
      expiresInDays: keyExpiry ? Number(keyExpiry) : null,
    })
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    setKeyOpen(false)
    setKeyName('')
    setKeyScopes(new Set())
    setKeyExpiry('')
    setReveal({ title: 'Your new API key', value: result.rawKey })
  }

  /* ── New endpoint dialog ─────────────────────────────────────────────── */
  const [epOpen, setEpOpen] = useState(false)
  const [epUrl, setEpUrl] = useState('')
  const [epEvents, setEpEvents] = useState<Set<string>>(new Set())

  const addEndpoint = async () => {
    setBusy(true)
    const result = await createEndpointAction({ url: epUrl, events: [...epEvents] })
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    setEpOpen(false)
    setEpUrl('')
    setEpEvents(new Set())
    setReveal({ title: 'This endpoint’s signing secret', value: result.secret })
  }

  const keyColumns: Column<KeyRow>[] = [
    { key: 'name', header: 'Name', cell: (r) => <span className="font-medium text-ink">{r.name}</span>, sortValue: (r) => r.name },
    { key: 'prefix', header: 'Key', cell: (r) => <span className="numeric text-muted">odk_…_{r.keyPrefix}_…</span> },
    {
      key: 'scopes',
      header: 'Scopes',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.scopes.map((s) => (
            <Badge key={s} tone="neutral">{s}</Badge>
          ))}
        </span>
      ),
    },
    { key: 'created', header: 'Created', cell: (r) => `${r.createdAt} by ${r.createdBy}`, sortValue: (r) => r.createdAt },
    { key: 'used', header: 'Last used', cell: (r) => r.lastUsedAt ?? '—', sortValue: (r) => r.lastUsedAt ?? '' },
    { key: 'expires', header: 'Expires', cell: (r) => r.expiresAt ?? 'Never', sortValue: (r) => r.expiresAt ?? '' },
    {
      key: 'status',
      header: 'Status',
      cell: (r) =>
        r.revoked ? (
          <Badge tone="danger">Revoked</Badge>
        ) : r.expired ? (
          <Badge tone="warning">Expired</Badge>
        ) : (
          <Badge tone="success">Active</Badge>
        ),
      sortValue: (r) => (r.revoked ? 2 : r.expired ? 1 : 0),
    },
  ]

  const endpointColumns: Column<EndpointRow>[] = [
    { key: 'url', header: 'URL', cell: (r) => <span className="break-all font-medium text-ink">{r.url}</span> },
    {
      key: 'events',
      header: 'Events',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.events.map((e) => (
            <Badge key={e} tone="brand">{e}</Badge>
          ))}
        </span>
      ),
    },
    { key: 'ok', header: 'Last success', cell: (r) => r.lastSuccessAt ?? '—' },
    { key: 'fail', header: 'Last failure', cell: (r) => r.lastFailureAt ?? '—' },
    {
      key: 'active',
      header: 'Status',
      cell: (r) => (r.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Paused</Badge>),
    },
  ]

  const deliveryColumns: Column<DeliveryRow>[] = [
    { key: 'when', header: 'Queued', cell: (r) => r.createdAt, sortValue: (r) => r.createdAt },
    { key: 'event', header: 'Event', cell: (r) => <Badge tone="brand">{r.event}</Badge> },
    { key: 'url', header: 'Endpoint', cell: (r) => <span className="break-all text-muted">{r.endpointUrl}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (r) =>
        r.status === 'delivered' ? (
          <Badge tone="success">Delivered</Badge>
        ) : r.status === 'pending' ? (
          <Badge tone="warning">Pending</Badge>
        ) : (
          <Badge tone="danger">Dead</Badge>
        ),
      sortValue: (r) => r.status,
    },
    { key: 'attempts', header: 'Attempts', cell: (r) => String(r.attempts), numeric: true },
    {
      key: 'error',
      header: 'Last result',
      cell: (r) =>
        r.lastError ? (
          <span className="text-danger-ink">{r.lastStatusCode ? `${r.lastStatusCode} — ` : ''}{r.lastError}</span>
        ) : r.lastStatusCode ? (
          String(r.lastStatusCode)
        ) : (
          '—'
        ),
    },
  ]

  const referenceColumns: Column<ReferenceRow>[] = [
    {
      key: 'method',
      header: 'Method',
      cell: (r) => <Badge tone={r.method === 'GET' ? 'neutral' : 'brand'}>{r.method}</Badge>,
    },
    { key: 'path', header: 'Path', cell: (r) => <span className="font-mono text-sm text-ink">/api/v1{r.path}</span> },
    { key: 'scope', header: 'Scope', cell: (r) => <Badge tone="neutral">{r.scope}</Badge> },
    { key: 'summary', header: 'What it answers', cell: (r) => <span className="text-muted">{r.summary}</span> },
  ]

  return (
    <>
      <Tabs
        items={[
          { value: 'keys', label: `API keys (${keys.length})` },
          { value: 'webhooks', label: `Webhooks (${endpoints.length})` },
          { value: 'deliveries', label: 'Delivery log' },
          { value: 'reference', label: 'Reference' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'keys' && (
        <Card>
          <CardHeader
            title="API keys"
            description="A key authenticates a program, not a person: pass it as Authorization: Bearer. Read-only by design — integrations read, and changes arrive by webhook."
            action={<Button onClick={() => setKeyOpen(true)}>New key</Button>}
          />
          <DataTable
            columns={keyColumns}
            rows={keys}
            getRowKey={(r) => r.id}
            actions={(r) =>
              r.revoked ? null : (
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={async () => {
                    const result = await revokeApiKeyAction(r.id)
                    if (!result.ok) toast.error(result.error)
                    else toast.success('Key revoked. Programs holding it are refused from now on.')
                  }}
                >
                  Revoke
                </Button>
              )
            }
            empty={{
              title: 'No API keys yet',
              hint: 'Mint one to let an outside program read this store over /api/v1.',
            }}
          />
        </Card>
      )}

      {tab === 'webhooks' && (
        <div className="space-y-4">
        <Card>
          <CardHeader
            title="Webhook endpoints"
            description="Events are POSTed as JSON with an X-Odyssey-Signature header: HMAC-SHA256 of `t.body` with the endpoint secret. Failed deliveries retry on a backoff ladder."
            action={<Button onClick={() => setEpOpen(true)}>Add endpoint</Button>}
          />
          <DataTable
            columns={endpointColumns}
            rows={endpoints}
            getRowKey={(r) => r.id}
            actions={(r) => (
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    const result = await sendTestPingAction(r.id)
                    if (!result.ok) toast.error(result.error)
                    else toast.success(`Ping delivered — the receiver answered HTTP ${result.statusCode}.`)
                  }}
                >
                  Send ping
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    await setEndpointActiveAction(r.id, !r.isActive)
                    toast.success(r.isActive ? 'Paused — queued deliveries will park as dead.' : 'Resumed.')
                  }}
                >
                  {r.isActive ? 'Pause' : 'Resume'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    const result = await rotateEndpointSecretAction(r.id)
                    if (!result.ok) toast.error(result.error)
                    else setReveal({ title: 'The new signing secret', value: result.secret })
                  }}
                >
                  Rotate secret
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={async () => {
                    await deleteEndpointAction(r.id)
                    toast.success('Endpoint deleted, along with its delivery log.')
                  }}
                >
                  Delete
                </Button>
              </div>
            )}
            empty={{
              title: 'No webhook endpoints yet',
              hint: 'Add one to have orders, sales and voids pushed to another system as they happen.',
            }}
          />
        </Card>

        <Card>
          <CardHeader
            title="Verifying signatures"
            description="Your receiver must recompute the HMAC over the raw body before trusting a payload — and refuse a stale timestamp, which is what stops a captured delivery being replayed later."
          />
          <CardBody>
            <pre className="overflow-x-auto rounded-control border border-border bg-surface-2 p-3 font-mono text-sm leading-relaxed text-ink">
{`// Node receiver — req must expose the RAW body string, not re-serialised JSON
const [tPart, v1Part] = req.headers['x-odyssey-signature'].split(',')
const t = Number(tPart.slice(2))
const expected = crypto.createHmac('sha256', SECRET).update(\`\${t}.\${rawBody}\`).digest('hex')
if (v1Part.slice(3) !== expected) return res.status(401).end()          // wrong secret or tampered body
if (Math.abs(Date.now() / 1000 - t) > 300) return res.status(401).end() // stale t — replay guard`}
            </pre>
          </CardBody>
        </Card>
        </div>
      )}

      {tab === 'deliveries' && (
        <Card>
          <CardHeader
            title="Delivery log"
            description="The most recent 50 deliveries across every endpoint. Redeliver resends the exact original payload with a fresh signature. Delivered and dead rows clear after 30 days."
          />
          <DataTable
            columns={deliveryColumns}
            rows={deliveries}
            getRowKey={(r) => r.id}
            actions={(r) =>
              r.status === 'pending' ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    const result = await redeliverAction(r.id)
                    if (!result.ok) toast.error(result.error)
                    else toast.success('Queued — it goes out on the next delivery tick.')
                  }}
                >
                  Redeliver
                </Button>
              )
            }
            empty={{
              title: 'Nothing delivered yet',
              hint: 'Rows appear here as events fire against active endpoints.',
            }}
          />
        </Card>
      )}

      {tab === 'reference' && (
        <Card>
          <CardHeader
            title="Endpoint reference"
            description={
              'Every call authenticates per request: Authorization: Bearer odk_… ' +
              'List responses share the envelope { items, total, limit, offset }. ' +
              'The machine-readable spec lives at /api/v1/openapi.json — no key needed.'
            }
            action={
              <Button variant="secondary" onClick={() => window.open('/api/v1/openapi.json', '_blank')}>
                Open openapi.json
              </Button>
            }
          />
          <DataTable
            columns={referenceColumns}
            rows={reference}
            getRowKey={(r) => `${r.method} ${r.path}`}
            empty={{ title: 'No endpoints', hint: 'The reference is built from the route registry.' }}
          />
        </Card>
      )}

      {/* New key */}
      <Modal open={keyOpen} onClose={() => setKeyOpen(false)} title="New API key">
        <div className="space-y-4">
          <Field label="Name" hint="The integration this key belongs to — that is how you will recognise it later.">
            <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="e.g. Accounting sync" />
          </Field>
          <Field
            label="Expires"
            hint="A key with an end date dies on its own — no one has to remember to revoke it."
          >
            <Select value={keyExpiry} onChange={(e) => setKeyExpiry(e.target.value)}>
              <option value="">Never</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="180">In 180 days</option>
              <option value="365">In 1 year</option>
            </Select>
          </Field>
          <Field label="Scopes">
            <div className="space-y-2">
              {SCOPES.map((s) => (
                <Checkbox
                  key={s.key}
                  label={s.label}
                  checked={keyScopes.has(s.key)}
                  onChange={(e) => {
                    const next = new Set(keyScopes)
                    if (e.target.checked) next.add(s.key)
                    else next.delete(s.key)
                    setKeyScopes(next)
                  }}
                />
              ))}
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setKeyOpen(false)}>Cancel</Button>
            <Button onClick={() => void mintKey()} disabled={busy || !keyName.trim() || keyScopes.size === 0}>
              Mint key
            </Button>
          </div>
        </div>
      </Modal>

      {/* New endpoint */}
      <Modal open={epOpen} onClose={() => setEpOpen(false)} title="Add webhook endpoint">
        <div className="space-y-4">
          <Field label="URL" hint="An https address on the receiving system.">
            <Input value={epUrl} onChange={(e) => setEpUrl(e.target.value)} placeholder="https://example.com/hooks/odyssey" />
          </Field>
          <Field label="Events">
            <div className="space-y-2">
              {EVENTS.map((ev) => (
                <Checkbox
                  key={ev.key}
                  label={ev.label}
                  checked={epEvents.has(ev.key)}
                  onChange={(e) => {
                    const next = new Set(epEvents)
                    if (e.target.checked) next.add(ev.key)
                    else next.delete(ev.key)
                    setEpEvents(next)
                  }}
                />
              ))}
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEpOpen(false)}>Cancel</Button>
            <Button onClick={() => void addEndpoint()} disabled={busy || !epUrl.trim() || epEvents.size === 0}>
              Add endpoint
            </Button>
          </div>
        </div>
      </Modal>

      {/* The once-only reveal */}
      <Modal open={reveal !== null} onClose={() => setReveal(null)} title={reveal?.title ?? ''}>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Copy this now — it is shown <span className="font-semibold text-ink">once</span> and the
            server keeps only a hash.
          </p>
          <div className="break-all rounded-control border border-border bg-surface-2 p-3 font-mono text-sm text-ink">
            {reveal?.value}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                if (reveal) void navigator.clipboard.writeText(reveal.value)
                toast.success('Copied.')
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setReveal(null)}>Done</Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
