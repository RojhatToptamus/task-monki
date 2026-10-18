/**
 * The recorder that runs in an isolated world of the page under test. Page scripts cannot see
 * it: it lives in its own JavaScript world and reports through a binding that exists only there.
 * It records what a person does (clicks, final field values, choices, the supported keys) with
 * facts to find the same element again, and runs pick mode when the person marks the bug.
 */

export const RECORDER_WORLD = 'tm-bug-recorder';
export const RECORDER_BINDING = '__tmRec';

export const RECORDER_SCRIPT = String.raw`(() => {
  if (globalThis.__tmRecorderInstalled) return;
  globalThis.__tmRecorderInstalled = true;
  const send = (event) => {
    try { globalThis.${RECORDER_BINDING}(JSON.stringify(event)); } catch (_) {}
  };
  const isTop = window.top === window;
  const SUPPORTED_KEYS = new Set(['Enter', 'Escape', 'Tab', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  const ACTIONABLE = 'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=option], [role=treeitem], [contenteditable=""], [contenteditable=true]';
  const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy'];
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const clip = (value, max) => { const text = norm(value); return text.length > max ? text.slice(0, max) : text; };

  function isEditable(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;
    const tag = element.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'range', 'color'].includes(type);
  }

  function implicitRole(element) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'summary') return 'button';
    if (tag === 'select') return element.multiple || Number(element.size) > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (['', 'text', 'email', 'tel', 'url', 'password'].includes(type)) return type === 'password' ? undefined : 'textbox';
      return undefined;
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'li') return 'listitem';
    if (tag === 'img' && element.getAttribute('alt')) return 'img';
    if (tag === 'option') return 'option';
    return undefined;
  }

  function labelText(element) {
    if (element.labels && element.labels.length) return clip(Array.from(element.labels).map((label) => label.innerText).join(' '), 200);
    const id = element.getAttribute('aria-labelledby');
    if (id) {
      const text = id.split(/\s+/).map((part) => document.getElementById(part)).filter(Boolean).map((node) => node.innerText || node.textContent).join(' ');
      if (norm(text)) return clip(text, 200);
    }
    return undefined;
  }

  function accessibleName(element, role) {
    const aria = element.getAttribute('aria-label');
    if (norm(aria)) return clip(aria, 200);
    const labelled = element.getAttribute('aria-labelledby');
    if (labelled) {
      const text = labelled.split(/\s+/).map((part) => document.getElementById(part)).filter(Boolean).map((node) => node.innerText || node.textContent).join(' ');
      if (norm(text)) return clip(text, 200);
    }
    const tag = element.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const label = labelText(element);
      if (label) return label;
      const type = (element.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return clip(element.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''), 200);
      if (element.getAttribute('title')) return clip(element.getAttribute('title'), 200);
      if (element.getAttribute('placeholder')) return clip(element.getAttribute('placeholder'), 200);
      return undefined;
    }
    if (tag === 'IMG') return clip(element.getAttribute('alt'), 200) || undefined;
    if (role && ['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'heading', 'switch', 'treeitem', 'listitem'].includes(role)) {
      const text = clip(element.innerText || element.textContent, 200);
      if (text) return text;
    }
    if (element.getAttribute('title')) return clip(element.getAttribute('title'), 200);
    return undefined;
  }

  function cssPath(element) {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 12) {
      const id = node.getAttribute('id');
      if (id && /^[A-Za-z][\w-]{0,60}$/.test(id) && !/\d{3,}/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1) {
        parts.unshift('#' + CSS.escape(id));
        return parts.join(' > ');
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag);
      node = parent;
    }
    return parts.length ? (parts[0].startsWith('#') ? '' : 'html > ') + parts.join(' > ') : 'html';
  }

  function facts(element) {
    const tag = element.tagName.toLowerCase();
    const explicit = element.getAttribute('role');
    const role = explicit ? explicit.split(/\s+/)[0] : implicitRole(element);
    const name = role ? accessibleName(element, role) : undefined;
    const testIds = [];
    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value && value.length <= 200) testIds.push({ attribute, value });
    }
    const result = { tag, testIds, css: cssPath(element).slice(0, 2000) };
    if (tag === 'input') result.inputType = (element.getAttribute('type') || 'text').toLowerCase();
    if (role && /^[a-z]+$/.test(role)) result.role = role;
    if (name) result.name = name;
    const label = labelText(element);
    if (label) result.label = label;
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) result.placeholder = clip(placeholder, 200);
    if (!['input', 'select', 'textarea'].includes(tag)) {
      const text = clip(element.innerText || element.textContent, 300);
      if (text) result.text = text;
    }
    if (!result.name && !result.label) {
      const context = contextText(element);
      if (context) result.context = context;
    }
    return result;
  }

  // The words that label an element on the page: "Cart total" in a "Cart total: $40.00" line,
  // or the term of a definition. Only the element's own line counts, never earlier content.
  function contextText(element) {
    const own = norm(element.innerText || element.textContent);
    const parent = element.parentElement;
    if (!own || !parent) return undefined;
    if (parent.tagName === 'DD' || element.tagName === 'DD') {
      const term = (element.tagName === 'DD' ? element : parent).previousElementSibling;
      if (term && term.tagName === 'DT') return clip(term.innerText || term.textContent, 60) || undefined;
    }
    // Only an element that sits inline on a line shares it with a label; a block's parent text
    // is its neighbours' content, not its name.
    if (!getComputedStyle(element).display.startsWith('inline')) return undefined;
    const line = norm(parent.innerText || parent.textContent);
    if (!line.endsWith(own) || line.length > own.length + 60) return undefined;
    const label = line.slice(0, line.length - own.length).replace(/[\s:\-]+$/, '').trim();
    return label && label.length <= 60 && !/[.!?]$/.test(label) ? label : undefined;
  }

  function actionable(element) {
    if (!element || element.nodeType !== 1) return element;
    return element.closest(ACTIONABLE) || element;
  }

  // Recording
  let lastInput = 0;
  const activity = () => {
    const now = Date.now();
    if (now - lastInput > 1000) { lastInput = now; send({ type: 'activity' }); }
  };
  const fillTimers = new WeakMap();
  const fillStarted = new WeakMap();
  const lastValues = new WeakMap();

  function emitFill(element) {
    const started = fillStarted.get(element);
    fillStarted.delete(element);
    const value = element.isContentEditable ? (element.innerText || '') : element.value;
    if (lastValues.get(element) === value) return;
    lastValues.set(element, value);
    const sensitive = element.tagName === 'INPUT' && (element.getAttribute('type') || '').toLowerCase() === 'password';
    // How long ago typing began: the fill is timed from its first keystroke.
    const typedForMs = started === undefined ? 0 : Date.now() - started;
    send({ type: 'action', kind: 'fill', target: facts(element), value: String(value).slice(0, 4096), sensitive, typedForMs, frame: isTop ? 'top' : 'child' });
  }

  document.addEventListener('click', (event) => {
    if (!event.isTrusted || globalThis.__tmPicking) return;
    activity();
    const element = actionable(event.target);
    if (!element || element.nodeType !== 1) return;
    if (element.tagName === 'INPUT') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'file') return;
      if (isEditable(element)) return;
    }
    if (element.tagName === 'SELECT' || element.tagName === 'TEXTAREA' || element.isContentEditable) return;
    if (element.tagName === 'LABEL' && element.control && ['checkbox', 'radio'].includes((element.control.getAttribute('type') || '').toLowerCase())) return;
    send({ type: 'action', kind: 'click', target: facts(element), frame: isTop ? 'top' : 'child' });
  }, true);

  document.addEventListener('input', (event) => {
    if (!event.isTrusted) return;
    activity();
    const element = event.target;
    if (!element || !isEditable(element) || element.tagName === 'SELECT') return;
    if (!fillStarted.has(element)) fillStarted.set(element, Date.now());
    clearTimeout(fillTimers.get(element));
    fillTimers.set(element, setTimeout(() => emitFill(element), 700));
  }, true);

  document.addEventListener('change', (event) => {
    if (!event.isTrusted) return;
    activity();
    const element = event.target;
    if (!element || element.nodeType !== 1) return;
    if (element.tagName === 'SELECT') {
      const values = Array.from(element.selectedOptions || []).map((option) => option.value);
      send({ type: 'action', kind: 'select', target: facts(element), values, frame: isTop ? 'top' : 'child' });
      return;
    }
    if (element.tagName === 'INPUT') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        send({ type: 'action', kind: element.checked ? 'check' : 'uncheck', target: facts(element), frame: isTop ? 'top' : 'child' });
        return;
      }
      if (type === 'file') {
        send({ type: 'unsupported', what: 'file chooser' });
        return;
      }
    }
    if (isEditable(element)) {
      clearTimeout(fillTimers.get(element));
      emitFill(element);
    }
  }, true);

  // A pending fill is flushed before the next click lands, so steps keep the person's order.
  document.addEventListener('pointerdown', () => {
    const focused = document.activeElement;
    if (focused && isEditable(focused) && fillTimers.has(focused)) {
      clearTimeout(fillTimers.get(focused));
      emitFill(focused);
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted || globalThis.__tmPicking) return;
    activity();
    const focused = document.activeElement;
    const editable = isEditable(focused);
    if (event.metaKey || event.ctrlKey || event.altKey) {
      if (!editable && event.key.length === 1) send({ type: 'unsupported', what: (event.metaKey ? '⌘' : event.ctrlKey ? 'Ctrl+' : '⌥') + event.key.toUpperCase() });
      return;
    }
    if (!SUPPORTED_KEYS.has(event.key)) return;
    if (editable && focused && fillTimers.has(focused)) {
      clearTimeout(fillTimers.get(focused));
      emitFill(focused);
    }
    if (editable && event.key !== 'Enter' && event.key !== 'Escape' && event.key !== 'Tab') return;
    send({ type: 'action', kind: 'press', key: event.key === ' ' ? 'Space' : event.key, frame: isTop ? 'top' : 'child' });
  }, true);

  document.addEventListener('drop', (event) => {
    if (event.isTrusted) send({ type: 'unsupported', what: 'drag and drop' });
  }, true);

  // Pick mode: the person points at the wrong value; the click never reaches the page.
  let overlay;
  function ensureOverlay() {
    if (overlay) return overlay;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:2px solid #4f7cff;background:rgba(79,124,255,0.12);border-radius:3px;pointer-events:none;display:none;box-sizing:border-box;';
    root.appendChild(box);
    overlay = { host, box };
    return overlay;
  }
  function pickTarget(element) {
    if (!element || element.nodeType !== 1) return element;
    return element;
  }
  // Where the page's own scroll boxes stood when the capture's screenshot was taken, so a pick
  // made after more scrolling can still be placed on it. The window's scroll is returned.
  let shotOffsets = new WeakMap();
  globalThis.__tmNoteShot = () => {
    shotOffsets = new WeakMap();
    for (const element of document.querySelectorAll('*')) {
      if (element === document.scrollingElement || element === document.body) continue;
      if (element.scrollTop || element.scrollLeft) shotOffsets.set(element, { x: element.scrollLeft, y: element.scrollTop });
    }
    return [window.scrollX, window.scrollY];
  };
  // How the boxes around an element scrolled since the screenshot, and whether the window's own
  // scroll moves it: a fixed box stays where it is, a sticky one cannot be placed once anything moved.
  function placement(element) {
    const shift = { x: 0, y: 0 };
    let fixed = false;
    let sticky = false;
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === 'sticky') sticky = true;
      if (position === 'fixed') { fixed = true; break; }
      const parent = node.parentElement;
      if (!parent || parent === document.scrollingElement || parent === document.body || parent === document.documentElement) continue;
      const then = shotOffsets.get(parent) || { x: 0, y: 0 };
      shift.x += parent.scrollLeft - then.x;
      shift.y += parent.scrollTop - then.y;
    }
    return { shift, fixed, sticky };
  }
  globalThis.__tmStartPick = () => {
    if (!isTop) return;
    globalThis.__tmPicking = true;
    const { host, box } = ensureOverlay();
    document.documentElement.appendChild(host);
    // Only the person's own input points: events the page dispatches are not trusted.
    const move = (event) => {
      if (!event.isTrusted) return;
      const element = pickTarget(event.target);
      if (!element || element === host) return;
      const rect = element.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
    };
    // A pick keeps its box on the element until the numbered outline takes its place.
    const stop = (keepBox) => {
      globalThis.__tmPicking = false;
      globalThis.__tmStopPicking = undefined;
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('mousedown', swallow, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('keydown', key, true);
      if (keepBox) return;
      box.style.display = 'none';
      host.remove();
    };
    const swallow = (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const click = (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = pickTarget(event.target);
      const picked = Boolean(element && element.nodeType === 1);
      stop(picked);
      if (!picked) { send({ type: 'pick', cancelled: true }); return; }
      const result = facts(element);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      let count = 1;
      try {
        if (result.testIds[0]) count = document.querySelectorAll('[' + result.testIds[0].attribute + '="' + CSS.escape(result.testIds[0].value) + '"]').length;
        else count = document.querySelectorAll(result.css).length;
      } catch (_) {}
      const value = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? String(element.value) : undefined;
      // Where it sits, with the scroll it was read at: the screenshot may have been taken at another.
      const box = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      send({ type: 'pick', target: result, text: norm(element.innerText || element.textContent || (value ?? '')).slice(0, 4000), value, visible, count, box, scroll: { x: window.scrollX, y: window.scrollY }, placement: placement(element) });
    };
    const key = (event) => {
      if (event.isTrusted && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        stop();
        send({ type: 'pick', cancelled: true });
      }
    };
    globalThis.__tmStopPicking = () => {
      stop();
      send({ type: 'pick', cancelled: true });
    };
    // On the window in the capture phase: ahead of every listener on the document.
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mousedown', swallow, true);
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('click', click, true);
    window.addEventListener('keydown', key, true);
  };
  // Stop pointing without an event the page could also see.
  globalThis.__tmStopPick = () => {
    if (globalThis.__tmPicking && globalThis.__tmStopPicking) globalThis.__tmStopPicking();
  };
  // While the bug is marked, each element a check reads keeps a numbered outline, so the page and
  // the checks beside it name the same thing. Outlines follow scrolling and never take input.
  let marks;
  function drawMarks() {
    if (!marks) return;
    for (const mark of marks.items) {
      const rect = mark.element.isConnected ? mark.element.getBoundingClientRect() : undefined;
      const shown = rect && rect.width > 0 && rect.height > 0;
      mark.box.style.display = shown ? 'block' : 'none';
      if (!shown) continue;
      mark.box.style.left = rect.left + 'px';
      mark.box.style.top = rect.top + 'px';
      mark.box.style.width = rect.width + 'px';
      mark.box.style.height = rect.height + 'px';
    }
  }
  const redraw = () => requestAnimationFrame(drawMarks);
  // The pick's own box gives way to the numbered outlines, whichever call comes first.
  const dropPickBox = () => {
    if (!overlay || globalThis.__tmPicking) return;
    overlay.box.style.display = 'none';
    overlay.host.remove();
  };
  globalThis.__tmClearMarks = () => {
    dropPickBox();
    if (!marks) return;
    window.removeEventListener('scroll', redraw, true);
    window.removeEventListener('resize', redraw);
    marks.host.remove();
    marks = undefined;
  };
  // Outlines are kept by element and number, so editing a value never redraws them.
  globalThis.__tmShowMarks = (json) => {
    if (!isTop) return;
    dropPickBox();
    let wanted = [];
    try { wanted = JSON.parse(json); } catch (_) { return; }
    if (!marks) {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
      marks = { host, root: host.attachShadow({ mode: 'closed' }), items: [] };
      document.documentElement.appendChild(host);
      window.addEventListener('scroll', redraw, true);
      window.addEventListener('resize', redraw);
    }
    const next = [];
    for (const item of wanted.slice(0, 5)) {
      const label = String(item.label).slice(0, 2);
      let element;
      try { element = document.querySelector(item.css); } catch (_) { element = undefined; }
      if (!element) continue;
      const kept = marks.items.find((mark) => mark.element === element && mark.label === label);
      if (kept) { next.push(kept); continue; }
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;border:2px solid #4f7cff;border-radius:3px;pointer-events:none;box-sizing:border-box;display:none;';
      const badge = document.createElement('div');
      badge.textContent = label;
      badge.style.cssText = 'position:absolute;left:-2px;top:-20px;min-width:16px;height:16px;padding:0 4px;border-radius:3px;background:#4f7cff;color:#fff;font:600 11px/16px -apple-system,system-ui,sans-serif;text-align:center;box-sizing:border-box;';
      box.appendChild(badge);
      marks.root.appendChild(box);
      next.push({ element, label, box });
    }
    for (const mark of marks.items) if (!next.includes(mark)) mark.box.remove();
    marks.items = next;
    if (!next.length) { globalThis.__tmClearMarks(); return; }
    drawMarks();
  };
  // The recorder starts before the document is parsed, so the title is read once it exists.
  if (isTop) {
    const ready = () => send({ type: 'ready', title: document.title });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
    else ready();
  }
})();`;
