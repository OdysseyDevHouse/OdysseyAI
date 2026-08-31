// Where the Next server's own copy of `next` lives.
//
// ── TWO DEPENDENCY TREES, AND THEY ARE NOT INTERCHANGEABLE ──────────────────
//
// A packaged build carries two, on purpose:
//
//   · THE SHELL'S, inside app.asar — electron-updater, mysql2 and their
//     closure. Listed explicitly in electron-builder.yml's `files`. Reached by
//     an ordinary require(), because the asar is on the normal resolution path.
//
//   · THE APP'S, at resources/app/node_modules — emitted by Next's
//     `output: 'standalone'` and containing only what the traced server loads.
//     NOT on the resolution path from here, which is what this file is for.
//
// The split is deliberate. The shell must not depend on the app's tree: mysql2
// is in it today only because it is a serverExternalPackage, and a machine that
// could not migrate its database because Next changed what it traces is a
// failure nobody would think to look for. Conversely `next` MUST come from the
// app's tree — it has to be the copy that matches the build in app/.next.
//
// ── WHY THAT MATTERS MORE THAN IT SOUNDS ────────────────────────────────────
//
// Before this existed, electron-builder packed the whole production tree into
// the asar whatever `files` said, so `require('next')` resolved there while the
// compiled server chunks resolved React against app/node_modules. Two trees,
// two module registries, one process — the classic way to end up with two
// Reacts and a hook error that makes no sense on the screen it appears on.
// Latent so far. One tree per job keeps it that way.
const path = require('node:path')
const { app } = require('electron')

/**
 * The Next server's tree, packaged or not.
 *
 * A dev checkout has no resourcesPath worth the name and its node_modules is
 * the repository's own — the same shape localDb.binDir() and
 * siteMigrate.migrationsDir() already use, and deliberately so, since three
 * different ideas of "where the app's files are" is three things to get wrong.
 */
function appNodeModules() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'node_modules')
    : path.join(__dirname, '..', 'node_modules')
}

/**
 * require(), resolved against the app's tree rather than the asar's.
 *
 * require.resolve's `paths` option rather than a path.join, so a package's
 * `exports` map decides the entry point instead of a guess at its file layout.
 *
 * Throws what require() throws when the module is missing, which is wanted: a
 * build that failed to emit a standalone tree should say so at startup rather
 * than degrade into something harder to read later.
 */
function appRequire(name) {
  return require(require.resolve(name, { paths: [appNodeModules()] }))
}

module.exports = { appNodeModules, appRequire }
