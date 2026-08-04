// Minimal surface. The renderer is the same Next app the browser runs, so it
// must not depend on anything here — this only exposes facts the web build can
// read from NEXT_PUBLIC_APP_MODE instead.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('odyssey', {
  isDesktop: true,
  platform: process.platform,
  version: process.env.npm_package_version || null,
})
