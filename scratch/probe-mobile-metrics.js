/* Runs BEFORE the capture stretches the viewport, so these are real 390px
   numbers rather than the 1600px the photograph is taken at. */
const out = {};
out.innerWidth = window.innerWidth;
out.docScrollW = document.documentElement.scrollWidth;
out.horizontalOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;

out.sidebar = document.querySelector('aside') ? 'PRESENT (bad)' : 'absent (good)';
out.grid = document.querySelector('.react-grid-layout') ? 'PRESENT (bad)' : 'absent (good)';

const header = document.querySelector('header');
out.headerHeight = header ? Math.round(header.getBoundingClientRect().height) : null;
out.headerText = (header?.innerText || '').trim().replace(/\n/g, ' | ').slice(0, 60);

// Every card in the scrolling pane: how wide, and does any escape the screen.
const cards = [...document.querySelectorAll('main .rounded-card')].map((el) => {
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) };
});
out.cardCount = cards.length;
out.narrowestCard = cards.length ? Math.min(...cards.map((c) => c.w)) : null;
out.widestCard = cards.length ? Math.max(...cards.map((c) => c.w)) : null;
out.cardsOffscreen = cards.filter((c) => c.x + c.w > window.innerWidth + 1).length;

// Touch targets in the bar must clear 44px.
const taps = [...document.querySelectorAll('header a, header button')].map((el) => {
  const r = el.getBoundingClientRect();
  return {
    label: el.getAttribute('aria-label') || '?',
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
});
out.headerTaps = taps;
out.smallestTapSide = taps.length ? Math.min(...taps.map((t) => Math.min(t.w, t.h))) : null;

// Open the menu and measure its rows too — a drawer that clips is invisible
// in a screenshot of the page behind it.
const menuBtn = [...document.querySelectorAll('header button')].find(
  (b) => (b.getAttribute('aria-label') || '').includes('menu'),
);
if (menuBtn) {
  menuBtn.click();
  await new Promise((r) => setTimeout(r, 700));
  const dlg = document.querySelector('dialog[open]');
  out.menuOpens = dlg ? 'yes (good)' : 'NO (bad)';
  if (dlg) {
    const rect = dlg.getBoundingClientRect();
    out.menuWidth = Math.round(rect.width);
    out.menuFitsOnScreen = rect.left >= -1 && rect.right <= window.innerWidth + 1;
    const rows = [...dlg.querySelectorAll('a')].map((a) =>
      Math.round(a.getBoundingClientRect().height),
    );
    out.menuRowCount = rows.length;
    out.shortestMenuRow = rows.length ? Math.min(...rows) : null;
  }
}

return JSON.stringify(out, null, 1);
