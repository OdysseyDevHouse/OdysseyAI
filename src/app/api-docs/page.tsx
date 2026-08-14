import type { Metadata } from 'next'
import { API_ENDPOINTS } from '@/app/api/v1/_lib/openapi'
import { API_SCOPES } from '@/lib/site/apiKeys'
import { WEBHOOK_EVENTS } from '@/lib/site/webhooks'
import { Badge, Card, CardBody, CardHeader } from '@/components/ui'

/**
 * The public developer reference for /api/v1.
 *
 * PUBLIC on purpose, and listed in proxy.ts PUBLIC_PREFIXES: the people who
 * need it are integrators who do not have a back-office login and cannot get
 * one — behind the cookie gate they would meet a sign-in form for a system
 * they have no account on. It is safe to publish because it describes the API
 * and touches no store: every value on this page comes from three exported
 * constants in the source, and the page opens no database connection at all.
 *
 * ── ONE REGISTRY, THREE SURFACES ─────────────────────────────────────────
 *
 * The endpoint table, the Reference tab inside Setup → API, and
 * /api/v1/openapi.json all read API_ENDPOINTS. Adding a route means adding
 * its entry, and all three follow — documentation that cannot drift from the
 * spec because it is not a copy of it.
 *
 * ── WHY NO SWAGGER UI ────────────────────────────────────────────────────
 *
 * A rendered viewer would mean either a new dependency in a self-hosted app
 * or a CDN <script> — an outbound network call on a page a shop may serve
 * from behind its own firewall, which fails exactly where it is needed most.
 * The spec is a click away for anyone who wants Swagger, Postman or a client
 * generator; this page is the human-readable half, built from the kit.
 */

export const metadata: Metadata = {
  title: 'OdysseyAI API reference',
  description: 'Read-only HTTP API and outbound webhooks for an OdysseyAI store.',
}

export const dynamic = 'force-dynamic'

const SCOPE_NOTES: Record<string, string> = {
  'products:read': 'The catalogue: descriptions, barcodes, selling prices. Never cost or margin.',
  'customers:read': 'The customer book, with balances and terms.',
  'sales:read': 'Invoices, credit sales, quotes and orders, with their lines.',
  'stock:read': 'Quantities on hand, per location.',
  'suppliers:read': 'The supplier book. Bank details are never exposed.',
  'purchases:read': 'Orders, goods receipts and returns — these carry COST prices, which is what a purchase document is.',
  'gl:read': 'Journal batches and their debit/credit lines: the accounting export. This is financial data.',
  'gift-cards:read': 'Balance lookup by card number.',
  'reports:run': 'Run a saved or built-in report by id. Cost and margin columns are stripped unless the key also holds gl:read.',
}

const RECEIVER_SNIPPET = `// Node receiver — req must expose the RAW body string, not re-serialised JSON
const [tPart, v1Part] = req.headers['x-odyssey-signature'].split(',')
const t = Number(tPart.slice(2))
const expected = crypto.createHmac('sha256', SECRET).update(\`\${t}.\${rawBody}\`).digest('hex')
if (v1Part.slice(3) !== expected) return res.status(401).end()          // wrong secret or tampered body
if (Math.abs(Date.now() / 1000 - t) > 300) return res.status(401).end() // stale t — replay guard
res.status(200).end()                                                   // ack fast; do the work after`

const SYNC_SNIPPET = `// Delta poll: ask only for what changed since last time.
let cursor = loadCursor()          // e.g. '2026-08-01T00:00:00Z', or null on first run
const url = new URL('https://your-host/api/v1/products')
if (cursor) url.searchParams.set('updatedSince', cursor)
url.searchParams.set('limit', '200')

for (let offset = 0; ; offset += 200) {
  url.searchParams.set('offset', String(offset))
  const res = await fetch(url, { headers: { authorization: \`Bearer \${KEY}\` } })
  const { items, total } = await res.json()
  for (const p of items) upsert(p)
  // Advance the cursor to the newest updatedAt you have actually stored.
  for (const p of items) if (!cursor || p.updatedAt > cursor) cursor = p.updatedAt
  if (offset + items.length >= total) break
}
saveCursor(cursor)`

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-control border border-border bg-surface-2 p-3 font-mono text-sm leading-relaxed text-ink">
      {children}
    </pre>
  )
}

export default function ApiDocsPage() {
  return (
    <main className="min-h-screen bg-canvas px-6 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold text-ink">OdysseyAI API</h1>
          <p className="text-muted">
            A read-only HTTP API over one store, plus outbound webhooks for the events that
            happen in it. Everything here is versioned under <code className="font-mono">/api/v1</code>.
          </p>
          <p className="text-muted">
            The machine-readable spec is at{' '}
            <a className="text-brand underline" href="/api/v1/openapi.json">
              /api/v1/openapi.json
            </a>{' '}
            — OpenAPI 3.1, no key required. Load it into Postman, Swagger UI, or a client generator.
          </p>
        </header>

        <Card>
          <CardHeader
            title="Getting a key"
            description="Keys are minted by someone with back-office access, under Setup → API."
          />
          <CardBody>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-2">
              <li>They open <span className="font-medium text-ink">Setup → API → New key</span>, name it after your integration, and tick only the scopes you need.</li>
              <li>They may set an expiry date. A key with one stops working on its own — worth asking for if the integration is temporary.</li>
              <li>
                The raw key is shown <span className="font-medium text-ink">once</span> and never again:
                the server keeps only a SHA-256 hash. If it is lost, it must be revoked and re-minted.
              </li>
            </ol>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Authenticating"
            description="Every request carries the key. There are no sessions, cookies or login calls."
          />
          <CardBody className="space-y-3">
            <Code>{`curl https://your-host/api/v1/products?limit=5 \\
  -H "Authorization: Bearer odk_1_AbCdEfGh_…"`}</Code>
            <p className="text-sm text-muted">
              The key embeds the store id, so it routes itself — you never pass a store id separately.
              A malformed, unknown, revoked or expired key all get the same{' '}
              <span className="font-mono">401 Invalid API key.</span>, deliberately: the refusal says
              nothing about which part failed. A valid key without the route&rsquo;s scope gets a{' '}
              <span className="font-mono">403</span> that names the scope it wants.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Scopes"
            description="A key sees exactly what its scopes allow. Ask for the narrowest set that does your job."
          />
          <CardBody>
            <dl className="space-y-3">
              {API_SCOPES.map((scope) => (
                <div key={scope} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
                  <dt className="sm:w-40 shrink-0">
                    <Badge tone="neutral">{scope}</Badge>
                  </dt>
                  <dd className="text-sm text-muted">{SCOPE_NOTES[scope]}</dd>
                </div>
              ))}
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Endpoints"
            description="Read-only by design: integrations read, and changes arrive by webhook. There are no write endpoints."
          />
          <CardBody className="space-y-5">
            <p className="text-sm text-muted">
              List endpoints share one envelope —{' '}
              <span className="font-mono">{'{ items, total, limit, offset }'}</span> — and take{' '}
              <span className="font-mono">limit</span> (1–200) and{' '}
              <span className="font-mono">offset</span>. Detail endpoints return the object itself,
              with its lines.
            </p>
            <div className="space-y-4">
              {API_ENDPOINTS.map((e) => (
                <div key={`${e.method} ${e.path}`} className="rounded-control border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={e.method === 'get' ? 'neutral' : 'brand'}>
                      {e.method.toUpperCase()}
                    </Badge>
                    <span className="font-mono text-sm text-ink">/api/v1{e.path}</span>
                    <Badge tone="neutral">{e.scope}</Badge>
                  </div>
                  <p className="mt-2 text-sm font-medium text-ink">{e.summary}</p>
                  {e.description && <p className="mt-1 text-sm text-muted">{e.description}</p>}
                  {e.params && e.params.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {e.params.map((p) => (
                        <li key={p.name} className="text-sm text-muted">
                          <span className="font-mono text-ink-2">{p.name}</span>
                          <span className="text-faint"> ({p.in}{p.required ? ', required' : ''})</span>
                          {' — '}
                          {p.description}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Keeping in sync"
            description="Poll a delta rather than re-pulling the whole catalogue every time."
          />
          <CardBody className="space-y-3">
            <p className="text-sm text-muted">
              Products, customers and suppliers each carry an{' '}
              <span className="font-mono">updatedAt</span> and accept{' '}
              <span className="font-mono">?updatedSince=</span>. Store the newest{' '}
              <span className="font-mono">updatedAt</span> you have written and pass it back next
              time. A delta deliberately includes archived and closed rows — &ldquo;this product was
              archived&rdquo; is exactly the change a sync exists to learn.
            </p>
            <Code>{SYNC_SNIPPET}</Code>
            <p className="text-sm text-muted">
              An <span className="font-mono">updatedSince</span> that is not a valid ISO 8601 instant
              is a <span className="font-mono">400</span>, never a silent full pull — a sync that
              believes it is polling a delta must never quietly receive everything.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Webhooks"
            description="The store pushes these to a URL you give it. Subscribe under Setup → API → Add endpoint."
          />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {WEBHOOK_EVENTS.map((event) => (
                <Badge key={event} tone="brand">{event}</Badge>
              ))}
            </div>
            <p className="text-sm text-muted">
              Payloads are thin on purpose — ids and the totals you already know. Fetch detail back
              through this API with your key, which keeps personal data out of third-party request
              logs and makes a redelivery harmless.
            </p>
            <p className="text-sm text-muted">
              Delivery is <span className="font-medium text-ink">at least once</span>: acknowledge
              with any 2xx, and make your handler idempotent on the{' '}
              <span className="font-mono">X-Odyssey-Delivery</span> header. A failure retries on a
              ladder — 1, 5, 30, 120 then 720 minutes — before the delivery is marked dead. The shop
              can see every attempt, and redeliver any of them, from the delivery log.
            </p>
            <div className="space-y-2">
              <p className="text-sm font-medium text-ink">Verify every delivery before trusting it</p>
              <p className="text-sm text-muted">
                Each request carries <span className="font-mono">X-Odyssey-Signature</span> as{' '}
                <span className="font-mono">t=&lt;unix&gt;,v1=&lt;hex&gt;</span>, where v1 is
                HMAC-SHA256 of <span className="font-mono">{'`${t}.${rawBody}`'}</span> with your
                endpoint&rsquo;s signing secret. The timestamp is inside the signed material, so
                neither it nor the body can be swapped. Refuse a stale one.
              </p>
              <Code>{RECEIVER_SNIPPET}</Code>
              <p className="text-sm text-muted">
                Use the <span className="font-medium text-ink">Send ping</span> button on the
                endpoint to fire a signed test delivery immediately — it exercises this exact path,
                so you can prove your receiver works before a real sale depends on it.
              </p>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Rate limits and errors"
            description="One bucket per key: roughly 2 requests a second sustained, with a burst allowance."
          />
          <CardBody>
            <ul className="space-y-2 text-sm text-muted">
              <li>
                <span className="font-mono text-ink-2">429</span> — over the limit.{' '}
                <span className="font-mono">Retry-After</span> says how long to wait;{' '}
                <span className="font-mono">X-RateLimit-Remaining</span> rides every response.
              </li>
              <li>
                <span className="font-mono text-ink-2">401</span> — missing, malformed, revoked or
                expired key. One uniform message for all four.
              </li>
              <li>
                <span className="font-mono text-ink-2">403</span> — valid key, but it lacks the scope
                that route requires. The message names the scope.
              </li>
              <li>
                <span className="font-mono text-ink-2">400</span> — a parameter you sent is not
                usable, e.g. a malformed <span className="font-mono">updatedSince</span>.
              </li>
              <li>
                <span className="font-mono text-ink-2">404</span> — no such record in this store.
              </li>
            </ul>
          </CardBody>
        </Card>
      </div>
    </main>
  )
}
