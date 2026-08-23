/* Each shot run gets a fresh browser profile, so both fetches happen here. A
   reload would kill the CDP evaluation context, so this measures the HTML the
   server returns rather than navigating this document.

   Order matters: the DESKTOP fetch runs FIRST. The mobile fetch makes the proxy
   set the odyssey_shell cookie, and once it is set every later fetch from this
   page is mobile too — which previously made the desktop control look broken
   when it was the probe that had changed. */
const plain = await fetch('/dashboard');
const plainHtml = await plain.text();

const res = await fetch('/dashboard', { headers: { 'x-odyssey-shell': 'mobile' } });
const html = await res.text();

const doc = new DOMParser().parseFromString(html, 'text/html');
const plainDoc = new DOMParser().parseFromString(plainHtml, 'text/html');

/* The RENDERED grid, not the string "react-grid-layout" — which also appears in
   a source comment and in a type-only import that compiles away. Asserting on
   the class the library actually puts in the DOM is asserting on what shipped. */
const gridClass = (d) => (d.querySelector('.react-grid-layout') ? 'present' : 'absent');

const out = {
  mobile: {
    status: res.status,
    sidebar: doc.querySelector('aside') ? 'PRESENT (bad)' : 'absent (good)',
    header: doc.querySelector('header') ? 'present (good)' : 'MISSING (bad)',
    title: (doc.querySelector('header')?.textContent || '').trim().slice(0, 60),
    grid: gridClass(doc) === 'absent' ? 'absent (good)' : 'PRESENT (bad)',
    searchPalette: /Search everything/.test(html) ? 'PRESENT (bad)' : 'absent (good)',
    menuButton: /Open the menu/.test(html) ? 'present (good)' : 'MISSING (bad)',
  },
  desktopControl: {
    status: plain.status,
    sidebar: plainDoc.querySelector('aside') ? 'present (good)' : 'MISSING (bad)',
    grid: gridClass(plainDoc) === 'present' ? 'present (good)' : 'ABSENT (bad)',
    searchPalette: /Search everything/.test(plainHtml) ? 'present (good)' : 'MISSING (bad)',
  },
};

return JSON.stringify(out, null, 1);
