import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import {
  verifyApiKey,
  capabilityFnFor,
  touchLastUsed,
  type ApiScope,
} from '@/lib/site/apiKeys'
import { rateLimit } from '@/lib/rateLimit'
import type { Capability } from '@/lib/site/permissions'

/**
 * The auth wrapper every /api/v1 route runs through.
 *
 * The prefix sits in proxy.ts PUBLIC_PREFIXES because its callers are
 * programs holding an API key, never a browser with a cookie — a change of
 * authentication scheme, not an absence of one. Each request re-proves
 * itself here: Bearer key → verifyApiKey (prefix lookup + constant-time
 * SHA-256 compare) → scope check → rate limit → handler.
 *
 * scripts/test-permissions.ts requires every v1 route to call this wrapper,
 * so a route cannot ship open by omission.
 */

export type ApiContext = {
  siteId: number
  keyId: number
  scopes: ReadonlySet<ApiScope>
  can: (c: Capability) => boolean
}

/** Sustained ~2 requests/second per key, with a burst allowance. */
const LIMIT = { capacity: 30, refillPerMinute: 120 }

type Handler = (
  req: NextRequest,
  ctx: ApiContext,
  params: Record<string, string>,
) => Promise<NextResponse>

export function withApiKey(scope: ApiScope, handler: Handler, opts: { cost?: number } = {}) {
  return async (
    req: NextRequest,
    routeCtx?: { params?: Promise<Record<string, string>> },
  ): Promise<NextResponse> => {
    const header = req.headers.get('authorization') ?? ''
    const rawKey = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!rawKey) {
      return NextResponse.json(
        { error: 'Pass your API key as: Authorization: Bearer odk_…' },
        { status: 401 },
      )
    }

    const verified = await verifyApiKey(rawKey)
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: verified.status })
    }

    if (!verified.scopes.has(scope)) {
      return NextResponse.json(
        { error: `This key does not have the ${scope} scope.` },
        { status: 403 },
      )
    }

    const limit = rateLimit(`${verified.siteId}:${verified.keyId}`, {
      ...LIMIT,
      cost: opts.cost ?? 1,
    })
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(limit.retryAfterSeconds),
            'X-RateLimit-Remaining': String(limit.remaining),
          },
        },
      )
    }

    touchLastUsed(verified.siteId, verified.keyId)

    try {
      const params = routeCtx?.params ? await routeCtx.params : {}
      const response = await handler(
        req,
        {
          siteId: verified.siteId,
          keyId: verified.keyId,
          scopes: verified.scopes,
          can: capabilityFnFor(verified.scopes),
        },
        params,
      )
      response.headers.set('X-RateLimit-Remaining', String(limit.remaining))
      return response
    } catch (error) {
      console.error('[api/v1] handler failed:', error)
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal error.' },
        { status: 500 },
      )
    }
  }
}

/** Shared list-envelope helpers. */
export function pageParams(req: NextRequest, maxLimit = 200): { limit: number; offset: number } {
  const q = req.nextUrl.searchParams
  const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), maxLimit)
  const offset = Math.max(Number(q.get('offset')) || 0, 0)
  return { limit, offset }
}
