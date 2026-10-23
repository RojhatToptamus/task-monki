// Design audit for the running app (DESIGN.md §15, step 6). It reads computed
// styles on the screen as it is, on real data, and lists what the static checks
// cannot see: type off the scale or inherited at the browser's 16px, a face that
// is not Instrument Sans or Geist Mono, a weight other than 400 or 500, control
// heights off the scale, an icon off centre in its button, an icon-only button
// with no name, an icon size outside the set, a corner too round for its height,
// a doubled edge, the pointer or not-allowed cursor, and separator glyphs in copy.
//
// Run it in DevTools, or over CDP against the dev app, for example:
//   agent-browser --session <name> eval "$(cat tools/design-audit.js)"
// It returns { count, byRule, items } and logs a table. Each item is a lead to
// look at, not an automatic defect: a decorative miniature may be meant to be
// small. To catch content shifts, call window.taskMonkiDesignAudit.watchShifts(),
// then hover, toggle, expand, send and wait for loads; every shift it logs whose
// source is not the element you meant to move is a defect.
(() => {
  const typeSizes = new Set(['22px', '17px', '15px', '13px', '12px', '11.5px']);
  const controlHeights = new Set([16, 18, 20, 24, 28, 32, 36, 48]);
  const iconSizes = new Set([12, 13, 16, 18]);
  const separator = /\s[·•—]\s/;

  const describe = (el) => {
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return [el.tagName.toLowerCase(), ...classes].join('.');
  };
  const ownText = (el) => [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join('').trim();
  const decorative = (el) => Boolean(el.closest('[aria-hidden="true"], [hidden], .tm-visually-hidden'));

  function run(root = document.body) {
    const items = [];
    const flag = (rule, value, el) => items.push({ rule, value: String(value), element: describe(el) });
    for (const el of root.querySelectorAll('*')) {
      if (!el.getClientRects().length || decorative(el)) continue;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const text = ownText(el);
      if (text) {
        if (!typeSizes.has(style.fontSize)) flag('type size off the scale', style.fontSize, el);
        if (!/^"?(Instrument Sans|Geist Mono)/.test(style.fontFamily)) flag('face', style.fontFamily.split(',')[0], el);
        if (!['400', '500'].includes(style.fontWeight)) flag('weight', style.fontWeight, el);
        if (separator.test(text)) flag('separator glyph in copy', text.slice(0, 60), el);
        if (el.matches('code, pre, kbd, samp') && !/^"?Geist Mono/.test(style.fontFamily)) flag('code not in the app mono', style.fontFamily.split(',')[0], el);
      }
      if (el.matches('button, [role="button"], input:not([type="checkbox"]):not([type="radio"]), select')) {
        const height = Math.round(box.height);
        if (!controlHeights.has(height)) flag('control height', height, el);
        const icon = el.querySelector(':scope > svg');
        if (icon && !el.textContent.trim()) {
          const glyph = icon.getBoundingClientRect();
          const dx = box.left + box.width / 2 - (glyph.left + glyph.width / 2);
          const dy = box.top + box.height / 2 - (glyph.top + glyph.height / 2);
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) flag('icon off centre', `${dx.toFixed(1)}, ${dy.toFixed(1)}`, el);
          if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) flag('icon-only button without a name', '', el);
        }
      }
      if (el instanceof SVGSVGElement && el.closest('button, a, [role="button"], [role="menuitem"]') && !iconSizes.has(Math.round(box.width))) {
        flag('icon size', Math.round(box.width), el);
      }
      const radius = parseFloat(style.borderTopLeftRadius);
      const height = Math.min(box.height, box.width);
      // Lets 4 on 16, 6 on 20 and 24, 8 on 28 to 36 and 12 on 40 through; flags 6 on 16 and 12 on 36.
      if (radius > 0 && radius < height / 2 - 0.5 && radius > height / 3.2) flag('corner too round for its height', `${radius}px on ${Math.round(height)}px`, el);
      if (['pointer', 'not-allowed'].includes(style.cursor)) flag('cursor', style.cursor, el);
      if (parseFloat(style.borderTopWidth) > 0 && /inset 0px 0px 0px 1px/.test(style.boxShadow)) flag('doubled edge', 'border and inset ring', el);
    }
    const byRule = items.reduce((counts, item) => ({ ...counts, [item.rule]: (counts[item.rule] ?? 0) + 1 }), {});
    console.table(items);
    return { count: items.length, byRule, items: items.slice(0, 200) };
  }

  function watchShifts() {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        console.warn('layout shift', entry.value.toFixed(4), (entry.sources ?? []).map((source) => source.node && describe(source.node)));
      }
    });
    observer.observe({ type: 'layout-shift', buffered: true });
    return () => observer.disconnect();
  }

  window.taskMonkiDesignAudit = { run, watchShifts };
  return run();
})();
