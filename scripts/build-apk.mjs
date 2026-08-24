// Builds the Android debug APK.
//
//   npm run mobile:apk
//
// A script rather than an npm one-liner because JAVA_HOME has to be set and its
// path contains spaces — "C:\Program Files\Android\Android Studio\jbr". Every
// attempt to pass that through cross-env and npm's shell lost the quoting and
// tried to spawn "Files\Android\Android" as a program.
//
// It also means a developer with no java on PATH still builds: Android Studio
// ships its own JDK 21, which is the only one this needs.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const androidDir = path.join(root, 'android')

if (!existsSync(androidDir)) {
  console.error('No android/ directory. Run `npx cap add android` first.')
  process.exit(1)
}

/* An explicit JAVA_HOME wins; otherwise Android Studio's bundled runtime, which
   is what a machine with the SDK installed already has. */
const candidates = [
  process.env.JAVA_HOME,
  'C:\\Program Files\\Android\\Android Studio\\jbr',
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Android Studio', 'jbr'),
  '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
].filter(Boolean)

const javaHome = candidates.find((c) => existsSync(path.join(c, 'bin')))

if (!javaHome) {
  console.error(
    'No JDK found. Install Android Studio (it bundles one) or set JAVA_HOME.\n' +
      `Looked in:\n  ${candidates.join('\n  ')}`,
  )
  process.exit(1)
}

if (!existsSync(path.join(androidDir, 'local.properties'))) {
  console.error(
    'android/local.properties is missing. It must name the SDK, with FORWARD slashes:\n' +
      '  sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk\n' +
      'It is gitignored, because it is a path on one machine.',
  )
  process.exit(1)
}

console.log(`JAVA_HOME=${javaHome}`)

/* An explicit relative path on both platforms. With `shell: true` a bare
   "gradlew.bat" is looked up on PATH — where it is not — rather than in cwd. */
const gradle = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew'
const result = spawnSync(gradle, ['assembleDebug', ...process.argv.slice(2)], {
  cwd: androidDir,
  env: { ...process.env, JAVA_HOME: javaHome },
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.status === 0) {
  console.log('\nAPK: android/app/build/outputs/apk/debug/app-debug.apk')
}
process.exit(result.status ?? 1)
