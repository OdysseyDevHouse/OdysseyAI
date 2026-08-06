/** @type {import('next').NextConfig} */

// Desktop builds are wrapped by Electron, which loads the app from a local
// Next server rather than a CDN. Keeping the mode on the config lets server
// code branch on it without reading process.env in a dozen places.
const isDesktop = process.env.APP_MODE === 'desktop'

const nextConfig = {
  reactStrictMode: true,
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
