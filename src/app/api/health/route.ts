import { NextResponse } from 'next/server'
import { queryOne } from '@/lib/db'

// The Electron shell waits on this before opening a window, so it must stay
// unauthenticated and cheap. It reports DB reachability without failing the
// request — the shell should still start when the database is down, so the app
// can show a real error instead of hanging on a dead URL.
export const dynamic = 'force-dynamic'

export async function GET() {
  let database: 'up' | 'down' = 'down'
  try {
    await queryOne('SELECT 1 AS ok')
    database = 'up'
  } catch {
    database = 'down'
  }

  return NextResponse.json({
    status: 'ok',
    mode: process.env.APP_MODE === 'desktop' ? 'desktop' : 'web',
    database,
  })
}
