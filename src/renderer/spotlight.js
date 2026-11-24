'use strict';

/* global iconSvg, api */

let DATA = null;
let rows = [];
let selected = 0;
let lastError = '';

const $ = (s) => document.querySelector(s);
const input = () => $('#spotlight-input');

function svg(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round">${iconSvg(name)}</svg>`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cfg() { return DATA.config; }
function catName(id) { const c = DATA.categories.find((x) => x.id === id); return c ? c.name : ''; }

function applyTheme() {
  const t = cfg().theme;
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.accent = cfg().accent || 'blue';
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (cfg().theme === 'system') applyTheme();
});

function highlight(text, query) {
  const raw = String(text == null ? '' : text);
  if (!query) return esc(raw);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return esc(raw);
  const lower = raw.toLowerCase();
  const marks = [];
  for (const w of words) {
    let idx = 0;
    while ((idx = lower.indexOf(w, idx)) !== -1) {
      marks.push([idx, idx + w.length]);
      idx += w.length;
    }
  }
  if (!marks.length) return esc(raw);
  // 合并重叠区间（按原始文本索引）
  marks.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of marks) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  // 先按原始索引切段，再逐段转义拼接：
  // 直接在转义后的字符串上套原始索引会因实体长度变化而错位（历史缺陷）
  let out = '';
  let cursor = 0;
  for (const [s, e] of merged) {
    out += esc(raw.slice(cursor, s)) + '<mark>' + esc(raw.slice(s, e)) + '</mark>';
    cursor = e;
  }
  out += esc(raw.slice(cursor));
  return out;
}

let pendingConfirmId = null;

function tryCalcMath(str) {
  if (!str) return null;
  const trimmed = str.trim();
  if (!/^[0-9+\-*/().^%xX÷×\s]+$/.test(trimmed)) return null;
  if (!/[+\-*/^%xX÷×]/.test(trimmed) || !/\d/.test(trimmed)) return null;
  try {
    const norm = trimmed
      .replace(/[xX×]/g, '*')
      .replace(/÷/g, '/')
      .replace(/\^/g, '**');
    const res = new Function(`"use strict"; return (${norm})`)();
    if (typeof res === 'number' && !isNaN(res) && isFinite(res)) {
      const rounded = Number(res.toFixed(8)) === Math.round(res) ? Math.round(res) : Number(res.toFixed(4));
      return { expr: trimmed, val: rounded };
    }
  } catch (_) {}
  return null;
}

function score(a, q) {
  const name = a.name.toLowerCase(), kw = (a.keywords || []).join(' ').toLowerCase(), desc = a.desc.toLowerCase();
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const t of tokens) {
    if (name.startsWith(t)) s += 0;
    else if (name.includes(t)) s += 10;
    else if (kw.includes(t)) s += 20;
    else if (desc.includes(t)) s += 50;
    else return -1;
  }
  return s;
}

function buildRows() {
  const q = input().value.replace(/[　 ]/g, ' ').trim();
  const calc = tryCalcMath(q);

  if (!q) {
    const fav = cfg().favorites.map((id) => DATA.actions.find((a) => a.id === id)).filter(Boolean).slice(0, 6);
    const recent = cfg().recents.map((r) => DATA.actions.find((a) => a.id === r.id)).filter(Boolean).slice(0, 6);
    const curatedIds = ['snip-region', 'shutdown-timer', 'terminal', 'lock', 'taskmgr', 'run-dialog',
      'clipboard-history', 'emoji-panel', 'win-search', 'settings'];
    const curated = curatedIds.map((id) => DATA.actions.find((a) => a.id === id)).filter(Boolean);
    const groups = [];
    if (fav.length) groups.push({ label: '已收藏', items: fav });
    if (recent.length) groups.push({ label: '最近使用', items: recent });
    groups.push({ label: '推荐', items: curated });
    return { groups, calc: null };
  }

  const hits = DATA.actions
    .map((a) => ({ a, s: score(a, q) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => x.s - y.s || x.a.name.localeCompare(y.a.name, 'zh'))
    .slice(0, 14)
    .map((x) => x.a);
  const groups = hits.length ? [{ label: '搜索结果', items: hits }] : [];
  return { groups, calc };
}

function render() {
  const q = input().value.replace(/[　 ]/g, ' ').trim();
  const { groups, calc } = buildRows();
  const box = $('#spot-results');

  let calcRow = [];
  if (calc) {
    calcRow = [{
      id: '__calc__',
      name: `= ${calc.val}`,
      desc: `计算算式：${calc.expr}（回车直接复制结果到剪贴板）`,
      icon: 'sparkles',
      cat: 'calc',
      isCalc: true,
      val: calc.val
    }];
  }

  const allItems = [...calcRow, ...groups.flatMap((g) => g.items)];
  rows = allItems;

  if (!rows.length) {
    box.innerHTML = `<div class="spot-empty">没有找到「${esc(q)}」，换个关键词试试</div>`;
    return;
  }

  let html = '';
  let flatIndex = -1;

  if (calcRow.length) {
    flatIndex = 0;
    const isSel = selected === 0;
    html += `
      <div class="spot-group-label">即时计算</div>
      <div class="spot-row ${isSel ? 'selected' : ''}" data-i="0" data-id="__calc__">
        <span class="icon-tile" style="background:var(--accent-soft);color:var(--accent)">${svg('sparkles')}</span>
        <span style="min-width:0">
          <span class="sr-name" style="display:block;font-size:16px;font-weight:700;color:var(--accent)">= ${esc(calc.val)}</span>
          <span class="sr-desc" style="display:block">按 Enter 复制结果到剪贴板</span>
        </span>
        <span class="sr-tag" style="background:var(--accent-soft);color:var(--accent)">算式结果</span>
      </div>`;
  }

  groups.forEach((g) => {
    html += `<div class="spot-group-label">${esc(g.label)}</div>`;
    g.items.forEach((a) => {
      flatIndex += 1;
      const i = flatIndex;
      const isConfirming = pendingConfirmId === a.id;
      html += `<div class="spot-row ${i === selected ? 'selected' : ''} ${isConfirming ? 'confirming-row' : ''}" data-i="${i}" data-id="${esc(a.id)}">
        <span class="icon-tile ${isConfirming ? 'danger-icon' : ''}">${svg(a.icon)}</span>
        <span style="min-width:0">
          <span class="sr-name" style="display:block">${isConfirming ? '<span style="color:var(--danger);font-weight:700">⚠️ 再按一次 Enter 立即执行（Esc 取消）</span>' : highlight(a.name, q)}</span>
          <span class="sr-desc" style="display:block">${highlight(a.desc, q)}</span>
        </span>
        <span class="sr-tag">${esc(catName(a.cat))}</span>
      </div>`;
    });
  });

  box.innerHTML = html;

  box.querySelectorAll('.spot-row').forEach((row) => {
    row.addEventListener('mousemove', () => select(Number(row.dataset.i)));
    row.addEventListener('mousedown', (e) => { e.preventDefault(); launch(Number(row.dataset.i)); });
  });
  followSelection();
}

function select(i) {
  if (!rows.length) return;
  selected = (i + rows.length) % rows.length;
  $$('.spot-row').forEach((r) => r.classList.toggle('selected', Number(r.dataset.i) === selected));
  followSelection();
}
function $$(s) { return Array.from(document.querySelectorAll(s)); }
function followSelection() {
  const el = document.querySelector(`.spot-row[data-i="${selected}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

async function launch(i) {
  const a = rows[i];
  if (!a) return;

  // 1. 即时计算器点击 / 回车：写入剪贴板并淡出
  if (a.isCalc) {
    try {
      await navigator.clipboard.writeText(String(a.val));
      api.spotlightShowOutput({ text: `已复制计算结果：${a.val}`, ok: true });
    } catch (_) {
      api.spotlightShowOutput({ text: `计算结果：${a.val}`, ok: true });
    }
    return;
  }

  if (['shortcuts', 'settings'].includes(a.cat)) { api.spotlightOpenView(a.cat); return; }

  // 2. 危险动作行内二次确认：
  // 第一次回车就地变红高亮提示，第二次回车立即执行，不打断心流
  if (a.confirm && !a.ui && !a.custom) {
    if (pendingConfirmId !== a.id) {
      pendingConfirmId = a.id;
      render();
      return;
    }
    // 已确认，继续放行
    pendingConfirmId = null;
  }

  // 需要参数输入、自定义命令或打开弹窗视图的动作交由主窗口处理
  if (a.ui || a.custom || a.run?.type === 'view') { api.spotlightOpenAction(a.id); return; }

  const r = await api.execute(a.id);
  // 截图/录屏类操作直接退场，严禁唤醒主窗口遮挡屏幕
  if (a.cat === 'capture' || a.hideOnRun) {
    hide();
    return;
  }

  if (typeof r.output === 'string' || (r.ok && typeof r.message === 'string')) {
    api.spotlightShowOutput({ text: r.output || r.message, ok: r.ok !== false });
    return;
  }
  if (r.ok === false) {
    lastError = r.message || '执行失败';
    $('#spot-results').insertAdjacentHTML('afterbegin',
      `<div class="spot-empty" style="color:var(--danger);padding:14px">${esc(lastError)}</div>`);
    return;
  }
  hide();
}

function show() {
  lastError = '';
  pendingConfirmId = null;
  input().value = '';
  selected = 0;
  render();
  $('#spot-backdrop').classList.add('show');
  $('#spot').classList.add('show');
  setTimeout(() => input().focus(), 30);
}
function hide() {
  pendingConfirmId = null;
  $('#spot-backdrop').classList.remove('show');
  $('#spot').classList.remove('show');
  api.hideSpotlight();
}

input().addEventListener('input', () => { selected = 0; render(); });
input().addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); launch(selected); }
  else if (e.key === 'Escape') {
    e.preventDefault();
    if (pendingConfirmId) {
      pendingConfirmId = null;
      render();
    } else {
      hide();
    }
  }
});
$('#spot-backdrop').addEventListener('mousedown', hide);
$('#spot').addEventListener('mousedown', () => setTimeout(() => input().focus(), 0));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#spot').classList.contains('show')) hide();
});

api.on('qk:spotlight-show', show);
api.on('qk:spotlight-hide', () => {
  $('#spot-backdrop').classList.remove('show');
  $('#spot').classList.remove('show');
});
api.on('qk:config-changed', (c) => { DATA.config = c; applyTheme(); render(); });
api.on('qk:custom-changed', async () => { DATA = await api.getInit(); render(); });

(async function init() {
  try {
    DATA = await api.getInit();
    applyTheme();
    render();
    api.rendererReady();
  } catch (e) {
    $('#spot-results').innerHTML = `<div class="spot-empty">初始化失败：${esc(e.message)}</div>`;
  }
})();
