const out = {};
out.innerWidth = window.innerWidth;
out.docScrollW = document.documentElement.scrollWidth;
out.horizontalOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;

const side = document.querySelector('aside');
out.sidebar = side ? Math.round(side.getBoundingClientRect().width) : null;

const grid = document.querySelector('.react-grid-layout');
out.gridWidth = grid ? Math.round(grid.getBoundingClientRect().width) : null;

const items = [...document.querySelectorAll('.react-grid-item')].map((el) => {
  const r = el.getBoundingClientRect();
  const t = (el.innerText || '').trim().split('\n')[0].slice(0, 22);
  return { t, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) };
});
out.widgetCount = items.length;
out.sample = items.slice(0, 6);
out.narrowest = items.length ? Math.min(...items.map((i) => i.w)) : null;
out.offscreen = items.filter((i) => i.x + i.w > window.innerWidth + 1).length;
return JSON.stringify(out, null, 1);
