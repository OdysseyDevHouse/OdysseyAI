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

/* The last few failures, kept in memory so a screen can show them.
 *
 * Next strips the message from a server error before the browser sees it —
 * correctly, for a public web app, where the reader might be anybody. A desktop
 * install is the opposite case: the only person who can read this screen is the
 * one standing at the machine, and hiding the cause from them buys nothing and
 * costs a support call.
 *
 * Bounded, because this is a diagnostic and not a history. */
const recentErrors = []
const RECENT_LIMIT = 25

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
          const text = line(level.toUpperCase(), args)
          stream?.write(text)
          if (level === 'error') {
            recentErrors.push(text.trimEnd())
            if (recentErrors.length > RECENT_LIMIT) recentErrors.shift()
          }
        } catch {
          /* Never let logging break the thing being logged. */
        }
        original(...args)
      }
    }

    const fatal = (label) => (payload) => {
      try {
        const text = line('FATAL', [label, payload])
        stream?.write(text)
        recentErrors.push(text.trimEnd())
        if (recentErrors.length > RECENT_LIMIT) recentErrors.shift()
      } catch {
        /* as above */
      }
    }
    process.on('uncaughtException', fatal('uncaughtException'))
    process.on('unhandledRejection', fatal('unhandledRejection'))

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

/** The most recent failures, newest last. Empty when nothing has gone wrong. */
function recent() {
  return recentErrors.slice()
}

module.exports = { start, pathOf, recent }
