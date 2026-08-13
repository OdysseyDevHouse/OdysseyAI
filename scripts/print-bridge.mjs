#!/usr/bin/env node
/**
 * The print bridge — the six-metre cable between the browser and the till's
 * thermal printer.
 *
 * A browser cannot open a socket to a printer; this can. It runs ON the till
 * machine (or one machine per shop), accepts raw ESC/POS bytes over local
 * HTTP, and forwards them to the printer's TCP port 9100. It knows NOTHING
 * about receipts — every layout decision lives in the app's tested TypeScript
 * (src/lib/escpos/), and the bridge just moves bytes. That is what keeps this
 * file too small to be wrong.
 *
 * RUN:    node scripts/print-bridge.mjs
 * CONFIG: print-bridge.config.json beside this file:
 *
 *   {
 *     "port": 9723,
 *     "bind": "127.0.0.1",
 *     "printers": {
 *       "receipt": { "type": "tcp", "host": "192.168.1.50", "port": 9100 },
 *       "kitchen": { "type": "tcp", "host": "192.168.1.51", "port": 9100 }
 *     }
 *   }
 *
 * bind 127.0.0.1 = this machine only (the default, and why the permissive
 * CORS below is safe). A shop whose tills share one bridge sets "0.0.0.0"
 * deliberately and points the other tills at this machine's LAN address.
 *
 * PROTOCOL:
 *   GET  /health           -> { ok, version, printers: ["receipt","kitchen"] }
 *   POST /print            <- { printer: "receipt", dataBase64: "..." }
 *                          -> { ok: true } | { ok: false, error }
 *
 * v1 transport is TCP 9100 only — every 80mm thermal and kitchen printer of
 * the last fifteen years speaks it. USB-only models: configure them as
 * network printers with the vendor utility, or share them via a 9100
 * emulator. See docs/print-bridge.md.
 */

import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '1.0.0'
const here = dirname(fileURLToPath(import.meta.url))

function loadConfig() {
  const defaults = { port: 9723, bind: '127.0.0.1', printers: {} }
  try {
    const raw = readFileSync(join(here, 'print-bridge.config.json'), 'utf8')
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    console.log('No print-bridge.config.json found — starting with no printers configured.')
    return defaults
  }
}

const config = loadConfig()

function sendToPrinter(printer, bytes) {
  return new Promise((resolve) => {
    if (!printer || printer.type !== 'tcp' || !printer.host) {
      resolve({ ok: false, error: 'That printer is not configured on this bridge.' })
      return
    }
    const socket = createConnection({ host: printer.host, port: printer.port ?? 9100 })
    const fail = (error) => {
      socket.destroy()
      resolve({ ok: false, error })
    }
    socket.setTimeout(3000, () => fail('The printer did not answer within 3 seconds.'))
    socket.on('error', (err) => fail(`Could not reach the printer: ${err.message}`))
    socket.on('connect', () => {
      socket.end(bytes, () => resolve({ ok: true }))
    })
  })
}

const server = createServer((req, res) => {
  // Loopback by default, so a permissive CORS answer is safe — see the header.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: VERSION, printers: Object.keys(config.printers) }))
    return
  }

  if (req.method === 'POST' && req.url === '/print') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy() // a slip is kilobytes, not megabytes
    })
    req.on('end', async () => {
      try {
        const { printer, dataBase64 } = JSON.parse(body)
        const bytes = Buffer.from(String(dataBase64 ?? ''), 'base64')
        if (bytes.length === 0) throw new Error('Empty print job.')
        const result = await sendToPrinter(config.printers[printer], bytes)
        res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: error?.message ?? 'Bad print job.' }))
      }
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'Unknown path.' }))
})

server.listen(config.port, config.bind, () => {
  console.log(`Print bridge ${VERSION} listening on http://${config.bind}:${config.port}`)
  console.log(`Printers: ${Object.keys(config.printers).join(', ') || '(none configured)'}`)
})
