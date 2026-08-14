import 'server-only'
import { API_SCOPES } from '@/lib/site/apiKeys'
import { WEBHOOK_EVENTS } from '@/lib/site/webhooks'

/**
 * The public API described once, served twice: as /api/v1/openapi.json for
 * machines, and as the Reference tab on Setup → API for people. Routes are
 * hand-registered here because Next.js routes are not introspectable — adding
 * an endpoint means adding its entry, and the entry IS the documentation.
 */

type Param = {
  name: string
  in: 'query' | 'path'
  description: string
  required?: boolean
  schema: Record<string, unknown>
}

export type EndpointDoc = {
  method: 'get' | 'post'
  path: string
  scope: (typeof API_SCOPES)[number]
  summary: string
  description?: string
  params?: Param[]
  requestBody?: Record<string, unknown>
}

const page: Param[] = [
  { name: 'limit', in: 'query', description: 'Page size, 1–200. Default 50.', schema: { type: 'integer' } },
  { name: 'offset', in: 'query', description: 'Rows to skip. Default 0.', schema: { type: 'integer' } },
]

const updatedSince = (what: string): Param => ({
  name: 'updatedSince',
  in: 'query',
  description:
    `Sync cursor: only ${what} changed on or after this ISO 8601 instant. ` +
    'Poll with the largest updatedAt you have seen and you get a cheap delta ' +
    'instead of the full set. A delta includes archived/closed rows — those ' +
    'changes are what a sync exists to learn.',
  schema: { type: 'string', format: 'date-time' },
})

const id = (what: string): Param => ({
  name: 'id',
  in: 'path',
  required: true,
  description: `The ${what} id.`,
  schema: { type: 'integer' },
})

export const API_ENDPOINTS: EndpointDoc[] = [
  {
    method: 'get',
    path: '/products',
    scope: 'products:read',
    summary: 'List products',
    description:
      'The catalogue flat — every sellable row exactly once, variants unfolded. ' +
      'Prices per structure; stockOnHand appears when the key also holds stock:read.',
    params: [
      { name: 'search', in: 'query', description: 'Matches description, code, or exact barcode.', schema: { type: 'string' } },
      { name: 'includeArchived', in: 'query', description: '1 to include archived rows. Implied by updatedSince.', schema: { type: 'string', enum: ['1'] } },
      updatedSince('products'),
      ...page,
    ],
  },
  { method: 'get', path: '/products/{id}', scope: 'products:read', summary: 'One product', params: [id('product')] },
  {
    method: 'get',
    path: '/products/{id}/stock-locations',
    scope: 'stock:read',
    summary: 'Stock by location for one product',
    params: [id('product')],
  },
  {
    method: 'get',
    path: '/stock-levels',
    scope: 'stock:read',
    summary: 'Stock levels for a set of products',
    params: [
      { name: 'ids', in: 'query', required: true, description: 'Comma-separated product ids.', schema: { type: 'string' } },
    ],
  },
  {
    method: 'get',
    path: '/customers',
    scope: 'customers:read',
    summary: 'List customers',
    params: [
      { name: 'search', in: 'query', description: 'Matches name, code, email, phone, contact, or exact loyalty number.', schema: { type: 'string' } },
      updatedSince('customers'),
      ...page,
    ],
  },
  { method: 'get', path: '/customers/{id}', scope: 'customers:read', summary: 'One customer', params: [id('customer')] },
  {
    method: 'get',
    path: '/sales-documents',
    scope: 'sales:read',
    summary: 'List sales documents',
    description: 'Defaults to finalised documents. Headers only — fetch one by id for its lines.',
    params: [
      { name: 'docType', in: 'query', description: 'invoice, credit_sale, quote or sales_order.', schema: { type: 'string', enum: ['invoice', 'credit_sale', 'quote', 'sales_order'] } },
      { name: 'status', in: 'query', description: 'draft, saved, issued, finalised or cancelled. Default finalised.', schema: { type: 'string', enum: ['draft', 'saved', 'issued', 'finalised', 'cancelled'] } },
      { name: 'from', in: 'query', description: 'Document date on or after, YYYY-MM-DD.', schema: { type: 'string', format: 'date' } },
      { name: 'to', in: 'query', description: 'Document date on or before, YYYY-MM-DD.', schema: { type: 'string', format: 'date' } },
      { name: 'customerId', in: 'query', description: 'Only this customer.', schema: { type: 'integer' } },
      ...page,
    ],
  },
  { method: 'get', path: '/sales-documents/{id}', scope: 'sales:read', summary: 'One sales document, with lines', params: [id('document')] },
  {
    method: 'get',
    path: '/suppliers',
    scope: 'suppliers:read',
    summary: 'List suppliers',
    description: 'Bank details are deliberately absent from the shape.',
    params: [
      { name: 'search', in: 'query', description: 'Matches name, code, email, phone, contact, or account number.', schema: { type: 'string' } },
      updatedSince('suppliers'),
      ...page,
    ],
  },
  {
    method: 'get',
    path: '/purchase-documents',
    scope: 'purchases:read',
    summary: 'List purchase documents',
    description:
      'Orders, goods receipts and supplier returns. Carries cost prices — that is what a ' +
      'purchase document is; the scope name says so on the mint screen. Headers only; fetch by id for lines.',
    params: [
      { name: 'docType', in: 'query', description: 'purchase_order, grv or supplier_return.', schema: { type: 'string', enum: ['purchase_order', 'grv', 'supplier_return'] } },
      { name: 'status', in: 'query', description: 'Filter by document status.', schema: { type: 'string' } },
      { name: 'supplierId', in: 'query', description: 'Only this supplier.', schema: { type: 'integer' } },
      { name: 'search', in: 'query', description: 'Matches document number, supplier name or their invoice number.', schema: { type: 'string' } },
      { name: 'from', in: 'query', description: 'Document date on or after, YYYY-MM-DD.', schema: { type: 'string', format: 'date' } },
      { name: 'to', in: 'query', description: 'Document date on or before, YYYY-MM-DD.', schema: { type: 'string', format: 'date' } },
      ...page,
    ],
  },
  { method: 'get', path: '/purchase-documents/{id}', scope: 'purchases:read', summary: 'One purchase document, with lines', params: [id('document')] },
  {
    method: 'get',
    path: '/journal-batches',
    scope: 'gl:read',
    summary: 'List journal batches',
    description:
      'The accounting export. Defaults to posted batches — what an external ledger imports. ' +
      'Headers only; fetch by id for the debit/credit lines.',
    params: [
      { name: 'from', in: 'query', description: 'Journal date on or after, YYYY-MM-DD.', schema: { type: 'string', format: 'date' } },
      { name: 'to', in: 'query', description: 'Journal date on or before, YYYY-MM-DD.', schema: { type: 'string', format: 'date' } },
      { name: 'source', in: 'query', description: 'Only batches from one source (sale, grv, payment, …).', schema: { type: 'string' } },
      { name: 'status', in: 'query', description: 'posted (default), draft, void or all.', schema: { type: 'string', enum: ['posted', 'draft', 'void', 'all'] } },
      { name: 'limit', in: 'query', description: 'Max rows, 1–1000. Default 100.', schema: { type: 'integer' } },
    ],
  },
  { method: 'get', path: '/journal-batches/{id}', scope: 'gl:read', summary: 'One journal batch, with lines', params: [id('batch')] },
  {
    method: 'get',
    path: '/gift-cards/{code}',
    scope: 'gift-cards:read',
    summary: 'Gift-card balance lookup',
    description:
      'What a partner site needs to answer "what is on this card". Read-only — ' +
      'redemption still only happens at a till, where the sale it pays for exists.',
    params: [
      { name: 'code', in: 'path', required: true, description: 'The card number; spaces and dashes are tolerated.', schema: { type: 'string' } },
    ],
  },
  {
    method: 'post',
    path: '/reports/run',
    scope: 'reports:run',
    summary: 'Run a report by id',
    description:
      "A built-in template key ('sales-by-product') or 'saved:12'. The engine enforces each " +
      "source's permission against the key's scopes and strips cost/margin columns the key may " +
      'not see — hiddenColumns says what was dropped.',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['reportId'],
            properties: {
              reportId: { type: 'string', description: "Template key or 'saved:<id>'." },
              period: { type: 'string', description: 'A named period key, e.g. this_month.' },
              from: { type: 'string', format: 'date' },
              to: { type: 'string', format: 'date' },
              limit: { type: 'integer' },
            },
          },
        },
      },
    },
  },
]

/** The OpenAPI 3.1 document, built fresh per request — it is cheap and pure. */
export function buildOpenApiSpec(baseUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const e of API_ENDPOINTS) {
    const operation: Record<string, unknown> = {
      summary: e.summary,
      ...(e.description ? { description: e.description } : {}),
      security: [{ apiKey: [] }],
      'x-required-scope': e.scope,
      ...(e.params?.length ? { parameters: e.params } : {}),
      ...(e.requestBody ? { requestBody: e.requestBody } : {}),
      responses: {
        '200': { description: 'Success.' },
        '401': { $ref: '#/components/responses/Unauthorised' },
        '403': { $ref: '#/components/responses/MissingScope' },
        '429': { $ref: '#/components/responses/RateLimited' },
      },
    }
    paths[e.path] = { ...(paths[e.path] ?? {}), [e.method]: operation }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'OdysseyAI public API',
      version: '1',
      description:
        'Read-only access to one store, authenticated per request with an API key ' +
        '(`Authorization: Bearer odk_…`). Keys are minted on Setup → API with named scopes; ' +
        'every route demands its scope. List endpoints share the envelope ' +
        '`{ items, total, limit, offset }`. Rate limit: sustained 2 requests/second per key ' +
        'with burst allowance; a 429 carries Retry-After. Writes arrive by webhook + back ' +
        'office, deliberately — there are no write endpoints.',
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'The raw key from the once-only reveal at minting. The server stores only its hash.',
        },
      },
      responses: {
        Unauthorised: { description: 'Missing, malformed, revoked or expired key — one uniform refusal.' },
        MissingScope: { description: 'The key is valid but does not hold the scope this route demands.' },
        RateLimited: { description: 'Too many requests. Retry-After says when to come back.' },
      },
    },
    // OpenAPI 3.1 webhooks: events this store pushes to subscribed endpoints.
    // Every delivery is signed: X-Odyssey-Signature is `t=<unix>,v1=<hex>`
    // where v1 = HMAC-SHA256(endpoint secret, `${t}.${rawBody}`). Receivers
    // must recompute over the RAW body and refuse a stale t.
    webhooks: Object.fromEntries(
      WEBHOOK_EVENTS.map((event) => [
        event,
        {
          post: {
            summary: `${event} event`,
            description:
              'Signed JSON POST with X-Odyssey-Event, X-Odyssey-Delivery and X-Odyssey-Signature ' +
              'headers. Payloads are thin — ids and totals; fetch detail back through this API. ' +
              'Delivery is at-least-once with a retry ladder (1, 5, 30, 120, 720 minutes).',
            responses: { '200': { description: 'Any 2xx acknowledges the delivery.' } },
          },
        },
      ]),
    ),
  }
}
