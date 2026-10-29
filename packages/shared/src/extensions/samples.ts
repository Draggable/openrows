import type { ExtensionBundle, ExtensionManifest } from './manifest.js';

/**
 * The built-in extensions, shipped with the app: installed by key, their manifest and
 * bundle read from here (so they update with the app). Each is a plain bundle on the
 * `window.openrows` API, the same as a third-party one, and gets only its manifest's scopes.
 */
export interface BuiltInExtension {
  key: string;
  manifest: ExtensionManifest;
  bundle: ExtensionBundle;
}

// Helpers the samples share, prepended to each bundle's JS.
const HELPERS = `
const h = (tag, props, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
};
const app = document.getElementById('app');
const render = (...nodes) => app.replaceChildren(...nodes);
const fieldSelect = (label, table, value, filter, onChange) => h('label', { class: 'pick' },
  h('span', { class: 'muted', text: label }),
  h('select', { 'aria-label': label, onchange: (e) => onChange(e.target.value) },
    h('option', { value: '', text: 'Choose…' }),
    ...(table ? table.fields.filter(filter) : []).map((f) =>
      h('option', { value: f.id, selected: f.id === value, text: f.name }))));
`;

const CHART_JS = `${HELPERS}
const block = window.openrows;
let stopWatch = null;
let watched = null;
let token = 0;
async function draw() {
  const run = ++token;
  const s = block.settings;
  const base = block.base;
  const table = base.tables.find((t) => t.id === s.tableId) || base.tables[0] || null;
  const field = table && table.fields.find((f) => f.id === s.fieldId);
  const controls = block.canEditSettings ? h('div', { class: 'controls' },
    h('label', { class: 'pick' }, h('span', { class: 'muted', text: 'Table' }),
      h('select', { 'aria-label': 'Table', onchange: (e) => block.setSettings({ tableId: e.target.value }) },
        ...base.tables.map((t) => h('option', { value: t.id, selected: table && t.id === table.id, text: t.name })))),
    fieldSelect('Group by', table, s.fieldId, () => true,
      (v) => block.setSettings({ tableId: table && table.id, fieldId: v || undefined }))) : null;
  const want = table && field ? table.id : null;
  if (watched !== want) {
    if (stopWatch) stopWatch();
    stopWatch = want ? block.watchRecords(want, draw) : null;
    watched = want;
  }
  if (!table || !field) {
    render(controls || '', h('p', { class: 'muted', text: 'Pick a table and a field to chart its records by.' }));
    return;
  }
  const records = await block.selectRecords(table.id, { fields: [field.id] });
  if (run !== token) return;
  const counts = new Map();
  for (const r of records) {
    const key = r.strings[field.id] || '(empty)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  render(controls || '',
    h('h2', { text: table.name + ' by ' + field.name }),
    h('ul', { class: 'bars', 'aria-label': 'Records by ' + field.name },
      ...rows.map(([label, n]) => h('li', { 'data-label': label },
        h('span', { class: 'label', text: label }),
        h('span', { class: 'track' }, h('span', { class: 'bar', style: 'width:' + (n / max) * 100 + '%' })),
        h('span', { class: 'count', text: String(n) })))),
    h('p', { class: 'muted', text: records.length + ' records' }));
}
block.on('settings', draw);
block.on('base', draw);
draw().catch((e) => render(h('p', { role: 'alert', text: e.message })));
`;

const CHART_CSS = `
h2{font-size:13px;font-weight:600;margin:8px 0}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.pick{display:grid;gap:2px}
.bars{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.bars li{display:grid;grid-template-columns:minmax(60px,30%) 1fr 40px;gap:8px;align-items:center}
.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{background:var(--or-border);border-radius:3px;height:14px;overflow:hidden}
.bar{display:block;height:100%;background:var(--or-accent)}
.count{text-align:right;font-variant-numeric:tabular-nums}
`;

const PRINT_JS = `${HELPERS}
const block = window.openrows;
let designing = false;
let token = 0;
async function draw() {
  const run = ++token;
  const c = block.cursor;
  const table = c && c.tableId && block.base.tables.find((t) => t.id === c.tableId);
  if (!table || !c.recordId) {
    render(h('p', { class: 'muted', text: 'Select a record to lay it out for printing.' }));
    return;
  }
  const record = await block.getRecord(table.id, c.recordId);
  if (run !== token) return;
  if (!record) {
    render(h('p', { class: 'muted', text: 'That record is gone.' }));
    return;
  }
  const chosen = (block.settings.fields || {})[table.id];
  const shown = table.fields.filter((f) => !chosen || chosen.includes(f.id));
  const toggle = (id, on) => {
    const now = new Set(chosen || table.fields.map((f) => f.id));
    if (on) now.add(id); else now.delete(id);
    const fields = { ...(block.settings.fields || {}), [table.id]: table.fields.map((f) => f.id).filter((x) => now.has(x)) };
    block.setSettings({ ...block.settings, fields });
  };
  render(
    h('div', { class: 'toolbar no-print' },
      h('button', { class: 'primary', onclick: () => window.print(), text: 'Print' }),
      block.canEditSettings ? h('button', { 'aria-pressed': String(designing), onclick: () => { designing = !designing; draw(); }, text: designing ? 'Done' : 'Choose fields' }) : null),
    designing ? h('fieldset', { class: 'no-print' }, h('legend', { text: 'Fields on the page' }),
      ...table.fields.map((f) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: shown.includes(f), onchange: (e) => toggle(f.id, e.target.checked) }), f.name))) : null,
    h('article', { class: 'page' },
      h('p', { class: 'muted', text: table.name }),
      h('h1', { text: record.name }),
      h('dl', {}, ...shown.filter((f) => f.id !== table.primaryFieldId).map((f) => [
        h('dt', { text: f.name }), h('dd', { text: record.strings[f.id] || '—' })]))));
}
block.on('cursor', draw);
block.on('settings', draw);
draw().catch((e) => render(h('p', { role: 'alert', text: e.message })));
`;

const PRINT_CSS = `
.toolbar{display:flex;gap:8px;margin-bottom:8px}
fieldset{border:1px solid var(--or-border);border-radius:6px;margin:0 0 8px;display:grid;gap:2px}
.check{display:flex;gap:6px;align-items:center}
.page{background:var(--or-surface);border:1px solid var(--or-border);border-radius:6px;padding:16px}
h1{font-size:20px;margin:0 0 12px}
.page>p{margin:0 0 4px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}
dt{color:var(--or-text-2)}
dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
@media print{body{padding:0;background:#fff;color:#000}.no-print{display:none}.page{border:0;padding:0}}
`;

const URL_JS = `${HELPERS}
const block = window.openrows;
let token = 0;
function embedOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\\./, '');
  const yt = host === 'youtu.be' ? u.pathname.slice(1) : (host === 'youtube.com' || host === 'm.youtube.com') ? u.searchParams.get('v') : null;
  if (yt && /^[\\w-]{6,20}$/.test(yt)) return 'https://www.youtube-nocookie.com/embed/' + yt;
  const vimeo = host === 'vimeo.com' && /^\\/(\\d+)/.exec(u.pathname);
  if (vimeo) return 'https://player.vimeo.com/video/' + vimeo[1];
  const loom = host === 'loom.com' && /^\\/share\\/([\\w-]+)/.exec(u.pathname);
  if (loom) return 'https://www.loom.com/embed/' + loom[1];
  return null;
}
async function draw() {
  const run = ++token;
  const c = block.cursor;
  const table = c && c.tableId && block.base.tables.find((t) => t.id === c.tableId);
  const urlFields = table ? table.fields.filter((f) => f.type === 'url') : [];
  const chosen = table && (block.settings.fields || {})[table.id];
  const field = urlFields.find((f) => f.id === chosen) || urlFields[0];
  const picker = block.canEditSettings && urlFields.length > 1 ? fieldSelect('URL field', { fields: urlFields }, field && field.id, () => true,
    (v) => block.setSettings({ ...block.settings, fields: { ...(block.settings.fields || {}), [table.id]: v } })) : null;
  if (!table || !field) {
    render(h('p', { class: 'muted', text: table ? 'This table has no URL field.' : 'Open a table with a URL field.' }));
    return;
  }
  if (!c.recordId) {
    render(picker || '', h('p', { class: 'muted', text: 'Select a record to preview its ' + field.name + '.' }));
    return;
  }
  const record = await block.getRecord(table.id, c.recordId);
  if (run !== token) return;
  const url = record && record.cells[field.id];
  if (typeof url !== 'string' || !/^https?:\\/\\//i.test(url)) {
    render(picker || '', h('p', { class: 'muted', text: 'No link in ' + field.name + ' for this record.' }));
    return;
  }
  const embed = embedOf(url);
  const image = /\\.(png|jpe?g|gif|webp|svg)(\\?.*)?$/i.test(url);
  render(picker || '',
    h('p', { class: 'title' }, h('strong', { text: record.name }), ' · ', h('span', { class: 'muted', text: new URL(url).hostname })),
    embed ? h('iframe', { src: embed, title: 'Preview of ' + url, allow: 'fullscreen', referrerpolicy: 'no-referrer' })
      : image ? h('img', { src: url, alt: 'Image at ' + url, referrerpolicy: 'no-referrer' })
      : h('p', { class: 'muted', text: 'No preview for this site.' }),
    h('p', {}, h('button', { onclick: () => block.openUrl(url), text: 'Open link' }), ' ', h('span', { class: 'url', text: url })));
}
block.on('cursor', draw);
block.on('settings', draw);
draw().catch((e) => render(h('p', { role: 'alert', text: e.message })));
`;

const URL_CSS = `
.title{margin:0 0 8px}
iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:6px;background:#000}
img{max-width:100%;max-height:60vh;border-radius:6px;display:block}
.url{color:var(--or-text-2);overflow-wrap:anywhere}
.pick{display:grid;gap:2px;margin-bottom:8px}
`;

const html = '<main id="app"><p class="muted">Loading…</p></main>';

export const BUILT_IN_EXTENSIONS: readonly BuiltInExtension[] = [
  {
    key: 'chart',
    manifest: {
      manifestVersion: 1,
      name: 'Chart',
      description: "A bar chart of a table's records, counted by a field's values. Updates live.",
      version: '1.0.0',
      scopes: ['records:read', 'settings:write'],
    },
    bundle: { html, css: CHART_CSS.trim(), js: CHART_JS.trim() },
  },
  {
    key: 'print-view',
    manifest: {
      manifestVersion: 1,
      name: 'Print view',
      description: 'Lays out the selected record as a page to print, with the fields you choose.',
      version: '1.0.0',
      scopes: ['records:read', 'cursor:read', 'settings:write'],
    },
    bundle: { html, css: PRINT_CSS.trim(), js: PRINT_JS.trim() },
  },
  {
    key: 'url-preview',
    manifest: {
      manifestVersion: 1,
      name: 'URL preview',
      description:
        "Previews the selected record's link: YouTube, Vimeo and Loom videos and images inline.",
      version: '1.0.0',
      scopes: ['records:read', 'cursor:read', 'settings:write', 'embed:frames'],
    },
    bundle: { html, css: URL_CSS.trim(), js: URL_JS.trim() },
  },
];

export const BUILT_IN_EXTENSION_KEYS = BUILT_IN_EXTENSIONS.map((e) => e.key);

export function builtInExtension(key: string): BuiltInExtension | null {
  return BUILT_IN_EXTENSIONS.find((e) => e.key === key) ?? null;
}
