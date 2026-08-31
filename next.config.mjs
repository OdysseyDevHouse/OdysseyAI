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
  /**
   * Ship only the modules the server actually loads.
   *
   * ── WHAT THIS IS FOR, AND WHAT IT IS NOT FOR ──────────────────────────────
   *
   * Not download size. The desktop installer copies its whole dependency tree
   * next to the asar, and the cost of that is paid per FILE rather than per
   * byte: measured on the build this was added to, writing app/node_modules
   * ran at ~1,780 files/sec and app/.next at ~1,495 — flat throughput while the
   * bytes-per-file doubled. 42,476 files is therefore ~25 seconds on a
   * developer's NVMe with Defender off, and twenty times that on a shop's eMMC
   * all-in-one with it on. Two installers, and a customer waits half an hour.
   *
   * Next already knows which files matter: the .nft.json traces it emits name
   * 1,170 distinct node_modules files, 22MB, against the 33,969 files and 468MB
   * shipped wholesale. `standalone` is how you get told that in a form the
   * packager can use.
   *
   * ── THE CONSEQUENCE FOR electron-builder.yml ──────────────────────────────
   *
   * The traced tree covers the NEXT app and nothing else, so it does not carry
   * electron-updater — a dependency of the Electron shell, which Next has never
   * heard of. That subtree is shipped explicitly; see the note there. Getting
   * this wrong is silent until the day a machine tries to update itself.
   */
  output: 'standalone',

  /**
   * Everything the tracer must not follow out of the app and into the repo.
   *
   * ── WHY THIS IS NEEDED AT ALL ─────────────────────────────────────────────
   *
   * Turning `standalone` on the first time produced a 3.4GB .next/standalone —
   * a copy of the WHOLE working tree, `.git` and `release/` and vendor/mariadb
   * included. Reading the traces back showed every one of the 145 routes citing
   * every file in the repository root: 215,325 entries for release/ alone.
   *
   * That is what @vercel/nft does when it meets a path it cannot evaluate —
   * `path.join(process.cwd(), …)` in lib/uploads.ts is one — it stops reasoning
   * and takes the directory whole. The traced node_modules set stayed correct
   * throughout (1,339 files, 22MB); only the root spilled.
   *
   * ── SO THIS IS A LIST OF THINGS THE SERVER CANNOT IMPORT ─────────────────
   *
   * Checked rather than assumed, because a wrong entry here is a module that
   * exists in development and is missing in the shipped build:
   *
   *   · nothing under src/ imports from server/ or electron/ — both are
   *     separate processes with their own entry points.
   *   · every mention of sql/ in src/ is a code COMMENT. The migrations reach a
   *     shop through extraResources, read by electron/siteMigrate.js, and never
   *     through the Next server.
   *
   * The rest — release/, .git/, android/, vendor/, docs/, archive/, scratch/ —
   * is build output, history and tooling that was never a runtime dependency of
   * anything.
   *
   * Keyed by route glob, values resolved from the project root; see
   * node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md
   */
  outputFileTracingExcludes: {
    '**/*': [
      './.git/**/*',
      './release/**/*',
      './android/**/*',
      './mobile/**/*',
      './vendor/**/*',
      './archive/**/*',
      './docs/**/*',
      './scripts/**/*',
      './scratch/**/*',
      /* The publishing kit, and the build it stages. Excluded for the same
         reason release/ is, only worse: deploy/staged holds a whole COPY of
         this output, so the second build in a row would trace 124MB of its own
         previous result back into itself. See deploy/README.md. */
      './deploy/**/*',
      './sql/**/*',
      './electron/**/*',
      './server/**/*',
      './build/**/*',
      './build-config/**/*',
      './uploads/**/*',
      './.next/cache/**/*',
      './.pre-publish/**/*',
      './.claude/**/*',
      './.demo-seed/**/*',
      './.vscode/**/*',
      './node_modules/.cache/**/*',
    ],
  },

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
