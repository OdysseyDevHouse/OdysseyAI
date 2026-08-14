import { NextResponse, type NextRequest } from 'next/server'
import { buildOpenApiSpec } from '../_lib/openapi'

export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/openapi.json — the machine-readable spec.
 *
 * Deliberately keyless (the one /api/v1 route that is): it describes the API
 * without exposing any store's data, and an integrator needs it BEFORE they
 * have a key. scripts/test-permissions.ts carries a matching exception.
 */
export function GET(req: NextRequest) {
  return NextResponse.json(buildOpenApiSpec(req.nextUrl.origin))
}
