const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const log = (...a) => out.push(a.join(' '))
const sel = document.querySelector('select')
const opt = [...sel.options].find((o) => /till slip/i.test(o.textContent))
const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
setter.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true }))
await sleep(2500)
const start = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start a design')
if (start) { start.click(); await sleep(4500) }
await sleep(1200)

const rows = () => [...document.querySelectorAll('[data-slip-row]')]
const tiles = () => [...document.querySelectorAll('[aria-label^="Add "]')].map((t) => t.getAttribute('aria-label'))
log('lines at start   :', rows().length)
log('palette offers   :', tiles().length, JSON.stringify(tiles()))

// Remove a removable line and check it returns to the palette.
const loyalty = rows().find((r) => r.getAttribute('aria-label') === 'Loyalty points')
const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1, pointerType: 'mouse' }
const lr = loyalty.getBoundingClientRect()
loyalty.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: lr.left + 20, clientY: lr.top + 4 }))
await sleep(60)
loyalty.parentElement.parentElement.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0, clientX: lr.left + 20, clientY: lr.top + 4 }))
await sleep(700)
const removeBtn = [...document.querySelectorAll('button')].find((b) => /Remove this block/.test(b.textContent))
log('')
log('remove offered   :', !!removeBtn)
removeBtn.click()
await sleep(1000)
log('lines after      :', rows().length)
log('palette now      :', tiles().length, tiles().includes('Add Loyalty points') ? '(loyalty came back)' : '*** loyalty missing ***')

// Now reset.
const reset = [...document.querySelectorAll('button')].find((b) => /Reset to standard/.test(b.textContent))
reset.click()
await sleep(1200)
log('')
log('lines after reset:', rows().length)
log('undo after reset :', document.querySelector('[aria-label="Undo"]')?.disabled ? 'disabled (history cleared)' : '*** still enabled ***')
log('palette after    :', tiles().length)
return out.join('\n')
