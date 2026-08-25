// Somewhere for a failure on somebody else's machine to go.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// A packaged Windows app has no console. The Next server runs in-process and
// reports its errors through console.error, which on a customer's machine goes
// nowhere at all — so a server-rendered page that throws shows "This page
// couldn't load. A server error occurred." and a digest number, and that is
// genuinely everything anybody has to work with.
//
// Three separate faults were diagnosed by guesswork before this existed. Each
// guess cost a build, a copy and an install.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
// It does not send anything anywhere. The file sits in userData and a tester
// attaches it to a message when asked. A crash reporter that phones home is a
// different feature with a different conversation attached to it.
//
// It also does not try to be clever about redaction, because it cannot be: the
// safe assumption is that a log MAY contain a connection string or a query, so
// it says so at the top of the file and stays on the machine.
const fs = require('node:fs')
const path = require('node:path')

let stream = null
let logPath = null

/** Keep the last few runs, so "it broke yesterday" is still answerable. */
function rotate(file) {
  try {
    const stat = fs.statSync(file)
    /* 2MB is several thousand lines — long enough to hold a whole session,
       short enough to attach to an email. */
    if (stat.size < 2 * 1024 * 1024) return
    fs.renameSync(file, `${file}.1`)
  } catch {
    /* No file yet, or a rename that failed. Neither is worth failing over —
       logging must never be the thing that stops the app starting. */
  }
}

function line(level, args) {
  const text = args
    .map((a) => {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
  return `${new Date().toISOString()}  ${level.padEnd(5)}  ${text}\n`
}

/**
 * Start writing, and capture everything worth having.
 *
 * Called as early as main.js can manage — before the Next server starts, so a
 * failure during startup is in the file rather than being the reason the file
 * was never opened.
 */
function start(userDataDir, meta = {}) {
  try {
    const dir = path.join(userDataDir, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    logPath = path.join(dir, 'odyssey.log')
    rotate(logPath)
    stream = fs.createWriteStream(logPath, { flags: 'a' })

    stream.write('\n')
    stream.write(line('INFO', ['──── started ────']))
    for (const [k, v] of Object.entries(meta)) stream.write(line('INFO', [`${k}: ${v}`]))
    stream.write(
      line('INFO', [
        'This file may contain database names, hosts and query text. It stays on this machine.',
      ]),
    )

    /* console.error is the one that matters: it is how Next reports a server
       component that threw, which is the failure a customer actually sees. */
    for (const level of ['error', 'warn', 'log']) {
      const original = console[level]
      console[level] = (...args) => {
        try {
          stream?.write(line(level.toUpperCase(), args))
        } catch {
          /* Never let logging break the thing being logged. */
        }
        original(...args)
      }
    }

    process.on('uncaughtException', (err) => {
      try {
        stream?.write(line('FATAL', ['uncaughtException', err]))
      } catch {
        /* as above */
      }
    })
    process.on('unhandledRejection', (reason) => {
      try {
        stream?.write(line('FATAL', ['unhandledRejection', reason]))
      } catch {
        /* as above */
      }
    })

    return logPath
  } catch {
    /* A read-only profile, or a locked directory. The app still runs; it just
       runs without a log, which is exactly where it was before this file. */
    return null
  }
}

/** Where the log is, for a screen that wants to tell somebody. */
function pathOf() {
  return logPath
}

module.exports = { start, pathOf }
