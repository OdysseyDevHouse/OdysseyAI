const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const log = (...a) => out.push(a.join(' '))
const errs = []
window.addEventListener('error', (e) => errs.push(e.message))

const sel = document.querySelector('select')
const opt = [...sel.options].find((o) => /till slip/i.test(o.textContent))
const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
setter.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true }))
await sleep(2500)
const start = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start a design')
if (start) { start.click(); await sleep(4500) }
await sleep(1200)

const rows = () => [...document.querySelectorAll('[data-slip-row]')]
const labels = () => rows().map((r) => r.getAttribute('aria-label'))

log('slip lines           :', rows().length)
log('palette tiles        :', document.querySelectorAll('[aria-label^="Add "]').length)
log('undo button          :', !!document.querySelector('[aria-label="Undo"]'))
log('redo button          :', !!document.querySelector('[aria-label="Redo"]'))
log('reset button         :', [...document.querySelectorAll('button')].some((b) => /Reset to standard/.test(b.textContent)))
log('undo starts disabled :', document.querySelector('[aria-label="Undo"]')?.disabled)

// ── Drag a palette tile onto a specific spot on the slip.
const tile = [...document.querySelectorAll('[aria-label^="Add "]')][0]
log('')
log('dragging             :', tile ? JSON.stringify(tile.getAttribute('aria-label')) : 'no tile')
if (!tile) return out.join('\n')

const before = labels()
const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, pointerType: 'mouse' }
const tr = tile.getBoundingClientRect()
tile.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: tr.left + 30, clientY: tr.top + 10 }))
await sleep(120)

// Move onto the slip, aiming between the 3rd and 4th line.
const list = rows()[0].parentElement.parentElement
const aim = rows()[3].getBoundingClientRect()
for (let i = 1; i <= 6; i++) {
  const y = tr.top + ((aim.top - tr.top) * i) / 6
  list.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: aim.left + 40, clientY: y }))
  await sleep(35)
}
const strip = [...document.querySelectorAll('div')].filter((d) => d.className.includes('bg-brand') && d.className.includes('h-0.5'))
log('landing strip shown  :', strip.length > 0 ? 'yes' : 'NO')

list.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0, clientX: aim.left + 40, clientY: aim.top + 2 }))
await sleep(1000)

const after = labels()
log('lines after          :', after.length, before.length === after.length - 1 ? '(one added)' : '*** expected one more ***')
const added = after.find((l, i) => l !== before[i])
log('added at position    :', after.findIndex((l, i) => l !== before[i]), JSON.stringify(added))
log('undo now enabled     :', !document.querySelector('[aria-label="Undo"]')?.disabled)

// ── Undo it.
document.querySelector('[aria-label="Undo"]')?.click()
await sleep(900)
log('')
log('after undo           :', labels().length, 'lines', JSON.stringify(labels()) === JSON.stringify(before) ? '(back to before)' : '*** differs ***')
log('redo now enabled     :', !document.querySelector('[aria-label="Redo"]')?.disabled)

// ── Redo it.
document.querySelector('[aria-label="Redo"]')?.click()
await sleep(900)
log('after redo           :', labels().length, 'lines', JSON.stringify(labels()) === JSON.stringify(after) ? '(back to after)' : '*** differs ***')

log('')
log('js errors            :', errs.length ? '*** ' + errs.join(' | ') : 'none')
return out.join('\n')
