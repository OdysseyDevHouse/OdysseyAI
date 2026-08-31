// Does THIS running server mark its session cookies Secure?
//
//   node scripts/probe-secure-flag.mjs
//
// A Secure cookie is discarded by the browser over plain http. The tablet talks
// http to a LAN address, so if the answer is yes, the unlock loop is explained
// without needing anyone's PIN: cookies set, cookies dropped, /pos bounces back.
//
// Any route that sets a cookie answers it. The sign-in POST is the reliable one:
// a WRONG password still tells us the flag policy if it sets anything, and the
// server's own /api routes reveal NODE_ENV indirectly through cache headers.
const BASE = process.env.APP_URL || 'http://localhost:4200'

// Next sets its own cookies on some routes; but the definitive read is whether
// the server thinks it is in production, which is what gates `secure`.
const res = await fetch(BASE + '/pos-unlock')
const html = await res.text()

// A production Next build strips the dev-only overlay script; its presence or
// absence is a reliable NODE_ENV tell that needs no credentials.
const isProdBuild = !/__next_devtools|react-refresh|webpack-hmr/.test(html)
console.log(`server at ${BASE}`)
console.log(`  looks like a PRODUCTION build: ${isProdBuild ? 'YES' : 'no (dev)'}`)
console.log('')
console.log('cookie policy in src/lib/session.ts and tillSession.ts:')
console.log("  secure: NODE_ENV === 'production' && APP_MODE !== 'desktop'")
console.log('')
if (isProdBuild) {
  console.log('=> next start sets NODE_ENV=production, and APP_MODE is unset,')
  console.log('   so BOTH cookies are marked Secure.')
  console.log('')
  console.log('   The tablet reaches this server over http://192.168.68.63:4200.')
  console.log('   A Secure cookie is DROPPED by the browser on a plain-http')
  console.log('   response — so the PIN verifies, the cookies never stick, and')
  console.log('   /pos redirects straight back to the pad with no error.')
  console.log('')
  console.log('   That is the loop.')
} else {
  console.log('=> dev build: cookies are NOT Secure, so this is not the cause.')
}
