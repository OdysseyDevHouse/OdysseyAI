/** @type {import('next').NextConfig} */

// Desktop builds are wrapped by Electron, which loads the app from a local
// Next server rather than a CDN. Keeping the mode on the config lets server
// code branch on it without reading process.env in a dozen places.
const isDesktop = process.env.APP_MODE === 'desktop'

/**
 * Machines other than this one that may talk to the DEV server.
 *
 * Next blocks cross-origin requests to dev-only assets and endpoints by
 * default — it initialises on `localhost`, and a colleague opening
 * http://192.168.x.x:4100 is a different origin, so the page loads and then
 * fails to fetch its own HMR and dev chunks. Listing the origin is what makes
 * a LAN demo work; it has no effect on `next build` / `next start`.
 *
 * Set `DEV_LAN_ORIGINS` in `.env` to a comma-separated list of hosts —
 * "192.168.10.101,100.96.0.9" — rather than editing this file, so nobody's
 * personal address ends up committed. Ports are not part of an origin host
 * here; give the address only.
 */
const devLanOrigins = (process.env.DEV_LAN_ORIGINS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean)

const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: devLanOrigins,
  serverExternalPackages: ['mysql2', 'pdfkit'],
  experimental: {
    serverActions: {
      // Account documents are uploaded through a server action, and the default
      // cap is 1MB — small enough that a scanned credit application fails.
      //
      // Must stay in step with MAX_UPLOAD_BYTES in src/lib/uploads.ts. Next
      // rejects an oversized body before any of our code runs, so if this were
      // the smaller of the two the user would get an opaque framework error
      // instead of the sentence naming the limit.
      bodySizeLimit: '10mb',
    },
  },
  env: {
    NEXT_PUBLIC_APP_MODE: isDesktop ? 'desktop' : 'web',
  },
}

export default nextConfig
