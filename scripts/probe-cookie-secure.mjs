// Does the unlock hand back cookies a plain-HTTP tablet will keep?
//
//   node scripts/probe-cookie-secure.mjs
//
// The tablet reaches the server over http:// (a LAN address has no certificate),
// and a `Secure` cookie is DISCARDED by the browser on a plain-HTTP response. If
// the unlock sets Secure, the PIN verifies, the cookies are thrown away, /pos
// sees no session and bounces back to the pad — a silent loop with no error,
// because nothing actually failed.
const BASE = process.env.APP_URL || 'http://localhost:4200'

const res = await fetch(BASE + '/pos-unlock', { redirect: 'manual' })
console.log(`GET /pos-unlock -> ${res.status}`)

// Any Set-Cookie the app emits on a plain request tells us the flag policy.
const raw = res.headers.getSetCookie?.() ?? []
console.log(`\nSet-Cookie headers: ${raw.length}`)
for (const c of raw) {
  const name = c.split('=')[0]
  console.log(`  ${name.padEnd(22)} secure:${/;\s*Secure/i.test(c) ? 'YES' : 'no'}  ${/HttpOnly/i.test(c) ? 'httpOnly' : ''}`)
}

console.log(`\nNODE_ENV on this server decides it:`)
console.log(`  secure = NODE_ENV === 'production' && APP_MODE !== 'desktop'`)
console.log(`  this shell: NODE_ENV=${process.env.NODE_ENV ?? '(unset)'} APP_MODE=${process.env.APP_MODE ?? '(unset)'}`)
console.log(`\n'next start' sets NODE_ENV=production in its OWN process, so the`)
console.log(`server's value is what matters, not this one.`)
