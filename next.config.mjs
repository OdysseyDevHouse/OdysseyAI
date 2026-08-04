/** @type {import('next').NextConfig} */

// Desktop builds are wrapped by Electron, which loads the app from a local
// Next server rather than a CDN. Keeping the mode on the config lets server
// code branch on it without reading process.env in a dozen places.
const isDesktop = process.env.APP_MODE === 'desktop'

const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['mysql2', 'pdfkit'],
  env: {
    NEXT_PUBLIC_APP_MODE: isDesktop ? 'desktop' : 'web',
  },
}

export default nextConfig
