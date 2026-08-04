import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/session'

// Next 16 renamed the `middleware` convention to `proxy`; same signature, same
// place in the request lifecycle.
//
// Cheap gate only: it checks that a session cookie is *present*, not that it is
// valid — verifying the JWT needs the secret and would run on every asset
// request. Pages call requireSession()/requireSiteId() for the real check
// (which also re-confirms site access against the database).

// `/` is the login page. Matched exactly — as a prefix it would make every
// route public.
const PUBLIC_EXACT = ['/']
const PUBLIC_PREFIXES = ['/forgot-password', '/reset-password']

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC_EXACT.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    // Already signed in? Skip the login form.
    if (pathname === '/' && req.cookies.has(SESSION_COOKIE)) {
      return NextResponse.redirect(new URL('/dashboard', req.url))
    }
    return NextResponse.next()
  }

  if (!req.cookies.has(SESSION_COOKIE)) {
    const url = new URL('/', req.url)
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Everything except Next internals, the health probe the Electron shell
    // waits on, and static files.
    '/((?!_next/static|_next/image|favicon.ico|api/health|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)',
  ],
}
