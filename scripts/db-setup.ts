/**
 * OdysseyAI Database Setup — the provisioning run.
 *
 * A technician runs this on the ONE machine that hosts a shop's database: the
 * in-store box on a hybrid site, the back-office machine on a local one. A
 * cloud site never needs it, and this says so rather than installing something
 * nothing will connect to.
 *
 *   npm run db:setup                    interactive
 *   npm run db:setup -- --site ODY-10000 --email t@x.co.za --password ...
 *   npm run db:setup -- --dry-run       show the plan, write nothing
 *
 * ── WHAT THE TECHNICIAN NEVER LEARNS ──────────────────────────────────────
 *
 * The database password. They type an email and password they already have;
 * the credentials come from the control panel and go straight to MariaDB. That
 * is the point of doing it this way, so nothing here may print them — see
 * `redact`, which every display path goes through.
 *
 * ── RE-RUNNABLE, ON DEMAND ONLY ───────────────────────────────────────────
 *
 * It reaches the control panel when a person asks it to, never on a schedule.
 * Run against a machine that already has a server, it does not reprovision: it
 * reconciles TOWARD the control panel, which is the "Retrieve new details"
 * path. Every statement is CREATE IF NOT EXISTS or ALTER, and there is no DROP
 * anywhere — a machine that regenerated a credential its own database was
 * already using would lock the shop out of its data.
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import { signInForSetup } from '../src/lib/dbSetup/signIn'
import { planFor, redact, sitesForSetup, type SetupPlan } from '../src/lib/dbSetup/plan'
import { provisionStatements } from '../src/lib/dbSetup/sql'
import type { Site } from '../src/lib/sites'

type Args = {
  site?: string
  email?: string
  password?: string
  dryRun: boolean
  allowFrom?: string
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--site') out.site = argv[++i]
    else if (a === '--email') out.email = argv[++i]
    else if (a === '--password') out.password = argv[++i]
    else if (a === '--allow-from') out.allowFrom = argv[++i]
  }
  return out
}

/**
 * The prompt, opened lazily.
 *
 * createInterface holds stdin open from the moment it is called, so opening one
 * at module scope makes a fully-flagged run hang after printing its result —
 * with nothing on screen to say what it is waiting for. Opened on the first
 * question instead, a run that asks nothing keeps nothing open and exits.
 */
let rl: ReturnType<typeof createInterface> | null = null

async function ask(question: string): Promise<string> {
  if (!rl) rl = createInterface({ input: stdin, output: stdout })
  return (await rl.question(question)).trim()
}

function closePrompt() {
  rl?.close()
  rl = null
}

/**
 * Whether a database server is installed on this machine.
 *
 * Asked of the machine, not of the build — MariaDB ships in this installer, so
 * on the Database Setup build it is present by definition. The CLI runs outside
 * Electron, where `app.isPackaged` does not exist, so this checks the shared
 * location and the developer's vendor directory instead.
 */
async function serverInstalled(): Promise<boolean> {
  const { existsSync } = await import('node:fs')
  const path = await import('node:path')
  const candidates = [
    process.env.ODYSSEY_MARIADB_DIR,
    process.platform === 'win32'
      ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Odyssey', 'mariadb')
      : '/usr/local/share/Odyssey/mariadb',
    path.join(process.cwd(), 'vendor', 'mariadb'),
  ].filter(Boolean) as string[]

  for (const base of candidates) {
    for (const exe of ['mariadbd', 'mysqld']) {
      const file = path.join(base, 'bin', process.platform === 'win32' ? `${exe}.exe` : exe)
      if (existsSync(file)) return true
    }
  }
  return false
}

function describe(plan: SetupPlan): void {
  console.log('')
  if (plan.action === 'refuse') {
    console.log('  Cannot continue')
    console.log(`  ${plan.reason}`)
    return
  }
  if (plan.action === 'nothing') {
    console.log(`  ${plan.siteName} (${plan.siteCode}) — nothing to do`)
    console.log(`  ${plan.reason}`)
    return
  }

  const shown = redact(plan) as Record<string, unknown>
  console.log(`  ${plan.siteName} (${plan.siteCode}) — ${plan.connectionType}`)
  console.log('')
  console.log(`    from record   ${plan.purpose}`)
  console.log(`    server        ${plan.host}:${plan.port}`)
  console.log(`    database      ${plan.databaseName}`)
  console.log(`    username      ${plan.username}`)
  console.log(`    password      ${shown.password}`)
  if (plan.alreadyInstalled) {
    console.log('')
    console.log('    A database server is already installed here. Nothing will be')
    console.log('    re-initialised — the settings above are reapplied to it.')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log('\nOdysseyAI Database Setup\n')

  const email = args.email || (await ask('Email: '))
  const password = args.password || (await ask('Password: '))

  const who = await signInForSetup(email, password)
  if (!who.ok) {
    console.error(`\n  ${who.error}\n`)
    process.exitCode = 1
    return
  }
  console.log(`\n  Signed in as ${who.fullName || who.email}.`)

  const sites = await sitesForSetup(who.userId)
  if (sites.length === 0) {
    console.error('\n  This account has no sites.\n')
    process.exitCode = 1
    return
  }

  let site: Site | undefined
  if (args.site) {
    const wanted = args.site.trim().toLowerCase()
    site = sites.find(
      (s) => s.code.toLowerCase() === wanted || String(s.id) === wanted,
    )
    if (!site) {
      console.error(`\n  No site "${args.site}" on this account.\n`)
      process.exitCode = 1
      return
    }
  } else if (sites.length === 1) {
    site = sites[0]
  } else {
    console.log('\n  Which shop is this machine for?\n')
    sites.forEach((s, i) => {
      console.log(`    ${i + 1}. ${s.displayName} (${s.code}) — ${s.connectionType}`)
    })
    const pick = Number(await ask('\n  Number: '))
    site = sites[pick - 1]
    if (!site) {
      console.error('\n  Not one of the options.\n')
      process.exitCode = 1
      return
    }
  }

  const installed = await serverInstalled()
  const plan = await planFor(site, installed)
  describe(plan)

  if (plan.action !== 'provision') {
    console.log('')
    process.exitCode = plan.action === 'refuse' ? 1 : 0
    return
  }

  /* The LAN widening is opt-in and never a default. A hybrid box serves ten
     tills, so its user must accept the shop's subnet — but that is a real
     widening of who may reach the shop's data, and it should be asked for. */
  const allowFrom = ['127.0.0.1']
  if (args.allowFrom) allowFrom.push(args.allowFrom)
  else if (plan.connectionType === 'hybrid') {
    console.log('')
    console.log('  This is a hybrid site, so tills on the shop network connect to this box.')
    const subnet = await ask('  Which addresses may connect? (e.g. 192.168.1.%, blank for none): ')
    if (subnet) allowFrom.push(subnet)
  }

  const statements = provisionStatements({
    databaseName: plan.databaseName,
    username: plan.username,
    password: plan.password,
    allowFrom,
  })

  console.log('')
  console.log(`  ${statements.length} statements, allowing connections from: ${allowFrom.join(', ')}`)

  if (args.dryRun) {
    console.log('\n  --dry-run: nothing was written.\n')
    return
  }

  const go = await ask('\n  Apply this? (yes/no) ')
  if (go.toLowerCase() !== 'yes') {
    console.log('\n  Nothing was written.\n')
    return
  }

  /*
   * Applying, through the same code the installer uses.
   *
   * `electron/localDb.js` owns starting and provisioning a server; this script
   * drives it rather than reimplementing it, so a technician's run and an
   * installer's run cannot diverge. It requires Electron's `app` for two paths,
   * which a plain script does not have — stubbed the same way
   * test-runtime-config.mjs does, and for the same reason: these are decisions
   * about files and processes, not about Electron.
   */
  const { createRequire } = await import('node:module')
  const nodeModule = await import('node:module')
  const path = await import('node:path')
  const os = await import('node:os')

  const require_ = createRequire(import.meta.url)
  const dataHome =
    process.env.ODYSSEY_DATA_DIR ||
    path.join(process.env.ProgramData || os.tmpdir(), 'Odyssey', 'runtime')

  const Mod = nodeModule.default as unknown as {
    _load: (r: string, p: unknown, i: boolean) => unknown
  }
  const origLoad = Mod._load
  Mod._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getPath: () => dataHome,
        },
      }
    }
    return origLoad(request, parent, isMain)
  }

  try {
    const localDb = require_('../electron/localDb.js') as {
      provisionForPlan: (o: {
        port: number
        statements: string[]
        lan: boolean
        onProgress?: (m: string) => void
      }) => Promise<{ initialised: boolean; started: boolean; lan: boolean }>
    }

    const applied = await localDb.provisionForPlan({
      port: plan.port,
      statements,
      /* A hybrid box serves ten tills, so its server binds the LAN. A local
         backend stays on loopback. The plan already knows which this is. */
      lan: plan.connectionType === 'hybrid',
      onProgress: (message) => console.log(`  ${message}`),
    })

    console.log('')
    console.log(
      `  Done. ${applied.initialised ? 'A new database was created' : 'The existing database was updated'}` +
        `${applied.lan ? ', reachable from the shop network' : ', on this machine only'}.`,
    )
    console.log('')
  } finally {
    Mod._load = origLoad
  }
}

main()
  .catch((err) => {
    console.error(`\n  ${err?.message || err}\n`)
    process.exitCode = 1
  })
  .finally(() => {
    closePrompt()
    /* The control-panel pool keeps the event loop alive. Exiting explicitly on
       the code main() decided is what makes this usable from a script — an
       installer needs to know whether provisioning refused. */
    process.exit(process.exitCode ?? 0)
  })
