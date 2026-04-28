/* ============================================================
   PULSE — WhatsApp Operations Dashboard
   app.js · Vanilla JS · No framework
   ============================================================ */

(() => {
'use strict';

// ============================================================
// 1. UTILITIES
// ============================================================
const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
const fmt = {
  num: n => new Intl.NumberFormat('he-IL').format(n ?? 0),
  pct: n => `${(n ?? 0).toFixed(1)}%`,
  time: ts => new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
  date: ts => new Date(ts).toLocaleDateString('he-IL', { day: '2-digit', month: 'short' }),
  full: ts => new Date(ts).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
  bytes: b => {
    if (b == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`;
  },
  phone: p => {
    if (!p) return '';
    const s = String(p).replace(/\D/g, '');
    if (s.length === 12 && s.startsWith('972')) return `+972 ${s.slice(3, 5)}-${s.slice(5, 8)}-${s.slice(8)}`;
    if (s.length === 10 && s.startsWith('05')) return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
    return s;
  },
  // Pulls a usable filename + type label out of any file URL we might
  // store (internal:./uploads/123-name.pdf, https://…/foo.png, etc).
  file: url => {
    if (!url) return null;
    let cleaned = String(url).replace(/^internal:/, '').replace(/^\.\//, '');
    cleaned = cleaned.split('?')[0].split('#')[0];
    let seg = cleaned.split(/[\\/]/).filter(Boolean).pop() || cleaned;
    // Strip a leading numeric timestamp prefix added on upload.
    seg = seg.replace(/^\d{6,}-/, '');
    const ext = (seg.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const TYPES = {
      pdf: 'PDF',
      jpg: 'תמונה', jpeg: 'תמונה', png: 'תמונה', gif: 'תמונה', webp: 'תמונה', heic: 'תמונה', svg: 'תמונה',
      doc: 'DOC',  docx: 'DOC',
      xls: 'XLS',  xlsx: 'XLS',  csv: 'CSV',
      ppt: 'PPT',  pptx: 'PPT',
      mp3: 'אודיו', wav: 'אודיו', m4a: 'אודיו', ogg: 'אודיו',
      mp4: 'וידאו', mov: 'וידאו', webm: 'וידאו', avi: 'וידאו',
      zip: 'ZIP',  rar: 'RAR',  '7z': '7Z',
      txt: 'TXT'
    };
    return { name: seg, type: TYPES[ext] || (ext ? ext.toUpperCase() : 'קובץ') };
  }
};
const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => 'id_' + Math.random().toString(36).slice(2, 11);

// ============================================================
// 2. STORAGE
// ============================================================
const LS_KEY = 'pulse:v1';
const Storage = {
  load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch { return {}; }
  },
  save(patch) {
    const cur = Storage.load();
    localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch }));
  }
};

// ============================================================
// 3. STATE
// ============================================================
const persisted = Storage.load();
// When the dashboard is served straight from the backend (e.g. visiting
// http://100.112.26.103:3001 on a phone), the page's own origin is the
// backend URL. Use it as the default when nothing is persisted yet so
// first-visit on a new device just works.
const inferredBackend = window.location.port
  ? window.location.origin
  : '';
const State = {
  theme:       persisted.theme       ?? 'dark',
  route:       'dashboard',
  backendUrl:  persisted.backendUrl  ?? inferredBackend,
  optSound:    persisted.optSound    ?? false,
  connected:   false,
  qr:          null,
  loading:     null,
  waContacts:  [],
  waGroups:    [],
  logs:        persisted.logs        ?? [],
  pendingFile: null,
  chartRange:  14,
  logsFilter:  'all',
  logsQuery:   ''
};

// ============================================================
// 4. TOAST
// ============================================================
const Toast = (() => {
  const host = $('#toastHost');
  const ICONS = { success: 'i-check', error: 'i-alert', info: 'i-spark' };
  return {
    show(msg, type = 'info', ttl = 3500) {
      const el = document.createElement('div');
      el.className = `toast toast--${type}`;
      el.innerHTML = `<svg class="ico"><use href="#${ICONS[type]}"/></svg><span>${msg}</span>`;
      host.appendChild(el);
      setTimeout(() => {
        el.classList.add('toast--out');
        setTimeout(() => el.remove(), 260);
      }, ttl);
    }
  };
})();

// ============================================================
// 4b. DROPDOWN — custom replacement for native <select>
// Keeps the underlying <select> in the DOM as source of truth
// (so existing change listeners keep working) and renders a
// styled trigger + panel on top.
// ============================================================
const Dropdown = (() => {
  const instances = new WeakMap();
  let openInstance = null;

  function enhance(select) {
    if (!select || instances.has(select)) return;

    // Build wrapper. If the existing parent is a `.select-wrap`, replace it
    // entirely so its native chevron and padding don't leak through.
    const wrapper = document.createElement('div');
    wrapper.className = 'dropdown';

    const oldParent = select.parentNode;
    if (oldParent.classList.contains('select-wrap')) {
      oldParent.parentNode.insertBefore(wrapper, oldParent);
      wrapper.appendChild(select);
      oldParent.remove();
    } else {
      oldParent.insertBefore(wrapper, select);
      wrapper.appendChild(select);
    }

    // If the select had visibility-related classes (e.g. `hidden`), move
    // them to the wrapper so toggling visibility still works.
    if (select.classList.contains('hidden')) {
      wrapper.classList.add('hidden');
      select.classList.remove('hidden');
    }

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dropdown__trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `
      <span class="dropdown__label"></span>
      <svg class="dropdown__caret" viewBox="0 0 12 12" fill="none">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    wrapper.appendChild(trigger);

    const panel = document.createElement('div');
    panel.className = 'dropdown__panel';
    panel.setAttribute('role', 'listbox');
    // The panel must live outside any transformed ancestor (e.g. `.view`
    // has a transform animation which creates a containing block for
    // `position: fixed`). Appending to body keeps positioning relative
    // to the viewport, where it belongs.
    document.body.appendChild(panel);

    const inst = { select, wrapper, trigger, panel };
    instances.set(select, inst);

    // Initial build + label
    rebuild(select);

    // Trigger click toggles open/close.
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isOpen(inst) ? close(inst) : open(inst);
    });

    // Keyboard: Down arrow / Enter / Space opens.
    trigger.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        open(inst);
      }
    });

    // Watch for option changes (e.g. Send.refreshContacts() rewrites innerHTML).
    new MutationObserver(() => rebuild(select)).observe(select, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Reflect external value changes back to UI.
    select.addEventListener('change', () => updateLabel(inst));
  }

  function rebuild(select) {
    const inst = instances.get(select);
    if (!inst) return;
    inst.panel.innerHTML = '';

    // Show a search field only when there's enough content to justify it.
    const totalOpts = select.querySelectorAll('option').length;
    const showSearch = totalOpts > 6;
    if (showSearch) {
      const searchEl = document.createElement('div');
      searchEl.className = 'dropdown__search';
      searchEl.innerHTML = `
        <svg class="ico ico--sm" aria-hidden="true"><use href="#i-search"/></svg>
        <input type="text" placeholder="חפש..." autocomplete="off" />
      `;
      // Don't let clicks on the search row bubble up & accidentally
      // re-trigger the trigger button.
      searchEl.addEventListener('click', e => e.stopPropagation());
      const searchInput = searchEl.querySelector('input');
      searchInput.addEventListener('input', e => filterOptions(inst, e.target.value));
      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = inst.panel.querySelector('.dropdown__option:not([hidden])');
          if (first) first.click();
        }
      });
      inst.panel.appendChild(searchEl);
      inst.searchInput = searchInput;
    } else {
      inst.searchInput = null;
    }

    let any = false;
    Array.from(select.children).forEach(child => {
      if (child.tagName === 'OPTGROUP') {
        const label = document.createElement('div');
        label.className = 'dropdown__group-label';
        label.textContent = child.label || '';
        inst.panel.appendChild(label);
        Array.from(child.children).forEach(opt => {
          inst.panel.appendChild(buildOptionEl(opt, inst));
          any = true;
        });
      } else if (child.tagName === 'OPTION') {
        // Skip the "—" placeholder option from rendering as a regular row;
        // it'll show as the label when nothing is selected.
        if (!child.value && Array.from(select.children).indexOf(child) === 0) return;
        inst.panel.appendChild(buildOptionEl(child, inst));
        any = true;
      }
    });

    // Empty placeholder (used both when there are no options at all and
    // when a search filter matches nothing).
    const empty = document.createElement('div');
    empty.className = 'dropdown__empty';
    empty.textContent = any ? 'אין תוצאות' : '— אין פריטים —';
    if (any) empty.hidden = true;
    inst.panel.appendChild(empty);
    inst.emptyEl = empty;

    updateLabel(inst);
  }

  // Filter visible .dropdown__option rows (and their group labels) by a
  // case-insensitive substring match against the rendered text.
  function filterOptions(inst, query) {
    const q = String(query || '').trim().toLowerCase();
    let visibleCount = 0;
    inst.panel.querySelectorAll('.dropdown__option').forEach(el => {
      const matches = !q || el.textContent.toLowerCase().includes(q);
      el.hidden = !matches;
      if (matches) visibleCount++;
    });
    // Hide group labels whose options have all been filtered out.
    inst.panel.querySelectorAll('.dropdown__group-label').forEach(label => {
      let n = label.nextElementSibling, has = false;
      while (n && !n.classList.contains('dropdown__group-label')) {
        if (n.classList.contains('dropdown__option') && !n.hidden) { has = true; break; }
        n = n.nextElementSibling;
      }
      label.hidden = !has;
    });
    if (inst.emptyEl) inst.emptyEl.hidden = visibleCount > 0;
    // Keep position glued to the trigger after the panel height changes.
    if (openInstance === inst) positionPanel(inst);
  }

  function buildOptionEl(opt, inst) {
    const el = document.createElement('div');
    el.className = 'dropdown__option' + (opt.value === inst.select.value ? ' is-selected' : '');
    el.dataset.value = opt.value;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', opt.value === inst.select.value ? 'true' : 'false');
    // Detect "name · meta" pattern (used in WhatsApp contacts list) and split visually.
    const txt = opt.textContent || '';
    const meta = opt.dataset?.meta;
    if (meta) {
      el.innerHTML = `<span>${escapeHtml(txt)}</span><span class="dropdown__option-meta">${escapeHtml(meta)}</span>`;
    } else {
      el.textContent = txt;
    }
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      inst.select.value = opt.value;
      inst.select.dispatchEvent(new Event('change', { bubbles: true }));
      updateLabel(inst);
      close(inst);
    });
    return el;
  }

  function updateLabel(inst) {
    const label = inst.trigger.querySelector('.dropdown__label');
    const opt = inst.select.options[inst.select.selectedIndex];
    if (opt && opt.value) {
      label.textContent = opt.textContent;
      label.classList.remove('dropdown__label--placeholder');
    } else {
      label.textContent = (inst.select.options[0]?.textContent || '— בחר —');
      label.classList.add('dropdown__label--placeholder');
    }
    inst.panel.querySelectorAll('.dropdown__option').forEach(el => {
      const sel = el.dataset.value === inst.select.value;
      el.classList.toggle('is-selected', sel);
      el.setAttribute('aria-selected', sel ? 'true' : 'false');
    });
  }

  function open(inst) {
    if (openInstance && openInstance !== inst) close(openInstance);
    inst.wrapper.classList.add('is-open');
    inst.panel.classList.add('is-open');
    inst.trigger.setAttribute('aria-expanded', 'true');
    openInstance = inst;
    positionPanel(inst);
    // Auto-focus the in-panel search if present, so the user can start
    // typing immediately.
    if (inst.searchInput) {
      setTimeout(() => inst.searchInput.focus({ preventScroll: true }), 0);
    }
  }
  function close(inst) {
    inst.wrapper.classList.remove('is-open');
    inst.panel.classList.remove('is-open');
    inst.trigger.setAttribute('aria-expanded', 'false');
    if (openInstance === inst) openInstance = null;
    // Reset filter so the next open starts clean.
    if (inst.searchInput && inst.searchInput.value) {
      inst.searchInput.value = '';
      filterOptions(inst, '');
    }
  }
  function isOpen(inst) { return inst.wrapper.classList.contains('is-open'); }

  // Tear down an enhanced select. Used when modal content is replaced.
  function destroy(select) {
    const inst = instances.get(select);
    if (!inst) return;
    if (openInstance === inst) openInstance = null;
    inst.panel.remove();
    instances.delete(select);
  }

  function positionPanel(inst) {
    const rect = inst.trigger.getBoundingClientRect();
    const panel = inst.panel;
    const margin = 12;
    const gap = 6;

    // Match trigger width exactly, anchored to its left edge.
    panel.style.width = `${rect.width}px`;
    panel.style.left = `${rect.left}px`;

    // Always open below the trigger.
    panel.style.top = `${rect.bottom + gap}px`;
    panel.style.transformOrigin = 'top center';

    // Cap height to the space remaining below, so the panel always fits
    // inside the viewport (it scrolls internally when content is taller).
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    panel.style.maxHeight = `${Math.max(120, Math.min(320, spaceBelow))}px`;
  }

  // Global click-outside + Esc handlers (set once)
  document.addEventListener('click', (e) => {
    if (openInstance &&
        !openInstance.wrapper.contains(e.target) &&
        !openInstance.panel.contains(e.target)) {
      close(openInstance);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openInstance) {
      close(openInstance);
      openInstance.trigger.focus();
    }
  });
  // Reposition on scroll/resize while open. Capture: true catches scroll
  // events on inner containers (e.g. .views) too.
  window.addEventListener('scroll', () => {
    if (openInstance) positionPanel(openInstance);
  }, true);
  window.addEventListener('resize', () => {
    if (openInstance) positionPanel(openInstance);
  });

  return { enhance, rebuild, destroy };
})();


const Theme = {
  apply(t) {
    document.documentElement.dataset.theme = t;
    State.theme = t;
    Storage.save({ theme: t });
    $$('[data-theme]').forEach(b => b.classList.toggle('is-active', b.dataset.theme === t));
  },
  toggle() { Theme.apply(State.theme === 'dark' ? 'light' : 'dark'); }
};

// ============================================================
// 6. ROUTER
// ============================================================
const PAGE_META = {
  dashboard: { title: 'לוח בקרה',     sub: 'סקירת פעילות בזמן אמת' },
  send:      { title: 'שליחת הודעה',  sub: 'הזן נמען, חבר קובץ ושלח' },
  logs:      { title: 'לוגים',        sub: 'היסטוריית כל ההודעות' },
  settings:  { title: 'הגדרות',       sub: 'חיבור, אינטגרציות והעדפות' }
};
const Router = {
  go(route) {
    if (!PAGE_META[route]) return;
    State.route = route;
    $$('[data-view]').forEach(v => v.classList.toggle('is-active', v.dataset.view === route));
    $$('.nav__item[data-route]').forEach(b => b.classList.toggle('is-active', b.dataset.route === route));
    $('#pageTitle').textContent = PAGE_META[route].title;
    $('#pageSub').textContent = PAGE_META[route].sub;
    if (route === 'dashboard') Dashboard.render();
    if (route === 'logs')      Logs.render();
    if (route === 'settings')  Settings.render();
    if (route === 'send')      { Send.refreshContacts(); Send.refreshSchedules(); }
  }
};

// ============================================================
// 7. API CLIENT
// ============================================================
const Api = {
  base() { return State.backendUrl.replace(/\/+$/, ''); },
  hasBackend() { return Boolean(State.backendUrl); },

  async _fetch(path, opts = {}, ms = 6000) {
    if (!Api.hasBackend()) throw new Error('NO_BACKEND');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(Api.base() + path, { ...opts, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  },

  async status() {
    if (!Api.hasBackend()) return { connected: false, qr: null, demo: true };
    return Api._fetch('/api/status');
  },

  async send(payload) {
    if (!Api.hasBackend()) {
      // Demo: fake latency, then 92% success
      await sleep(700 + Math.random() * 800);
      if (Math.random() > 0.92) throw new Error('DEMO_FAIL');
      return { success: true, messageId: uid(), demo: true };
    }
    return Api._fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, 20000);
  },

  async getLogs() {
    if (!Api.hasBackend()) return null;
    try { return await Api._fetch('/api/logs'); }
    catch { return null; }
  }
};

// ============================================================
// 9. DEMO DATA — used when no backend is configured
// ============================================================
function seedDemo() {
  if (State.backendUrl) return;        // ← real backend = no fake data, ever
  if (State.logs.length > 0) return;
  const samples = [
    { p: '972501234567', m: 'שלום, ההזמנה שלך אושרה. זמן אספקה משוער: 3 ימי עסקים.' },
    { p: '972527766554', m: 'תזכורת: פגישה מחר ב־10:00. נשמח אם תאשר את הגעתך.' },
    { p: '972546677889', m: 'חשבונית מס׳ 2027 נשלחה לכתובת המייל. תודה שאתה בוחר בנו.' },
    { p: '972585432198', m: 'הצעת מחיר לשירותי השיפוץ מצורפת בקובץ ה־PDF. נשמח לשמוע מחשבות.' },
    { p: '972549988776', m: 'ערב טוב, הסטטוס של הבקשה שלך עודכן ל"בטיפול". נעדכן בהמשך.' },
    { p: '972526655443', m: 'הקליניקה תהיה סגורה ביום שני בגלל חג. נחזור לפעילות סדירה ביום שלישי.' },
    { p: '972503344556', m: 'חבילה מוכנה לאיסוף בסניף. שעות פתיחה: 9:00–19:00.' },
    { p: '972587766445', m: 'תודה על התשלום. הקבלה נשלחה אליך לאימייל.' }
  ];
  const now = Date.now();
  const logs = [];
  for (let d = 13; d >= 0; d--) {
    const dayBase = now - d * 86400000;
    const count = 6 + Math.floor(Math.random() * 22);
    for (let i = 0; i < count; i++) {
      const s = samples[(d * 7 + i) % samples.length];
      const r = Math.random();
      const status = r > 0.94 ? 'error' : (r > 0.91 && d <= 1 ? 'pending' : 'success');
      logs.push({
        id: uid(),
        ts: dayBase - Math.floor(Math.random() * 86400000 * 0.9),
        phone: s.p,
        message: s.m,
        attachment: Math.random() > 0.7 ? (Math.random() > 0.5 ? 'PDF' : 'IMG') : null,
        status,
        duration: 200 + Math.floor(Math.random() * 1800)
      });
    }
  }
  logs.sort((a, b) => b.ts - a.ts);
  State.logs = logs;
  saveLogs();
}
function saveLogs() {
  // keep storage tight
  Storage.save({ logs: State.logs.slice(0, 500) });
}

// ============================================================
// 10. CHART ENGINE — Bloomberg-style SVG area chart
// ============================================================
const Chart = {
  buildSeries(days = 14) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const sentByDay = new Array(days).fill(0);
    const failByDay = new Array(days).fill(0);
    State.logs.forEach(l => {
      const d = new Date(l.ts); d.setHours(0, 0, 0, 0);
      const diff = Math.round((now - d) / 86400000);
      if (diff >= 0 && diff < days) {
        if (l.status === 'success') sentByDay[days - 1 - diff]++;
        else if (l.status === 'error') failByDay[days - 1 - diff]++;
      }
    });
    return { sent: sentByDay, fail: failByDay, days };
  },

  renderMain(svg, range = 14) {
    const W = svg.clientWidth || 640;
    const H = svg.clientHeight || 280;
    const padL = 40, padR = 20, padT = 16, padB = 30;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const { sent, fail, days } = Chart.buildSeries(range);
    const max = Math.max(10, ...sent, ...fail) * 1.15;
    const x = i => padL + (i / (days - 1)) * innerW;
    const y = v => padT + innerH - (v / max) * innerH;

    const line = arr => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
    const area = arr => `${line(arr)} L${x(arr.length - 1)},${padT + innerH} L${padL},${padT + innerH} Z`;

    // y-axis ticks
    const tickCount = 4;
    const ticks = [];
    for (let i = 0; i <= tickCount; i++) {
      const v = Math.round((max / tickCount) * i);
      ticks.push({ v, y: y(v) });
    }
    // x-axis labels (every Nth)
    const skip = days <= 14 ? 2 : days <= 30 ? 5 : 14;
    const today = new Date(); today.setHours(0, 0, 0, 0);

    let html = `
      <defs>
        <linearGradient id="areaSent" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--accent)" stop-opacity="0.32"/>
          <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="areaFail" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--error)" stop-opacity="0.18"/>
          <stop offset="1" stop-color="var(--error)" stop-opacity="0"/>
        </linearGradient>
      </defs>
    `;

    // grid
    ticks.forEach(t => {
      html += `<line x1="${padL}" x2="${W - padR}" y1="${t.y}" y2="${t.y}" stroke="var(--grid-line)" stroke-width="1"/>`;
      html += `<text x="${padL - 8}" y="${t.y + 3}" text-anchor="end" font-size="10" fill="var(--text-dim)" font-family="JetBrains Mono">${t.v}</text>`;
    });

    // areas + lines
    html += `<path d="${area(fail)}" fill="url(#areaFail)"/>`;
    html += `<path d="${line(fail)}" fill="none" stroke="var(--error)" stroke-width="1.5" stroke-linejoin="round" stroke-dasharray="3 3" opacity="0.85"/>`;
    html += `<path d="${area(sent)}" fill="url(#areaSent)"/>`;
    html += `<path d="${line(sent)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

    // dots on last point
    html += `<circle cx="${x(days - 1)}" cy="${y(sent[days - 1])}" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
    html += `<circle cx="${x(days - 1)}" cy="${y(sent[days - 1])}" r="11" fill="var(--accent)" opacity="0.15"/>`;

    // x labels
    for (let i = 0; i < days; i += skip) {
      const d = new Date(today.getTime() - (days - 1 - i) * 86400000);
      const label = d.toLocaleDateString('he-IL', { day: '2-digit', month: 'short' });
      html += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--text-dim)" font-family="JetBrains Mono">${label}</text>`;
    }

    // hover layer
    html += `<g id="chartHover" style="display:none">
      <line id="hLine" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="2 3"/>
      <circle id="hDot" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
      <g id="hTip"></g>
    </g>`;
    // overlay rects for hover detection
    for (let i = 0; i < days; i++) {
      const cx = x(i);
      const stepW = innerW / (days - 1);
      html += `<rect x="${cx - stepW / 2}" y="${padT}" width="${stepW}" height="${innerH}" fill="transparent" data-idx="${i}" class="chart-hit"/>`;
    }

    svg.innerHTML = html;

    // hover handler
    const hover = svg.querySelector('#chartHover');
    const hLine = svg.querySelector('#hLine');
    const hDot  = svg.querySelector('#hDot');
    const hTip  = svg.querySelector('#hTip');
    svg.querySelectorAll('.chart-hit').forEach(rect => {
      rect.addEventListener('mouseenter', e => {
        const i = +e.target.dataset.idx;
        const cx = x(i), cy = y(sent[i]);
        hLine.setAttribute('x1', cx); hLine.setAttribute('x2', cx);
        hLine.setAttribute('y1', padT); hLine.setAttribute('y2', padT + innerH);
        hDot.setAttribute('cx', cx); hDot.setAttribute('cy', cy);
        const d = new Date(today.getTime() - (days - 1 - i) * 86400000);
        const dateLabel = d.toLocaleDateString('he-IL', { day: '2-digit', month: 'short' });
        const TIP_W = 140, TIP_H = 70;
        const tipX = Math.min(W - padR - TIP_W, Math.max(padL, cx - TIP_W / 2));
        const tipY = Math.max(padT + 6, cy - TIP_H - 12);
        hTip.innerHTML = `
          <foreignObject x="${tipX}" y="${tipY}" width="${TIP_W}" height="${TIP_H}">
            <div xmlns="http://www.w3.org/1999/xhtml" class="chart-tip">
              <div class="chart-tip__date">${dateLabel}</div>
              <div class="chart-tip__row chart-tip__row--ok">
                <span class="chart-tip__num">${sent[i]}</span>
                <span class="chart-tip__lbl">נשלחו</span>
              </div>
              <div class="chart-tip__row chart-tip__row--err">
                <span class="chart-tip__num">${fail[i]}</span>
                <span class="chart-tip__lbl">נכשלו</span>
              </div>
            </div>
          </foreignObject>
        `;
        hover.style.display = '';
      });
      rect.addEventListener('mouseleave', () => { hover.style.display = 'none'; });
    });
  },

  renderSpark(el, data) {
    const W = 78, H = 28, pad = 2;
    const max = Math.max(1, ...data);
    const x = i => pad + (i / (data.length - 1)) * (W - pad * 2);
    const y = v => pad + (H - pad * 2) - (v / max) * (H - pad * 2);
    const path = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
    const area = `${path} L${x(data.length - 1)},${H - pad} L${pad},${H - pad} Z`;
    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}">
        <defs>
          <linearGradient id="sg-${uid()}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--accent)" stop-opacity="0.4"/>
            <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#sg-${el.dataset.spark})"/>
        <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
    `;
    // unique gradient ids
    const grad = el.querySelector('linearGradient');
    const gid = `sg-${el.dataset.spark}-${Math.floor(Math.random() * 1e6)}`;
    grad.id = gid;
    el.querySelector('path[fill^="url"]').setAttribute('fill', `url(#${gid})`);
  }
};

// ============================================================
// 11. DASHBOARD VIEW
// ============================================================
const Dashboard = {
  render() {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const today    = State.logs.filter(l => new Date(l.ts) >= now);
    const week     = State.logs.filter(l => Date.now() - l.ts <= 7 * 86400000);
    const total    = State.logs.length;
    const success  = State.logs.filter(l => l.status === 'success').length;
    const failed   = State.logs.filter(l => l.status === 'error').length;
    const pending  = State.logs.filter(l => l.status === 'pending').length;
    const successRate = total ? (success / total) * 100 : 0;

    $('[data-stat="today"]').textContent = fmt.num(today.length);
    $('[data-stat="week"]').textContent = fmt.num(week.length);
    $('[data-stat="success"]').textContent = successRate.toFixed(1);
    $('[data-stat="failed"]').textContent = fmt.num(failed);
    $('[data-stat="pending"]').textContent = fmt.num(pending);
    $('[data-stat="pendingTotal"]').textContent = `${fmt.num(pending)} ממתינות`;
    const logsBadge = $('[data-stat="logsCount"]');
    logsBadge.textContent = fmt.num(total);
    logsBadge.dataset.empty = total ? '0' : '1';
    const fill = $('[data-bar="success"]');
    if (fill) fill.style.width = `${successRate.toFixed(1)}%`;

    // sparklines
    const { sent } = Chart.buildSeries(14);
    const todaySpark = $('[data-spark="today"]');
    const weekSpark  = $('[data-spark="week"]');
    if (todaySpark) Chart.renderSpark(todaySpark, sent.slice(-7));
    if (weekSpark)  Chart.renderSpark(weekSpark, sent);

    // chart
    requestAnimationFrame(() => {
      const svg = $('#mainChart');
      if (svg) Chart.renderMain(svg, State.chartRange);
    });

    // feed
    const feed = $('#recentFeed');
    const recent = State.logs.slice(0, 5);
    if (!recent.length) {
      feed.innerHTML = `<li class="feed__empty">אין פעילות עדיין</li>`;
    } else {
      feed.innerHTML = recent.map(l => {
        const info = resolveContactInfo(l.phone);
        const cls = l.status === 'success' ? 'pill--success' : l.status === 'error' ? 'pill--error' : 'pill--pending';
        const txt = l.status === 'success' ? 'נשלח' : l.status === 'error' ? 'נכשל' : 'ממתין';
        const sub = info.isGroup
          ? `<span class="feed__sub-icon" title="קבוצה"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 7a2 2 0 100-4 2 2 0 000 4zm0 1c-2.2 0-4 1.3-4 3v1h8v-1c0-1.7-1.8-3-4-3zm5-1a2 2 0 100-4 2 2 0 000 4zm.5 1c-.4 0-.8 0-1.2.1.7.7 1.2 1.7 1.2 2.9V12h4v-1c0-1.7-1.8-3-4-3z"/></svg></span> ${escapeHtml(info.sub)}`
          : escapeHtml(info.sub || '');
        // While the directory is still loading, show shimmer skeletons in
        // place of the (currently-fallback) name + sub.
        const nameHTML = info.loading
          ? `<span class="skel skel--name"></span>`
          : escapeHtml(info.name);
        const subHTML = info.loading
          ? `<span class="skel skel--sub"></span>`
          : sub;
        const avatarHTML = info.loading
          ? `<div class="feed__avatar feed__avatar--placeholder feed__avatar--loading"></div>`
          : `<div class="feed__avatar feed__avatar--placeholder">${escapeHtml(info.initials)}</div>`;
        return `<li class="feed__item" data-chatid="${info.chatId || ''}">
          ${avatarHTML}
          <div class="feed__main">
            <div class="feed__top">
              <div class="feed__id-block">
                <div class="feed__name">${nameHTML}</div>
                <div class="feed__sub">${subHTML}</div>
              </div>
            </div>
          </div>
          <div class="feed__meta">
            <span class="pill ${cls}"><span class="dot"></span>${txt}</span>
            <div class="feed__time">${fmt.full(l.ts)}</div>
          </div>
          <div class="feed__msg">${escapeHtml(l.message)}</div>
        </li>`;
      }).join('');

      // Lazy-load profile pictures for visible feed items.
      $$('#recentFeed .feed__item').forEach(async (li) => {
        const chatId = li.dataset.chatid;
        if (!chatId) return;
        const url = await ProfilePics.get(chatId);
        if (!url) return;
        const av = li.querySelector('.feed__avatar');
        if (!av) return;
        av.classList.remove('feed__avatar--placeholder');
        av.innerHTML = `<img src="${url}" alt="" loading="lazy" onerror="this.parentNode.classList.add('feed__avatar--placeholder');this.parentNode.innerHTML=this.parentNode.dataset.fallback||'';">`;
        av.dataset.fallback = escapeHtml(li.querySelector('.feed__name')?.textContent.slice(0, 2) || '?');
      });
    }

    // health
    $('#healthBackend').textContent = State.backendUrl ? (State.connected ? 'מחובר' : 'מוגדר') : 'לא מוגדר';
    $('#healthBackend').style.color = State.backendUrl ? (State.connected ? 'var(--accent)' : 'var(--warn)') : 'var(--text-muted)';
    $('#healthWA').textContent = State.connected ? 'מחובר' : 'לא מחובר';
    $('#healthWA').style.color = State.connected ? 'var(--accent)' : 'var(--text-muted)';
    const sched = $('#healthSchedules');
    if (sched) {
      const s = State.scheduleStats;
      if (!s || (s.recurring + s.scheduled) === 0) {
        sched.textContent = '—';
      } else {
        const parts = [];
        if (s.recurring) parts.push(`${s.recurring} חוזר${s.recurring > 1 ? 'ים' : ''}`);
        if (s.scheduled) parts.push(`${s.scheduled} בתור`);
        sched.textContent = parts.join(' · ');
      }
    }
  }
};

// ============================================================
// 12. SEND VIEW
// ============================================================
const Send = {
  init() {
    const phone = $('#phoneInput');
    const msg   = $('#messageInput');
    const src   = $('#sourceSelect');
    const cs    = $('#contactsSelect');
    const dz    = $('#dropzone');
    const fi    = $('#fileInput');

    const updatePreview = () => {
      const p = phone.value.trim();
      const m = msg.value.trim();
      const nameEl = $('#previewName');
      const idEl   = $('#previewId');
      const avEl   = $('#previewAvatar');
      if (p) {
        const info = resolveContactInfo(p);
        nameEl.textContent = info.name;
        // Show the underlying chat-id/phone, but trimmed if it's a long
        // group id so the row stays compact.
        const isGroup = /@g\.us$/.test(p);
        idEl.textContent = isGroup ? p.replace('@g.us', '') : (fmt.phone(p) || p);
        avEl.textContent = info.initials;
      } else {
        nameEl.textContent = 'בחר נמען';
        idEl.textContent = '';
        avEl.textContent = '·';
      }
      $('#previewText').textContent = m || 'ההודעה תופיע כאן…';
      $('#previewTime').textContent = fmt.time(Date.now());
      $('#charCount').textContent = `${m.length} תווים`;
      // attachment preview
      const at = $('#previewAttach');
      if (State.pendingFile) {
        at.classList.remove('hidden');
        if (State.pendingFile.preview) {
          at.innerHTML = `<img src="${State.pendingFile.preview}" alt=""/>`;
        } else {
          at.innerHTML = `<svg width="14" height="14"><use href="#i-${State.pendingFile.kind === 'pdf' ? 'pdf' : 'file'}"/></svg><span>${escapeHtml(State.pendingFile.name)}</span>`;
        }
      } else {
        at.classList.add('hidden');
        at.innerHTML = '';
      }
    };

    phone.addEventListener('input', updatePreview);
    msg.addEventListener('input', updatePreview);

    // template chips
    const TEMPLATES = {
      hello:    'שלום! מה שלומך? אשמח לדעת איך אפשר לעזור.',
      reminder: 'שלום, זוהי תזכורת ידידותית עבור התשלום שטרם הוסדר. אנא אשר ביצוע בהקדם.',
      meeting:  'מאשר את הפגישה שתואמה למחר ב־10:00. נתראה!'
    };
    $$('[data-tpl]').forEach(b => b.addEventListener('click', () => {
      msg.value = TEMPLATES[b.dataset.tpl];
      updatePreview();
      msg.focus();
    }));

    // source toggle (manual ↔ whatsapp)
    src.addEventListener('change', () => {
      Send.applySource();
    });
    cs.addEventListener('change', () => {
      const v = cs.value;
      if (!v) return;
      // value is either a phone (contact) or a chat id (group, ends @g.us)
      phone.value = v;
      updatePreview();
    });

    // dropzone
    $('#filePickBtn').addEventListener('click', () => fi.click());
    fi.addEventListener('change', e => Send.attachFile(e.target.files[0]));
    ;['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault(); dz.classList.add('is-drag');
    }));
    ;['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault(); dz.classList.remove('is-drag');
    }));
    dz.addEventListener('drop', e => Send.attachFile(e.dataTransfer.files[0]));
    $('#fileRemove').addEventListener('click', () => Send.clearFile());

    // schedule
    $('#clearSchedule').addEventListener('click', () => $('#scheduleInput').value = '');

    // actions
    $('#resetBtn').addEventListener('click', () => Send.reset());
    $('#sendBtn').addEventListener('click', () => Send.send());

    Send.bindScheduleActions();
    updatePreview();
  },

  refreshContacts() {
    const src = $('#sourceSelect').value;
    const cs = $('#contactsSelect');
    if (src !== 'whatsapp') return;

    const opts = ['<option value="">— בחר —</option>'];
    if (State.waGroups?.length) {
      opts.push('<optgroup label="קבוצות">');
      State.waGroups.forEach(g => {
        opts.push(`<option value="${escapeHtml(g.id)}" data-meta="${g.participants} חברים">${escapeHtml(g.name)}</option>`);
      });
      opts.push('</optgroup>');
    }
    if (State.waContacts?.length) {
      opts.push('<optgroup label="אנשי קשר">');
      State.waContacts.forEach(c => {
        opts.push(`<option value="${escapeHtml(c.phone)}" data-meta="${escapeHtml(fmt.phone(c.phone))}">${escapeHtml(c.name)}</option>`);
      });
      opts.push('</optgroup>');
    }
    cs.innerHTML = opts.join('');
  },

  applySource() {
    const src = $('#sourceSelect').value;
    const cs = $('#contactsSelect');
    const csWrap = cs.closest('.dropdown') || cs;
    const phone = $('#phoneInput');
    const hint = $('#phoneHint');

    if (src === 'manual') {
      csWrap.classList.add('hidden');
      phone.classList.remove('hidden');
      phone.placeholder = '972501234567';
      if (hint) hint.textContent = 'פורמט בינלאומי בלבד · ללא + או 0 בהתחלה';
      return;
    }

    csWrap.classList.remove('hidden');
    phone.classList.add('hidden');
    Send.refreshContacts();

    if (src === 'whatsapp') {
      if (hint) hint.textContent = 'בחירה מאנשי קשר/קבוצות שמקושרים לחשבון WhatsApp שלך';
      // Lazy-load if list isn't ready yet
      if (!State.waContacts.length && !State.waGroups.length && State.connected) {
        Send.loadWhatsAppDirectory().then(() => Send.refreshContacts());
      }
    }
  },

  async loadWhatsAppDirectory() {
    if (!State.backendUrl) return null;
    State.waLoading = true;
    try {
      const base = State.backendUrl.replace(/\/+$/, '');
      const [contactsRes, groupsRes] = await Promise.all([
        fetch(base + '/api/contacts?limit=2000').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(base + '/api/groups?limit=500').then(r => r.ok ? r.json() : null).catch(() => null)
      ]);
      State.waContacts = contactsRes?.contacts || [];
      State.waGroups   = groupsRes?.groups   || [];
      return { contacts: State.waContacts.length, groups: State.waGroups.length };
    } catch {
      return null;
    } finally {
      State.waLoading = false;
      // Mark as "finished trying" even on failure — otherwise resolveContactInfo
      // returns loading:true forever and the UI is stuck on shimmer skeletons.
      State.waLoaded   = true;
      if (State.route === 'dashboard') Dashboard.render();
      if (State.route === 'logs') Logs.render();
    }
  },

  async refreshSchedules() {
    if (!State.backendUrl) {
      Send.renderSchedules({ recurring: [], scheduled: [] });
      return;
    }
    const base = State.backendUrl.replace(/\/+$/, '');
    try {
      const [recurRes, schedRes] = await Promise.all([
        fetch(base + '/api/recurring?limit=200').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(base + '/api/schedule?status=pending&limit=200').then(r => r.ok ? r.json() : null).catch(() => null)
      ]);
      Send.renderSchedules({
        recurring: recurRes?.recurring || [],
        scheduled: schedRes?.scheduled || []
      });
    } catch (e) {
      console.error('[schedules] refresh failed:', e);
    }
  },

  renderSchedules({ recurring, scheduled }) {
    const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

    // For weekly/monthly, derive the specific day from the schedule's
    // anchor (startAt). Falls back to the generic label.
    const describeFrequency = (frequency, startAt) => {
      if (frequency === 'hourly') return 'מדי שעה';
      if (frequency === 'daily')  return 'כל יום';
      if (!startAt) {
        return frequency === 'weekly' ? 'מדי שבוע' :
               frequency === 'monthly' ? 'מדי חודש' : frequency;
      }
      const d = new Date(startAt);
      if (isNaN(d.getTime())) return frequency;
      if (frequency === 'weekly')  return `כל יום ${HEB_DAYS[d.getDay()]}`;
      if (frequency === 'monthly') return `כל ה־${d.getDate()} בחודש`;
      return frequency;
    };

    // Build the recipient chip — for a group, show its name; for a contact,
    // show its formatted phone.
    const recipientChip = (phone) => {
      if (/@g\.us$/.test(phone)) {
        const info = resolveContactInfo(phone);
        return `<span class="pill pill--group" title="${escapeHtml(info.name)}">
          <svg class="ico"><use href="#i-people"/></svg>
          <span class="pill__name">${escapeHtml(info.name)}</span>
        </span>`;
      }
      return `<span class="sched-item__phone">${escapeHtml(fmt.phone(phone))}</span>`;
    };

    // Build the file chip — show type prefix + filename.
    const fileChip = (url) => {
      const f = fmt.file(url);
      if (!f) return '';
      return `<span class="pill pill--file" title="${escapeHtml(f.name)}">
        <svg class="ico"><use href="#i-paperclip"/></svg>
        <span class="pill__type">${escapeHtml(f.type)}</span>
        <span class="pill__name">${escapeHtml(f.name)}</span>
      </span>`;
    };

    // -- Recurring
    const rl = $('#recurringList');
    const rc = $('#recurringCount');
    const activeRecur = recurring.filter(r => r.active);
    if (rc) rc.textContent = activeRecur.length;
    if (rl) {
      if (!recurring.length) {
        rl.innerHTML = '<div class="empty empty--sm">אין תזמונים חוזרים פעילים</div>';
      } else {
        rl.innerHTML = recurring.map(r => {
          const next = r.nextRunAt ? fmt.full(new Date(r.nextRunAt)) : '—';
          return `<div class="sched-item ${r.active ? '' : 'sched-item--paused'}">
            <div class="sched-item__icon"><svg width="14" height="14"><use href="#i-clock"/></svg></div>
            <div class="sched-item__main">
              <div class="sched-item__line1">
                ${recipientChip(r.phone)}
                <span class="sched-item__freq">${describeFrequency(r.frequency, r.startAt)}</span>
                ${fileChip(r.fileUrl)}
              </div>
              <div class="sched-item__msg">${escapeHtml(r.message || '')}</div>
              <div class="sched-item__meta">הבא: ${next} · רץ ${r.runsCount || 0} פעמים</div>
            </div>
            <div class="sched-item__actions">
              <button class="icon-btn icon-btn--sm" data-action="edit-recurring" data-id="${r.id}" title="ערוך">
                <svg class="ico ico--sm"><use href="#i-edit"/></svg>
              </button>
              <button class="icon-btn icon-btn--sm" data-action="toggle-recurring" data-id="${r.id}" data-active="${r.active ? 1 : 0}" title="${r.active ? 'השהה' : 'הפעל'}">
                <svg class="ico ico--sm"><use href="#i-${r.active ? 'clock' : 'check'}"/></svg>
              </button>
              <button class="icon-btn icon-btn--sm" data-action="delete-recurring" data-id="${r.id}" title="מחק">
                <svg class="ico ico--sm"><use href="#i-trash"/></svg>
              </button>
            </div>
          </div>`;
        }).join('');
      }
    }

    // -- One-shot scheduled
    const sl = $('#scheduledList');
    const sc = $('#scheduledCount');
    if (sc) sc.textContent = scheduled.length;
    if (sl) {
      if (!scheduled.length) {
        sl.innerHTML = '<div class="empty empty--sm">אין הודעות חד־פעמיות בתור</div>';
      } else {
        sl.innerHTML = scheduled.map(s => {
          const at = s.sendAt ? fmt.full(new Date(s.sendAt)) : '—';
          return `<div class="sched-item">
            <div class="sched-item__icon sched-item__icon--copper"><svg width="14" height="14"><use href="#i-clock"/></svg></div>
            <div class="sched-item__main">
              <div class="sched-item__line1">
                ${recipientChip(s.phone)}
                <span class="sched-item__freq">חד־פעמי</span>
                ${fileChip(s.fileUrl)}
              </div>
              <div class="sched-item__msg">${escapeHtml(s.message || '')}</div>
              <div class="sched-item__meta">${at}</div>
            </div>
            <div class="sched-item__actions">
              <button class="icon-btn icon-btn--sm" data-action="edit-scheduled" data-id="${s.id}" title="ערוך">
                <svg class="ico ico--sm"><use href="#i-edit"/></svg>
              </button>
              <button class="icon-btn icon-btn--sm" data-action="cancel-scheduled" data-id="${s.id}" title="בטל">
                <svg class="ico ico--sm"><use href="#i-x"/></svg>
              </button>
            </div>
          </div>`;
        }).join('');
      }
    }
  },

  bindScheduleActions() {
    const card = $('#schedulesCard');
    if (!card || card.dataset.bound) return;
    card.dataset.bound = '1';
    card.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const base = State.backendUrl.replace(/\/+$/, '');
      try {
        if (action === 'toggle-recurring') {
          const wasActive = btn.dataset.active === '1';
          const r = await fetch(`${base}/api/recurring/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active: !wasActive })
          });
          if (r.ok) Toast.show(wasActive ? 'תזמון הושהה' : 'תזמון הופעל', 'info');
        } else if (action === 'delete-recurring') {
          if (!confirm('למחוק את התזמון החוזר?')) return;
          const r = await fetch(`${base}/api/recurring/${id}`, { method: 'DELETE' });
          if (r.ok) Toast.show('תזמון נמחק', 'info');
        } else if (action === 'cancel-scheduled') {
          if (!confirm('לבטל את ההודעה המתוזמנת?')) return;
          const r = await fetch(`${base}/api/schedule/${id}`, { method: 'DELETE' });
          if (r.ok) Toast.show('בוטל', 'info');
        } else if (action === 'edit-recurring' || action === 'edit-scheduled') {
          await ScheduleEditor.open(action === 'edit-recurring' ? 'recurring' : 'scheduled', +id);
          return;  // refresh handled inside editor on save
        }
        Send.refreshSchedules();
      } catch (err) {
        Toast.show('הפעולה נכשלה: ' + err.message, 'error');
      }
    });
    $('#refreshSchedules')?.addEventListener('click', () => Send.refreshSchedules());
    $('#exportSchedules')?.addEventListener('click', () => Backup.export());
    $('#importSchedules')?.addEventListener('click', () => $('#importFileInput').click());
    $('#importFileInput')?.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) Backup.import(f);
      e.target.value = '';   // allow re-importing the same file
    });
  },

  attachFile(file) {
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      Toast.show('הקובץ גדול מ־16MB. וואטסאפ לא יקבל אותו.', 'error');
      return;
    }
    const ext = file.name.split('.').pop().toLowerCase();
    const isImg = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf' || ext === 'pdf';
    const kind = isImg ? 'image' : isPdf ? 'pdf' : 'file';
    State.pendingFile = { name: file.name, size: file.size, kind, file, preview: null };

    if (isImg) {
      const reader = new FileReader();
      reader.onload = e => {
        State.pendingFile.preview = e.target.result;
        Send.renderFile();
      };
      reader.readAsDataURL(file);
    }
    Send.renderFile();
  },

  renderFile() {
    const f = State.pendingFile;
    const block = $('#dropzoneFile');
    const inner = $('#dropzone .dropzone__inner');
    if (!f) {
      block.classList.add('hidden');
      inner.style.display = '';
      return;
    }
    inner.style.display = 'none';
    block.classList.remove('hidden');
    $('#fileName').textContent = f.name;
    $('#fileSize').textContent = fmt.bytes(f.size);
    $('#filePreviewIcon').innerHTML = `<use href="#i-${f.kind === 'pdf' ? 'pdf' : f.kind === 'image' ? 'image' : 'file'}"/>`;
    // bubble preview
    const phone = $('#phoneInput');
    const msg = $('#messageInput');
    phone.dispatchEvent(new Event('input'));
  },

  clearFile() {
    State.pendingFile = null;
    $('#fileInput').value = '';
    Send.renderFile();
    $('#phoneInput').dispatchEvent(new Event('input'));
  },

  reset() {
    $('#phoneInput').value = '';
    $('#messageInput').value = '';
    $('#scheduleInput').value = '';
    const rf = $('#recurFreq'); if (rf) rf.value = 'once';
    Send.clearFile();
    setStatus('idle', 'מוכן לשליחה');
  },

  async uploadFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(State.backendUrl.replace(/\/+$/, '') + '/api/upload', {
      method: 'POST',
      body: fd
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.message || j.error || 'Upload failed');
    return j.url;     // "internal:/uploads/..."
  },

  async send() {
    const phone = $('#phoneInput').value.trim();
    const message = $('#messageInput').value.trim();
    const schedule = $('#scheduleInput').value;
    const recurFreq = $('#recurFreq')?.value || 'once';
    const file = State.pendingFile;

    // Accept either an international phone (digits) or a full chat-id
    // (e.g. "1203...@g.us" for groups, "972...@c.us" for contacts).
    const isPhone = /^\d{8,15}$/.test(phone);
    const isChatId = /@(c|g)\.us$/.test(phone);
    if (!phone || (!isPhone && !isChatId)) {
      Toast.show('מספר לא תקין. הזן בפורמט בינלאומי, או בחר נמען מהרשימה.', 'error');
      return;
    }
    if (!message && !file) {
      Toast.show('יש להזין הודעה או לצרף קובץ.', 'error');
      return;
    }

    setStatus('pending', 'מכין שליחה…');
    $('#sendBtn').setAttribute('disabled', 'true');

    // Upload the attachment to the backend BEFORE the send call so the
    // server-side WhatsApp client can read it from disk. In demo mode
    // we keep the data-URL preview around as a placeholder.
    let fileUrl = null;
    if (file) {
      try {
        if (State.backendUrl) {
          fileUrl = await Send.uploadFile(file.file);
        } else {
          fileUrl = file.preview || null;
        }
      } catch (e) {
        setStatus('error', 'העלאת הקובץ נכשלה');
        Toast.show('העלאת הקובץ נכשלה: ' + e.message, 'error');
        $('#sendBtn').removeAttribute('disabled');
        return;
      }
    }

    const attachment = file
      ? (file.kind === 'pdf' ? 'PDF' : file.kind === 'image' ? 'IMG' : 'FILE')
      : null;

    // Branch A — recurring schedule (server-side only)
    if (recurFreq !== 'once') {
      if (!State.backendUrl) {
        setStatus('error', 'תזמון חוזר דורש Backend');
        Toast.show('תזמון חוזר דורש שרת מחובר', 'error');
        $('#sendBtn').removeAttribute('disabled');
        return;
      }
      try {
        const startAt = schedule ? new Date(schedule).toISOString() : new Date().toISOString();
        console.log('[send] saving recurring:', { phone, frequency: recurFreq, startAt, hasFile: !!fileUrl });
        const r = await fetch(State.backendUrl.replace(/\/+$/, '') + '/api/recurring', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, message, fileUrl, frequency: recurFreq, startAt })
        });
        const j = await r.json();
        console.log('[send] recurring response:', j);
        if (!r.ok || !j.ok) throw new Error(j.message || j.error || 'שמירה נכשלה');
        const labels = { hourly: 'מדי שעה', daily: 'מדי יום', weekly: 'מדי שבוע', monthly: 'מדי חודש' };
        setStatus('success', `תזמון חוזר נשמר · ${labels[recurFreq]}`);
        Toast.show(`תזמון חוזר נשמר · ריצה ראשונה: ${fmt.full(new Date(j.nextRunAt))}`, 'success');
        Send.refreshSchedules();
        setTimeout(() => Send.reset(), 1500);
      } catch (e) {
        console.error('[send] recurring save failed:', e);
        setStatus('error', 'שמירת תזמון נכשלה — ' + e.message);
        Toast.show('שמירת תזמון נכשלה: ' + e.message, 'error');
        $('#sendBtn').removeAttribute('disabled');
      }
      return;
    }

    // Branch B — one-shot future schedule (delegate to backend if available)
    if (schedule) {
      const ts = new Date(schedule).getTime();
      if (State.backendUrl) {
        try {
          console.log('[send] scheduling one-shot:', { phone, ts, hasFile: !!fileUrl });
          const r = await fetch(State.backendUrl.replace(/\/+$/, '') + '/api/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, message, fileUrl, scheduleAt: new Date(ts).toISOString() })
          });
          const j = await r.json();
          console.log('[send] schedule response:', j);
          if (!r.ok || !j.ok) throw new Error(j.message || 'תזמון נכשל');
          setStatus('pending', `מתוזמן ל־${fmt.full(ts)}`);
          Toast.show(`הודעה מתוזמנת ל־${fmt.full(ts)}`, 'success');
          Send.refreshSchedules();
          Send.reset();
        } catch (e) {
          console.error('[send] schedule failed:', e);
          setStatus('error', 'תזמון נכשל — ' + e.message);
          Toast.show('תזמון נכשל: ' + e.message, 'error');
          $('#sendBtn').removeAttribute('disabled');
        }
      } else {
        State.logs.unshift({
          id: uid(), ts, phone, message, attachment,
          status: 'pending', duration: 0
        });
        saveLogs();
        setStatus('pending', `מתוזמן ל־${fmt.full(ts)}`);
        Toast.show(`הודעה מתוזמנת ל־${fmt.full(ts)}`, 'info');
        Send.reset();
      }
      return;
    }

    // Branch C — immediate send
    setStatus('pending', 'שולח…');

    const t0 = performance.now();
    try {
      const res = await Api.send({ phone, message, fileUrl });
      const dur = Math.round(performance.now() - t0);
      const log = {
        id: res.messageId || uid(),
        ts: Date.now(),
        phone, message, attachment,
        status: 'success',
        duration: dur
      };
      State.logs.unshift(log);
      saveLogs();
      setStatus('success', `נשלח בהצלחה · ${dur}ms`);
      Toast.show('ההודעה נשלחה בהצלחה', 'success');
      if (State.optSound) playBeep();
      setTimeout(() => Send.reset(), 1200);
    } catch (e) {
      const dur = Math.round(performance.now() - t0);
      State.logs.unshift({
        id: uid(),
        ts: Date.now(),
        phone, message, attachment,
        status: 'error',
        duration: dur,
        error: e.message
      });
      saveLogs();
      const reason = e.message === 'NO_BACKEND' ? 'לא מוגדר Backend' : 'השליחה נכשלה';
      setStatus('error', reason);
      Toast.show(reason, 'error');
    } finally {
      $('#sendBtn').removeAttribute('disabled');
      Dashboard.render();
    }
  }
};

function setStatus(kind, label) {
  const el = $('#sendStatus');
  el.className = `status-pill status-pill--${kind}`;
  el.querySelector('span:last-child').textContent = label;
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.start(); o.stop(ctx.currentTime + 0.26);
  } catch {}
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// 12b. SCHEDULE EDITOR — modal for editing one-shot or recurring
// ============================================================
const ScheduleEditor = (() => {
  let kind = null;        // 'recurring' | 'scheduled'
  let currentId = null;
  let currentItem = null;

  // Convert an ISO-ish string to the local YYYY-MM-DDTHH:mm format that
  // <input type="datetime-local"> expects.
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // And back — the input's value is naive local; reading via Date() treats
  // it as local already, which is what we want.
  function fromLocalInput(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  async function open(k, id) {
    if (!State.backendUrl) {
      Toast.show('Backend לא מוגדר', 'error');
      return;
    }
    kind = k;
    currentId = id;

    const base = State.backendUrl.replace(/\/+$/, '');
    try {
      // Make sure we have the WhatsApp directory loaded so the recipient
      // picker can render group names and contact names — falls back to
      // a "(ידני)" tag if the chat-id isn't in the directory.
      if (!State.waContacts.length && !State.waGroups.length && State.connected) {
        await Send.loadWhatsAppDirectory();
      }
      const list = kind === 'recurring'
        ? (await fetch(`${base}/api/recurring`).then(r => r.json())).recurring
        : (await fetch(`${base}/api/schedule`).then(r => r.json())).scheduled;
      currentItem = list.find(x => x.id === id);
      if (!currentItem) {
        Toast.show('לא נמצא', 'error');
        return;
      }
    } catch (e) {
      Toast.show('כשל בטעינת הפריט: ' + e.message, 'error');
      return;
    }

    renderForm();
    showModal();
  }

  // Build the recipient <select>. Tries to match the saved phone/chat-id
  // against State.waGroups / State.waContacts; if nothing matches we keep
  // the raw value as a "(ידני)" option so the user can still save without
  // surprises.
  function buildRecipientSelect(currentValue) {
    const groups   = State.waGroups   || [];
    const contacts = State.waContacts || [];

    const isGroupId = /@g\.us$/.test(currentValue);
    const matchInGroups   = groups.some(g => g.id === currentValue);
    const matchInContacts = contacts.some(c => c.phone === String(currentValue).replace('@c.us', ''));
    const isKnown = matchInGroups || matchInContacts;

    const opts = [];
    if (currentValue && !isKnown) {
      const display = isGroupId
        ? `קבוצה — ${currentValue.replace('@g.us', '').slice(0, 18)}…`
        : (fmt.phone(currentValue) || currentValue);
      opts.push(`<option value="${escapeHtml(currentValue)}" selected data-meta="ידני">${escapeHtml(display)}</option>`);
    }
    if (groups.length) {
      opts.push('<optgroup label="קבוצות">');
      groups.forEach(g => {
        const sel = g.id === currentValue ? ' selected' : '';
        opts.push(`<option value="${escapeHtml(g.id)}"${sel} data-meta="${g.participants} חברים">${escapeHtml(g.name)}</option>`);
      });
      opts.push('</optgroup>');
    }
    if (contacts.length) {
      opts.push('<optgroup label="אנשי קשר">');
      contacts.forEach(c => {
        const sel = (c.phone === String(currentValue).replace('@c.us', '')) ? ' selected' : '';
        opts.push(`<option value="${escapeHtml(c.phone)}"${sel} data-meta="${escapeHtml(fmt.phone(c.phone))}">${escapeHtml(c.name)}</option>`);
      });
      opts.push('</optgroup>');
    }
    if (!opts.length) {
      // Directory not loaded — fall back to a single read-only option.
      opts.push(`<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue)}</option>`);
    }
    return `<select id="modalPhone">${opts.join('')}</select>`;
  }

  function renderForm() {
    const it = currentItem;
    const FREQ_OPTIONS = [
      { v: 'hourly',  l: 'מדי שעה' },
      { v: 'daily',   l: 'מדי יום' },
      { v: 'weekly',  l: 'מדי שבוע' },
      { v: 'monthly', l: 'מדי חודש' }
    ];

    const fileBlock = it.fileUrl
      ? (() => {
          const f = fmt.file(it.fileUrl);
          return `<div class="modal__file" id="modalFile">
            <svg class="ico ico--sm"><use href="#i-paperclip"/></svg>
            <span class="pill__type">${escapeHtml(f.type)}</span>
            <span class="pill__name">${escapeHtml(f.name)}</span>
            <button class="icon-btn icon-btn--sm" id="modalFileRemove" title="הסר קובץ" type="button">
              <svg class="ico ico--sm"><use href="#i-x"/></svg>
            </button>
          </div>`;
        })()
      : '<div class="modal__file modal__file--empty">אין קובץ מצורף</div>';

    let timeBlock = '';
    if (kind === 'recurring') {
      timeBlock = `
        <div class="field__row" style="grid-template-columns: 1fr 1fr;">
          <div class="field">
            <label class="field__label">תדירות</label>
            <select id="modalFreq">
              ${FREQ_OPTIONS.map(o => `<option value="${o.v}" ${o.v === it.frequency ? 'selected' : ''}>${o.l}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field__label">מתאריך</label>
            <input type="datetime-local" id="modalStartAt" value="${toLocalInput(it.startAt)}" />
          </div>
        </div>`;
    } else {
      timeBlock = `
        <div class="field">
          <label class="field__label">זמן שליחה</label>
          <input type="datetime-local" id="modalSendAt" value="${toLocalInput(it.sendAt)}" />
        </div>`;
    }

    $('#modalTitle').textContent = kind === 'recurring' ? 'עריכת תזמון חוזר' : 'עריכת הודעה מתוזמנת';
    // Tear down any leftover dropdown panels from the previous render so
    // we don't leave orphan elements floating in <body>.
    $$('#modalBody select').forEach(s => Dropdown.destroy(s));
    $('#modalBody').innerHTML = `
      <div class="field">
        <label class="field__label">נמען</label>
        ${buildRecipientSelect(it.phone)}
        <div class="field__hint">בחירה מאנשי קשר וקבוצות מ־WhatsApp</div>
      </div>
      <div class="field">
        <label class="field__label">הודעה</label>
        <textarea id="modalMessage" rows="5">${escapeHtml(it.message || '')}</textarea>
      </div>
      ${timeBlock}
      <div class="field">
        <label class="field__label">קובץ מצורף</label>
        ${fileBlock}
      </div>
    `;

    // Enhance both selects (recipient + frequency)
    Dropdown.enhance($('#modalPhone'));
    const freq = $('#modalFreq');
    if (freq) Dropdown.enhance(freq);

    // Wire file remove
    $('#modalFileRemove')?.addEventListener('click', () => {
      currentItem = { ...currentItem, fileUrl: null };
      renderForm();
    });
  }

  async function save() {
    const base = State.backendUrl.replace(/\/+$/, '');
    const phone   = $('#modalPhone').value.trim();
    const message = $('#modalMessage').value.trim();
    if (!phone || !message) {
      Toast.show('נמען והודעה הם שדות חובה', 'error');
      return;
    }

    const body = { phone, message };
    // Preserve a removed file by sending fileUrl: null explicitly.
    if (currentItem.fileUrl !== undefined) body.fileUrl = currentItem.fileUrl;

    let url;
    if (kind === 'recurring') {
      body.frequency = $('#modalFreq').value;
      const iso = fromLocalInput($('#modalStartAt').value);
      if (!iso) { Toast.show('תאריך לא תקין', 'error'); return; }
      body.startAt = iso;
      url = `${base}/api/recurring/${currentId}`;
    } else {
      const iso = fromLocalInput($('#modalSendAt').value);
      if (!iso) { Toast.show('תאריך לא תקין', 'error'); return; }
      body.sendAt = iso;
      url = `${base}/api/schedule/${currentId}`;
    }

    try {
      const r = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      Toast.show('נשמר', 'success');
      hideModal();
      Send.refreshSchedules();
    } catch (e) {
      Toast.show('שמירה נכשלה: ' + e.message, 'error');
    }
  }

  function showModal() {
    const m = $('#editModal');
    m.hidden = false;
  }
  function hideModal() {
    const m = $('#editModal');
    m.hidden = true;
    // Clean up any dropdown panels we appended to <body>.
    $$('#modalBody select').forEach(s => Dropdown.destroy(s));
    currentId = null;
    currentItem = null;
    kind = null;
  }

  // Bindings (set once)
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="modal-close"]')) hideModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#editModal').hidden) hideModal();
  });
  $('#modalSave')?.addEventListener('click', save);

  return { open, save, hideModal };
})();

// ============================================================
// 12c. BACKUP — export + import schedules as JSON
// ============================================================
const Backup = {
  async export() {
    if (!State.backendUrl) {
      Toast.show('Backend לא מוגדר', 'error');
      return;
    }
    const base = State.backendUrl.replace(/\/+$/, '');
    try {
      const r = await fetch(`${base}/api/export`);
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);

      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pulse-schedules-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const total = (data.counts?.recurring || 0) + (data.counts?.scheduled || 0);
      Toast.show(`גובו ${total} תזמונים`, 'success');
    } catch (e) {
      Toast.show('כשל בייצוא: ' + e.message, 'error');
    }
  },

  async import(file) {
    if (!State.backendUrl) {
      Toast.show('Backend לא מוגדר', 'error');
      return;
    }
    let payload;
    try {
      const txt = await file.text();
      payload = JSON.parse(txt);
    } catch (e) {
      Toast.show('הקובץ אינו JSON תקין', 'error');
      return;
    }
    if (payload.kind && payload.kind !== 'pulse-schedules-backup') {
      Toast.show('זה לא קובץ גיבוי של Pulse', 'error');
      return;
    }
    const totalIn = (payload.recurring?.length || 0) + (payload.scheduled?.length || 0);
    if (!confirm(`לייבא ${totalIn} תזמונים? (ישולבו בתזמונים הקיימים)`)) return;

    const base = State.backendUrl.replace(/\/+$/, '');
    try {
      const r = await fetch(`${base}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const added = (data.added?.recurring || 0) + (data.added?.scheduled || 0);
      const skip = data.skipped || 0;
      Toast.show(`יובאו ${added} · דולגו ${skip}`, 'success');
      Send.refreshSchedules();
    } catch (e) {
      Toast.show('כשל בייבוא: ' + e.message, 'error');
    }
  }
};

// ============================================================
// 13. LOGS VIEW
// ============================================================
const Logs = {
  init() {
    $('#logsSearch').addEventListener('input', debounce(e => {
      State.logsQuery = e.target.value.trim().toLowerCase();
      Logs.render();
    }, 200));
    $$('[data-filter]').forEach(b => b.addEventListener('click', () => {
      State.logsFilter = b.dataset.filter;
      $$('[data-filter]').forEach(x => x.classList.toggle('is-active', x === b));
      Logs.render();
    }));
    $('#exportLogs').addEventListener('click', () => Logs.export());
  },

  filter() {
    return State.logs.filter(l => {
      if (State.logsFilter !== 'all' && l.status !== State.logsFilter) return false;
      if (State.logsQuery) {
        const hay = `${l.phone} ${l.message} ${l.status}`.toLowerCase();
        if (!hay.includes(State.logsQuery)) return false;
      }
      return true;
    });
  },

  render() {
    const tbody = $('#logsBody');
    const empty = $('#logsEmpty');
    const list = Logs.filter();
    if (!list.length) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    tbody.innerHTML = list.map(l => {
      const cls = l.status === 'success' ? 'pill--success' : l.status === 'error' ? 'pill--error' : 'pill--pending';
      const lbl = l.status === 'success' ? 'הצליח' : l.status === 'error' ? 'נכשל' : 'ממתין';
      const icon = l.status === 'success' ? 'i-check' : l.status === 'error' ? 'i-alert' : 'i-clock';
      const att = l.attachment ? `<svg class="ico ico--sm" style="color:var(--text-muted)"><use href="#i-${l.attachment === 'PDF' ? 'pdf' : l.attachment === 'IMG' ? 'image' : 'file'}"/></svg>` : '<span class="muted">—</span>';
      const info = resolveContactInfo(l.phone);
      const isGroup = info.isGroup;
      const nameMain = info.loading
        ? `<span class="skel skel--name"></span>`
        : `<span class="logs-name__text">${escapeHtml(info.name)}</span>${isGroup ? '<svg class="ico ico--xs logs-name__icon" title="קבוצה"><use href="#i-people"/></svg>' : ''}`;
      const idShown = isGroup ? l.phone.replace('@g.us', '') : fmt.phone(l.phone);
      return `<tr>
        <td class="col-time">${fmt.full(l.ts)}</td>
        <td class="col-recipient">
          <div class="logs-name">${nameMain}</div>
          <div class="logs-id mono">${escapeHtml(idShown)}</div>
        </td>
        <td class="col-msg">${escapeHtml(l.message)}</td>
        <td>${att}</td>
        <td><span class="pill ${cls}"><svg class="ico"><use href="#${icon}"/></svg>${lbl}</span></td>
        <td class="col-time">${l.duration ? `${l.duration}ms` : '—'}</td>
        <td class="col-actions">
          <button class="icon-btn icon-btn--sm" data-resend="${l.id}" title="שלח שוב"><svg class="ico ico--sm"><use href="#i-refresh"/></svg></button>
        </td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-resend]').forEach(b => {
      b.addEventListener('click', () => {
        const log = State.logs.find(l => l.id === b.dataset.resend);
        if (!log) return;
        Router.go('send');
        $('#phoneInput').value = log.phone;
        $('#messageInput').value = log.message;
        $('#phoneInput').dispatchEvent(new Event('input'));
        $('#messageInput').dispatchEvent(new Event('input'));
      });
    });
  },

  export() {
    const list = Logs.filter();
    const head = ['timestamp', 'phone', 'message', 'attachment', 'status', 'duration_ms'];
    const lines = [head.join(',')];
    list.forEach(l => {
      const row = [
        new Date(l.ts).toISOString(),
        l.phone,
        `"${(l.message || '').replace(/"/g, '""')}"`,
        l.attachment || '',
        l.status,
        l.duration || ''
      ];
      lines.push(row.join(','));
    });
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `pulse-logs-${Date.now()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    Toast.show('הלוגים יוצאו ל־CSV', 'success');
  }
};

// ============================================================
// 14. SETTINGS VIEW
// ============================================================
const Settings = {
  init() {
    $('#backendUrl').value = State.backendUrl;
    $('#optSound').checked = State.optSound;

    $('#saveBackend').addEventListener('click', () => {
      State.backendUrl = $('#backendUrl').value.trim();
      Storage.save({ backendUrl: State.backendUrl });
      Toast.show('כתובת ה־Backend נשמרה', 'success');
      Connection.poll();
    });
    $('#testBackend').addEventListener('click', async () => {
      const url = $('#backendUrl').value.trim();
      if (!url) { Toast.show('הזן כתובת תחילה', 'error'); return; }
      const old = State.backendUrl;
      State.backendUrl = url;
      try {
        await Api.status();
        Toast.show('החיבור ל־Backend הצליח', 'success');
      } catch {
        Toast.show('לא ניתן להתחבר ל־Backend', 'error');
        State.backendUrl = old;
      }
    });

    $('#qrRefresh').addEventListener('click', () => Connection.poll(true));

    $('#optSound').addEventListener('change', e => {
      State.optSound = e.target.checked;
      Storage.save({ optSound: State.optSound });
    });

    $$('[data-theme]').forEach(b => b.addEventListener('click', () => Theme.apply(b.dataset.theme)));

    $('#clearLogs').addEventListener('click', async () => {
      if (!confirm('למחוק את כל הלוגים?')) return;
      State.logs = [];
      saveLogs();
      // If a backend is configured, wipe its DB too — otherwise the next
      // sync would just bring everything back.
      if (State.backendUrl) {
        try {
          await fetch(State.backendUrl.replace(/\/+$/, '') + '/api/logs', { method: 'DELETE' });
        } catch (_) { /* offline: local clear still fine */ }
      }
      Toast.show('הלוגים נמחקו', 'info');
      Dashboard.render();
      if (State.route === 'logs') Logs.render();
    });
  },

  render() {
    Settings.renderQR();
  },

  renderQR() {
    const frame = $('#qrFrame');
    if (State.connected) {
      frame.classList.remove('is-loading');
      frame.innerHTML = `
        <div class="qr-empty">
          <svg class="ico ico--lg" style="color:var(--accent)"><use href="#i-check"/></svg>
          <div class="qr-empty__title" style="color:var(--accent)">מחובר בהצלחה</div>
          <div class="qr-empty__sub">הפעלה תקינה · ניתן לשלוח הודעות</div>
        </div>
      `;
    } else if (State.qr) {
      frame.classList.remove('is-loading');
      frame.innerHTML = `<img src="${State.qr}" alt="QR Code"/>`;
    } else if (State.loading && State.loading.percent > 0) {
      frame.classList.add('is-loading');
      frame.innerHTML = `
        <div class="qr-empty">
          <svg class="ico ico--lg"><use href="#i-refresh"/></svg>
          <div class="qr-empty__title">טוען ${State.loading.percent}%</div>
          <div class="qr-empty__sub">${escapeHtml(State.loading.msg || 'מסתנכרן עם WhatsApp Web')}</div>
        </div>
      `;
    } else if (State.backendUrl) {
      frame.classList.add('is-loading');
      frame.innerHTML = `
        <div class="qr-empty">
          <svg class="ico ico--lg"><use href="#i-power"/></svg>
          <div class="qr-empty__title">ממתין ל־QR</div>
          <div class="qr-empty__sub">בודק את ה־Backend…</div>
        </div>
      `;
    } else {
      frame.classList.remove('is-loading');
      frame.innerHTML = `
        <div class="qr-empty">
          <svg class="ico ico--lg"><use href="#i-power"/></svg>
          <div class="qr-empty__title">אין חיבור פעיל</div>
          <div class="qr-empty__sub">הגדר את כתובת ה־Backend</div>
        </div>
      `;
    }
  }
};

// ============================================================
// 14b. PROFILE PICTURE CACHE — lazy-loaded per chat id
// ============================================================
const ProfilePics = {
  cache: new Map(),     // chatId → url | null
  pending: new Map(),   // chatId → Promise
  loaded: new Set(),    // chatIds where we've already attempted & resolved

  resolve(phone) {
    const s = String(phone || '');
    if (/@(c|g)\.us$/.test(s)) return s;
    const digits = s.replace(/\D/g, '');
    return digits ? `${digits}@c.us` : null;
  },

  async get(chatId) {
    if (!chatId || !State.backendUrl || !State.connected) return null;
    if (this.cache.has(chatId)) return this.cache.get(chatId);
    if (this.pending.has(chatId)) return this.pending.get(chatId);

    const p = (async () => {
      try {
        const r = await fetch(
          State.backendUrl.replace(/\/+$/, '') +
            '/api/profile-pic?id=' + encodeURIComponent(chatId)
        );
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const url = j?.url || null;
        this.cache.set(chatId, url);
        return url;
      } catch {
        this.cache.set(chatId, null);
        return null;
      } finally {
        this.pending.delete(chatId);
        this.loaded.add(chatId);
      }
    })();
    this.pending.set(chatId, p);
    return p;
  }
};

// Look up the human-readable name + a short subtitle for a phone/chat-id
// against the loaded WhatsApp directory.
function resolveContactInfo(phoneOrChatId) {
  const v = String(phoneOrChatId || '');
  const isGroup = /@g\.us$/.test(v);
  const chatId = ProfilePics.resolve(v);
  // True when we *might* be able to resolve this once the WhatsApp
  // contact directory finishes loading — used to render shimmer rows.
  const dirReady = !!State.waLoaded;
  const dirLoading = !!State.waLoading;

  if (isGroup) {
    const g = State.waGroups?.find(g => g.id === v);
    return {
      chatId,
      isGroup: true,
      loading: !g && (dirLoading || !dirReady),
      name: g?.name || 'קבוצה',
      sub: g ? `${g.participants} חברים` : v.replace('@g.us', '').slice(0, 14) + '…',
      initials: (g?.name || 'ק').slice(0, 2)
    };
  }
  const c = State.waContacts?.find(c => c.phone === v.replace('@c.us', '') || c.id === v);
  return {
    chatId,
    isGroup: false,
    loading: !c && (dirLoading || !dirReady),
    name: c?.name || fmt.phone(v) || v,
    sub: c ? fmt.phone(c.phone) : '',
    initials: ((c?.name || v).match(/[\u05D0-\u05EAA-Za-z]/g) || [v.slice(-2)]).slice(0, 2).join('')
  };
}

// ============================================================
// 15. CONNECTION POLLING
// ============================================================
const Connection = {
  timer: null,
  tickCount: 0,
  start() {
    Connection.poll();
    Connection.timer = setInterval(() => Connection.poll(), 6000);
  },
  async poll(force = false) {
    if (!State.backendUrl) {
      State.connected = false; State.qr = null; State.loading = null;
      Connection.renderUI();
      return;
    }
    const wasConnected = State.connected;
    try {
      const s = await Api.status();
      State.connected = !!s.connected;
      State.qr = s.qr || null;
      State.loading = s.loading || null;
      // Pick up scheduling counters so the Dashboard health card stays
      // in sync without needing a separate fetch.
      if (s.stats) {
        State.scheduleStats = {
          recurring: s.stats.recurringActive || 0,
          scheduled: s.stats.pendingScheduled || 0
        };
      }
    } catch {
      State.connected = false;
      State.qr = null;
      State.loading = null;
    }
    Connection.renderUI();
    if (State.route === 'dashboard') Dashboard.render();

    // Once connected, keep contacts/groups in sync. Retries until we
    // actually get a list (handles flaky first call right after ready).
    if (State.connected) {
      const empty = !State.waContacts.length && !State.waGroups.length;
      const becameConnected = !wasConnected;
      if (becameConnected || empty) {
        Send.loadWhatsAppDirectory().then(() => {
          if (State.route === 'send' && $('#sourceSelect').value === 'whatsapp') {
            Send.refreshContacts();
          }
        }).catch(() => {});
      }
    }

    // Sync logs from server every other tick (~12s) when connected.
    Connection.tickCount++;
    if (State.connected && Connection.tickCount % 2 === 0) {
      Connection.syncLogs().catch(() => {});
    }
  },

  async syncLogs() {
    if (!State.backendUrl) return;
    const data = await Api.getLogs();
    if (!data || !Array.isArray(data.logs)) return;
    // Map backend rows → frontend log shape
    State.logs = data.logs.map(r => ({
      id:       String(r.id),
      ts:       r.ts || (r.sentAt ? Date.parse(r.sentAt) : Date.now()),
      phone:    r.phone,
      message:  r.message,
      attachment: r.attachment || null,
      status:   r.status,
      duration: r.duration || 0,
      error:    r.error || undefined
    }));
    saveLogs();
    if (State.route === 'dashboard') Dashboard.render();
    if (State.route === 'logs')      Logs.render();
  },
  renderUI() {
    const dot = $('#connDot');
    const lbl = $('#connLabel');
    const sub = $('#connSub');
    const btn = $('#connectBtn');
    if (!State.backendUrl) {
      dot.className = 'dot dot--off';
      lbl.textContent = 'לא מחובר';
      sub.textContent = 'פועל במצב הדגמה';
      btn.querySelector('span').textContent = 'הגדר Backend';
    } else if (State.connected) {
      dot.className = 'dot';
      lbl.textContent = 'מחובר';
      sub.textContent = 'WhatsApp פעיל';
      btn.querySelector('span').textContent = 'נתק חיבור';
    } else if (State.loading && State.loading.percent > 0) {
      // Mid-load — distinguishes "stuck at 99%" from "no QR yet"
      dot.className = 'dot dot--warn';
      lbl.textContent = `טוען ${State.loading.percent}%`;
      sub.textContent = State.loading.msg || 'מחבר ל־WhatsApp Web';
      btn.querySelector('span').textContent = 'בהמתנה…';
    } else if (State.qr) {
      dot.className = 'dot dot--warn';
      lbl.textContent = 'ממתין לסריקה';
      sub.textContent = 'סרוק QR מהטלפון';
      btn.querySelector('span').textContent = 'פתח QR';
    } else {
      dot.className = 'dot dot--warn';
      lbl.textContent = 'מאתחל';
      sub.textContent = 'מכין את WhatsApp Web…';
      btn.querySelector('span').textContent = 'פתח QR';
    }
    if (State.route === 'settings') Settings.renderQR();
    if (State.route === 'dashboard') Dashboard.render();
  }
};

// ============================================================
// 16. INIT
// ============================================================
function init() {
  // Theme
  Theme.apply(State.theme);
  $('#themeToggle').addEventListener('click', Theme.toggle);

  // Routing
  $$('.nav__item[data-route]').forEach(b => b.addEventListener('click', () => Router.go(b.dataset.route)));
  $$('.quick__tile[data-route]').forEach(b => b.addEventListener('click', () => Router.go(b.dataset.route)));
  $$('.link[data-route]').forEach(b => b.addEventListener('click', () => Router.go(b.dataset.route)));

  // Quick tiles
  $('#quickAuto')?.addEventListener('click', () => {
    Router.go('send');
    $('#scheduleInput').focus();
  });

  // Connection button
  $('#connectBtn').addEventListener('click', () => {
    if (!State.backendUrl) Router.go('settings');
    else Router.go('settings');
  });

  // Chart range
  $$('[data-range]').forEach(b => b.addEventListener('click', () => {
    State.chartRange = +b.dataset.range;
    $$('[data-range]').forEach(x => x.classList.toggle('is-active', x === b));
    if (State.route === 'dashboard') {
      const svg = $('#mainChart');
      Chart.renderMain(svg, State.chartRange);
    }
  }));

  // Submodules
  Send.init();
  Logs.init();
  Settings.init();

  // Enhance native <select>s into our custom dropdown component.
  ['#sourceSelect', '#contactsSelect', '#recurFreq'].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) Dropdown.enhance(el);
  });

  // If a real backend is configured, ditch any leftover demo data and
  // adopt the server's logs as the source of truth. seedDemo() is a no-op
  // in this branch.
  if (State.backendUrl) {
    State.logs = [];
    saveLogs();
    Connection.syncLogs().catch(() => {});
  }

  // Demo seed (only when no backend configured)
  seedDemo();

  // Initial render
  Dashboard.render();

  // Connection poll
  Connection.start();

  // Resize re-render chart
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (State.route === 'dashboard') {
        const svg = $('#mainChart');
        if (svg) Chart.renderMain(svg, State.chartRange);
      }
    }, 150);
  });
}

document.addEventListener('DOMContentLoaded', init);

})();
