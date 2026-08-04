// Kill whatever is holding the dev port. Next picks a different port when the
// default is busy, which then breaks the Electron shell's fixed dev URL and the
// wait-on health check — so we free it deterministically instead.
import { execSync } from 'node:child_process'

const port = Number(process.argv[2] || 4100)

function pidsOnPort() {
  try {
    const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8' })
    const pids = new Set()
    for (const line of out.split(/\r?\n/)) {
      // e.g.  TCP    0.0.0.0:4100    0.0.0.0:0    LISTENING    12345
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
      if (m && Number(m[1]) === port) pids.add(m[2])
    }
    return [...pids]
  } catch {
    return []
  }
}

const pids = pidsOnPort()
if (!pids.length) {
  console.log(`[free-port] ${port} is free`)
} else {
  for (const pid of pids) {
    // PID 0 is the system idle process — never a real listener we can kill.
    if (pid === '0') continue
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' })
      console.log(`[free-port] killed pid ${pid} on ${port}`)
    } catch {
      console.warn(`[free-port] could not kill pid ${pid} — continuing`)
    }
  }
}
