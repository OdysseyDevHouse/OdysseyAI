// The print queues installed on THIS machine, with enough detail to choose one.
//
// ── WHY NOT getPrintersAsync() ──────────────────────────────────────────────
//
// Because on Windows it answers almost nothing. Verified against a real machine:
//
//   { name: 'EPSON TM-T70 Receipt', displayName: 'EPSON TM-T70 Receipt',
//     description: '', options: {} }
//
// No status, no isDefault, no port — the docs promise more than the platform
// delivers. A picker built on that can only show a list of names, and the single
// most common cause of "it stopped printing" (a paused or offline queue) is
// invisible.
//
// `Get-Printer` answers all of it:
//
//   Name          'EPSON TM-T70 Receipt'
//   PortName      'ESDPRT001'      <- USB. An IP here means a network printer.
//   DriverName    'EPSON TM-T70 ReceiptE4'
//   PrinterStatus 4224             <- 0x1000|0x80, NOT_AVAILABLE|OFFLINE
//   Shared        false
//   ShareName     ''               <- what the raw UNC fallback needs
//
// So PowerShell is the source, and getPrintersAsync is the fallback for when it
// is blocked by policy — a list of names is worse than this, and much better
// than nothing.
const { spawn } = require('node:child_process')

const POWERSHELL_TIMEOUT_MS = 5000

/**
 * Ports that mean "this is not a printer".
 *
 * `PORTPROMPT:` is the Save-As dialog behind Microsoft Print to PDF and the XPS
 * writer; `nul:` is OneNote; `SHRFAX:` is the fax driver. Printing to one of
 * these with `silent: true` opens a modal dialog on a window nobody can see,
 * which presents as the app hanging for no reason.
 *
 * Matched on the PORT rather than the name, because the name is localised — a
 * German install has "Microsoft Print to PDF" as "Microsoft Print to PDF" but
 * OneNote as "An OneNote senden", and a name list would miss it.
 */
const VIRTUAL_PORTS = ['portprompt:', 'nul:', 'shrfax:', 'onenote']

/** Names, as a second net for a machine where the port is unhelpful. */
const VIRTUAL_NAMES = ['print to pdf', 'xps document writer', 'onenote', 'fax', 'microsoft to do']

function looksVirtual(name, port) {
  const p = String(port ?? '').toLowerCase()
  const n = String(name ?? '').toLowerCase()
  return VIRTUAL_PORTS.some((v) => p.includes(v)) || VIRTUAL_NAMES.some((v) => n.includes(v))
}

/**
 * An IPv4 or IPv6 address hiding in a port name.
 *
 * Windows names a Standard TCP/IP port after the address by default, and
 * usually prefixes it — `IP_192.168.1.50`, or just `192.168.1.50`. Pulling the
 * address out is what lets the setup screen say "Network · 192.168.1.50"
 * instead of "Port IP_192.168.1.50", and lets it OFFER that address as a direct
 * connection: raw TCP needs no driver on any other till, which is exactly what
 * a shop wants for a kitchen printer.
 */
function addressInPort(port) {
  const text = String(port ?? '')
  const v4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(text)
  if (v4) return v4[1]
  return null
}

/**
 * How a queue is wired, in one word, from its port.
 *
 * A guess, and labelled as one in the UI ("looks like…"). Windows does not
 * report a connection KIND, only a port name, and a port can be named anything.
 * It is right for every default: USB ports are USB00n or a vendor's own
 * (ESDPRT00n for Epson, DOT4_00n for HP), TCP/IP ports carry the address, and
 * `\\server\queue` is a shared one.
 */
function kindOfPort(port) {
  const p = String(port ?? '')
  if (!p) return 'unknown'
  if (addressInPort(p)) return 'network'
  if (/^\\\\/.test(p)) return 'shared'
  if (/^(USB|ESDPRT|DOT4|LPT|COM)/i.test(p)) return 'usb'
  return 'other'
}

/** The Windows PRINTER_STATUS bits worth a sentence. 0 is ready. */
function describeStatus(status) {
  const s = Number(status) || 0
  if (s === 0) return null
  if (s & 0x00000001) return 'Paused'
  if (s & 0x00000080) return 'Offline'
  if (s & 0x00001000) return 'Not available'
  if (s & 0x00000010) return 'Out of paper'
  if (s & 0x00000008) return 'Paper jam'
  if (s & 0x00000002) return 'Error'
  if (s & 0x00000040) return 'Paper problem'
  if (s & 0x00000800) return 'Output bin full'
  /* Printing, busy, processing and waiting are all healthy — a queue with a job
     in it is working, and calling that a problem would cry wolf on every sale. */
  if (s & (0x00000100 | 0x00000200 | 0x00000400 | 0x00002000 | 0x00004000)) return null
  return `Not ready (${s})`
}

/** Runs a PowerShell command and resolves its stdout, or null. */
function powershell(command) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { windowsHide: true },
      )
    } catch {
      resolve(null)
      return
    }

    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* Already gone. */
      }
      resolve(value)
    }

    /* Bounded: this runs while somebody waits for a dropdown to populate, and a
       PowerShell that hangs on a wedged spooler must not hang the screen. */
    const timer = setTimeout(() => finish(null), POWERSHELL_TIMEOUT_MS)
    if (timer.unref) timer.unref()

    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code === 0 ? out : null)
    })
  })
}

/**
 * Every queue on this machine.
 *
 * `fallbackNames` is what getPrintersAsync returned — used when PowerShell is
 * blocked, so the picker still lists something. Those entries carry no port and
 * no status, and the screen says less about them rather than guessing.
 */
async function listQueues(fallbackNames = []) {
  if (process.platform !== 'win32') return listPosixQueues(fallbackNames)

  /* ConvertTo-Json with one printer returns an OBJECT, not an array — the
     classic PowerShell trap. @() forces an array either way. */
  const json = await powershell(
    '@(Get-Printer | Select-Object Name,PortName,DriverName,PrinterStatus,Shared,ShareName) | ConvertTo-Json -Compress -Depth 2',
  )

  if (json) {
    try {
      const parsed = JSON.parse(json.trim())
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      const defaultName = await powershell(
        '(Get-CimInstance -Class Win32_Printer -Filter "Default = True").Name',
      )
      const isDefault = (defaultName ?? '').trim()

      return rows
        .filter((r) => r && r.Name)
        .map((r) => {
          const port = String(r.PortName ?? '')
          return {
            name: String(r.Name),
            displayName: String(r.Name),
            port,
            driver: String(r.DriverName ?? ''),
            kind: kindOfPort(port),
            /** The IP behind a Standard TCP/IP port, when there is one. */
            address: addressInPort(port),
            statusText: describeStatus(r.PrinterStatus),
            shared: Boolean(r.Shared),
            shareName: String(r.ShareName ?? ''),
            isDefault: isDefault !== '' && String(r.Name) === isDefault,
            isVirtual: looksVirtual(r.Name, port),
          }
        })
        .sort((a, b) => Number(a.isVirtual) - Number(b.isVirtual) || a.name.localeCompare(b.name))
    } catch {
      /* Malformed output. Fall through to the names below rather than failing
         the whole screen over a parse. */
    }
  }

  return fallbackNames.map((name) => bare(name))
}

/** POSIX: CUPS, through lpstat. Same shape, less detail. */
async function listPosixQueues(fallbackNames) {
  const out = await new Promise((resolve) => {
    let child
    try {
      child = spawn('lpstat', ['-p', '-d'], {})
    } catch {
      resolve(null)
      return
    }
    let text = ''
    child.stdout.on('data', (c) => {
      text += String(c)
    })
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(text))
  })

  if (!out) return fallbackNames.map((name) => bare(name))

  const queues = []
  const defaultMatch = /system default destination:\s*(\S+)/i.exec(out)
  for (const line of out.split('\n')) {
    const m = /^printer\s+(\S+)\s+is\s+(\S+)/i.exec(line.trim())
    if (!m) continue
    queues.push({
      ...bare(m[1]),
      statusText: /idle|printing/i.test(m[2]) ? null : m[2],
      isDefault: defaultMatch ? m[1] === defaultMatch[1] : false,
    })
  }
  return queues.length > 0 ? queues : fallbackNames.map((name) => bare(name))
}

/** A queue we know only the name of. Says less rather than guessing. */
function bare(name) {
  return {
    name: String(name),
    displayName: String(name),
    port: '',
    driver: '',
    kind: 'unknown',
    address: null,
    statusText: null,
    shared: false,
    shareName: '',
    isDefault: false,
    isVirtual: looksVirtual(name, ''),
  }
}

module.exports = { listQueues, describeStatus, kindOfPort, addressInPort, looksVirtual }
