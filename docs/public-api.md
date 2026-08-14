# The public API

A read-only HTTP API over one store, plus outbound webhooks for the events that
happen in it. This is the guide for someone writing an integration against it.

Three places describe this API, and all three are generated from the same
registry in `src/app/api/v1/_lib/openapi.ts`:

| Where | What it is | Who it is for |
| --- | --- | --- |
| `/api/v1/openapi.json` | OpenAPI 3.1, no key required | Postman, Swagger UI, client generators |
| `/api-docs` | Rendered reference, public page | An integrator with no back-office login |
| Setup → API → Reference | The same table, inside the app | Whoever administers the store |

Adding an endpoint means adding its entry to `API_ENDPOINTS`; all three follow.
Documentation here cannot drift from the spec, because it is not a copy of it.

## Getting a key

Keys are minted in the back office under **Setup → API → New key** by someone
with the `setup.api` capability. Ask them for:

- a **name** — the integration it belongs to, so it can be recognised later;
- the **scopes** you actually need, and no more (see below);
- an **expiry**, if the integration is temporary. A key with an end date stops
  working on its own rather than relying on someone remembering to revoke it.

The raw key is displayed **once**. The server stores only its SHA-256, so a lost
key cannot be recovered — it must be revoked and re-minted.

### The key format

    odk_<siteId>_<prefix8>_<secret>

The store id is embedded because a bare bearer token carries no hint of which
database to check. The verifier parses the id, opens that one store, looks the
row up by prefix, and compares hashes in constant time. **A guessed or altered
site id simply fails the hash compare** — the id routes, it never authorises.

## Authenticating

Every request carries the key. There are no sessions, cookies, or login calls.

```bash
curl https://your-host/api/v1/products?limit=5 \
  -H "Authorization: Bearer odk_1_AbCdEfGh_…"
```

A malformed, unknown, revoked or expired key all receive the same
`401 {"error":"Invalid API key."}`. That uniformity is deliberate: the refusal
must not tell an attacker which part failed. A valid key that lacks the scope a
route requires gets a `403` naming the scope it wants.

## Scopes

A key sees exactly what its scopes allow. Ask for the narrowest set that does
the job.

| Scope | What it opens |
| --- | --- |
| `products:read` | The catalogue: descriptions, barcodes, selling prices. Never cost or margin. |
| `customers:read` | The customer book, with balances and terms. |
| `sales:read` | Invoices, credit sales, quotes and orders, with lines. |
| `stock:read` | Quantities on hand, per location. |
| `suppliers:read` | The supplier book. Bank details are never exposed by the API. |
| `purchases:read` | Orders, goods receipts and returns — **these carry cost prices**. |
| `gl:read` | Journal batches and their debit/credit lines: the accounting export. **Financial data.** |
| `gift-cards:read` | Balance lookup by card number. |
| `reports:run` | Run a saved or built-in report by id. |

Two of these deserve their names read carefully. `purchases:read` exposes cost
prices, because that is what a purchase document *is*. `gl:read` carries the
`reports.financial` capability — so a key holding it *and* `reports:run` can
also run financial reports, which is the same data by another door. Every other
scope is treated like a junior user: the report engine strips cost, margin and
profit columns and reports what it dropped in `hiddenColumns`.

## Reading

List endpoints share one envelope and take `limit` (1–200, default 50) and
`offset`:

```json
{ "items": [ … ], "total": 412, "limit": 50, "offset": 0 }
```

Detail endpoints (`/products/{id}`, `/sales-documents/{id}`, …) return the
object itself, with its lines.

There are **no write endpoints**, deliberately. Every write path in the app runs
through actor-attributed, capability-guarded flows with heavy invariants;
exposing writes behind a machine key would mean idempotency keys and synthetic
actors. Integrations read; changes arrive by webhook and the back office.

See `/api-docs` or the OpenAPI spec for the full endpoint list and every
parameter — that list is generated, so it is always current.

## Keeping in sync

Products, customers and suppliers carry an `updatedAt` and accept
`?updatedSince=`. Poll a delta instead of re-pulling the whole catalogue:

```js
let cursor = loadCursor()          // ISO 8601 instant, or null on first run
const url = new URL('https://your-host/api/v1/products')
if (cursor) url.searchParams.set('updatedSince', cursor)
url.searchParams.set('limit', '200')

for (let offset = 0; ; offset += 200) {
  url.searchParams.set('offset', String(offset))
  const res = await fetch(url, { headers: { authorization: `Bearer ${KEY}` } })
  const { items, total } = await res.json()
  for (const p of items) upsert(p)
  for (const p of items) if (!cursor || p.updatedAt > cursor) cursor = p.updatedAt
  if (offset + items.length >= total) break
}
saveCursor(cursor)                 // only after the page is safely stored
```

Two properties worth knowing:

- **A delta includes archived and closed rows.** "This product was archived" is
  exactly the change a sync exists to learn, so a cursored request does not
  apply the default "live rows only" filter that an uncursored one does.
- **A malformed `updatedSince` is a `400`, never a silent full pull.** A sync
  that believes it is polling a delta must never quietly receive everything.

Advance the cursor only to the newest `updatedAt` you have actually written. If
your process dies mid-page, re-polling from the old cursor replays a few rows —
which is why upserts should be idempotent — rather than skipping them.

## Webhooks

The store pushes events to a URL you provide. The shop adds it under
**Setup → API → Add endpoint**, choosing which events to send, and is shown the
signing secret once.

| Event | Fires when |
| --- | --- |
| `order.placed` | A shopper completes checkout online. |
| `order.paid` | An online order is paid. |
| `order.status_changed` | An order moves along the pipeline, or is cancelled. Carries the status role, so a courier integration can act on "picked" or "dispatched". |
| `sale.finalised` | A sale is finalised at a till or on account. |
| `sale.voided` | A finalised sale is voided. |
| `customer.created` | A customer account is created, anywhere in the app. |
| `grv.received` | Goods are received against a supplier. |
| `stock.low` | Products are below their minimum. Rides the low-stock digest's claim, so it fires at digest cadence (daily by default) and cannot spam per-sale. |

### Payloads are thin

Ids and the totals the counterpart already knows — never the whole document.
Detail is fetched back through `/api/v1` with a key, which keeps personal data
out of third-party request logs and makes a redelivery harmless.

```json
{
  "event": "sale.finalised",
  "occurredAt": "2026-08-14T09:31:07.412Z",
  "documentId": 8814,
  "documentNumber": "INV004192",
  "totalIncl": 115.00
}
```

### Verify the signature before trusting anything

Each delivery carries `X-Odyssey-Signature: t=<unix>,v1=<hex>`, where v1 is
HMAC-SHA256 of `` `${t}.${rawBody}` `` using your endpoint's signing secret.
Because the timestamp is *inside* the signed material, neither it nor the body
can be swapped for another.

```js
// Node receiver — req must expose the RAW body string, not re-serialised JSON
const [tPart, v1Part] = req.headers['x-odyssey-signature'].split(',')
const t = Number(tPart.slice(2))
const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex')
if (v1Part.slice(3) !== expected) return res.status(401).end()          // wrong secret or tampered body
if (Math.abs(Date.now() / 1000 - t) > 300) return res.status(401).end() // stale t — replay guard
res.status(200).end()                                                   // ack fast; do the work after
```

Sign over the **raw** body. Parsing and re-serialising JSON changes key order
and whitespace, and the HMAC will not match.

### Delivery guarantees

- **At least once.** Acknowledge with any 2xx. Make your handler idempotent on
  the `X-Odyssey-Delivery` header, which is the delivery row's id and is stable
  across retries of the same delivery.
- **Fast, then patient.** A fresh event is attempted immediately, so a healthy
  endpoint hears within seconds. Anything that misses — a failed attempt, a
  restarted process — is picked up by the delivery tick, which is the retry
  safety net.
- **The ladder.** A failure retries after 1, 5, 30, 120 then 720 minutes; after
  five attempts the delivery is marked dead. The shop sees every attempt in the
  delivery log and can redeliver any of them — the exact original payload, with
  a fresh signature.
- **A paused endpoint parks its queue.** Deliveries waiting for an endpoint that
  was switched off are marked dead rather than hammering a URL the shop asked to
  stop calling.
- **Settled rows clear after 30 days.** The delivery log is a log, not an
  archive.

### Test your receiver before you need it

The **Send ping** button on an endpoint fires a signed `ping` delivery
immediately, through the same code path every real event uses — same headers,
same signature scheme, and it lands in the delivery log like anything else. The
toast reports what your server answered. Use it to prove the receiver and your
signature check work before a real sale depends on them.

Ask the shop to press it while you watch your logs.

## Rate limits

One bucket per key: roughly 2 requests per second sustained, with a burst
allowance of 30. Every response carries `X-RateLimit-Remaining`; a `429` carries
`Retry-After` in seconds. Back off rather than retrying immediately — a sync
that hammers through a 429 will simply stay throttled.

## Errors

| Status | Meaning |
| --- | --- |
| `400` | A parameter is unusable — e.g. a malformed `updatedSince` or an unknown `status`. |
| `401` | Missing, malformed, revoked or expired key. One uniform message for all four. |
| `403` | Valid key, but it lacks the scope the route requires. The message names the scope. |
| `404` | No such record in this store. |
| `429` | Rate limited. See `Retry-After`. |
| `500` | Something failed server-side. Safe to retry with backoff. |

## Operational notes for the shop

Two things must be running for the integration to work end to end:

- **`/api/webhooks/tick`** — the delivery retry net, called by cron with
  `WEBHOOK_CRON_SECRET`. Without it, a delivery that fails its first attempt
  waits forever. It is listed in `proxy.ts` `PUBLIC_PREFIXES`; without that
  entry it answers a 307 to the login page and every delivery silently stalls.
- **`/api/alerts/tick`** — the low-stock digest, which is what `stock.low`
  rides. No tick, no event.

Safe to call often: both only touch work that is actually due, so frequency
changes latency, never volume.
