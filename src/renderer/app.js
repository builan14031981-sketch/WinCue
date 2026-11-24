'use strict';

/* global iconSvg, TABS, api */

let DATA = null;
let state = { cat: 'home', query: '', shortcutTab: 'win', showAllCategories: false };
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function svg(name, cls = '') {
  // qk-i 提供默认 15px 尺寸，防止裸 svg 在没有容器尺寸约束时按默认 300×150 撑满布局；
  // 各处的 `.xxx svg { width/height }` 规则特异性更高，会正常覆盖它。
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" class="qk-i ${cls}">${iconSvg(name)}</svg>`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cfg() { return DATA.config; }
function catMeta(id) { return DATA.categories.find((c) => c.id === id); }
function actionById(id) { return DATA.actions.find((a) => a.id === id); }

/* ---------------------------- 危险命令识别 ---------------------------- */
// 规则由主进程统一下发（getInitData.dangerRules），保证前后端判断一致；
// 用于「执行任意命令」「自定义命令」在运行前给出有区分度的警告。
let DANGER_RULES = [];

function buildDangerRules() {
  DANGER_RULES = ((DATA && DATA.dangerRules) || []).map((r) => {
    try { return { label: r.label, re: new RegExp(r.source, r.flags || '') }; } catch (_) { return null; }
  }).filter(Boolean);
}
function detectDanger(command) {
  const text = String(command || '');
  if (!text.trim()) return [];
  return DANGER_RULES.filter((r) => r.re.test(text)).map((r) => r.label);
}

/* ================================ 主题 ================================ */

const LEGACY_ACCENT_MAP = {
  blue: 'slate',
  graphite: 'ink',
  green: 'sage',
  purple: 'taupe',
  orange: 'clay',
};
const VALID_ACCENTS = new Set(['slate', 'taupe', 'sage', 'ink', 'clay']);
const FONT_PRESETS = [
  { id: 'noto-sans', name: '思源黑体', sub: '现代默认', family: '"Inter","Noto Sans SC",sans-serif' },
  { id: 'misans', name: 'MiSans', sub: '小米精工', family: '"MiSansLatin VF","MiSans VF",sans-serif' },
  { id: 'editorial', name: '典雅混搭', sub: '宋体标题+黑体', family: '"Noto Serif SC",Georgia,serif' },
  { id: 'wenkai', name: '霞鹜文楷', sub: '温润手账风', family: '"LXGW WenKai Lite",sans-serif' },
  { id: 'noto-serif', name: '思源宋体', sub: '全站书卷', family: '"Noto Serif SC",Georgia,serif' },
];
const VALID_FONTS = new Set(FONT_PRESETS.map((f) => f.id));

function normalizeAccent(raw) {
  const mapped = LEGACY_ACCENT_MAP[raw] || raw;
  return VALID_ACCENTS.has(mapped) ? mapped : 'slate';
}

function normalizeFontPreset(raw) {
  if (raw === 'system') return 'noto-sans';
  return VALID_FONTS.has(raw) ? raw : 'noto-sans';
}

function resolvedTheme() {
  const t = cfg().theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  const root = document.documentElement;
  const theme = resolvedTheme();
  root.dataset.theme = theme;
  root.dataset.accent = normalizeAccent(cfg().accent);
  root.dataset.font = normalizeFontPreset(cfg().fontPreset);
  $('#theme-icon').innerHTML = iconSvg(theme === 'dark' ? 'sun' : 'moon');
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (cfg().theme === 'system') applyTheme();
});

/* ================================ Toast ================================ */

function toast(text, type = 'ok', timeout = 2600) {
  const layer = $('#toast-layer');
  const el = document.createElement('div');
  el.className = `toast ${type === 'err' ? 'err' : 'ok'}`;
  el.innerHTML = `${svg(type === 'err' ? 'alert' : 'check')}<span>${esc(text)}</span>`;
  layer.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, timeout);
}

/* ================================ 模态 ================================ */

const backdrop = () => $('#backdrop');
function openSheet(innerHtml, extraClass = '') {
  closeSheet();
  const b = backdrop();
  const cls = extraClass ? `sheet ${extraClass}` : 'sheet';
  b.innerHTML = `<div class="${cls}" role="dialog">${innerHtml}</div>`;
  requestAnimationFrame(() => b.classList.add('open'));
  const sheet = b.querySelector('.sheet');
  sheet.addEventListener('click', (e) => e.stopPropagation());
  return sheet;
}
function closeSheet() {
  const b = backdrop();
  b.classList.remove('open');
  setTimeout(() => { if (!b.classList.contains('open')) b.innerHTML = ''; }, 220);
}
backdrop().addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && backdrop().classList.contains('open')) closeSheet();
});

/* ================================ 执行动作 ================================ */

/**
 * 执行动作。
 * opts.silent = true 时只返回结果、不弹出任何面板或 toast（调用方通常自带输出面板），
 * 避免「openOutputFromPromise + run()」双开面板互相顶替的问题。
 */
async function run(id, params, opts = {}) {
  let r;
  try {
    r = await api.execute(id, params || {});
  } catch (e) {
    if (opts.silent) throw e;
    toast(`执行出错：${e.message}`, 'err');
    return { ok: false };
  }
  if (r.timers) { state.timers = r.timers; renderBanner(); }
  if (Array.isArray(r.recents)) {
    DATA.config.recents = r.recents;
    if (state.cat === 'home' && !state.query) renderContent();
  }

  // 主进程安全门兜底：危险命令未经显式确认会被拒绝，这里补上确认再放行
  if (r.needConfirm && !(params && params.confirmed)) {
    const cmdText = (params && params.command) || '';
    const ok = await confirmSheet({
      title: '检测到危险操作，确认执行？',
      message: `${r.message || '该命令包含潜在危险操作'}${cmdText ? `\n\n${cmdText}` : ''}`,
      okText: '仍要执行',
      danger: true,
      icon: 'alert'
    });
    if (!ok) return { ok: false, canceled: true, message: '已取消执行' };
    const retry = { ...(params || {}), confirmed: true };
    if (!opts.silent) return run(id, retry, opts);
    // silent 场景：确认弹窗已顶替原输出面板，重新执行后补开结果面板
    let r2;
    try {
      r2 = await api.execute(id, retry);
    } catch (e) {
      openErrorSheet(id, e.message);
      return { ok: false };
    }
    if (r2.timers) { state.timers = r2.timers; renderBanner(); }
    if (typeof r2.output === 'string') openOutputModal(r2.output, r2.ok !== false);
    else if (r2.ok === false) openErrorSheet(id, r2.message || '执行失败', r2.detail);
    else toast(r2.message || '已执行', 'ok');
    return r2;
  }

  if (opts.silent) return r;
  if (r.view) {
    navigate(r.view === 'custom-add' ? 'custom' : r.view);
    closeSheet();
    return r;
  }
  if (typeof r.output === 'string') {
    openOutputModal(r.output, r.ok !== false);
  } else if (r.ok === false) {
    openErrorSheet(id, r.message || '未知错误，系统无法完成此操作', r.detail);
  } else {
    toast(r.message || '已执行', 'ok');
  }
  return r;
}

function openErrorSheet(actionId, errMsg, detail) {
  const a = actionById(actionId);
  const title = a ? `「${a.name}」未成功执行` : '功能执行失败';
  const detailHtml = detail ? `
    <details style="margin-top:10px">
      <summary style="cursor:pointer;color:var(--text-2);font-size:12px">查看技术详情</summary>
      <pre style="margin-top:6px;padding:10px;background:var(--bg-2);border-radius:8px;font-size:11.5px;line-height:1.5;white-space:pre-wrap;overflow:auto;max-height:200px">${esc(detail)}</pre>
    </details>` : '';
  openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon danger">${svg('alert')}</div>
      <div>
        <div class="sheet-title">${esc(title)}</div>
        <div class="sheet-sub">QuickKeys 已捕获该异常，错误详情已写入日志</div>
      </div>
    </div>
    <div class="output-box" style="margin-top:14px;color:var(--danger);white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.6;background:var(--danger-soft);border:1px solid rgba(255,59,48,0.2)">${esc(errMsg)}</div>
    ${detailHtml}
    <div class="sheet-actions">
      <button class="btn btn-primary" data-act="done">我知道了</button>
    </div>
  `).querySelector('[data-act=done]').onclick = closeSheet;
}

function activate(a) {
  if (!a) return;
  // 应用内视图
  if (['shortcuts', 'settings', 'guardian', 'gaming', 'contextmenu', 'cleaner', 'cdrive'].includes(a.cat)) return navigate(a.cat);
  if (a.id === 'sys-boost') {
    confirmSheet({
      title: '执行一键系统优化加速？',
      message: '将深度修剪后台应用工作集内存、清理临时垃圾碎片，并刷新本地网络解析缓存。',
      okText: '开始加速',
      danger: false,
      icon: 'zap'
    }).then((ok) => {
      if (ok) triggerBoost();
    });
    return;
  }
  if (a.id === 'startup-manager') return openStartupModal();
  if (a.id === 'context-menu-manager') return navigate('contextmenu');
  if (a.id === 'pure-native-context-menu') {
    if (window._isPureCMRunning) return;
    confirmSheet({
      title: a.confirm ? a.confirm.title : '确认还原纯净原生右键菜单？',
      message: a.confirm ? a.confirm.message : '将一键屏蔽所有第三方软件注入的右键菜单项。系统原生菜单不受影响，且可随时恢复。',
      okText: a.confirm ? a.confirm.okText : '立即还原纯净',
      danger: false,
      icon: 'shield'
    }).then(async (ok) => {
      if (!ok || window._isPureCMRunning) return;
      window._isPureCMRunning = true;
      toast('正在屏蔽第三方扩展并重启资源管理器…', 'info');
      try {
        const res = await api.guardianPureCM();
        if (res.ok) {
          toast(res.message, 'ok');
          openContextMenuModal();
        } else {
          toast(`执行失败: ${res.error || res.message || '权限受限'}`, 'err');
        }
      } catch (e) {
        toast(`执行异常: ${e.message}`, 'err');
      } finally {
        window._isPureCMRunning = false;
      }
    });
    return;
  }
  if (a.id === 'registry-tweaks') return openRegistryTweaksModal();
  // 自定义命令：任何入口（卡片 / 搜索 / Spotlight 转交）都必须先二次确认
  if (a.custom) return confirmAndRunCustom(a);
  if (a.ui && a.ui.kind === 'timer') return openTimerModal(a.ui.mode);
  if (a.ui && a.ui.kind === 'input') return openInputModal(a);
  if (a.ui && a.ui.kind === 'image-pdf') return openImagesToPdfModal(a);
  if (a.ui && a.ui.kind === 'single-convert') return openSingleConvertModal(a);
  if (a.ui && a.ui.kind === 'file-hash') return openFileHashModal(a);
  if (a.ui && a.ui.kind === 'text-tool') return openTextToolModal(a);
  if (a.ui && a.ui.kind === 'terminal') return openTerminalModal();
  if (a.ui && a.ui.kind === 'runbox') return openRunboxModal();
  if (a.ui && a.ui.kind === 'custom-add') return openCustomEditor();
  if (a.confirm) return openConfirm(a);
  run(a.id);
}

// 自定义命令的统一执行确认（危险命令会额外标注命中的危险类型）
function confirmAndRunCustom(action) {
  const dangerLabels = detectDanger(action.command || '');
  const modeDesc = action.runMode === 'hidden'
    ? '命令将在后台静默运行，且无法在 QuickKeys 中终止。'
    : action.runMode === 'terminal'
      ? '命令将在可见终端中运行。'
      : '命令输出将在 QuickKeys 中显示。';
  const dangerDesc = dangerLabels.length ? `检测到危险操作：${dangerLabels.join('、')}\n\n` : '';
  confirmSheet({
    title: dangerLabels.length ? `「${action.name}」含危险操作，确认执行？` : `运行「${action.name}」？`,
    message: `${dangerDesc}${modeDesc}\n\n${action.command}`,
    okText: dangerLabels.length ? '仍要执行' : '确认运行',
    danger: dangerLabels.length > 0,
    icon: dangerLabels.length ? 'alert' : 'terminal'
  }).then((ok) => { if (ok) run(action.id, { confirmed: true }); });
}

function openConfirm(a) {
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon danger">${svg(a.icon)}</div>
      <div><div class="sheet-title">${esc(a.confirm.title)}</div></div>
    </div>
    <div class="sheet-msg">${esc(a.confirm.message)}</div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-danger" data-act="ok">${esc(a.confirm.okText || '确认')}</button>
    </div>`);
  sheet.querySelector('[data-act=cancel]').onclick = closeSheet;
  sheet.querySelector('[data-act=ok]').onclick = () => { closeSheet(); run(a.id); };
}

// 通用确认弹窗（Promise），遮罩点击 / Esc 视为取消
function confirmSheet({ title, message, okText = '确认', danger = true, icon = 'alert' }) {
  return new Promise((resolve) => {
    let settled = false;
    const sheet = openSheet(`
      <div class="sheet-head">
        <div class="sheet-icon ${danger ? 'danger' : ''}">${svg(icon)}</div>
        <div><div class="sheet-title">${esc(title)}</div></div>
      </div>
      <div class="sheet-msg">${esc(message)}</div>
      <div class="sheet-actions">
        <button class="btn btn-ghost" data-act="cancel">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(okText)}</button>
      </div>`);
    const b = backdrop();
    const done = (v) => {
      if (settled) return;
      settled = true;
      obs.disconnect();
      closeSheet();
      resolve(v);
    };
    const obs = new MutationObserver(() => {
      if (!b.querySelector('.sheet')) done(false);
    });
    obs.observe(b, { childList: true, subtree: true });
    sheet.querySelector('[data-act=cancel]').onclick = () => done(false);
    sheet.querySelector('[data-act=ok]').onclick = () => done(true);
  });
}

/* --------------------------- 定时关机 / 重启 / 睡眠 --------------------------- */

const MODE_LABEL = { shutdown: '关机', restart: '重启', sleep: '睡眠' };
const MODE_ACTION = { shutdown: 'shutdown-timer', restart: 'restart-timer', sleep: 'sleep-timer' };
const MODE_CANCEL = { shutdown: 'shutdown-cancel', restart: 'shutdown-cancel', sleep: 'sleep-cancel' };
const TIMER_PRESETS = [15, 30, 60, 120];

function fmtRemain(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}

function activeTimers() {
  const now = Date.now();
  return Object.entries(state.timers || {})
    .filter(([, v]) => v && v.at > now)
    .map(([mode, v]) => ({ mode, at: v.at }));
}

function openTimerModal(mode) {
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg(mode === 'sleep' ? 'timer-moon' : mode === 'restart' ? 'timer-restart' : 'timer')}</div>
      <div>
        <div class="sheet-title">定时${MODE_LABEL[mode]}</div>
        <div class="sheet-sub">由 Windows 系统计时，关闭本软件依然生效</div>
      </div>
    </div>
    <div class="preset-grid">
      ${TIMER_PRESETS.map((m) => `<button class="preset-chip" data-min="${m}">${m < 60 ? `${m} 分钟` : `${m / 60} 小时`}</button>`).join('')}
    </div>
    <label class="field-label">自定义时间</label>
    <div class="custom-time">
      <input class="input" id="t-h" type="number" min="0" max="240" placeholder="小时" />
      <input class="input" id="t-m" type="number" min="0" max="59" placeholder="分钟" />
      <button class="btn btn-primary" id="t-go">开始</button>
    </div>
    <div id="t-active"></div>`);

  sheet.querySelectorAll('.preset-chip').forEach((b) => {
    b.onclick = () => doSetTimer(mode, Number(b.dataset.min) * 60);
  });
  sheet.querySelector('#t-go').onclick = () => {
    const h = Number(sheet.querySelector('#t-h').value || 0), m = Number(sheet.querySelector('#t-m').value || 0);
    const sec = h * 3600 + m * 60;
    if (sec < 60) return toast('请设置至少 1 分钟', 'err');
    doSetTimer(mode, sec);
  };
  renderTimerActive(sheet, mode);
}

async function doSetTimer(mode, seconds) {
  const minutes = Math.round(seconds / 60);
  const duration = minutes < 60 ? `${minutes} 分钟` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  const confirmed = await confirmSheet({
    title: `确认定时${MODE_LABEL[mode]}`,
    message: `电脑将在 ${duration} 后${MODE_LABEL[mode]}。该计划在关闭 QuickKeys 后仍会生效。`,
    okText: `确认${MODE_LABEL[mode]}`,
    danger: mode !== 'sleep',
    icon: mode === 'sleep' ? 'timer-moon' : mode === 'restart' ? 'timer-restart' : 'timer'
  });
  if (!confirmed) return;
  const r = await run(MODE_ACTION[mode], { mode, seconds });
  if (r && r.ok !== false) setTimeout(() => { closeSheet(); openTimerModal(mode); }, 150);
}

function renderTimerActive(sheet, mode) {
  const box = sheet.querySelector('#t-active');
  const t = (state.timers || {})[mode];
  if (!t || t.at < Date.now()) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="timer-active-box">
      <div>
        <div class="count" data-at="${t.at}">${fmtRemain(t.at - Date.now())}</div>
        <div class="meta">距${MODE_LABEL[mode]}剩余时间</div>
      </div>
      <button class="btn btn-secondary" id="t-cancel">取消${MODE_LABEL[mode]}计划</button>
    </div>`;
  box.querySelector('#t-cancel').onclick = async () => {
    await run(MODE_CANCEL[mode]);
    renderTimerActive(sheet, mode);
  };
}

/* -------------------------- 离线格式转换与实用工具 -------------------------- */

function openImagesToPdfModal(a) {
  let images = [];
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg(a.icon)}</div>
      <div>
        <div class="sheet-title">${esc(a.name)}</div>
        <div class="sheet-sub">100% 本地纯离线处理，支持多张 JPG / PNG / WebP 拼接为单份 PDF</div>
      </div>
    </div>
    <div class="dropzone" id="img-dropzone" style="margin-top:14px">
      ${svg('file-image')}
      <div class="dz-title">点击选择图片，或将图片拖拽至此处</div>
      <div class="dz-sub">支持多选，按选中顺序排版并自动适配页面</div>
    </div>
    <div class="file-pill-list" id="img-list"></div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-primary" id="btn-export-pdf" disabled>选择保存位置并导出 PDF</button>
    </div>`);

  const dropzone = sheet.querySelector('#img-dropzone');
  const pillList = sheet.querySelector('#img-list');
  const exportBtn = sheet.querySelector('#btn-export-pdf');

  const updateList = () => {
    pillList.innerHTML = images.map((p, idx) => `
      <div class="file-pill">
        <span title="${esc(p)}">${esc(p.split(/[\\/]/).pop())}</span>
        <button type="button" data-del-img="${idx}">×</button>
      </div>`).join('');
    exportBtn.disabled = images.length === 0;
    pillList.querySelectorAll('[data-del-img]').forEach((btn) => {
      btn.onclick = () => {
        images.splice(Number(btn.dataset.delImg), 1);
        updateList();
      };
    });
  };

  dropzone.onclick = async () => {
    const selected = await api.selectFiles({
      title: '选择要合并的图片',
      multiple: true,
      filters: [{ name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] }]
    });
    if (selected && selected.length) {
      images = [...new Set([...images, ...selected])];
      updateList();
    }
  };

  dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('dragover'); };
  dropzone.ondragleave = () => dropzone.classList.remove('dragover');
  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const dropped = Array.from(e.dataTransfer.files).map((f) => api.getDroppedPath(f)).filter((p) => /\.(jpg|jpeg|png|webp|bmp|gif)$/i.test(p));
    if (dropped.length) {
      images = [...new Set([...images, ...dropped])];
      updateList();
    }
  };

  exportBtn.onclick = async () => {
    if (images.length === 0) return toast('请至少选择一张图片', 'err');
    const defaultName = `合并文档_${new Date().toISOString().slice(0, 10)}.pdf`;
    const savePath = await api.saveFile({
      title: '导出 PDF 保存路径',
      defaultPath: defaultName,
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    });
    if (!savePath) return;

    closeSheet();
    openOutputFromPromise('图片转 PDF', run('images-to-pdf', { images, savePath }, { silent: true }));
  };

  sheet.querySelector('[data-act=cancel]').onclick = closeSheet;
}

function openSingleConvertModal(a) {
  const isWord = a.ui.inputType === 'word';
  const filterExts = isWord ? ['docx', 'doc'] : ['txt', 'md'];
  const filterDesc = isWord ? 'Word 文档 (*.docx, *.doc)' : '文本文件 (*.txt, *.md)';
  let currentFile = null;

  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg(a.icon)}</div>
      <div>
        <div class="sheet-title">${esc(a.name)}</div>
        <div class="sheet-sub">${isWord ? '调用本地 Word/WPS 导出引擎，原汁原味转为 PDF' : '100% 离线排版，将笔记或纯文本转换为整齐标准的打印级 PDF'}</div>
      </div>
    </div>
    <div class="dropzone" id="conv-dropzone" style="margin-top:14px">
      ${svg(isWord ? 'file-text' : 'file-edit')}
      <div class="dz-title" id="conv-dz-title">点击选择文件，或将文件拖拽至此处</div>
      <div class="dz-sub" id="conv-dz-sub">支持 ${isWord ? '.docx / .doc' : '.txt / .md'} 格式文件</div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-primary" id="btn-start-convert" disabled>选择保存位置并导出 PDF</button>
    </div>`);

  const dropzone = sheet.querySelector('#conv-dropzone');
  const titleEl = sheet.querySelector('#conv-dz-title');
  const subEl = sheet.querySelector('#conv-dz-sub');
  const startBtn = sheet.querySelector('#btn-start-convert');

  const setFile = (filePath) => {
    currentFile = filePath;
    titleEl.textContent = filePath.split(/[\\/]/).pop();
    subEl.textContent = filePath;
    startBtn.disabled = !filePath;
  };

  dropzone.onclick = async () => {
    const selected = await api.selectFiles({
      title: isWord ? '选择 Word 文档' : '选择文本文件',
      multiple: false,
      filters: [{ name: filterDesc, extensions: filterExts }]
    });
    if (selected && selected[0]) setFile(selected[0]);
  };

  dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('dragover'); };
  dropzone.ondragleave = () => dropzone.classList.remove('dragover');
  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const p = api.getDroppedPath(e.dataTransfer.files[0]);
      const ext = p.split('.').pop().toLowerCase();
      if (filterExts.includes(ext)) {
        setFile(p);
      } else {
        toast(`请选择 ${filterExts.join('/')} 格式文件`, 'err');
      }
    }
  };

  startBtn.onclick = async () => {
    if (!currentFile) return toast('请先选择文件', 'err');
    const baseName = currentFile.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    const defaultSaveName = `${baseName}.pdf`;

    const savePath = await api.saveFile({
      title: '导出 PDF 保存路径',
      defaultPath: defaultSaveName,
      filters: [{ name: 'PDF 文档 (*.pdf)', extensions: ['pdf'] }]
    });
    if (!savePath) return;

    closeSheet();
    openOutputFromPromise(a.name, run(a.id, { file: currentFile, savePath }, { silent: true }));
  };

  sheet.querySelector('[data-act=cancel]').onclick = closeSheet;
}

function openFileHashModal(a) {
  let currentFile = null;
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg(a.icon)}</div>
      <div>
        <div class="sheet-title">${esc(a.name)}</div>
        <div class="sheet-sub">本地流式哈希计算，支持 GB 级大文件，计算 MD5、SHA-1 和 SHA-256</div>
      </div>
    </div>
    <div class="dropzone" id="hash-dropzone" style="margin-top:14px">
      ${svg('hash')}
      <div class="dz-title" id="hash-dz-title">点击选择文件，或将文件拖拽至此处</div>
      <div class="dz-sub" id="hash-dz-sub">100% 本地运算，文件不会离开计算机</div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-primary" id="btn-start-hash" disabled>开始计算哈希</button>
    </div>`);

  const dropzone = sheet.querySelector('#hash-dropzone');
  const titleEl = sheet.querySelector('#hash-dz-title');
  const subEl = sheet.querySelector('#hash-dz-sub');
  const startBtn = sheet.querySelector('#btn-start-hash');

  const setFile = (filePath) => {
    currentFile = filePath;
    titleEl.textContent = filePath.split(/[\\/]/).pop();
    subEl.textContent = filePath;
    startBtn.disabled = !filePath;
  };

  dropzone.onclick = async () => {
    const selected = await api.selectFiles({ title: '选择要校验的文件', multiple: false });
    if (selected && selected[0]) setFile(selected[0]);
  };

  dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('dragover'); };
  dropzone.ondragleave = () => dropzone.classList.remove('dragover');
  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(api.getDroppedPath(e.dataTransfer.files[0]));
    }
  };

  startBtn.onclick = () => {
    if (!currentFile) return toast('请先选择文件', 'err');
    closeSheet();
    openOutputFromPromise('文件哈希校验', run('file-hash', { file: currentFile }, { silent: true }));
  };

  sheet.querySelector('[data-act=cancel]').onclick = closeSheet;
}

function openTextToolModal(a) {
  const isJson = a.ui.toolType === 'json';
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg(a.icon)}</div>
      <div>
        <div class="sheet-title">${esc(a.name)}</div>
        <div class="sheet-sub">${isJson ? '离线验证与美化 JSON 结构' : '离线转换 Base64 编码与解码'}</div>
      </div>
    </div>
    <textarea class="input" id="tool-text-input" spellcheck="false" style="height:140px;margin-top:12px;font-family:var(--mono);font-size:12.5px"
      placeholder="${isJson ? '在此粘贴待处理的 JSON 内容，例如：{\"name\":\"QuickKeys\"}' : '在此输入需要编码或解码的文本'}"></textarea>
    <div class="radio-row" id="tool-mode-row" style="margin-top:10px">
      ${isJson ? `
        <div class="radio-pill active" data-mode="format">美化排版 (Indent 2)</div>
        <div class="radio-pill" data-mode="minify">压缩单行</div>
      ` : `
        <div class="radio-pill active" data-mode="encode">转为 Base64 (编码)</div>
        <div class="radio-pill" data-mode="decode">Base64 转文本 (解码)</div>
      `}
    </div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-primary" id="btn-run-text-tool">执行转换</button>
    </div>`);

  let mode = isJson ? 'format' : 'encode';
  sheet.querySelectorAll('.radio-pill').forEach((p) => {
    p.onclick = () => {
      mode = p.dataset.mode;
      sheet.querySelectorAll('.radio-pill').forEach((x) => x.classList.toggle('active', x === p));
    };
  });

  sheet.querySelector('#btn-run-text-tool').onclick = () => {
    const text = sheet.querySelector('#tool-text-input').value;
    if (!text.trim()) return toast('请输入内容', 'err');
    closeSheet();
    openOutputFromPromise(a.name, run(a.id, { text, mode }, { silent: true }));
  };

  sheet.querySelector('[data-act=cancel]').onclick = closeSheet;
}

function openInputModal(a) {
  const f = a.ui.field;
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg(a.icon)}</div>
      <div><div class="sheet-title">${esc(a.name)}</div><div class="sheet-sub">${esc(a.desc)}</div></div>
    </div>
    <label class="field-label">${esc(a.ui.label || '输入')}</label>
    <input class="input" id="inp" type="${a.ui.inputType || 'text'}" placeholder="${esc(a.ui.placeholder || '')}" />
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-primary" id="inp-go">执行</button>
    </div>`);
  const input = sheet.querySelector('#inp');
  input.focus();
  const submit = async () => {
    const val = input.value.trim();
    if (a.ui.required !== false && !val) return toast('请输入内容', 'err');
    if (val && a.ui.pattern && !new RegExp(a.ui.pattern).test(val)) return toast('输入格式不正确', 'err');
    closeSheet();
    openOutputFromPromise(a.name, run(a.id, { [f]: val }, { silent: true }));
  };
  sheet.querySelector('#inp-go').onclick = submit;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  sheet.querySelector('[data-act=cancel]').onclick = closeSheet;
}

/* -------------------------------- 终端选择 -------------------------------- */

function openTerminalModal() {
  const t = DATA.terminals;
  const opt = (which, name, sub, icon, available = true) => `
    <div class="terminal-option" data-term="${which}">
      ${svg(icon)}
      <div><div class="t-name">${name}</div><div class="t-sub">${sub}</div></div>
      ${available ? '' : '<span class="unavailable">未安装</span>'}
    </div>`;
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg('terminal')}</div>
      <div><div class="sheet-title">打开终端</div><div class="sheet-sub">选择一个命令行环境</div></div>
    </div>
    <div style="margin-top:14px">
      ${opt('wt', 'Windows Terminal', '现代标签页终端，支持分屏', 'terminal', t.wt)}
      ${opt('powershell', 'PowerShell', '系统默认，适合脚本与管理任务', 'chevrons')}
      ${opt('cmd', '命令提示符 CMD', '经典命令行，批处理兼容', 'play')}
    </div>`);
  sheet.querySelectorAll('.terminal-option').forEach((el) => {
    const which = el.dataset.term;
    if (which === 'wt' && !t.wt) el.style.opacity = '.5';
    el.onclick = () => { closeSheet(); run('terminal', { which }); };
  });
}

/* ------------------------------- 运行任意命令 ------------------------------- */

function openRunboxModal(prefill = '') {
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg('chevrons')}</div>
      <div><div class="sheet-title">执行任意命令</div><div class="sheet-sub">输入 cmd 命令或程序路径，例如：ipconfig /all</div></div>
    </div>
    <textarea class="input" id="cmd" spellcheck="false" placeholder="notepad&#10;start ms-settings:&#10;echo hello">${esc(prefill)}</textarea>
    <label class="field-label">运行方式</label>
    <div class="radio-row" id="mode-row">
      <div class="radio-pill" data-mode="hidden">后台执行</div>
      <div class="radio-pill active" data-mode="output">捕获输出</div>
      <div class="radio-pill" data-mode="terminal">终端中运行</div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-primary" id="cmd-go">运行</button>
    </div>`);
  let mode = 'output';
  const ta = sheet.querySelector('#cmd');
  ta.focus();
  sheet.querySelectorAll('.radio-pill').forEach((p) => {
    p.onclick = () => {
      mode = p.dataset.mode;
      sheet.querySelectorAll('.radio-pill').forEach((x) => x.classList.toggle('active', x === p));
    };
  });
  const submit = async () => {
    const command = ta.value.trim();
    if (!command) return toast('请输入命令', 'err');
    const dangerLabels = detectDanger(command);
    const modeText = mode === 'output' ? '捕获输出' : mode === 'terminal' ? '终端中运行' : '后台执行';
    const confirmed = await confirmSheet(dangerLabels.length ? {
      title: '检测到危险操作，确认执行？',
      message: `该命令包含：${dangerLabels.join('、')}\n\n${command}\n\n运行方式：${modeText}`,
      okText: '仍要执行',
      danger: true,
      icon: 'alert'
    } : {
      title: '确认执行命令',
      message: `将以“${modeText}”方式运行：\n\n${command}`,
      okText: '确认运行',
      danger: false,
      icon: 'terminal'
    });
    if (!confirmed) return;
    if (mode === 'output') return openOutputFromPromise('命令输出', run('run-command', { command, mode, confirmed: true }, { silent: true }));
    run('run-command', { command, mode, confirmed: true });
  };
  sheet.querySelector('#cmd-go').onclick = submit;
  sheet.querySelector('[data-act=cancel]').onclick = closeSheet;
}

/* -------------------------------- 输出面板 -------------------------------- */

function outputSheet(title, iconName, fillTarget) {
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg(iconName)}</div>
      <div><div class="sheet-title">${esc(title)}</div></div>
      <button class="btn btn-secondary" id="copy-out" style="margin-left:auto">${svg('copy')}复制</button>
    </div>
    <div class="output-box loading" id="out"><span class="spinner"></span><span>正在执行，请稍候…</span></div>
    <div class="sheet-actions"><button class="btn btn-primary" data-act="done">完成</button></div>`);
  sheet.querySelector('[data-act=done]').onclick = closeSheet;
  const box = sheet.querySelector('#out');
  const fill = (text, success, filePath) => {
    box.classList.remove('loading');
    box.textContent = text || '（无输出）';
    const icon = sheet.querySelector('.sheet-icon');
    if (!success) { icon.classList.add('danger'); icon.innerHTML = iconSvg('alert'); }
    sheet.querySelector('#copy-out').onclick = () => {
      navigator.clipboard.writeText(text || '').then(() => toast('已复制到剪贴板', 'ok'));
    };
    if (filePath) {
      const actions = sheet.querySelector('.sheet-actions');
      const extra = document.createElement('div');
      extra.style.marginRight = 'auto';
      extra.style.display = 'flex';
      extra.style.gap = '8px';
      extra.innerHTML = `
        <button class="btn btn-secondary" id="btn-open-file">${svg('file-text')}打开文件</button>
        <button class="btn btn-secondary" id="btn-show-folder">${svg('folder')}在文件夹中显示</button>
      `;
      actions.insertBefore(extra, actions.firstChild);
      extra.querySelector('#btn-open-file').onclick = () => api.openPath(filePath);
      extra.querySelector('#btn-show-folder').onclick = () => api.showItemInFolder(filePath);
    }
  };
  Promise.resolve(fillTarget).then((r) => {
    if (typeof r === 'string') return fill(r, true);
    if (!r) return fill('没有返回结果', false);
    fill(r.output || r.message || (r.ok ? '执行完成。' : '执行失败。'), r.ok !== false, r.filePath);
  }).catch((e) => fill(e.message, false));
  return sheet;
}

function openOutputFromPromise(title, promise) {
  return outputSheet(title, 'terminal', promise);
}

function openOutputModal(promiseOrText, ok = true) {
  if (typeof promiseOrText === 'string') return outputSheet('执行结果', ok ? 'check' : 'alert', promiseOrText);
  return outputSheet('执行结果', 'check', promiseOrText);
}

/* ------------------------------- 自定义命令 ------------------------------- */

function openCustomEditor(existing) {
  // 注意：下发到渲染进程的字段名是 runMode（见 executor.customActions），
  // 历史实现误读 existing.mode 导致编辑时运行模式被静默重置为「后台执行」。
  const existingMode = existing ? (existing.runMode || existing.mode || 'hidden') : 'hidden';
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg('plus-circle')}</div>
      <div><div class="sheet-title">${existing ? '编辑命令' : '新建自定义命令'}</div></div>
    </div>
    <label class="field-label">名称</label>
    <input class="input" id="c-name" maxlength="40" placeholder="例如：打开工作目录" value="${esc(existing?.name || '')}" />
    <label class="field-label">说明（可选）</label>
    <input class="input" id="c-desc" maxlength="80" placeholder="一句话说明这个命令做什么" value="${esc(existing?.desc || '')}" />
    <label class="field-label">命令</label>
    <textarea class="input" id="c-cmd" spellcheck="false" placeholder="例如：code E:\\projects&#10;或：start steam://open/main">${esc(existing?.command || '')}</textarea>
    <label class="field-label">运行方式</label>
    <div class="radio-row" id="c-mode">
      <div class="radio-pill ${existingMode === 'hidden' ? 'active' : ''}" data-mode="hidden">后台执行</div>
      <div class="radio-pill ${existingMode === 'terminal' ? 'active' : ''}" data-mode="terminal">终端中运行</div>
      <div class="radio-pill ${existingMode === 'output' ? 'active' : ''}" data-mode="output">捕获输出</div>
    </div>
    <div class="sheet-actions">
      ${existing ? '<button class="btn btn-danger" id="c-del" style="margin-right:auto">删除</button>' : ''}
      <button class="btn btn-ghost" data-act="cancel">取消</button>
      <button class="btn btn-primary" id="c-save">保存</button>
    </div>`);
  let mode = existingMode;
  sheet.querySelectorAll('#c-mode .radio-pill').forEach((p) => {
    p.onclick = () => {
      mode = p.dataset.mode;
      sheet.querySelectorAll('#c-mode .radio-pill').forEach((x) => x.classList.toggle('active', x === p));
    };
  });
  sheet.querySelector('[data-act=cancel]').onclick = closeSheet;
  sheet.querySelector('#c-save').onclick = async () => {
    const action = {
      name: sheet.querySelector('#c-name').value.trim(),
      desc: sheet.querySelector('#c-desc').value.trim(),
      command: sheet.querySelector('#c-cmd').value.trim(),
      mode
    };
    if (!action.name || !action.command) return toast('名称和命令不能为空', 'err');
    const r = existing ? await api.customUpdate(existing.id, action) : await api.customAdd(action);
    if (!r.ok) return toast(r.message || '保存失败', 'err');
    DATA.actions = r.actions;
    toast('已保存', 'ok');
    closeSheet();
    navigate('custom');
  };
  if (existing) {
    sheet.querySelector('#c-del').onclick = async () => {
      const confirmed = await confirmSheet({
        title: '删除自定义命令',
        message: `确定删除「${existing.name}」？此操作不可撤销。`,
        okText: '删除',
        icon: 'trash'
      });
      if (!confirmed) return;
      await api.customRemove(existing.id);
      DATA = await api.getInit();
      toast('已删除', 'ok');
      navigate('custom');
    };
  }
}

/* ================================ 侧栏 ================================ */

function renderSidebar() {
  const footIds = ['shortcuts', 'settings'];
  const main = DATA.categories.filter((c) => !footIds.includes(c.id));
  const foot = DATA.categories.filter((c) => footIds.includes(c.id));
  const groups = [
    { label: '概览', ids: ['home'] },
    { label: '日常', ids: ['power', 'capture', 'launch', 'window', 'convert'] },
    { label: '系统', ids: ['guardian', 'cleaner', 'cdrive', 'contextmenu', 'systools', 'maintain', 'network', 'gaming'] },
    { label: '我的', ids: ['custom', 'tools'] },
  ];
  const knownIds = new Set(groups.flatMap((g) => g.ids));
  const byId = new Map(main.map((c) => [c.id, c]));
  const item = (c) => {
    return `<div class="nav-item ${state.cat === c.id ? 'active' : ''}" data-cat="${c.id}" title="${esc(c.name)}">
      <div class="nav-icon-wrap">${svg(c.icon)}</div>
      <span class="nav-text">${esc(c.name)}</span>
    </div>`;
  };
  const groupHtml = groups.map((g) => {
    const cats = g.ids.map((id) => byId.get(id)).filter(Boolean);
    if (g.label === '系统') {
      main.forEach((c) => { if (!knownIds.has(c.id)) cats.push(c); });
    }
    if (!cats.length) return '';
    return `<div class="nav-group"><div class="nav-section-label">${g.label}</div>${cats.map(item).join('')}</div>`;
  }).join('');
  $('#sidebar').innerHTML = `
    ${groupHtml}
    <div class="sidebar-footer nav-group nav-group-foot">${foot.map(item).join('')}</div>`;
  $$('#sidebar .nav-item').forEach((el) => {
    el.onclick = () => { navigate(el.dataset.cat); $('#search-input').value = ''; state.query = ''; };
  });
}

function navigate(cat) {
  state.cat = cat;
  renderSidebar();
  renderContent();
  $('#main').scrollTop = 0;
}

/* ================================ 横幅 ================================ */

let bannerKey = null;

function renderBanner() {
  const actives = activeTimers();
  const b = $('#timer-banner');
  // 只有计划集合变化时才重建 DOM；否则每秒 tick 只刷新倒计时文本，
  // 避免整体重绘导致按钮聚焦丢失与无谓的性能开销
  const key = actives.map((x) => `${x.mode}:${x.at}`).join('|');
  if (key === bannerKey) return;
  bannerKey = key;
  if (!actives.length) { b.innerHTML = ''; return; }
  const more = actives.length > 1 ? `（另有 ${actives.length - 1} 项计划）` : '';
  b.innerHTML = `
    <div class="timer-banner">
      ${svg('timer')}
      <div>
        <div class="tb-text">${actives.map((x) =>
          `<span>定时${MODE_LABEL[x.mode]} <span class="tb-count" data-at="${x.at}">${fmtRemain(x.at - Date.now())}</span></span>`).join('　')}</div>
        <div class="tb-sub">系统级计时，关闭软件依然有效${more}</div>
      </div>
      <button class="btn btn-secondary" id="banner-cancel">取消计划</button>
    </div>`;
  $('#banner-cancel').onclick = async () => {
    if (actives.length > 1) {
      const confirmed = await confirmSheet({
        title: '取消全部定时计划？',
        message: `将取消 ${actives.map((item) => `定时${MODE_LABEL[item.mode]}`).join('、')}。`,
        okText: '全部取消',
        danger: false,
        icon: 'timer-off'
      });
      if (!confirmed) return;
    }
    for (const t of actives) await run(MODE_CANCEL[t.mode]);
  };
}

setInterval(() => {
  renderBanner();
  $$('[data-at]').forEach((el) => {
    const at = Number(el.dataset.at);
    if (el.classList.contains('count') || el.classList.contains('tb-count')) {
      el.textContent = fmtRemain(at - Date.now());
    }
  });
  const wbTimerEl = document.querySelector('[data-wb-status="shutdown-timer"]');
  if (wbTimerEl) {
    const hasTimer = activeTimers().length > 0;
    wbTimerEl.textContent = getWorkbenchLiveStatusText('shutdown-timer');
    wbTimerEl.classList.toggle('is-amber', hasTimer);
  }
}, 1000);

/* ================================ 内容渲染 ================================ */

function highlightMatch(text, q) {
  if (!text) return '';
  if (!q) return esc(text);
  const words = q.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return esc(text);
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return esc(text).replace(re, '<mark class="highlight">$1</mark>');
}

/**
 * 从动作描述与后端 cliHint 中拆分干净的一句话描述和 CLI 参数胶囊。
 * 避免正文中混入 `(shutdown /s /t 0)` 或 `（/hybrid）` 等冗余命令字符。
 */
function splitActionDescAndCli(a, customCli = '') {
  let desc = String((a && a.desc) || '');
  let cli = String(customCli || (a && a.cliHint) || '').trim();

  // 提取并剥离诸如「关闭计算机（shutdown /s /t 0）」或「回到锁屏界面（Win + L）」里的尾部括号指令
  const tailCliMatch = desc.match(/[（(]((?:shutdown|rundll32|netsh|ipconfig|taskkill|schtasks|powercfg|Win\s*\+\s*[A-Za-z0-9]+|\/hybrid)[^）)]*)[）)]/i);
  if (tailCliMatch) {
    const inner = tailCliMatch[1].trim();
    const parts = inner.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    const cmdPart = parts[0] || '';
    const noteParts = parts.slice(1);
    if (!cli && cmdPart && cmdPart !== '/hybrid') {
      cli = cmdPart;
    }
    if (noteParts.length) {
      desc = desc.replace(tailCliMatch[0], `（${noteParts.join('，')}）`);
    } else {
      desc = desc.replace(tailCliMatch[0], '');
    }
  }

  desc = desc.replace(/^([，,、\s]+)|([，,、\s]+)$/g, '').replace(/([。！？])([，,])/g, '$1');
  return { desc: desc || String((a && a.desc) || ''), cli };
}

function cardHtml(a, idx = 0, q = '', opts = {}) {
  const faved = cfg().favorites.includes(a.id);
  const cat = DATA.categories.find((c) => c.id === a.cat);
  const catName = cat ? cat.name : '';
  const showCat = opts.showCategory === true && !!catName;
  const { desc: cleanDesc, cli } = splitActionDescAndCli(a, opts.cliOverride);
  const titleHtml = q ? highlightMatch(a.name, q) : esc(a.name);
  const descHtml = q ? highlightMatch(cleanDesc, q) : esc(cleanDesc);
  return `
    <div class="action-row qk-cmd-row action-card ${a.danger ? 'danger' : ''} ${faved ? 'faved' : ''}" data-id="${a.id}" tabindex="0">
      <div class="row-leading">
        <div class="row-icon">${svg(a.icon)}</div>
        <div class="row-title">${titleHtml}</div>
        <div class="row-divider"></div>
        <div class="row-desc">${descHtml}</div>
      </div>
      <div class="row-trailing">
        <div class="qk-Progressive-meta">
          ${a.danger ? '<span class="card-badge danger">！谨慎</span>' : ''}
          ${cli ? `<span class="cmd-cli-pill qk-mono">${esc(cli)}</span>` : ''}
          ${showCat ? `<span class="row-cat">${esc(catName)}</span>` : ''}
          <span class="row-enter"><kbd>↵</kbd></span>
        </div>
      </div>
    </div>
  `;
}

function section(title, list, q = '', opts = {}) {
  if (!list.length) return '';
  return `
    <div class="section-title"><span>${title}</span><span class="count qk-tabular">${list.length}</span></div>
    <div class="action-list qk-list-shell">${list.map((a, i) => cardHtml(a, i, q, opts)).join('')}</div>
  `;
}

function renderRecentsSection(recentsList) {
  if (!recentsList.length) return '';
  const rowsHtml = recentsList.map((entry) => {
    const a = entry.action;
    const { desc: cleanDesc, cli } = splitActionDescAndCli(a, entry.cli);
    return `
      <div class="qk-recent-row action-card" data-id="${a.id}" tabindex="0">
        <div class="qk-recent-leading">
          <div class="qk-recent-icon">${svg(a.icon)}</div>
          <div class="row-title">${esc(a.name)}</div>
          <div class="row-divider"></div>
          <div class="row-desc">${esc(cleanDesc)}</div>
        </div>
        <div class="qk-recent-trailing">
          ${cli ? `<span class="cmd-cli-pill qk-mono">${esc(cli)}</span>` : ''}
          <button class="qk-rerun-btn" type="button">再次执行 <span class="qk-mono">↵</span></button>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="section-title"><span>最近使用 · RECENTS</span><span class="count qk-tabular">${recentsList.length}</span></div>
    <div class="qk-recents-shell">${rowsHtml}</div>
  `;
}

function updateKeyboardSelection(index) {
  const rows = Array.from(document.querySelectorAll('.action-row'));
  if (!rows.length || index < 0) {
    state.selectedIndex = -1;
    rows.forEach((row) => row.classList.remove('selected', 'is-focused'));
    return;
  }
  const nextIdx = Math.max(0, Math.min(index, rows.length - 1));
  state.selectedIndex = nextIdx;
  rows.forEach((row, i) => {
    if (i === nextIdx) {
      row.classList.add('selected', 'is-focused');
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      row.classList.remove('selected', 'is-focused');
    }
  });
}

function executeCurrentSelection() {
  const rows = document.querySelectorAll('.action-row');
  if (!rows.length) return;
  const idx = state.selectedIndex >= 0 ? state.selectedIndex : 0;
  const target = rows[idx];
  if (!target) return;
  const id = target.dataset.id;
  if (!id) return;
  const a = actionById(id);
  if (a) activate(a);
}

/* ============================================================
   系统状态与一键加速 (Guardian & System Boost — Monochromatic)
   ============================================================ */

let currentHealth = null;
let topProcesses = [];
let procsExpanded = false;
const selectedApps = new Set();
let deepBoost = false;
const workbenchLiveCache = {
  win11Classic: null,
  startupEnabledCount: null
};

function buildGaugeAndStatsHtml(h) {
  const ready = Boolean(h && typeof h.usedPercent === 'number');
  const strokeDash = 147.65; // 2 * PI * 23.5 (56x56 viewBox)
  const pct = ready ? Math.min(Math.max(h.usedPercent, 0), 100) : 0;
  const offset = ready ? (strokeDash - (strokeDash * pct) / 100) : strokeDash;
  const standbyVal = ready ? Number(h.standbyGB) : 0;
  const standbyAmber = Number.isFinite(standbyVal) && standbyVal > 4;
  const isAmberAlert = standbyAmber || (ready && (h.level === 'danger' || h.level === 'warn'));
  const tagText = !ready ? '检测中' : standbyAmber ? `待机 ${h.standbyGB}GB` : (h.level === 'danger' ? '高负荷' : h.level === 'warn' ? '较繁忙' : '运行良好');

  const gaugeInnerHtml = ready
    ? `<div class="boost-gauge-pct qk-tabular" id="gauge-pct">${pct}<small>%</small></div>`
    : `<div class="boost-gauge-pct" id="gauge-pct"><span class="qk-skeleton qk-skeleton-ring"></span></div>`;

  const statsHtml = ready
    ? `
      <div class="stat-cell"><span class="stat-k">物理内存</span><span class="stat-v qk-tabular"><strong>${h.usedGB}</strong> / ${h.totalGB} GB</span></div>
      <div class="stat-cell"><span class="stat-k">当前可用</span><span class="stat-v qk-tabular"><strong>${h.availableGB}</strong> GB</span></div>
      <div class="stat-cell"><span class="stat-k">待机缓存</span><span class="stat-v qk-tabular ${standbyAmber ? 'is-amber' : ''}"><strong>${h.standbyGB}</strong> GB</span></div>`
    : `
      <div class="stat-cell"><span class="stat-k">物理内存</span><span class="qk-skeleton qk-skeleton-stat"></span></div>
      <div class="stat-cell"><span class="stat-k">当前可用</span><span class="qk-skeleton qk-skeleton-stat"></span></div>
      <div class="stat-cell"><span class="stat-k">待机缓存</span><span class="qk-skeleton qk-skeleton-stat"></span></div>`;

  const detailHtml = ready
    ? `虚拟提交 ${h.commitGB} / ${h.commitLimitGB} GB · 内核池 ${h.kernelPoolGB || '0.0'} GB · 提交率 ${h.commitPercent || 0}%${Number(h.tempSizeMB) > 0 ? ` · 临时文件约 ${h.tempSizeMB} MB` : ''}`
    : `<span class="qk-skeleton qk-skeleton-line"></span>`;

  return `
    <div class="boost-gauge ${ready ? '' : 'is-loading'}">
      <svg viewBox="0 0 56 56" class="gauge-svg" aria-hidden="true">
        <circle class="bg-circle" cx="28" cy="28" r="23.5"></circle>
        <circle class="val-circle ${isAmberAlert ? 'is-amber' : ''}" id="gauge-circle" cx="28" cy="28" r="23.5"
                style="stroke-dasharray:${strokeDash}; stroke-dashoffset:${offset};"></circle>
      </svg>
      <div class="boost-gauge-inner">
        ${gaugeInnerHtml}
      </div>
    </div>
    <div class="boost-info">
      <div class="boost-title-row">
        <div class="boost-title-group">
          <span class="boost-title-main">系统资源监控</span>
          <span class="boost-tag ${isAmberAlert ? 'is-amber' : ''} qk-tabular" id="gauge-tag">${tagText}</span>
        </div>
        <div class="boost-status-pill" id="gauge-text">${ready ? esc(h.statusText) : '正在采样实时内存分配…'}</div>
      </div>
      <div class="boost-stats" id="gauge-stats">${statsHtml}</div>
      <div class="boost-detail-row qk-tabular" id="gauge-detail">${detailHtml}</div>
      <label class="boost-deep">
        <input class="qk-checkbox" type="checkbox" id="boost-deep" ${deepBoost ? 'checked' : ''} />
        <span>启用待机缓存深度刷新（需管理员权限，让文件缓存重新加载）</span>
      </label>
    </div>`;
}

function formatBoostMainText() {
  return selectedApps.size > 0 ? `释放选中 (${selectedApps.size})` : '智能瞬时加速';
}

function renderBoostHero() {
  let procsDrawerHtml = '';
  if (procsExpanded) {
    let procsHtml = '';
    if (topProcesses.length) {
      for (const p of topProcesses) {
        const isChecked = selectedApps.has(p.Key);
        const ro = !!p.ReadOnly;
        procsHtml += `
          <div class="proc-card ${ro ? 'readonly' : ''}" data-proc-key="${esc(p.Key)}">
            <input class="qk-checkbox" type="checkbox" data-key="${esc(p.Key)}" ${isChecked ? 'checked' : ''} ${ro ? 'disabled' : ''} />
            <div class="proc-info">
              <div class="proc-name-row">
                <span class="proc-name">${esc(p.Name)}${p.Count > 1 ? `<span class="proc-count qk-tabular">×${p.Count}</span>` : ''}${ro ? `<span class="proc-badge">${esc(p.Badge)}</span>` : ''}</span>
                <span class="proc-mem qk-tabular">${p.MemMB} MB</span>
              </div>
              <div class="proc-title qk-tabular" title="${esc(p.Path || p.Title)}">${esc(p.Title || p.Path || '应用进程')} · 提交 ${p.PrivateMB} MB</div>
            </div>
          </div>`;
      }
    } else {
      procsHtml = `<div class="empty-hint" style="grid-column:span 2;padding:12px">正在分析后台高耗内存应用…</div>`;
    }

    procsDrawerHtml = `
      <div class="boost-procs-panel" id="procs-drawer">
        <div class="procs-header">
          <span>高耗应用负载排行 · 按应用 TOP 20</span>
          <span style="font-size:11px;color:var(--qk-text-tertiary)">勾选进程整组终止；系统核心保护进程只读</span>
        </div>
        <div class="procs-list">${procsHtml}</div>
      </div>`;
  }

  return `
    <div class="boost-hero-card" id="boost-hero">
      <div class="boost-hero-main">
        <div class="boost-hero-left" id="boost-hero-left">
          ${buildGaugeAndStatsHtml(currentHealth)}
        </div>
        <div class="boost-hero-right">
          <button class="btn-toggle-procs ${procsExpanded ? 'expanded' : ''}" id="btn-toggle-procs" type="button" title="查看后台高耗内存应用排行">
            ${svg('layers')}
            <span>进程负载${topProcesses.length ? ` (${topProcesses.length})` : ''}</span>
            <svg class="chevron-indicator" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m4 6 4 4 4-4"/></svg>
          </button>
          <button class="btn-boost-main" id="btn-quick-boost" type="button">
            ${svg('zap')}
            <span id="boost-btn-text">${formatBoostMainText()}</span>
          </button>
        </div>
      </div>
      ${procsDrawerHtml}
    </div>`;
}

function renderGuardianQuickGrid() {
  return `
    <div class="guardian-grid">
      <div class="guardian-card" data-guardian="startup">
        <div class="guardian-card-icon">${svg('rocket')}</div>
        <div class="guardian-card-body">
          <div class="guardian-card-title">开机自启动管理</div>
          <div class="guardian-card-desc">排查慢速开机项</div>
        </div>
      </div>
      <div class="guardian-card" data-guardian="context-menu">
        <div class="guardian-card-icon">${svg('menu')}</div>
        <div class="guardian-card-body">
          <div class="guardian-card-title">右键菜单管理</div>
          <div class="guardian-card-desc">Win11经典/清理</div>
        </div>
      </div>
      <div class="guardian-card" data-guardian="registry">
        <div class="guardian-card-icon">${svg('shield')}</div>
        <div class="guardian-card-body">
          <div class="guardian-card-title">注册表调优工具</div>
          <div class="guardian-card-desc">显示后缀/常用开关</div>
        </div>
      </div>
      <div class="guardian-card" data-guardian="restart-explorer">
        <div class="guardian-card-icon">${svg('refresh')}</div>
        <div class="guardian-card-body">
          <div class="guardian-card-title">卡顿急救复原</div>
          <div class="guardian-card-desc">一键重启桌面任务栏</div>
        </div>
      </div>
    </div>`;
}

function getWorkbenchLiveStatusText(id) {
  const timers = activeTimers();
  if (id === 'pure-native-context-menu') {
    if (workbenchLiveCache.win11Classic === true) return '当前：Win11 经典模式';
    if (workbenchLiveCache.win11Classic === false) return '当前：Win11 折叠菜单';
    return '当前：探测右键模式…';
  }
  if (id === 'shutdown-timer') {
    if (timers.length) {
      const t = timers[0];
      return `${MODE_LABEL[t.mode] || '定时'}中：${fmtRemain(t.at - Date.now())}`;
    }
    return '当前：无定时计划';
  }
  if (id === 'startup-manager') {
    if (typeof workbenchLiveCache.startupEnabledCount === 'number') {
      return `已启用 ${workbenchLiveCache.startupEnabledCount} 项`;
    }
    return '正在扫描自启项…';
  }
  const staticStatus = {
    'snip-region': '区域与像素取色',
    wifipass: 'WLAN 凭据本地提取',
    'net-clean-proxy': '清理代理与刷新 DNS',
    'restart-explorer': 'Explorer 桌面守护中',
    'images-to-pdf': '纯本地离线引擎'
  };
  return staticStatus[id] || '';
}

function renderWorkbench() {
  const cards = [
    {
      id: 'pure-native-context-menu',
      name: '重置原生右键菜单',
      desc: '屏蔽第三方扩展注入残留，还原系统经典极速响应',
      icon: 'shield',
      badge: '右键管理',
      actionLabel: '复原',
      kbd: ''
    },
    {
      id: 'shutdown-timer',
      name: '定时关机与睡眠',
      desc: '预设倒计时计划任务，无感自动休眠、挂机与关机',
      icon: 'timer',
      badge: '电源任务',
      actionLabel: '定时',
      kbd: ''
    },
    {
      id: 'snip-region',
      name: '屏幕截取与拾色',
      desc: '自由框选 / 窗口 / 全屏截取，支持像素级精准取色',
      icon: 'camera',
      badge: '屏幕工具',
      actionLabel: '',
      kbd: 'Win+Shift+S'
    },
    {
      id: 'wifipass',
      name: '查看已存 Wi-Fi 密码',
      desc: '提取本机历史连接过的所有无线网络并清晰展示密码',
      icon: 'key',
      badge: '网络凭据',
      actionLabel: '提取',
      kbd: ''
    },
    {
      id: 'net-clean-proxy',
      name: '网络代理环境急救',
      desc: '清理残留系统代理与无效路由网关，极速刷新本地 DNS',
      icon: 'trash-2',
      badge: '网络诊断',
      actionLabel: '急救',
      kbd: ''
    },
    {
      id: 'restart-explorer',
      name: '重启 Windows 资源管理器',
      desc: '桌面图标消失、任务栏卡死或异常无响应时平滑重启',
      icon: 'refresh',
      badge: '进程急救',
      actionLabel: '重启',
      kbd: ''
    },
    {
      id: 'startup-manager',
      name: '开机自启动管理',
      desc: '排查高延迟自启引导项，按需关闭后台常驻进程',
      icon: 'rocket',
      badge: '启动优化',
      actionLabel: '管理',
      kbd: ''
    },
    {
      id: 'images-to-pdf',
      name: '图片批量合并为 PDF',
      desc: '本地离线高画质合并多张图片为单份标准 PDF 文档',
      icon: 'file-text',
      badge: '离线转换',
      actionLabel: '合并',
      kbd: ''
    }
  ];

  const timers = activeTimers();
  const hasTimer = timers.length > 0;

  return `
    <div class="workbench-section">
      <div class="workbench-header">
        <div class="workbench-title-box">
          <h2 class="workbench-title">快捷工作台</h2>
          <span class="workbench-subtitle">高频系统维护与实用捷径</span>
        </div>
        <div class="workbench-meta">
          <span class="meta-dot"></span>
          <span>即时响应 · 本地执行</span>
        </div>
      </div>
      <div class="workbench-grid">
        ${cards.map((c) => {
          const statusText = getWorkbenchLiveStatusText(c.id);
          const isAmberStatus = c.id === 'shutdown-timer' && hasTimer;
          return `
          <div class="workbench-card qk-wb-card action-card" data-id="${c.id}">
            <div class="wb-card-top">
              <div class="wb-card-icon">${svg(c.icon)}</div>
              <div class="wb-badge">${c.badge}</div>
            </div>
            <div class="wb-card-mid">
              <div class="wb-card-title">${c.name}</div>
              <div class="wb-card-desc">${c.desc}</div>
            </div>
            <div class="wb-card-bottom">
              <span class="wb-live-status qk-tabular ${isAmberStatus ? 'is-amber' : ''}" data-wb-status="${c.id}">${esc(statusText)}</span>
              <span class="wb-shortcut-action">
                ${c.kbd ? `<span class="wb-shortcut-kbd">${esc(c.kbd)}</span>` : ''}
                ${c.actionLabel ? `<span>${esc(c.actionLabel)}</span>` : ''}
                <span>›</span>
              </span>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
}

let workbenchProbing = false;
async function refreshWorkbenchLiveStatus(root) {
  if (workbenchProbing) return;
  workbenchProbing = true;
  try {
    // 串行探测：两个接口都由 PowerShell 冷启动实现，串行执行避免启动期并发抢 CPU
    try {
      const cm = await api.guardianGetWin11CM();
      if (cm) {
        workbenchLiveCache.win11Classic = Boolean(cm.classic);
        const cmEl = (root || document).querySelector('[data-wb-status="pure-native-context-menu"]');
        if (cmEl) cmEl.textContent = getWorkbenchLiveStatusText('pure-native-context-menu');
      }
    } catch (_) { /* 忽略探测异常，维持友好兜底状态 */ }

    try {
      const startup = await api.guardianGetStartup();
      if (Array.isArray(startup)) {
        const enabledCount = startup.filter((item) => item && item.Enabled !== false).length;
        workbenchLiveCache.startupEnabledCount = enabledCount;
        const stEl = (root || document).querySelector('[data-wb-status="startup-manager"]');
        if (stEl) stEl.textContent = getWorkbenchLiveStatusText('startup-manager');
      }
    } catch (_) { /* 忽略探测异常，维持友好兜底状态 */ }
  } finally {
    workbenchProbing = false;
  }
}

let workbenchProbeArmed = false;
// 启动阶段不主动探测工作台状态（两个接口都靠 PowerShell 冷启动）；
// 等用户第一次点击/按键后再拉取，避免和首屏渲染抢 CPU。
function armWorkbenchProbeOnInteraction() {
  if (workbenchProbeArmed) return;
  workbenchProbeArmed = true;
  const run = () => { if (state.cat === 'home' && !state.query) refreshWorkbenchLiveStatus(); };
  window.addEventListener('pointerdown', run, { once: true });
  window.addEventListener('keydown', run, { once: true });
}

function renderCategoryDrawers() {
  const realCats = DATA.categories.filter((c) => !c.virtual && !['shortcuts', 'settings'].includes(c.id));

  return `
    <div class="vault-section">
      <div class="vault-header">
        <div class="vault-title-box">
          <h2 class="workbench-title">分类工具箱 · 全量命令抽屉</h2>
          <span class="workbench-subtitle">按功能场景收纳</span>
        </div>
        <div class="vault-hint">默认折叠收纳 · 点击展开</div>
      </div>
      <div class="drawer-accordion">
        ${realCats.map((c) => {
          const list = DATA.actions.filter((a) => a.cat === c.id);
          if (!list.length) return '';
          return `
            <div class="drawer-card" data-drawer-cat="${c.id}">
              <div class="drawer-header">
                <div class="drawer-left">
                  <div class="drawer-icon">${svg(c.icon)}</div>
                  <div class="drawer-info">
                    <span class="drawer-title">${c.name}</span>
                    <span class="drawer-sub">包含 ${list.length} 个功能命令</span>
                  </div>
                </div>
                <div class="drawer-right">
                  <span class="drawer-pill qk-tabular">${list.length} 项</span>
                  <div class="drawer-chevron">${svg('chevron-down')}</div>
                </div>
              </div>
              <div class="drawer-body">
                <div class="drawer-inner">
                  <div class="action-list">
                    ${list.map((a, i) => cardHtml(a, i, '', { showCategory: false })).join('')}
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function bindDrawerEvents(root) {
  $$('.drawer-header', root).forEach((header) => {
    header.onclick = (e) => {
      e.stopPropagation();
      const drawer = header.closest('.drawer-card');
      if (drawer) {
        drawer.classList.toggle('expanded');
      }
    };
  });
}

function bindGuardianEvents(root) {
  const boostBtn = root.querySelector('#btn-quick-boost');
  if (boostBtn) {
    boostBtn.onclick = () => triggerBoost();
  }

  const toggleProcsBtn = root.querySelector('#btn-toggle-procs');
  if (toggleProcsBtn) {
    toggleProcsBtn.onclick = async () => {
      procsExpanded = !procsExpanded;
      if (procsExpanded && (!topProcesses.length)) {
        topProcesses = await api.guardianGetTopProcs(20);
      }
      renderContent();
    };
  }

  // 绑定进程卡片勾选（按应用整组，系统进程只读）
  $$('.proc-card', root).forEach((card) => {
    card.onclick = (e) => {
      if (card.classList.contains('readonly')) return;
      const key = card.dataset.procKey;
      const chk = card.querySelector('input[type="checkbox"]');
      if (!chk || chk.disabled) return;
      if (e.target !== chk) {
        chk.checked = !chk.checked;
      }
      if (chk.checked) selectedApps.add(key);
      else selectedApps.delete(key);

      const btnText = root.querySelector('#boost-btn-text');
      if (btnText) {
        btnText.textContent = formatBoostMainText();
      }
    };
  });

  const deepChk = root.querySelector('#boost-deep');
  if (deepChk) {
    deepChk.onchange = () => { deepBoost = deepChk.checked; };
  }

  $$('.guardian-card', root).forEach((card) => {
    card.onclick = () => {
      const type = card.dataset.guardian;
      if (type === 'startup') openStartupModal();
      else if (type === 'context-menu') openContextMenuModal();
      else if (type === 'registry') openRegistryTweaksModal();
      else if (type === 'restart-explorer') {
        const a = actionById('restart-explorer');
        if (a) activate(a);
      }
    };
  });
}

async function refreshSystemHealth() {
  try {
    // 两个接口都会冷启动 PowerShell；串行拉取，避免启动期同时并发两个进程抢 CPU。
    // 健康概览先到先画，再补进程排行，首屏数据不必等两个探测都完成。
    const h = await api.guardianGetHealth();
    currentHealth = h;

    const hero = $('#boost-hero');
    if (!hero) return;

    const leftSlot = $('#boost-hero-left');
    if (leftSlot) {
      leftSlot.innerHTML = buildGaugeAndStatsHtml(h);
      const deepChk = leftSlot.querySelector('#boost-deep');
      if (deepChk) deepChk.onchange = () => { deepBoost = deepChk.checked; };
    }

    // 进程排行按需加载：点开「进程负载」抽屉时才拉取；已加载过才随概览一起刷新。
    if (topProcesses.length || procsExpanded) {
      const procs = await api.guardianGetTopProcs(20);
      topProcesses = procs || [];

      const procsBtn = $('#btn-toggle-procs span');
      if (procsBtn) procsBtn.textContent = `进程负载 (${topProcesses.length})`;
    }
  } catch (e) {
    console.error('refreshSystemHealth failed', e);
  }
}

async function triggerBoost() {
  const btn = $('#btn-quick-boost');
  const hasSelected = selectedApps.size > 0;

  // 勾选的行按应用整组终止（同一应用的多个子进程一起结束，才真的能腾出内存）
  const targets = topProcesses
    .filter((p) => selectedApps.has(p.Key) && !p.ReadOnly)
    .map((p) => ({ name: p.RawName, pids: p.Pids }));

  if (hasSelected && targets.length) {
    const confirmed = await confirmSheet({
      title: `确认终止选中的 ${targets.length} 个应用？`,
      message: `将强制关闭以下正在运行的程序并释放其内存：\n${targets.map((t) => `• ${t.name} (${t.pids.length}个进程)`).join('\n')}\n\n注意：正在编辑且未保存的工作内容可能会丢失。`,
      okText: '立即终止',
      danger: true,
      icon: 'power'
    });
    if (!confirmed) return;
  }

  if (btn) {
    btn.classList.add('boosting');
    btn.innerHTML = `${svg('zap')}<span>${hasSelected ? '正在清理选中…' : '正在加速…'}</span>`;
  }

  toast(hasSelected ? `正在终止 ${targets.length} 个应用（共 ${targets.reduce((n, t) => n + t.pids.length, 0)} 个进程）…` : '正在修剪后台工作集与清理陈旧临时文件…', 'info');

  try {
    const res = await api.guardianBoost({ targetApps: targets, deep: deepBoost });
    selectedApps.clear();
    if (res && res.ok) {
      toast(res.message, 'ok', 6000);
      currentHealth = res.newHealth;
      topProcesses = res.topProcs || [];
      renderContent();
    } else {
      toast('加速过程未发现需清理的垃圾', 'info');
      refreshSystemHealth();
    }
  } catch (e) {
    toast(`加速失败: ${e.message}`, 'err');
  } finally {
    if (btn) {
      btn.classList.remove('boosting');
      btn.innerHTML = `${svg('zap')}<span id="boost-btn-text">${formatBoostMainText()}</span>`;
    }
  }
}

async function openStartupModal() {
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg('rocket')}</div>
      <div class="sheet-head-info">
        <div class="sheet-title">开机自启动管理</div>
        <div class="sheet-sub">智能识别开机项真实中文身份，支持系统计划任务、注册表与目录自启的可逆启闭</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-secondary" id="open-startup-dir" style="height:32px;padding:0 10px;font-size:11.5px">${svg('folder')}启动目录</button>
        <button class="btn btn-secondary" id="open-taskmgr-startup" style="height:32px;padding:0 10px;font-size:11.5px">${svg('cpu')}任务管理器</button>
      </div>
    </div>
    <div class="startup-toolbar">
      <div class="searchbar" style="margin-bottom:0">
        ${svg('search')}
        <input type="text" id="startup-search" placeholder="搜索中文名、原始进程、命令 (如: switch, edge, ctfmon)..." autocomplete="off" />
      </div>
      <div class="segmented" id="startup-tabs">
        <button class="active" data-tab="all">全部 <span class="tab-badge" id="tab-cnt-all">0</span></button>
        <button data-tab="app">第三方应用 <span class="tab-badge" id="tab-cnt-app">0</span></button>
        <button data-tab="task">计划任务自启 <span class="tab-badge" id="tab-cnt-task">0</span></button>
        <button data-tab="core">系统核心/驱动 <span class="tab-badge" id="tab-cnt-core">0</span></button>
        <button data-tab="disabled">已隔离 <span class="tab-badge" id="tab-cnt-disabled">0</span></button>
      </div>
    </div>
    <div class="guardian-sheet-content" id="startup-container">
      <div class="output-box loading"><span class="spinner"></span><span>正在扫描开机启动项…</span></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-primary" data-act="done">完成</button>
    </div>`, 'large');

  sheet.querySelector('[data-act=done]').onclick = closeSheet;
  sheet.querySelector('#open-startup-dir').onclick = () => run('startup-folder');
  sheet.querySelector('#open-taskmgr-startup').onclick = () => run('taskmgr');

  const container = sheet.querySelector('#startup-container');
  const searchInput = sheet.querySelector('#startup-search');
  const tabBtns = sheet.querySelectorAll('#startup-tabs button');

  let currentTab = 'all';
  let currentSearch = '';
  let fullList = [];

  function updateCounts() {
    const total = fullList.length;
    const app = fullList.filter(x => x.Category === 'app').length;
    const task = fullList.filter(x => x.Type === 'Task' || x.Category === 'task').length;
    const core = fullList.filter(x => x.Category === 'core' || x.Category === 'driver' || x.IsCore).length;
    const disabled = fullList.filter(x => !x.Enabled).length;

    const elAll = sheet.querySelector('#tab-cnt-all');
    const elApp = sheet.querySelector('#tab-cnt-app');
    const elTask = sheet.querySelector('#tab-cnt-task');
    const elCore = sheet.querySelector('#tab-cnt-core');
    const elDis = sheet.querySelector('#tab-cnt-disabled');

    if (elAll) elAll.textContent = total;
    if (elApp) elApp.textContent = app;
    if (elTask) elTask.textContent = task;
    if (elCore) elCore.textContent = core;
    if (elDis) elDis.textContent = disabled;
  }

  function renderCards() {
    if (!fullList || !fullList.length) {
      container.innerHTML = '<div class="empty-hint">未检测到任何开机自启动项</div>';
      return;
    }

    const kw = currentSearch.trim().toLowerCase();
    const filtered = fullList.filter(item => {
      if (currentTab === 'app' && item.Category !== 'app') return false;
      if (currentTab === 'task' && item.Type !== 'Task' && item.Category !== 'task') return false;
      if (currentTab === 'core' && item.Category !== 'core' && item.Category !== 'driver' && !item.IsCore) return false;
      if (currentTab === 'disabled' && item.Enabled) return false;

      if (kw) {
        const text = `${item.DisplayName || ''} ${item.Name || ''} ${item.Command || ''} ${item.Advice || ''} ${item.Scope || ''}`.toLowerCase();
        if (!text.includes(kw)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      container.innerHTML = `<div class="empty-hint">没有找到匹配「${esc(currentSearch || currentTab)}」的启动项</div>`;
      return;
    }

    let cardsHtml = `<div style="display:flex;flex-direction:column;gap:6px">`;
    for (const item of filtered) {
      const isDis = !item.Enabled;
      const isCore = item.Category === 'core' || item.IsCore;
      const isDriver = item.Category === 'driver';
      const isTask = item.Type === 'Task' || item.Category === 'task';
      const showRaw = item.DisplayName && item.DisplayName !== item.Name;

      cardsHtml += `
        <div class="startup-card" style="${isDis ? 'opacity:0.6;' : ''}">
          <div class="startup-info">
            <div class="startup-name-row">
              <span class="startup-name" title="${esc(item.DisplayName || item.Name)}">${esc(item.DisplayName || item.Name)}</span>
              ${showRaw ? `<span class="startup-raw-name" title="原始标识">${esc(item.Name)}</span>` : ''}
              <span class="boost-tag">${esc(item.Scope)}</span>
              ${isCore ? '<span class="boost-tag warn">系统核心 · 建议保留</span>' : ''}
              ${isDriver ? '<span class="boost-tag">硬件驱动</span>' : ''}
              ${isTask ? '<span class="boost-tag">计划任务自启</span>' : ''}
            </div>
            <div class="startup-cmd" title="${esc(item.Command)}">${esc(item.Command)}</div>
            ${item.Advice ? `<div class="startup-advice">${esc(item.Advice)}</div>` : ''}
          </div>
          <div class="startup-actions">
            <span class="status-pill ${item.Enabled ? 'active' : 'disabled'}">${item.Enabled ? '运行中' : '已隔离'}</span>
            <label class="switch-label">
              <input type="checkbox" data-startup-toggle="${esc(item.Id)}" ${item.Enabled ? 'checked' : ''} />
              <span class="switch-slider"></span>
            </label>
            <button class="btn btn-ghost" style="color:var(--danger);padding:4px 6px;display:grid;place-items:center" data-del-startup="${esc(item.Id)}" title="彻底删除此启动项">${svg('trash')}</button>
          </div>
        </div>`;
    }
    cardsHtml += `</div>`;
    container.innerHTML = cardsHtml;

    // 绑定可逆切换开关
    container.querySelectorAll('[data-startup-toggle]').forEach((chk) => {
      chk.onchange = async () => {
        const id = chk.dataset.startupToggle;
        const target = fullList.find((x) => x.Id === id);
        if (!target) return;
        const wantEnable = chk.checked;
        const res = await api.guardianToggleStartup(target, wantEnable);
        if (res.ok) {
          toast(`已${wantEnable ? '启用' : '禁用'}「${target.DisplayName || target.Name}」自启动`, 'ok');
          target.Enabled = wantEnable;
          updateCounts();
          renderCards();
        } else {
          toast(`操作失败: ${res.error || '权限受限'}`, 'err');
          chk.checked = !wantEnable;
        }
      };
    });

    // 彻底物理删除
    container.querySelectorAll('[data-del-startup]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.delStartup;
        const target = fullList.find((x) => x.Id === id);
        if (!target) return;
        const ok = await confirmSheet({
          title: '彻底删除开机启动项？',
          message: `确定彻底永久删除「${target.DisplayName || target.Name}」的开机配置？\n注意：此操作物理清除注册表、计划任务或快捷方式，不可恢复！建议优先使用左侧开关进行禁用。`,
          okText: '彻底删除',
          danger: true,
          icon: 'trash'
        });
        if (ok) {
          const res = await api.guardianRemoveStartup(target);
          if (res.ok) {
            toast(`已彻底删除「${target.DisplayName || target.Name}」配置`, 'ok');
            fullList = fullList.filter(x => x.Id !== id);
            updateCounts();
            renderCards();
          } else {
            toast(`删除失败: ${res.error || '权限受限'}`, 'err');
          }
        }
      };
    });
  }

  // 绑定实时搜索
  if (searchInput) {
    searchInput.oninput = (e) => {
      currentSearch = e.target.value;
      renderCards();
    };
  }

  // 绑定 Tab 过滤
  tabBtns.forEach(btn => {
    btn.onclick = () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      renderCards();
    };
  });

  try {
    const list = await api.guardianGetStartup();
    fullList = list || [];
    updateCounts();
    renderCards();
  } catch (e) {
    container.innerHTML = `<div class="empty-hint" style="color:var(--danger)">扫描启动项失败: ${esc(e.message)}</div>`;
  }
}

/* ============================================================
   右键菜单管家 (Context Menu Manager — 增/删/改/一键装)
   ============================================================ */

function openAddCustomContextMenuModal(onSuccess) {
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg('plus')}</div>
      <div class="sheet-head-info">
        <div class="sheet-title">添加自定义右键菜单</div>
        <div class="sheet-sub">支持将任意程序或脚本注入 Windows 右键（写入 HKCU 免提权立即生效）</div>
      </div>
    </div>
    <div class="sheet-body" style="display:flex;flex-direction:column;gap:12px;padding:12px 0">
      <div>
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">菜单显示名称 <span style="color:var(--danger)">*</span></label>
        <input type="text" id="custom-cm-name" class="input-text" placeholder="如：使用 VS Code 打开 / 用终端打开" style="width:100%" />
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">生效范围</label>
        <select id="custom-cm-scope" class="input-text" style="width:100%">
          <option value="background">桌面与文件夹空白处右键</option>
          <option value="file">任意文件右键</option>
          <option value="directory">文件夹右键</option>
        </select>
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">执行命令行 <span style="color:var(--danger)">*</span></label>
        <input type="text" id="custom-cm-cmd" class="input-text" placeholder='如："C:\\Path\\To\\app.exe" "%V"' style="width:100%" />
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">文件模式传 "%1"，桌面或文件夹传 "%V"；支持 exe 或 powershell/cmd 命令</div>
      </div>
      <div>
        <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">自定义图标（可选）</label>
        <input type="text" id="custom-cm-icon" class="input-text" placeholder="exe 绝对路径或留空复用命令图标" style="width:100%" />
      </div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-secondary" data-act="cancel">取消</button>
      <button class="btn btn-primary" data-act="submit">确认添加并写入</button>
    </div>`, 'medium');

  sheet.querySelector('[data-act=cancel]').onclick = closeSheet;
  sheet.querySelector('[data-act=submit]').onclick = async () => {
    const name = sheet.querySelector('#custom-cm-name').value.trim();
    const scope = sheet.querySelector('#custom-cm-scope').value;
    const command = sheet.querySelector('#custom-cm-cmd').value.trim();
    const icon = sheet.querySelector('#custom-cm-icon').value.trim();

    if (!name || !command) {
      toast('菜单名称和执行命令不能为空', 'err');
      return;
    }

    toast('正在写入注册表…', 'info');
    try {
      const res = await api.guardianAddCustomCM({ name, scope, command, icon });
      if (res.ok) {
        toast(res.message, 'ok');
        closeSheet();
        if (typeof onSuccess === 'function') onSuccess();
      } else {
        toast(`添加失败: ${res.error || '未知错误'}`, 'err');
      }
    } catch (e) {
      toast(`写入异常: ${e.message}`, 'err');
    }
  };
}

async function renderContextMenuCore(container, onRefresh) {
  try {
    const [win11Status, rawCmItems, presets] = await Promise.all([
      api.guardianGetWin11CM(),
      api.guardianGetCMItems(true),
      api.guardianGetCMPresets ? api.guardianGetCMPresets() : []
    ]);

    let cmItems = rawCmItems || [];
    let currentTab = 'third'; // 默认优先切到第三方软件 Tab，方便安一眼看到需要管理的流氓项
    let currentSearch = '';

    function getCounts() {
      const all = cmItems.length;
      const third = cmItems.filter(x => x.IsThirdParty).length;
      const desktop = cmItems.filter(x => x.Scope === '桌面空白处').length;
      const file = cmItems.filter(x => x.Scope === '所有文件').length;
      const folder = cmItems.filter(x => x.Scope === '文件夹目录').length;
      const disabled = cmItems.filter(x => !x.Enabled).length;
      return { all, third, desktop, file, folder, disabled };
    }

    function updateTabCounts() {
      const counts = getCounts();
      const elAll = container.querySelector('#cm-cnt-all');
      const elThird = container.querySelector('#cm-cnt-third');
      const elDesktop = container.querySelector('#cm-cnt-desktop');
      const elFile = container.querySelector('#cm-cnt-file');
      const elFolder = container.querySelector('#cm-cnt-folder');
      const elDisabled = container.querySelector('#cm-cnt-disabled');
      const elSummary = container.querySelector('#cm-summary-text');

      if (elAll) elAll.textContent = counts.all;
      if (elThird) elThird.textContent = counts.third;
      if (elDesktop) elDesktop.textContent = counts.desktop;
      if (elFile) elFile.textContent = counts.file;
      if (elFolder) elFolder.textContent = counts.folder;
      if (elDisabled) elDisabled.textContent = counts.disabled;

      const thirdEnabled = cmItems.filter(x => x.IsThirdParty && x.Enabled).length;
      if (elSummary) {
        elSummary.innerHTML = thirdEnabled > 0
          ? `第三方开启: <strong>${thirdEnabled}</strong> 项 · 共 ${cmItems.length} 项`
          : '<span style="color:var(--accent);font-weight:600">已是纯净原生状态</span> · 共 ' + cmItems.length + ' 项';
      }
    }

    function renderList() {
      const listContainer = container.querySelector('#cm-items-list');
      if (!listContainer) return;

      const kw = currentSearch.trim().toLowerCase();
      const filtered = cmItems.filter(item => {
        // Tab filter
        if (currentTab === 'third' && !item.IsThirdParty) return false;
        if (currentTab === 'desktop' && item.Scope !== '桌面空白处') return false;
        if (currentTab === 'file' && item.Scope !== '所有文件') return false;
        if (currentTab === 'folder' && item.Scope !== '文件夹目录') return false;
        if (currentTab === 'disabled' && item.Enabled) return false;

        // Keyword filter
        if (kw) {
          const text = `${item.DisplayName || ''} ${item.Name || ''} ${item.SubText || ''} ${item.Scope || ''} ${item.Clsid || ''}`.toLowerCase();
          if (!text.includes(kw)) return false;
        }
        return true;
      });

      if (!filtered.length) {
        listContainer.innerHTML = `<div class="empty-hint" style="padding:24px 0">没有找到匹配「${esc(currentSearch || currentTab)}」的右键菜单项</div>`;
        return;
      }

      let cardsHtml = '';
      for (const item of filtered) {
        const isDis = !item.Enabled;
        const isCustom = (item.Name || '').startsWith('QK_Custom_');
        const showRaw = item.DisplayName && item.DisplayName !== item.Name;

        cardsHtml += `
          <div class="startup-card" style="${isDis ? 'opacity:0.6;' : ''}">
            <div class="startup-info">
              <div class="startup-name-row">
                <span class="startup-name" title="${esc(item.DisplayName || item.Name)}">${esc(item.DisplayName || item.Name)}</span>
                ${showRaw ? `<span class="startup-raw-name" title="注册表原始标识">${esc(item.Name)}</span>` : ''}
                <span class="boost-tag">${esc(item.Scope)}</span>
                ${item.IsThirdParty ? '<span class="boost-tag">第三方软件</span>' : '<span class="boost-tag warn">系统原生 · 建议保留</span>'}
                ${isCustom ? '<span class="boost-tag" style="background:var(--accent);color:#fff">自定义添加</span>' : ''}
              </div>
              <div class="startup-cmd" title="${esc(item.SubText || item.Name)}">${esc(item.SubText || '系统原生关联或内置命令')}</div>
            </div>
            <div class="startup-actions">
              <span class="status-pill ${item.Enabled ? 'active' : 'disabled'}">${item.Enabled ? '运行中' : '已屏蔽'}</span>
              <label class="switch-label" title="切换启用/屏蔽">
                <input type="checkbox" data-cm-toggle="${esc(item.Id)}" ${item.Enabled ? 'checked' : ''} />
                <span class="switch-slider"></span>
              </label>
              <button class="btn btn-ghost" style="color:var(--danger);padding:4px 6px;display:grid;place-items:center" data-del-id="${esc(item.Id)}" title="从注册表物理抹除此菜单项">
                ${svg('trash')}
              </button>
            </div>
          </div>`;
      }

      listContainer.innerHTML = cardsHtml;

      // 绑定每个项目的就地开关切换（局部更新，零滚动跳变）
      listContainer.querySelectorAll('[data-cm-toggle]').forEach(chk => {
        chk.onchange = async () => {
          if (chk.disabled) return;
          const id = chk.dataset.cmToggle;
          const target = cmItems.find(x => x.Id === id);
          if (!target) return;
          chk.disabled = true;
          const wantEnable = chk.checked;
          try {
            const res = await api.guardianToggleCM(target, wantEnable);
            if (res.ok) {
              target.Enabled = wantEnable;
              toast(`已${wantEnable ? '启用' : '屏蔽'}「${target.DisplayName || target.Name}」右键项`, 'ok');
              updateTabCounts();
              renderList();
            } else {
              toast(`操作失败: ${res.error || '需要管理员权限'}`, 'err');
              chk.checked = !wantEnable;
              chk.disabled = false;
            }
          } catch (e) {
            toast(`操作异常: ${e.message}`, 'err');
            chk.checked = !wantEnable;
            chk.disabled = false;
          }
        };
      });

      // 绑定彻底抹除按钮
      listContainer.querySelectorAll('[data-del-id]').forEach(btn => {
        btn.onclick = async () => {
          const id = btn.dataset.delId;
          const target = cmItems.find(x => x.Id === id);
          if (!target) return;
          const confirmed = await confirmSheet({
            title: `彻底抹除「${target.DisplayName || target.Name}」？`,
            message: `将从 Windows 注册表中物理删除该右键项配置（${target.KeyPath}）。\n\n注意：此操作永久清除注册表键，适合清理已卸载软件残留的死链。建议优先使用左侧开关进行安全屏蔽。确定继续？`,
            okText: '彻底删除',
            danger: true,
            icon: 'trash'
          });
          if (!confirmed) return;
          toast('正在彻底抹除注册表项并刷新资源管理器…', 'info');
          try {
            const res = await api.guardianDeleteCM(target);
            if (res.ok) {
              toast(res.message, 'ok');
              cmItems = cmItems.filter(x => x.Id !== id);
              updateTabCounts();
              renderList();
            } else {
              toast(`删除失败: ${res.error || '需要管理员权限'}`, 'err');
            }
          } catch (e) {
            toast(`删除异常: ${e.message}`, 'err');
          }
        };
      });
    }

    // 初始框架 HTML 注入
    let html = `
      <div class="guardian-banner-box" style="margin-bottom:12px">
        <div style="flex:1">
          <div style="font-size:14px;font-weight:700;color:var(--text)">Win11 经典全展开右键菜单</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:3px">跳过“显示更多选项”折叠步骤，直接展示全功能经典右键（自动安全刷新资源管理器）</div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-shrink:0">
          <label class="switch-label">
            <input type="checkbox" id="w11-classic-toggle" ${win11Status.isClassic ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="btn-add-custom-cm" style="height:32px;padding:0 12px;font-size:12px;display:flex;align-items:center;gap:6px">
            ${svg('plus')}<span>添加自定义右键</span>
          </button>
          <button class="btn btn-secondary" id="btn-pure-cm" style="height:32px;padding:0 12px;font-size:12px;display:flex;align-items:center;gap:6px">
            ${svg('shield')}<span>一键纯净原生右键</span>
          </button>
          <button class="btn btn-secondary" id="btn-restore-all-cm" style="height:32px;padding:0 10px;font-size:11.5px;display:flex;align-items:center;gap:6px">
            ${svg('refresh')}<span>恢复全部扩展</span>
          </button>
        </div>
        <div style="font-size:12px;color:var(--text-3)" id="cm-summary-text"></div>
      </div>

      <!-- 常用神级右键预设专区 -->
      <div style="margin-bottom:16px;padding:12px;background:var(--fill-soft);border:1px solid var(--border-soft);border-radius:10px">
        <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:var(--text);margin-bottom:8px">
          ${svg('zap')}<span style="color:var(--accent)">常用神级右键工具</span>
          <span style="font-size:11px;font-weight:normal;color:var(--text-3);margin-left:4px">一键直接注入系统右键，日常效率倍增</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:8px">
          ${(presets || []).map(p => `
            <div style="display:flex;align-items:center;justify-content:space-between;background:var(--card-bg);padding:8px 10px;border-radius:8px;border:1px solid var(--border-soft)">
              <div style="overflow:hidden;margin-right:6px">
                <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
                <div style="font-size:11px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.desc)}</div>
              </div>
              <button class="btn btn-secondary btn-apply-preset" data-preset-id="${esc(p.id)}" style="height:26px;padding:0 8px;font-size:11px;flex-shrink:0">
                一键装入
              </button>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- 搜索与分类 Tab 栏 -->
      <div class="startup-toolbar" style="margin-bottom:12px">
        <div class="searchbar" style="margin-bottom:0">
          ${svg('search')}
          <input type="text" id="cm-search-input" placeholder="搜索右键菜单名称、关联程序、DLL路径 (如: 百度网盘, 360, VSCode, git)..." autocomplete="off" />
        </div>
        <div class="segmented" id="cm-tabs">
          <button data-tab="all">全部 <span class="tab-badge" id="cm-cnt-all">0</span></button>
          <button class="active" data-tab="third">第三方软件 <span class="tab-badge" id="cm-cnt-third">0</span></button>
          <button data-tab="desktop">桌面空白处 <span class="tab-badge" id="cm-cnt-desktop">0</span></button>
          <button data-tab="file">文件右键 <span class="tab-badge" id="cm-cnt-file">0</span></button>
          <button data-tab="folder">文件夹右键 <span class="tab-badge" id="cm-cnt-folder">0</span></button>
          <button data-tab="disabled">已屏蔽 <span class="tab-badge" id="cm-cnt-disabled">0</span></button>
        </div>
      </div>

      <div id="cm-items-list" style="display:flex;flex-direction:column;gap:6px"></div>
    `;

    container.innerHTML = html;

    // 绑定搜索输入
    const searchInput = container.querySelector('#cm-search-input');
    if (searchInput) {
      searchInput.oninput = (e) => {
        currentSearch = e.target.value;
        renderList();
      };
    }

    // 绑定 Tab 切换
    const tabBtns = container.querySelectorAll('#cm-tabs button');
    tabBtns.forEach(btn => {
      btn.onclick = () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTab = btn.dataset.tab;
        renderList();
      };
    });

    // 绑定添加自定义右键
    const btnAdd = container.querySelector('#btn-add-custom-cm');
    if (btnAdd) {
      btnAdd.onclick = () => openAddCustomContextMenuModal(onRefresh);
    }

    // 绑定预设一键装入
    container.querySelectorAll('.btn-apply-preset').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.presetId;
        btn.disabled = true;
        btn.textContent = '写入中…';
        try {
          const res = await api.guardianApplyCMPreset(id);
          if (res.ok) {
            toast(res.message, 'ok');
            if (typeof onRefresh === 'function') onRefresh();
          } else {
            toast(`装入失败: ${res.error || '权限不足'}`, 'err');
            btn.disabled = false;
            btn.textContent = '一键装入';
          }
        } catch (e) {
          toast(`写入异常: ${e.message}`, 'err');
          btn.disabled = false;
          btn.textContent = '一键装入';
        }
      };
    });

    // 绑定 Win11 经典右键切换
    const toggle = container.querySelector('#w11-classic-toggle');
    if (toggle) {
      toggle.onchange = async () => {
        const wantClassic = toggle.checked;
        toast('正在切换右键菜单并安全刷新资源管理器…', 'info');
        const res = await api.guardianSetWin11CM(wantClassic);
        if (res.ok) {
          toast(wantClassic ? '已开启经典全功能右键菜单' : '已恢复 Win11 默认新版右键菜单', 'ok');
        } else {
          toast(`切换失败: ${res.error || '未知错误'}`, 'err');
          toggle.checked = !wantClassic;
        }
      };
    }

    // 绑定一键纯净原生
    const btnPure = container.querySelector('#btn-pure-cm');
    if (btnPure) {
      btnPure.onclick = async () => {
        const confirmed = await confirmSheet({
          title: '确认一键还原纯净原生右键？',
          message: '将一键屏蔽所有第三方软件注入的右键菜单，并重启资源管理器以恢复纯净系统右键。\n\n操作 100% 可逆：你随时可以在列表中重新勾选开启所需的软件。',
          okText: '立即还原纯净',
          danger: false,
          icon: 'shield'
        });
        if (!confirmed) return;
        toast('正在屏蔽第三方扩展并刷新资源管理器…', 'info');
        try {
          const res = await api.guardianPureCM();
          if (res.ok) {
            toast(res.message, 'ok');
            if (typeof onRefresh === 'function') onRefresh();
          } else {
            toast(`操作失败: ${res.error || '权限不足'}`, 'err');
          }
        } catch (e) {
          toast(`操作异常: ${e.message}`, 'err');
        }
      };
    }

    // 绑定恢复全部
    const btnRestore = container.querySelector('#btn-restore-all-cm');
    if (btnRestore) {
      btnRestore.onclick = async () => {
        const confirmed = await confirmSheet({
          title: '确认恢复全部右键菜单扩展？',
          message: '将恢复所有已屏蔽的右键项并自动刷新资源管理器。',
          okText: '全部恢复',
          danger: false,
          icon: 'refresh'
        });
        if (!confirmed) return;
        toast('正在恢复全部右键项并刷新资源管理器…', 'info');
        try {
          const res = await api.guardianRestoreAllCM();
          if (res.ok) {
            toast(res.message, 'ok');
            if (typeof onRefresh === 'function') onRefresh();
          } else {
            toast(`操作失败: ${res.error || '权限不足'}`, 'err');
          }
        } catch (e) {
          toast(`操作异常: ${e.message}`, 'err');
        }
      };
    }

    // 初始渲染与计数计算
    updateTabCounts();
    renderList();

  } catch (e) {
    container.innerHTML = `<div class="empty-hint" style="color:var(--danger)">读取右键配置失败: ${esc(e.message)}</div>`;
  }
}

function renderContextMenuPage(root) {
  root.innerHTML = `
    <div class="view-animate" style="padding-bottom:24px">
      <div class="section-title"><span>右键菜单管家 · CONTEXT MENU MANAGER</span></div>
      <div id="cm-page-container">
        <div class="output-box loading"><span class="spinner"></span><span>正在读取右键菜单与系统扩展配置…</span></div>
      </div>
    </div>
  `;
  const container = root.querySelector('#cm-page-container');
  renderContextMenuCore(container, () => renderContextMenuPage(root));
}

async function openContextMenuModal() {
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg('menu')}</div>
      <div class="sheet-head-info">
        <div class="sheet-title">右键菜单管家</div>
        <div class="sheet-sub">按需禁用臃肿右键扩展，添加自定义命令或抹除流氓死链</div>
      </div>
    </div>
    <div class="guardian-sheet-content" id="cm-modal-container">
      <div class="output-box loading"><span class="spinner"></span><span>正在读取右键菜单配置…</span></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-primary" data-act="done">完成</button>
    </div>`, 'large');

  sheet.querySelector('[data-act=done]').onclick = closeSheet;
  const container = sheet.querySelector('#cm-modal-container');
  renderContextMenuCore(container, () => openContextMenuModal());
}

async function openRegistryTweaksModal() {
  const sheet = openSheet(`
    <div class="sheet-head">
      <div class="sheet-icon">${svg('shield')}</div>
      <div>
        <div class="sheet-title">系统卫士与注册表调优</div>
        <div class="sheet-sub">一键开启常用高频系统优化，防止木马伪装并释放后台资源</div>
      </div>
      <div style="margin-left:auto">
        <button class="btn btn-secondary" id="btn-open-regedit">${svg('cpu')}打开注册表编辑器</button>
      </div>
    </div>
    <div class="guardian-sheet-content" id="tweaks-container">
      <div class="output-box loading"><span class="spinner"></span><span>正在读取系统配置…</span></div>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-primary" data-act="done">完成</button>
    </div>`);

  sheet.querySelector('[data-act=done]').onclick = closeSheet;
  sheet.querySelector('#btn-open-regedit').onclick = () => run('regedit');
  const container = sheet.querySelector('#tweaks-container');

  try {
    const tweaks = await api.guardianGetTweaks();
    let html = `<div style="display:flex;flex-direction:column;gap:8px">`;
    for (const t of tweaks) {
      html += `
        <div class="tweak-row">
          <div class="tweak-info">
            <div class="tweak-title">${esc(t.name)}</div>
            <div class="tweak-desc">${esc(t.desc)}</div>
          </div>
          <label class="switch-label">
            <input type="checkbox" data-tweak-id="${esc(t.id)}" ${t.enabled ? 'checked' : ''} />
            <span class="switch-slider"></span>
          </label>
        </div>`;
    }
    html += `</div>`;
    container.innerHTML = html;

    container.querySelectorAll('[data-tweak-id]').forEach((chk) => {
      chk.onchange = async () => {
        const id = chk.dataset.tweakId;
        const want = chk.checked;
        const res = await api.guardianSetTweak(id, want);
        if (res.ok) {
          toast(`已${want ? '开启' : '关闭'}该项设置`, 'ok');
        } else {
          toast(`修改失败: ${res.error || '权限不足'}`, 'err');
          chk.checked = !want;
        }
      };
    });
  } catch (e) {
    container.innerHTML = `<div class="empty-hint" style="color:var(--danger)">读取调优配置失败: ${esc(e.message)}</div>`;
  }
}

const HOME_WELCOME_MEMES = [
  // 影视经典
  { tag: '影视', text: '《星际穿越》：“不要温和地走进那个良夜”，也别把工作进度温和地交到未保存的窗口里。' },
  { tag: '影视', text: '《黑客帝国》：红药丸是看清内存占用，蓝药丸是假装卡顿从未发生——今天先点一次加速。' },
  { tag: '影视', text: '《让子弹飞》：“让子弹飞一会儿。”——刚点完清理任务的时候，建议也给后台进程两秒钟。' },
  { tag: '影视', text: '《楚门的世界》：“如果再也见不到你，祝你早安、午安、晚安。”记得顺手把定时睡眠挂上。' },
  { tag: '影视', text: '《武林外传》：“世界如此美妙，我却如此暴躁。”先清下后台进程，电脑不卡心情就好一半。' },
  { tag: '影视', text: '《肖申克的救赎》：“忙着活，或者忙着死。”至于后台那堆开机自启，建议直接选「关闭」。' },
  { tag: '影视', text: '《功夫》：“天下武功，唯快不破。”——用 Alt+Space 呼出全局搜索也是一样的道理。' },
  { tag: '影视', text: '《流浪地球》：“道路千万条，安全第一条。”改注册表和删大文件前，二次确认比后悔更省事。' },
  { tag: '影视', text: '《头号玩家》：绿洲再好玩也要留点精力回现实，游戏瞬时加速完记得按时下线休息。' },
  { tag: '影视', text: '《疯狂动物城》：如果电脑此刻慢得像闪电树懒，先查查是不是 C 盘爆红或者后台在偷跑更新。' },
  // 游戏玩家
  { tag: '游戏', text: '《只狼》：“犹豫，就会败北。”——直接用快捷键直达，省下切五层设置菜单的帧数。' },
  { tag: '游戏', text: '《艾尔登法环》：负重过重会翻滚变慢，电脑开机自启装满一屏幕其实是一个道理。' },
  { tag: '游戏', text: '《赛博朋克 2077》：夜之城没有传奇，只有把内存释放到 40% 以下依然稳如磐石的帧率。' },
  { tag: '游戏', text: '《塞尔达传说》：别光顾着在海拉鲁找呀哈哈，桌面那几个「新建文件夹 (4)」也该收收尾了。' },
  { tag: '游戏', text: '《GTA》：按 F 进入载具，按 Win+Shift+S 截下刚才的高光瞬间。' },
  { tag: '游戏', text: 'Steam 玩家共识：库里 200 款游戏喜加一，最后每天打开的还是桌面那两三个快捷方式。' },
  { tag: '游戏', text: '《文明》经典错觉：“再玩最后一回合就睡觉。”——结果抬头一看天已经亮了。' },
  { tag: '游戏', text: '《我的世界》：整理磁盘就像整理箱子，真正难的不是挖矿，是把杂物分类归位。' },
  { tag: '游戏', text: 'G 胖世界定律：有些数字永远数不到 3，但定时关机倒计时一定会准时归零。' },
  { tag: '游戏', text: '《死亡搁浅》：把大文件从爆红的 C 盘安全搬去其它盘，约等于给系统送了一趟五星快递。' },
  // 金融财经
  { tag: '金融', text: '时间是最昂贵的复利：每天省下三分钟层层翻菜单，一年攒下来就是十几个小时。' },
  { tag: '金融', text: 'K 线看久了就会明白：电脑内存曲线和股市一样，别在最高点上头，该止损清理就清理。' },
  { tag: '金融', text: '所谓流动性危机，放在桌面就是 C 盘只剩 200MB 却还想再导出一个 4K 大视频。' },
  { tag: '金融', text: '分散风险不止适用于资产配置，重要文档也别全堆在桌面同一座孤岛上。' },
  { tag: '金融', text: '市场波动和情绪价值一样难预测，唯独按下快捷键后的确定感从不画大饼。' },
  { tag: '金融', text: '后台软件像悄然滚雪球的杠杆一样偷吃内存时，按下瞬时加速就是最好的风控。' },
  { tag: '金融', text: '真正的隐形通胀，是十年里聊天软件从 50MB 默默膨胀到 50GB 的存储税。' },
  { tag: '金融', text: '止盈靠纪律，关机靠定时——别等凌晨三点才发现自己还没退出“加班盘”。' },
  { tag: '金融', text: '复盘每天最划算的一笔交易：把注意力买在创造上，而不是花在到处找系统开关上。' },
  // 世界人文与科普
  { tag: '世界', text: '热力学第二定律：房间、桌面和下载文件夹都会自发走向混乱，除非定期做功整理。' },
  { tag: '世界', text: '奥卡姆剃刀：“如无必要，勿增实体。”——能一键直达的动作，绝不装三个常驻托盘。' },
  { tag: '世界', text: '“世界是个巨大的草台班子”，能稳定跑起来的电脑配置，全靠某个没人敢删的环境变量。' },
  { tag: '世界', text: '墨菲定律桌面版：越是没按 Ctrl+S 的那份文档，系统越容易在你去倒水时自动重启。' },
  { tag: '世界', text: '薛定谔的剪贴板：在按下 Win+V 之前，你永远不知道刚才到底有没有真正复制成功。' },
  { tag: '世界', text: '时间膨胀理论在桌面也成立：盯着更新进度条看一分钟，体感大约相当于一个世纪。' },
  { tag: '世界', text: '古希腊哲学追求“认识你自己”，现代桌面用户追求“先搞清到底是谁占着 8080 端口”。' },
  { tag: '世界', text: '语言学的尽头是“这个、那个、一下”，而桌面的尽头是「新建文件夹 (最终版2)」。' },
  { tag: '世界', text: '据不完全统计，世界上 90% 标着「临时放桌面」的文件，最后都在桌面上办了永久居留证。' },
  // 极客日常
  { tag: '极客', text: 'Ctrl+C 和 Ctrl+V，依然是人类迄今为止最伟大的双键协同发明。' },
  { tag: '极客', text: '重启能解决 90% 的 Windows 玄学问题，剩下 10% 多半是数据线没插紧。' },
  { tag: '极客', text: '右键菜单如果卡成幻灯片，八成是有个软件在里面偷偷塞了三行推广。' },
  { tag: '极客', text: '能跑起来的脚本就别手痒重构了，它能稳定干活全靠某个早已忘掉的巧合。' },
  { tag: '极客', text: 'Windows 正在寻找问题解决方案…… 五分钟后诚恳答复：没有找到。' },
  { tag: '极客', text: '遇到报错先别慌：只要你没点「发送错误报告」，系统就假装刚刚没崩过。' },
  { tag: '极客', text: 'Win+Shift+S 截完图没弹窗？去剪贴板里找吧，它比你想象的更老实。' },
  { tag: '极客', text: '极简桌面守则第一条：看不见的冗余进程，和清理完的 C 盘一样让人舒心。' },
];

const HOME_LATE_NIGHT_MEMES = [
  { tag: '深夜', text: '夜深了，连系统自动更新都在打瞌睡，手头收个尾就早点休息吧。' },
  { tag: '深夜', text: '凌晨迸发的奇思妙想，明早睡醒再看常常和系统日志一样令人莞尔。' },
  { tag: '深夜', text: '风扇都已经安静下来了，说明今晚这台机子比你更想合盖睡觉。' },
  { tag: '深夜', text: '屏幕色温再暖也替代不了睡眠，忙完这一步把电脑交给定时关机吧。' },
];

const HOME_FRIDAY_MEMES = [
  { tag: '周五', text: '今天周五，唯一真正重要的快捷键叫作「Ctrl+S 保存，然后下班」。' },
  { tag: '周五', text: '周五下午的进度条哪怕爬得再慢，也拦不住周末准点加载完成。' },
  { tag: '周五', text: '周末余额即将到账，清理一遍后台进程就当给这周做个干净的收尾。' },
];

const welcomeState = { item: null, streak: 0 };

function getWelcomeMeta(now = new Date()) {
  const h = now.getHours();
  const day = now.getDay();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  let greeting = '你好，轻唤盒子';
  if (h >= 5 && h < 9) greeting = '早安，新的一天';
  else if (h >= 9 && h < 12) greeting = '上午好';
  else if (h >= 12 && h < 14) greeting = '午安，小憩片刻';
  else if (h >= 14 && h < 18) greeting = '下午好';
  else if (h >= 18 && h < 23) greeting = '晚上好';
  else greeting = '夜深了，注意休息';

  let dayLabel = weekdays[day];
  if (h >= 23 || h < 5) dayLabel = `${weekdays[day]}夜`;
  else if (day === 5) dayLabel = '周五下班倒计时';
  else if (day === 1 && h < 12) dayLabel = '周一开机';
  return { greeting, dayLabel, isLateNight: h >= 23 || h < 5, isFriday: day === 5 };
}

function pickWelcomeMeme(forceNext = false, now = new Date()) {
  if (!forceNext && welcomeState.item) return welcomeState.item;
  const meta = getWelcomeMeta(now);
  const pool = [...HOME_WELCOME_MEMES];
  if (meta.isLateNight) pool.push(...HOME_LATE_NIGHT_MEMES, ...HOME_LATE_NIGHT_MEMES);
  if (meta.isFriday) pool.push(...HOME_FRIDAY_MEMES, ...HOME_FRIDAY_MEMES);
  const curText = welcomeState.item ? welcomeState.item.text : '';
  const candidates = pool.filter((item) => item.text !== curText);
  const list = candidates.length ? candidates : pool;
  welcomeState.item = list[Math.floor(Math.random() * list.length)];
  return welcomeState.item;
}

function renderHomeWelcome() {
  const now = new Date();
  const meta = getWelcomeMeta(now);
  const item = pickWelcomeMeme(false, now);
  return `
    <section class="home-welcome" id="home-welcome" title="点击换一句彩蛋">
      <div class="home-welcome-main">
        <div class="home-welcome-head">
          <h1 class="home-welcome-title">${esc(meta.greeting)}</h1>
          <span class="home-welcome-badge" id="home-welcome-badge">${esc(meta.dayLabel)} · ${esc(item.tag)}彩蛋</span>
        </div>
        <p class="home-welcome-quote" id="home-welcome-quote">${esc(item.text)}</p>
      </div>
      <button class="home-welcome-refresh" id="home-welcome-refresh" type="button">
        ${svg('refresh')}<span>换一句</span>
      </button>
    </section>
  `;
}

function bindHomeWelcome(root) {
  const wrap = $('#home-welcome', root);
  if (!wrap) return;
  const rotateQuote = (e) => {
    e.stopPropagation();
    welcomeState.streak += 1;
    const now = new Date();
    const meta = getWelcomeMeta(now);
    const nextItem = pickWelcomeMeme(true, now);
    const quoteEl = $('#home-welcome-quote', wrap);
    const badgeEl = $('#home-welcome-badge', wrap);
    if (quoteEl) quoteEl.textContent = nextItem.text;
    if (badgeEl) badgeEl.textContent = `${meta.dayLabel} · ${nextItem.tag}彩蛋`;
    if (welcomeState.streak === 5) {
      toast('发现隐藏彩蛋：摸鱼连击 ×5！快捷键记熟了，下班才能走得早');
    } else if (welcomeState.streak === 10) {
      toast('连点 ×10：影视游戏金融梗都被你翻遍了，顺手点下内存加速吧');
    }
  };
  wrap.addEventListener('click', rotateQuote);
}

function matchAction(a, q) {
  const hay = (a.name + ' ' + a.desc + ' ' + (a.keywords || []).join(' ')).toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function renderContent() {
  const root = $('#content');
  const q = state.query.replace(/[　 ]/g, ' ').trim();

  if (q) {
    const list = DATA.actions.filter((a) => matchAction(a, q));
    root.innerHTML = list.length
      ? section(`搜索结果 · RESULTS`, list, q, { showCategory: true })
      : `<div class="empty-hint">未找到与「${esc(q)}」匹配的动作，请尝试其他关键词</div>`;
    bindCards(root);
    updateKeyboardSelection(0);
    return;
  }

  if (state.cat === 'home') {
    const fav = cfg().favorites.map(actionById).filter(Boolean);
    const recentEntries = cfg().recents
      .map((r) => ({ action: actionById(r.id), cli: r.cli || '' }))
      .filter((item) => item.action)
      .slice(0, 5);

    let html = `
      <div class="view-animate">
        ${renderHomeWelcome()}
        ${renderBoostHero()}
        ${renderWorkbench()}
        ${fav.length ? section('已收藏 · FAVORITES', fav, '', { showCategory: true }) : ''}
        ${renderRecentsSection(recentEntries)}
        ${renderCategoryDrawers()}
      </div>
    `;

    root.innerHTML = html;
    bindHomeWelcome(root);
    bindGuardianEvents(root);
    bindDrawerEvents(root);
    // 启动路径只保留「内存概览」一个探测（最多 1 个 PowerShell）；
    // 工作台状态改为用户首次交互后再拉取，避开启动窗口。
    setTimeout(() => { if (state.cat === 'home' && !state.query) refreshSystemHealth(); }, 300);
    // 首屏稳定后再空闲探测工作台状态，避免首页长期停在「探测中…」；
    // 若用户提前交互，下面的 arm 逻辑会立即触发，重复调用有 workbenchProbing 去重。
    setTimeout(() => { if (state.cat === 'home' && !state.query) refreshWorkbenchLiveStatus(); }, 4000);
    armWorkbenchProbeOnInteraction();
  } else if (state.cat === 'gaming') {
    root.innerHTML = renderGamingView();
    bindGamingEvents(root);
    loadGamingData().then(() => {
      if (state.cat === 'gaming') {
        root.innerHTML = renderGamingView();
        bindGamingEvents(root);
      }
    });
  } else if (state.cat === 'contextmenu') {
    renderContextMenuPage(root);
  } else if (state.cat === 'cleaner') {
    renderCleanerView(root);
  } else if (state.cat === 'cdrive') {
    renderCDriveView(root);
  } else if (state.cat === 'guardian') {
    const guardianActions = DATA.actions.filter((a) => a.id.startsWith('sys-') || a.id.includes('manager') || a.id === 'registry-tweaks' || a.cat === 'maintain');
    let html = `
      <div class="view-animate">
        ${renderBoostHero()}
        ${renderGuardianQuickGrid()}
        ${section('安全卫士与系统维护工具 · GUARDIAN & MAINTAIN', guardianActions)}
      </div>
    `;
    root.innerHTML = html;
    bindGuardianEvents(root);
    refreshSystemHealth();
  } else if (state.cat === 'custom') {
    const mine = DATA.actions.filter((a) => a.custom);
    root.innerHTML = `
      <div class="view-animate">
        ${section('我的命令 · CUSTOM', mine)}
        <div class="section-title"><span>新建自定义命令</span></div>
        <div class="action-list qk-list-shell"><div class="action-row qk-cmd-row action-card" id="add-custom" style="justify-content:center;color:var(--qk-text-primary);font-weight:600">
          + 新建自定义命令
        </div></div>
      </div>`;
    $('#add-custom').onclick = () => openCustomEditor();
  } else if (state.cat === 'shortcuts') {
    root.innerHTML = `<div class="view-animate">${renderShortcuts()}</div>`;
    bindShortcuts();
  } else if (state.cat === 'settings') {
    root.innerHTML = `<div class="view-animate">${renderSettings()}</div>`;
    bindSettings();
  } else {
    const list = DATA.actions.filter((a) => a.cat === state.cat);
    root.innerHTML = `<div class="view-animate">${section(catMeta(state.cat).name.toUpperCase(), list)}</div>`;
  }
  bindCards(root);
  updateKeyboardSelection(-1);
  renderBanner();
}

function bindCards(root) {
  $$('.action-row', root).forEach((row, idx) => {
    row.addEventListener('focus', () => {
      updateKeyboardSelection(idx);
    });
  });

  $$('.action-card', root).forEach((card) => {
    card.addEventListener('click', (e) => {
      const fav = e.target.closest('[data-fav]');
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      if (fav) {
        e.stopPropagation();
        api.toggleFavorite(fav.dataset.fav).then((favs) => { DATA.config.favorites = favs; renderContent(); });
        return;
      }
      if (edit) { e.stopPropagation(); openCustomEditor(actionById(edit.dataset.edit)); return; }
      if (del) {
        e.stopPropagation();
        const a = actionById(del.dataset.del);
        confirmSheet({ title: '删除自定义命令', message: `确定删除「${a.name}」？此操作不可撤销。`, okText: '删除', icon: 'trash' })
          .then((ok) => {
            if (!ok) return;
            api.customRemove(del.dataset.del).then(async () => { DATA = await api.getInit(); navigate('custom'); });
          });
        return;
      }
      const action = actionById(card.dataset.id);
      if (action?.custom) {
        confirmAndRunCustom(action);
        return;
      }
      activate(action);
    });
  });
}

/* ============================== 快捷键手册 ============================== */

function keyChips(k) {
  return k.split(/\s*\/\s*/).map((alt) =>
    alt.split('+').map((key) => `<span class="kbd">${esc(key.trim())}</span>`).join('<span class="kbd" style="border:0;background:none;padding:0 1px">+</span>')
  ).join('<span style="color:var(--text-3);padding:0 4px">/</span>');
}

function renderShortcuts() {
  const q = state.query.replace(/[　 ]/g, ' ').trim().toLowerCase();
  const tab = TABS.find((t) => t.id === state.shortcutTab) || TABS[0];
  const tabs = `<div class="tabs-bar"><div class="segmented">${TABS.map((t) =>
    `<button data-tab="${t.id}" class="${t.id === tab.id ? 'active' : ''}">${t.name}</button>`).join('')}</div></div>`;

  const groups = tab.sections.map((g) => {
    const rows = q
      ? g.rows.filter((r) => (r.d + r.k).toLowerCase().includes(q))
      : g.rows;
    if (!rows.length) return '';
    return `<div class="shortcut-group"><h4>${esc(g.title)}</h4>${rows.map((r) =>
      `<div class="shortcut-row"><span class="d">${esc(r.d)}</span><span class="keys">${keyChips(r.k)}</span></div>`).join('')}</div>`;
  }).join('');

  return tabs + `<div class="shortcut-groups">${groups || '<div class="empty-hint">没有匹配的快捷键</div>'}</div>`;
}

function bindShortcuts() {
  $$('.tabs-bar [data-tab]').forEach((b) => {
    b.onclick = () => { state.shortcutTab = b.dataset.tab; renderContent(); };
  });
}

/* ================================ 设置 ================================ */

const ACCENT_SWATCHES = [
  { id: 'slate', title: '雾石蓝', light: '#4A5D7E', dark: '#9DB0D0' },
  { id: 'taupe', title: '暖灰褐', light: '#7A6E63', dark: '#C7B9AC' },
  { id: 'sage', title: '鼠尾草绿', light: '#527060', dark: '#95B8A5' },
  { id: 'ink', title: '青黛墨', light: '#4C525C', dark: '#AEB5C0' },
  { id: 'clay', title: '陶土玫瑰', light: '#A86055', dark: '#D4948A' },
];
const ACCENT_BY_ID = Object.fromEntries(ACCENT_SWATCHES.map((a) => [a.id, a]));

function syncSettingsActiveState() {
  const c = cfg();
  const activeAccent = normalizeAccent(c.accent);
  const activeFont = normalizeFontPreset(c.fontPreset);
  const activeTheme = c.theme || 'system';
  const isDark = resolvedTheme() === 'dark';
  $$('#theme-seg button').forEach((b) => b.classList.toggle('active', b.dataset.themeV === activeTheme));
  $$('.accent-dot').forEach((d) => {
    const sw = ACCENT_BY_ID[d.dataset.accent];
    d.classList.toggle('active', d.dataset.accent === activeAccent);
    if (sw) d.style.background = isDark ? sw.dark : sw.light;
  });
  $$('#font-seg button').forEach((b) => b.classList.toggle('active', b.dataset.fontV === activeFont));
  const swToggle = (sel, key) => { const el = $(sel); if (el) el.classList.toggle('on', !!c[key]); };
  swToggle('#sw-login', 'openAtLogin');
  swToggle('#sw-tray', 'trayEnabled');
  swToggle('#sw-min', 'minimizeToTray');
}

function renderSettings() {
  const c = cfg();
  const s = DATA.system || {};
  const activeAccent = normalizeAccent(c.accent);
  const activeFont = normalizeFontPreset(c.fontPreset);
  const isDark = resolvedTheme() === 'dark';
  const dot = (a) =>
    `<button class="accent-dot ${activeAccent === a.id ? 'active' : ''}" data-accent="${a.id}" title="${a.title}" aria-label="${a.title}" style="background:${isDark ? a.dark : a.light}"></button>`;
  const fontBtns = FONT_PRESETS.map((f) => `
    <button type="button" data-font-v="${f.id}" class="${activeFont === f.id ? 'active' : ''}" style="font-family:${esc(f.family.replace(/"/g, "'"))}">
      <span class="font-name">${esc(f.name)}</span>
      <span class="font-sub">${esc(f.sub)}</span>
    </button>
  `).join('');
  return `
  <div class="settings-wrap">
    <div class="section-title" style="margin-top:4px">外观</div>
    <div class="settings-group">
      <div class="settings-row">
        <div class="txt"><div class="label">主题模式</div><div class="sub">跟随系统，或固定浅色 / 深色</div></div>
        <div class="control">
          <div class="segmented" id="theme-seg">
            <button data-theme-v="system" class="${c.theme === 'system' ? 'active' : ''}">${svg('monitor')}系统</button>
            <button data-theme-v="light" class="${c.theme === 'light' ? 'active' : ''}">${svg('sun')}浅色</button>
            <button data-theme-v="dark" class="${c.theme === 'dark' ? 'active' : ''}">${svg('moon')}深色</button>
          </div>
        </div>
      </div>
      <div class="settings-row">
        <div class="txt"><div class="label">强调色</div><div class="sub">柔和莫兰迪色板，驱动主按钮与全局高亮</div></div>
        <div class="control"><div class="accent-dots">
          ${ACCENT_SWATCHES.map(dot).join('')}
        </div></div>
      </div>
      <div class="settings-row settings-row-stack">
        <div class="txt"><div class="label">界面字体</div><div class="sub">内置 MiSans 与霞鹜文楷离线字库，点击实时切换整套氛围</div></div>
        <div class="control">
          <div class="segmented font-segmented" id="font-seg">${fontBtns}</div>
        </div>
      </div>
    </div>

    <div class="section-title">快捷唤起与游戏瞬时加速</div>
    <div class="settings-group">
      <div class="settings-row">
        <div class="txt"><div class="label">全局搜索快捷键</div>
        <div class="sub">任何界面下按下即可唤起搜索面板（Spotlight），点击右侧后按下新组合键</div></div>
        <div class="control"><button class="hotkey-recorder" id="recorder">${esc(c.globalHotkey || '未设置')}</button></div>
      </div>
      <div class="settings-row">
        <div class="txt"><div class="label">游戏瞬时加速全局热键</div>
        <div class="sub">在全屏游戏或任何界面下按下，后台毫秒级排空内存并将前台游戏锁至 High 优先级，无需切屏</div></div>
        <div class="control"><button class="hotkey-recorder" id="game-recorder">${esc(c.gameBoostHotkey || 'Ctrl+F11')}</button></div>
      </div>
    </div>

    <div class="section-title">行为</div>
    <div class="settings-group">
      <div class="settings-row">
        <div class="txt"><div class="label">默认终端</div><div class="sub">「打开终端」与「终端中运行」使用的环境</div></div>
        <div class="control"><select class="select" id="default-terminal" style="width:180px">
          <option value="auto"${c.defaultTerminal === 'auto' ? ' selected' : ''}>自动（优先 Windows Terminal）</option>
          <option value="wt"${c.defaultTerminal === 'wt' ? ' selected' : ''}>Windows Terminal</option>
          <option value="powershell"${c.defaultTerminal === 'powershell' ? ' selected' : ''}>PowerShell</option>
          <option value="cmd"${c.defaultTerminal === 'cmd' ? ' selected' : ''}>命令提示符 CMD</option>
        </select></div>
      </div>
      <div class="settings-row">
        <div class="txt"><div class="label">开机自动启动</div><div class="sub">登录 Windows 后在后台待命，随时用快捷键唤起</div></div>
        <div class="control"><button class="switch ${c.openAtLogin ? 'on' : ''}" id="sw-login"></button></div>
      </div>
      <div class="settings-row">
        <div class="txt"><div class="label">显示系统托盘图标</div><div class="sub">在右下角托盘提供右键快捷菜单</div></div>
        <div class="control"><button class="switch ${c.trayEnabled ? 'on' : ''}" id="sw-tray"></button></div>
      </div>
      <div class="settings-row">
        <div class="txt"><div class="label">关闭窗口时最小化到托盘</div><div class="sub">关闭主面板后保持后台运行（定时任务不受影响）</div></div>
        <div class="control"><button class="switch ${c.minimizeToTray ? 'on' : ''}" id="sw-min"></button></div>
      </div>
    </div>

    <div class="section-title">数据与关于</div>
    <div class="settings-group">
      <div class="settings-row">
        <div class="txt about-box">
          <b>WinCue · 轻唤盒子</b> v${esc(s.appVersion)}　·　Electron ${esc(s.electron)}<br/>
          ${esc(s.osName)}　·　${esc(s.hostname)} / ${esc(s.user)}<br/>
          偏好、收藏与自定义命令保存在本机配置文件中，不上传任何数据。<br/>
          内嵌字体声明：MiSans © 小米公司；霞鹜文楷 Lite © 落霞孤鹜（SIL OFL 1.1）。
        </div>
        <div class="control" style="flex-direction:column;gap:8px;align-items:flex-end">
          <button class="btn btn-secondary" id="open-config">${svg('folder')}打开配置目录</button>
          <button class="btn btn-secondary" id="open-logs">${svg('file-text')}打开日志目录</button>
          <button class="btn btn-ghost" id="quit-app">${svg('power')}完全退出</button>
        </div>
      </div>
    </div>
  </div>`;
}

function bindSettings() {
  const patchAppearance = (patch) => {
    DATA.config = { ...cfg(), ...patch };
    applyTheme();
    syncSettingsActiveState();
    api.configPatch(patch);
  };
  $$('#theme-seg button').forEach((b) => b.onclick = () => patchAppearance({ theme: b.dataset.themeV }));
  $$('.accent-dot').forEach((d) => d.onclick = () => patchAppearance({ accent: d.dataset.accent }));
  $$('#font-seg button').forEach((b) => b.onclick = () => patchAppearance({ fontPreset: b.dataset.fontV }));
  $('#default-terminal').onchange = (e) => api.configPatch({ defaultTerminal: e.target.value });
  const sw = (id, key) => {
    const el = $(id);
    el.onclick = () => api.configPatch({ [key]: !cfg()[key] });
  };
  sw('#sw-login', 'openAtLogin');
  sw('#sw-tray', 'trayEnabled');
  sw('#sw-min', 'minimizeToTray');
  $('#open-config').onclick = () => api.openConfigFolder();
  $('#open-logs').onclick = () => api.openLogsFolder();
  $('#quit-app').onclick = () => api.quit();

  const bindRecorder = (recId, configKey) => {
    const rec = $(recId);
    if (!rec) return;
    rec.onclick = () => {
      rec.classList.add('recording');
      rec.textContent = '按下组合键（Esc 取消）';
      const handler = (e) => {
        e.preventDefault();
        if (e.key === 'Escape') { finish(cfg()[configKey]); return; }
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        const key = e.key;
        const isModifier = ['Control', 'Alt', 'Shift', 'Meta'].includes(key);
        if (!isModifier && parts.length) {
          const named = { ' ': 'Space', '+': 'Plus', ',': 'Comma', '.': 'Period' };
          parts.push(named[key] || (key.length === 1 ? key.toUpperCase() : key));
          finish(parts.join('+'));
        }
      };
      const finish = (accel) => {
        document.removeEventListener('keydown', handler, true);
        rec.classList.remove('recording');
        rec.textContent = accel;
        if (accel && accel !== cfg()[configKey]) api.configPatch({ [configKey]: accel });
      };
      document.addEventListener('keydown', handler, true);
    };
  };

  bindRecorder('#recorder', 'globalHotkey');
  bindRecorder('#game-recorder', 'gameBoostHotkey');
}

/* ================================ 初始化 ================================ */

function bindChrome() {
  const maximizeButton = $('#win-max');
  const syncMaximizedState = (isMaximized) => {
    document.documentElement.classList.toggle('window-maximized', !!isMaximized);
    maximizeButton.title = isMaximized ? '还原' : '最大化';
    maximizeButton.setAttribute('aria-label', isMaximized ? '还原' : '最大化');
  };

  $('#win-close').onclick = () => api.winControl('close');
  $('#win-min').onclick = () => api.winControl('min');
  maximizeButton.onclick = async () => syncMaximizedState(await api.winControl('max'));
  api.winControl('is-maximized').then(syncMaximizedState);
  api.on('qk:window-maximized', syncMaximizedState);
  $('.titlebar').addEventListener('dblclick', async (e) => {
    if (e.target.closest('button')) return;
    syncMaximizedState(await api.winControl('max'));
  });
  $('#theme-toggle').onclick = () =>
    api.configPatch({ theme: resolvedTheme() === 'dark' ? 'light' : 'dark' });

  // 滚动性能极致优化：滚动期间阻断无谓的 hover 重排重绘
  const mainEl = $('#main');
  if (mainEl) {
    let scrollTimer = null;
    mainEl.addEventListener('scroll', () => {
      if (!mainEl.classList.contains('is-scrolling')) {
        mainEl.classList.add('is-scrolling');
      }
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        mainEl.classList.remove('is-scrolling');
      }, 80);
    }, { passive: true });
  }

  const search = $('#search-input');
  search.addEventListener('input', () => {
    state.query = search.value;
    renderContent();
  });

  // 全键盘闭环驱动 (Keyboard-First Navigation)
  document.addEventListener('keydown', (e) => {
    const hasModal = Boolean($('.sheet, .modal'));
    const isTyping = document.activeElement === search;

    // 1. Escape 层次退出
    if (e.key === 'Escape') {
      if (hasModal) {
        closeSheet();
        return;
      }
      if (search.value) {
        search.value = '';
        state.query = '';
        renderContent();
        return;
      }
      api.winControl('close');
      return;
    }

    // 弹窗打开时不劫持列表光标
    if (hasModal) return;

    // 2. 方向键 ↑ / ↓ 导航
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = typeof state.selectedIndex === 'number' ? state.selectedIndex : -1;
      updateKeyboardSelection(cur < 0 ? 0 : cur + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = typeof state.selectedIndex === 'number' ? state.selectedIndex : -1;
      updateKeyboardSelection(cur <= 0 ? 0 : cur - 1);
      return;
    }

    // 3. Enter 盲打执行选中项
    if (e.key === 'Enter') {
      e.preventDefault();
      executeCurrentSelection();
      return;
    }

    // 4. 输入字符自动维持搜索框焦点
    const otherInput = document.activeElement && document.activeElement !== search &&
      (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (!otherInput && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      if (document.activeElement !== search) {
        search.focus();
      }
    }
  });

  api.on('qk:config-changed', (c) => {
    DATA.config = c;
    applyTheme();
    if (state.cat === 'settings' && $('#font-seg')) {
      syncSettingsActiveState();
    } else {
      renderSidebar();
      renderContent();
    }
  });
  api.on('qk:timers-changed', (t) => { state.timers = t; renderBanner(); });
  api.on('qk:custom-changed', async () => { DATA = await api.getInit(); buildDangerRules(); if (state.cat === 'custom') renderContent(); });
  api.on('qk:open-action', (id) => {
    const a = actionById(id);
    if (a) activate(a);
  });
  api.on('qk:navigate', (view) => navigate(view));
  api.on('qk:show-output', (p) => openOutputModal(p.text || p.message || '', p.ok !== false));
  api.on('qk:hotkey-failed', (p) => {
    toast(`全局快捷键 ${p?.accel || ''} 注册失败：${p?.reason || '可能被其他程序占用'}，可在设置中更换`, 'err', 5200);
  });
  api.on('qk:cleaner-progress', (p) => {
    if (state.cat !== 'cleaner' || !p) return;
    cleanerState.progress = p;
    const sub = $('#qk-cleaner-progress-text');
    const bar = $('#qk-cleaner-progress-bar');
    if (sub && p.phase === 'scanning') {
      const mbText = formatBytesShort(p.totalBytes || 0);
      sub.textContent = `正在扫描：${p.currentName || '...'}（已累计发现 ${mbText}）`;
    }
    if (bar && p.total > 0) {
      const pct = Math.min(100, Math.round(((p.done || 0) / p.total) * 100));
      bar.style.width = `${pct}%`;
    }
  });
}

async function init() {
  try {
    DATA = await api.getInit();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">初始化失败：${esc(e.message)}</div>`;
    console.error('[renderer-error] init failed', e);
    return;
  }
  try {
    state.timers = DATA.config.timers || {};
    buildDangerRules();
    if ($('#title-brand')) $('#title-brand').innerHTML = iconSvg('command');
    applyTheme();
    bindChrome();
    renderSidebar();
    renderContent();
    renderBanner();
    // 通知主进程：监听器已就绪，可以补发排队的消息（如启动阶段核对出的定时计划）
    api.rendererReady();
    // 健康/进程数据由 renderContent() 的首屏渲染统一调度（错峰拉取），这里不再重复调用，
    // 否则启动瞬间会并发拉起两套 PowerShell（getSystemHealth + getTopProcesses）。
  } catch (e) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">渲染失败：${esc(e.message)}<br><small>${esc(e.stack||'')}</small></div>`;
    console.error('[renderer-error] render failed', e);
  }
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('error', (e) => {
  console.error('[renderer-error]', e.message, e.filename, e.lineno);
});

/* ============================================================
   游戏战备专区与掉帧深度排查 (Gaming Battle Center)
   ============================================================ */

let gamingData = {
  profile: null,
  diagnostics: null,
  loading: true
};

async function loadGamingData(force = false) {
  try {
    const [p, d] = await Promise.all([
      api.gamingGetProfile(force),
      api.gamingGetDiagnostics()
    ]);
    gamingData.profile = p;
    gamingData.diagnostics = d;
    gamingData.loading = false;
  } catch (err) {
    console.error('加载游戏战备数据失败:', err);
    gamingData.loading = false;
  }
}

function formatCpuDisplay(raw) {
  return String(raw || '正在读取处理器…')
    .replace(/\((?:R|TM|C)\)/gi, '')
    .replace(/\s+with\s+Radeon\s+Graphics$/i, '')
    .replace(/\s+CPU\s*@.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatGpuDisplay(raw) {
  return String(raw || '正在识别显卡…')
    .replace(/^NVIDIA\s+/i, '')
    .replace(/\s+GPU$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function formatGpuBadge(gpu) {
  const s = String(gpu || '');
  if (/3060/i.test(s)) return '6GB GDDR6';
  if (/4060|3070|4070/i.test(s)) return '8GB GDDR6';
  if (/3050|4050|1650|1660/i.test(s)) return /1660/i.test(s) ? '6GB GDDR6' : '4GB / 6GB';
  return '独立显卡';
}

function formatRamBadge(slots) {
  const s = String(slots || '');
  const mhzMatch = s.match(/(\d{4})\s*MHz/i);
  const speed = mhzMatch ? Number(mhzMatch[1]) : 3200;
  const gen = speed >= 4400 ? 'DDR5' : 'DDR4';
  return `${gen} ${speed}`;
}

function formatRamKitMeta(slots, totalGB) {
  const s = String(slots || '');
  const parts = s.split('+').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const capMatch = parts[0].match(/(\d+)\s*GB/i);
    if (capMatch) return `(${capMatch[1]}G × ${parts.length})`;
  }
  return totalGB ? `(双通道)` : '';
}

function renderGamingView() {
  // 数据未回来前只展示中性占位，避免先把编造的机型/内存值画到屏幕上
  const p = gamingData.profile || {
    manufacturer: '',
    model: '',
    friendlyModel: '正在读取本机硬件信息…',
    cpu: '',
    physicalCores: 0,
    cores: 0,
    gpus: [],
    totalPhysicalGB: 0,
    visibleGB: 0,
    umaVramGB: 0,
    memorySlots: '',
    freeGB: 0,
    standbyGB: 0,
    powerPlan: ''
  };

  const d = gamingData.diagnostics || {
    gameDvr: null,
    hags: null,
    vbs: null,
    powerPlanName: '检测中',
    isHighPerformance: null,
    stickyKeys: null,
    standbyGB: 0
  };

  const standbyVal = Number(p.standbyGB || 0);
  const standbyIsHigh = standbyVal > 3.0;
  const physicalCores = p.physicalCores || 0;
  const threads = p.cores || 0;
  const cpuDisplay = formatCpuDisplay(p.cpu);
  const gpuPrimary = Array.isArray(p.gpus) && p.gpus.length ? p.gpus[0] : '正在识别显卡…';
  const gpuList = Array.isArray(p.gpus) ? p.gpus.filter(Boolean) : [];
  const gpuModeLabel = gpuList.length > 1
    ? `双显卡 · ${gpuList.slice(0, 2).map(formatGpuDisplay).join(' + ')}`
    : gpuList.length === 1 ? formatGpuDisplay(gpuList[0]) : '正在识别显卡…';
  const gpuDisplay = formatGpuDisplay(gpuPrimary);
  const gpuBadge = formatGpuBadge(gpuPrimary);
  const ramBadge = formatRamBadge(p.memorySlots);
  const ramKitMeta = formatRamKitMeta(p.memorySlots, p.totalPhysicalGB);

  // 计算物理内存四段占比（与任务管理器同口径：
  // freeGB 是「可用」且已含待机缓存，因此空闲 = 可用 - 待机，活跃 = 总量 - 固件预留 - 可用）
  const total = p.totalPhysicalGB || 0;
  const uma = p.umaVramGB || 0;
  const round1 = (n) => Math.round(n * 10) / 10;
  const available = round1(Math.min(Number(p.freeGB) || 0, total));
  const standby = round1(Math.min(Math.max(standbyVal, 0), available));
  const free = round1(Math.max(0, available - standby));
  const used = round1(Math.max(0, total - uma - available));

  const usedPct = total > 0 ? Math.round((used / total) * 100) : 0;
  const standbyPct = total > 0 ? Math.round((standby / total) * 100) : 0;
  const freePct = total > 0 ? Math.round((free / total) * 100) : 0;
  const umaPct = Math.max(0, 100 - usedPct - standbyPct - freePct);

  return `
    <div class="view-animate gaming-container" id="gaming-container">

      <!-- 硬件规格档案与实时内存舱 -->
      <div class="gaming-deck">
        <div class="gaming-deck-header">
          <div class="gaming-deck-title-area">
            <div class="gaming-deck-title-top">
              <span class="gaming-deck-badge">${esc((p.model || 'GAMING').toUpperCase())}</span>
              <span class="gaming-deck-model">${esc(p.friendlyModel || p.model)}</span>
            </div>
            <div class="gaming-deck-hotkey">
              ${svg('zap')}
              <span>全局游戏加速热键</span>
              <kbd>${esc(cfg().gameBoostHotkey || 'Ctrl+F11')}</kbd>
              <span>游戏内直接触发，后台静默排空待机内存与提权</span>
            </div>
          </div>
          <div class="gaming-deck-actions">
            <button class="gaming-btn-ghost" id="btn-gaming-refresh" type="button">${svg('refresh')} 刷新状态</button>
            <button class="gaming-btn-combat" id="btn-gaming-quick-ready" type="button">${svg('zap')} 一键战备冲锋</button>
          </div>
        </div>

        <!-- 4 列硬件规格矩阵：零省略号完整展示 -->
        <div class="gaming-grid-4">

          <div class="gaming-cell">
            <div class="gaming-cell-head">
              <span class="gaming-cell-lbl">处理器 CPU</span>
              <span class="gaming-pill">${physicalCores && threads ? `${physicalCores}C / ${threads}T` : '—'}</span>
            </div>
            <div class="gaming-cell-main" title="${esc(p.cpu)}">${esc(cpuDisplay)}</div>
            <div class="gaming-cell-sub">${physicalCores ? `${physicalCores} 物理核心 · ${threads} 逻辑线程` : '正在读取处理器信息'}</div>
          </div>

          <div class="gaming-cell">
            <div class="gaming-cell-head">
              <span class="gaming-cell-lbl">独立显卡 GPU</span>
              <span class="gaming-pill">${esc(gpuBadge)}</span>
            </div>
            <div class="gaming-cell-main" title="${esc(gpuPrimary)}">${esc(gpuDisplay)}</div>
            <div class="gaming-cell-sub">独立显卡 · 硬件编解码加速</div>
          </div>

          <div class="gaming-cell">
            <div class="gaming-cell-head">
              <span class="gaming-cell-lbl">物理内存 RAM</span>
              <span class="gaming-pill">${esc(ramBadge)}</span>
            </div>
            <div class="gaming-cell-main">${p.totalPhysicalGB} GB <span class="gaming-cell-meta">${esc(ramKitMeta)}</span></div>
            <div class="gaming-cell-sub">系统可见 ${p.visibleGB} GB · 固件预留 ${p.umaVramGB} GB</div>
          </div>

          <div class="gaming-cell">
            <div class="gaming-cell-head">
              <span class="gaming-cell-lbl">电源方案</span>
              <span class="gaming-pill">${esc(p.powerPlan || '自定义模式')}</span>
            </div>
            <div class="gaming-cell-main" id="gaming-free-stat">可用 ${available} GB</div>
            <div class="gaming-cell-sub ${standbyIsHigh ? 'is-amber' : ''}" id="gaming-standby-stat">待机缓存 ${p.standbyGB} GB</div>
          </div>

        </div>

        <!-- 物理内存 32GB 实时分段条（单语义琥珀色 + 明度阶梯） -->
        <div class="gaming-mem-bar-wrap">
          <div class="gaming-mem-bar-head">
            <div class="gaming-mem-bar-title">物理内存 ${total} GB 硬件级分配</div>
            <div class="gaming-mem-bar-legend" id="mem-legend-text">
              <span><span class="legend-dot used"></span>活跃 <strong>${used}G</strong></span>
              <span><span class="legend-dot standby"></span>待机缓存 <strong id="legend-standby-val" class="${standbyIsHigh ? 'legend-amber' : ''}">${standby}G</strong></span>
              <span><span class="legend-dot free"></span>剩余空闲 <strong id="legend-free-val">${free}G</strong></span>
              <span><span class="legend-dot uma"></span>核显预留 <strong>${uma}G</strong></span>
            </div>
          </div>
          <div class="gaming-mem-bar">
            <div class="mem-seg used" style="width:${usedPct}%" title="活跃进程内存 ${used}GB"></div>
            <div class="mem-seg standby" id="mem-seg-standby" style="width:${standbyPct}%" title="待机缓存 ${standby}GB"></div>
            <div class="mem-seg free" id="mem-seg-free" style="width:${freePct}%" title="剩余空闲内存 ${free}GB"></div>
            <div class="mem-seg uma" style="width:${umaPct}%" title="核显预留显存 ${uma}GB"></div>
          </div>
        </div>

      </div>

      <!-- 掉帧与卡顿元凶 · 深度体检雷达 -->
      <div class="gaming-radar">
        <div class="gaming-radar-header">
          <div>
            <div class="gaming-radar-title">掉帧与卡顿元凶 · 深度体检雷达</div>
            <div class="gaming-radar-sub">仅异常高开销项亮起琥珀警示，其余保持静默灰阶</div>
          </div>
        </div>

        <div class="gaming-radar-list">

          <!-- 1. 录屏方案开销 -->
          <div class="gaming-radar-row">
            <div class="gaming-radar-left">
              <div class="gaming-status-dot ${d.gameDvr ? 'warn' : ''}"></div>
              <div class="gaming-radar-info">
                <div class="gaming-radar-name">
                  <span>后台录屏方案</span>
                  <span class="gaming-badge ${d.gameDvr ? 'warn' : ''}">${d.gameDvr === null ? '检测中' : d.gameDvr ? 'GameDVR 高开销软录' : '未开启系统软录'}</span>
                </div>
                <div class="gaming-radar-desc">
                  ${d.gameDvr === null
                    ? '正在检测系统录屏方案…'
                    : d.gameDvr
                      ? '当前启用了 Windows 系统自带桌面截流录屏，持续占用 CPU 与总线，团战时易引发 0.1% Low 掉帧。建议改用几乎零损耗的 NVENC 硬件录屏。'
                      : '未检测到系统级桌面软录屏，CPU 与显卡编码通道未受抢占。'}
                </div>
              </div>
            </div>
            <button class="gaming-action-btn btn-secondary" id="btn-open-gamebar-settings" type="button">录屏设置</button>
          </div>

          <!-- 2. 待机内存 (Standby List) 膨胀 -->
          <div class="gaming-radar-row" id="radar-row-standby">
            <div class="gaming-radar-left">
              <div class="gaming-status-dot ${standbyIsHigh ? 'warn' : ''}" id="dot-standby"></div>
              <div class="gaming-radar-info">
                <div class="gaming-radar-name">
                  <span>系统待机内存缓存 (Standby List)</span>
                  <span class="gaming-badge ${standbyIsHigh ? 'warn' : ''}" id="badge-standby">${p.standbyGB} GB ${standbyIsHigh ? '待机内存堆积' : '健康区间'}</span>
                </div>
                <div class="gaming-radar-desc" id="desc-standby">
                  ${standbyIsHigh
                    ? `Windows 缓存堆积了 ${p.standbyGB} GB 待机数据未释放。大型游戏切图或加载贴图时缺少连续可用内存，极易触发卡顿。`
                    : '待机缓存处于健康区间，系统连续可用物理内存响应迅速。'}
                </div>
              </div>
            </div>
            <button class="gaming-action-btn ${standbyIsHigh ? 'btn-primary' : 'btn-secondary'}" id="btn-clean-standby" type="button">${svg('zap')} 立即排空 ${p.standbyGB}GB 缓存</button>
          </div>

          <!-- 3. 双显卡模式与独显直连 -->
          <div class="gaming-radar-row">
            <div class="gaming-radar-left">
              <div class="gaming-status-dot"></div>
              <div class="gaming-radar-info">
                <div class="gaming-radar-name">
                  <span>显卡输出模式</span>
                  <span class="gaming-badge">${esc(gpuModeLabel)}</span>
                </div>
                <div class="gaming-radar-desc">
                  混合输出模式下画面经核显中转存在 10%~15% 帧率损耗；建议在《联想电脑管家》或 BIOS 中切为独显直连模式。
                </div>
              </div>
            </div>
            <button class="gaming-action-btn btn-secondary" id="btn-open-nvidia-panel" type="button">NVIDIA 控制面板</button>
          </div>

          <!-- 4. Windows 电源计划 -->
          <div class="gaming-radar-row">
            <div class="gaming-radar-left">
              <div class="gaming-status-dot ${d.isHighPerformance ? '' : 'warn'}"></div>
              <div class="gaming-radar-info">
                <div class="gaming-radar-name">
                  <span>电源性能调度</span>
                  <span class="gaming-badge ${d.isHighPerformance ? '' : 'warn'}">${esc(d.powerPlanName)}</span>
                </div>
                <div class="gaming-radar-desc">
                  ${d.isHighPerformance === null
                    ? '正在读取当前电源方案…'
                    : d.isHighPerformance
                      ? '当前处于高性能电源调度，CPU 主频不会被系统节能策略抑制。'
                      : `当前电源方案为「${esc(d.powerPlanName)}」，不属于高性能/卓越性能计划，CPU 可能动态降频；如遇掉帧可激活卓越性能。`}
                </div>
              </div>
            </div>
            <button class="gaming-action-btn btn-secondary" id="btn-enable-ultimate-power" type="button">激活卓越性能</button>
          </div>

          <!-- 5. 硬件加速 GPU 计划 (HAGS) -->
          <div class="gaming-radar-row">
            <div class="gaming-radar-left">
              <div class="gaming-status-dot ${d.hags ? '' : 'warn'}"></div>
              <div class="gaming-radar-info">
                <div class="gaming-radar-name">
                  <span>硬件加速 GPU 计划 (HAGS)</span>
                  <span class="gaming-badge ${d.hags ? '' : 'warn'}">${d.hags === null ? '检测中' : d.hags ? '已开启' : '未开启'}</span>
                </div>
                <div class="gaming-radar-desc">
                  由独立显卡芯片自主管理显存调度，降低 CPU 开销并改善 1% Low 最低帧。
                </div>
              </div>
            </div>
            <span class="gaming-radar-tag">系统硬件直调</span>
          </div>

          <!-- 6. 核心隔离 (VBS) -->
          <div class="gaming-radar-row">
            <div class="gaming-radar-left">
              <div class="gaming-status-dot ${!d.vbs ? '' : 'warn'}"></div>
              <div class="gaming-radar-info">
                <div class="gaming-radar-name">
                  <span>内核隔离 / VBS 虚拟化防护</span>
                  <span class="gaming-badge ${!d.vbs ? '' : 'warn'}">${d.vbs === null ? '检测中' : d.vbs ? '运行中 (损耗 5%~15%)' : '已关闭'}</span>
                </div>
                <div class="gaming-radar-desc">
                  ${d.vbs === null
                    ? '正在检测内核隔离状态…'
                    : d.vbs
                      ? 'Windows 核心隔离运行中，可能会导致游戏帧率下降 5%~20%，可按需在安全中心关闭。'
                      : '内核虚拟化已关闭，CPU 算力全部开放给游戏，无额外虚拟化开销。'}
                </div>
              </div>
            </div>
            <span class="gaming-radar-tag">${d.vbs === null ? '检测中' : d.vbs ? '建议检查' : '无额外损耗'}</span>
          </div>

        </div>
      </div>

      <!-- 游戏战备急救箱 · 6 大硬核直达工具 -->
      <div class="gaming-tools-section">
        <div class="gaming-radar-header">
          <div>
            <div class="gaming-radar-title">游戏战备急救箱 · 核心工具</div>
            <div class="gaming-radar-sub">一键直达，不打断激战</div>
          </div>
        </div>

        <div class="gaming-tools-grid">

          <div class="gaming-tool-card" data-act="clean-standby">
            <div class="gaming-tool-top">
              <div class="gaming-tool-icon">${svg('zap')}</div>
              <span class="wb-badge">防爆内存</span>
            </div>
            <div>
              <div class="gaming-tool-title">排空待机缓存</div>
              <div class="gaming-tool-desc">瞬间排空 Standby List，为游戏切图腾出纯净大内存</div>
            </div>
          </div>

          <div class="gaming-tool-card" data-act="open-joy">
            <div class="gaming-tool-top">
              <div class="gaming-tool-icon">${svg('gamepad')}</div>
              <span class="wb-badge">外设测漂移</span>
            </div>
            <div>
              <div class="gaming-tool-title">手柄控制器校准</div>
              <div class="gaming-tool-desc">直达 Windows 原生测试面板，即插即测摇杆与按键响应</div>
            </div>
          </div>

          <div class="gaming-tool-card" data-act="disable-sticky">
            <div class="gaming-tool-top">
              <div class="gaming-tool-icon">${svg('keyboard')}</div>
              <span class="wb-badge">防断指弹窗</span>
            </div>
            <div>
              <div class="gaming-tool-title">彻底禁用粘滞键</div>
              <div class="gaming-tool-desc">连按 5 次 Shift 永不弹窗打断走位，FPS 必备</div>
            </div>
          </div>

          <div class="gaming-tool-card" data-act="kill-frozen">
            <div class="gaming-tool-top">
              <div class="gaming-tool-icon">${svg('trash')}</div>
              <span class="wb-badge">黑屏急救</span>
            </div>
            <div>
              <div class="gaming-tool-title">卡死未响应游戏强退</div>
              <div class="gaming-tool-desc">秒杀全屏卡死黑屏无响应的窗口，免去强制重启电脑</div>
            </div>
          </div>

          <div class="gaming-tool-card" data-act="flush-dns">
            <div class="gaming-tool-top">
              <div class="gaming-tool-icon">${svg('wifi')}</div>
              <span class="wb-badge">网络急救</span>
            </div>
            <div>
              <div class="gaming-tool-title">Steam / 联机网络急救</div>
              <div class="gaming-tool-desc">刷新本地 DNS 缓存并重置 Winsock，修复 118 社区打不开</div>
            </div>
          </div>

          <div class="gaming-tool-card" data-act="open-saves">
            <div class="gaming-tool-top">
              <div class="gaming-tool-icon">${svg('folder')}</div>
              <span class="wb-badge">存档直达</span>
            </div>
            <div>
              <div class="gaming-tool-title">游戏本地存档目录</div>
              <div class="gaming-tool-desc">直达系统 Saved Games 文件夹，备份或替换单机游戏进度</div>
            </div>
          </div>

        </div>
      </div>

    </div>
  `;
}

// 待机缓存排空动效与数字滚动冲刺引擎
function animateStandbyFlush(root) {
  const p = gamingData.profile || {};
  const total = p.totalPhysicalGB || 32.0;
  const startStandby = Number(p.standbyGB || 9.5);
  const startFree = Number(p.freeGB || 9.6);
  const targetStandby = Math.min(0.4, startStandby);
  const freedDelta = Math.max(0, startStandby - targetStandby);
  const targetFree = Math.round((startFree + freedDelta) * 10) / 10;

  const standbySeg = root.querySelector('#mem-seg-standby');
  const freeSeg = root.querySelector('#mem-seg-free');
  const standbyVal = root.querySelector('#legend-standby-val');
  const freeVal = root.querySelector('#legend-free-val');
  const standbyStat = root.querySelector('#gaming-standby-stat');
  const freeStat = root.querySelector('#gaming-free-stat');
  const badge = root.querySelector('#badge-standby');
  const dot = root.querySelector('#dot-standby');
  const desc = root.querySelector('#desc-standby');
  const cleanBtn = root.querySelector('#btn-clean-standby');

  if (standbySeg) standbySeg.style.width = `${Math.max(1, Math.round((targetStandby / total) * 100))}%`;
  if (freeSeg) freeSeg.style.width = `${Math.max(5, Math.round((targetFree / total) * 100))}%`;

  if (dot) dot.className = 'gaming-status-dot';
  if (badge) {
    badge.className = 'gaming-badge';
    badge.textContent = `${targetStandby} GB 健康区间`;
  }
  if (standbyStat) standbyStat.className = 'gaming-cell-sub';
  if (standbyVal) standbyVal.className = '';
  if (desc) {
    desc.textContent = '待机缓存处于健康区间，系统连续可用物理内存充裕，游戏切场景零阻塞。';
  }
  if (cleanBtn) {
    cleanBtn.className = 'gaming-action-btn btn-secondary';
    cleanBtn.innerHTML = svg('check') + ' 待机缓存已排空';
    cleanBtn.disabled = true;
  }

  let curr = startStandby;
  const step = Math.max(0.2, freedDelta / 18);
  const timer = setInterval(() => {
    curr = Math.max(targetStandby, Math.round((curr - step) * 10) / 10);
    const curFree = Math.round((startFree + (startStandby - curr)) * 10) / 10;
    if (standbyVal) standbyVal.textContent = `${curr}G`;
    if (standbyStat) standbyStat.textContent = `待机缓存 ${curr} GB`;
    if (freeVal) freeVal.textContent = `${curFree}G`;
    if (freeStat) freeStat.textContent = `空闲 ${curFree} GB`;
    if (curr <= targetStandby) {
      clearInterval(timer);
    }
  }, 25);
}

function bindGamingEvents(root) {
  // 刷新状态
  const refreshBtn = root.querySelector('#btn-gaming-refresh');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '正在刷新...';
      await loadGamingData(true);
      if (state.cat === 'gaming') {
        renderContent();
      }
      toast('硬件画像与掉帧雷达已更新', 'ok');
    };
  }

  // 一键战备冲锋 (带冲刺反馈动画)
  const quickReadyBtn = root.querySelector('#btn-gaming-quick-ready');
  if (quickReadyBtn) {
    quickReadyBtn.onclick = async () => {
      quickReadyBtn.disabled = true;
      quickReadyBtn.textContent = '冲锋优化中...';
      animateStandbyFlush(root);
      await api.gamingCleanStandby();
      await api.gamingAction('enable-power');
      setTimeout(async () => {
        await loadGamingData(true);
        if (state.cat === 'gaming') renderContent();
        toast('待机缓存已排空，CPU 性能调度已就绪！', 'ok');
      }, 900);
    };
  }

  // 单独排空待机缓存 (带冲刺反馈动画)
  const cleanStandbyBtn = root.querySelector('#btn-clean-standby');
  if (cleanStandbyBtn) {
    cleanStandbyBtn.onclick = async () => {
      cleanStandbyBtn.disabled = true;
      cleanStandbyBtn.textContent = '正在排空...';
      animateStandbyFlush(root);
      const res = await api.gamingCleanStandby();
      setTimeout(async () => {
        await loadGamingData(true);
        if (state.cat === 'gaming') renderContent();
        toast(res.message || '待机内存已排空', res.ok ? 'ok' : 'err');
      }, 900);
    };
  }

  // 激活卓越性能
  const powerBtn = root.querySelector('#btn-enable-ultimate-power');
  if (powerBtn) {
    powerBtn.onclick = async () => {
      const res = await api.gamingAction('enable-power');
      await loadGamingData(true);
      if (state.cat === 'gaming') renderContent();
      toast(res.message, res.ok ? 'ok' : 'err');
    };
  }

  // 打开录屏设置
  const gamebarBtn = root.querySelector('#btn-open-gamebar-settings');
  if (gamebarBtn) {
    gamebarBtn.onclick = () => api.openExternal('ms-settings:gaming-gamebar');
  }

  // 打开 NVIDIA 控制面板
  const nvBtn = root.querySelector('#btn-open-nvidia-panel');
  if (nvBtn) {
    nvBtn.onclick = () => api.execute('open-nvidia-control', {});
  }

  // 6 大工具卡片事件
  root.querySelectorAll('.gaming-tool-card').forEach((card) => {
    card.onclick = async () => {
      const act = card.dataset.act;
      if (act === 'clean-standby') {
        animateStandbyFlush(root);
        const res = await api.gamingCleanStandby();
        setTimeout(async () => {
          await loadGamingData(true);
          if (state.cat === 'gaming') renderContent();
          toast(res.message, res.ok ? 'ok' : 'err');
        }, 900);
      } else if (act === 'open-joy') {
        api.gamingAction('open-joy');
      } else if (act === 'disable-sticky') {
        const res = await api.gamingAction('disable-sticky');
        toast(res.message, res.ok ? 'ok' : 'err');
      } else if (act === 'kill-frozen') {
        const res = await api.gamingAction('kill-frozen');
        toast(res.message, res.ok ? 'ok' : 'err');
      } else if (act === 'flush-dns') {
        await api.execute('flush-dns', {});
        toast('DNS 缓存已刷新，网络重试连接', 'ok');
      } else if (act === 'open-saves') {
        api.gamingAction('open-saves');
      }
    };
  });
}

/* ==================== 垃圾清理 & C 盘专清视图 (HIG Bento) ==================== */

function formatBytesShort(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '0 MB';
  const gb = b / 1073741824;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
  const mb = b / 1048576;
  if (mb >= 0.1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  const kb = b / 1024;
  return `${Math.max(1, Math.round(kb))} KB`;
}

function formatShortDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const cleanerState = {
  status: 'idle', // idle | scanning | ready | cleaning | done
  progress: null,
  data: null,
  selected: new Set(),
  result: null
};

async function startJunkScan() {
  if (cleanerState.status === 'scanning' || cleanerState.status === 'cleaning') return;
  cleanerState.status = 'scanning';
  cleanerState.result = null;
  cleanerState.progress = { phase: 'scanning', currentName: '初始化扫描器…', done: 0, total: 10, totalBytes: 0 };
  if (state.cat === 'cleaner') renderContent();

  try {
    const res = await api.cleanerScan();
    if (res && res.ok) {
      cleanerState.data = res;
      cleanerState.selected = new Set(
        (res.items || []).filter((it) => it.tier === 'safe' && it.bytes > 0).map((it) => it.id)
      );
      cleanerState.status = 'ready';
    } else {
      cleanerState.status = 'idle';
      toast('扫描未完成', 'err');
    }
  } catch (e) {
    cleanerState.status = 'idle';
    toast(`扫描出错：${e.message}`, 'err');
  }
  if (state.cat === 'cleaner') renderContent();
}

function renderCleanerView(root) {
  if (cleanerState.status === 'idle' && !cleanerState.data) {
    setTimeout(() => {
      if (state.cat === 'cleaner' && cleanerState.status === 'idle') startJunkScan();
    }, 20);
  }

  const d = cleanerState.data;
  const items = d ? (d.items || []) : [];
  const safeItems = items.filter((it) => it.tier === 'safe');
  const confirmItems = items.filter((it) => it.tier === 'confirm');
  const selectedBytes = items
    .filter((it) => cleanerState.selected.has(it.id))
    .reduce((s, it) => s + (it.bytes || 0), 0);

  const isScanning = cleanerState.status === 'scanning';
  const isCleaning = cleanerState.status === 'cleaning';
  const cDrive = d && d.cDrive;
  const cFreeText = cDrive
    ? `C 盘可用 ${formatBytesShort(cDrive.freeBytes)} / ${formatBytesShort(cDrive.totalBytes)}`
    : '等待探测系统磁盘水位';

  const heroTitle = isScanning
    ? '正在深度扫描可清理垃圾…'
    : isCleaning
      ? '正在安全清理已选项目…'
      : d
        ? `已发现可清理垃圾 ${formatBytesShort(d.totalBytes)}`
        : '准备扫描系统垃圾与软件缓存';

  const heroSub = isScanning
    ? (cleanerState.progress?.currentName ? `正在扫描：${cleanerState.progress.currentName}` : '正在枚举临时目录与客户端缓存…')
    : `${cFreeText} · 默认仅勾安全缓存，聊天库与文档受保护`;

  const pct = isScanning && cleanerState.progress?.total > 0
    ? Math.min(100, Math.round(((cleanerState.progress.done || 0) / cleanerState.progress.total) * 100))
    : d ? 100 : 0;

  const renderGroupRow = (it) => {
    const checked = cleanerState.selected.has(it.id);
    const iconName = it.isRecycleBin ? 'trash' : (it.group === 'apps' ? 'layers' : 'folder');
    const isWarnSize = it.bytes >= 1024 * 1048576;
    const badge = it.tier === 'safe'
      ? '<span class="qk-pill-neutral">安全清理</span>'
      : '<span class="qk-pill-amber">需确认</span>';
    const firstPath = Array.isArray(it.paths) && it.paths[0] ? it.paths[0] : '';

    return `
      <div class="qk-clean-row" data-rule-row="${esc(it.id)}">
        <div class="qk-clean-row-left">
          <input class="qk-checkbox" type="checkbox" data-clean-id="${esc(it.id)}" ${checked ? 'checked' : ''} ${it.bytes <= 0 || isScanning || isCleaning ? 'disabled' : ''} />
          <div class="row-icon">${svg(iconName)}</div>
          <div class="qk-clean-row-info">
            <div class="qk-clean-row-title">
              <span>${esc(it.name)}</span>
              ${badge}
            </div>
            <div class="qk-clean-row-desc">${esc(it.desc)}</div>
          </div>
        </div>
        <div class="qk-clean-row-right">
          <div style="text-align:right">
            <div class="qk-size-num ${isWarnSize ? 'is-amber' : ''}">${formatBytesShort(it.bytes)}</div>
            <div class="qk-size-sub">${it.files ? `${it.files.toLocaleString()} 项` : '无堆积'}</div>
          </div>
          ${firstPath ? `<button class="qk-icon-btn" data-open-folder="${esc(firstPath)}" title="打开目录位置">${svg('folder')}</button>` : ''}
        </div>
      </div>`;
  };

  root.innerHTML = `
    <div class="view-animate qk-clean-shell">
      <div class="qk-clean-hero">
        <div class="qk-clean-hero-top">
          <div class="qk-clean-hero-main">
            <div class="qk-clean-icon-hero">${svg('broom')}</div>
            <div style="min-width:0;flex:1">
              <div class="qk-clean-hero-title">
                <span>${esc(heroTitle)}</span>
                ${d && selectedBytes > 0 ? `<span class="qk-clean-hero-num ${selectedBytes >= 1073741824 ? 'is-amber' : ''}">已选 ${formatBytesShort(selectedBytes)}</span>` : ''}
              </div>
              <div class="qk-clean-hero-sub" id="qk-cleaner-progress-text">${esc(heroSub)}</div>
            </div>
          </div>
          <div class="qk-clean-actions">
            ${isScanning
              ? `<button class="btn btn-secondary" id="btn-cleaner-cancel">停止扫描</button>`
              : `<button class="btn btn-secondary" id="btn-cleaner-rescan" ${isCleaning ? 'disabled' : ''}>${svg('refresh')}重新扫描</button>`
            }
            <button class="btn btn-primary" id="btn-cleaner-run" ${isScanning || isCleaning || selectedBytes <= 0 ? 'disabled' : ''}>
              ${svg('zap')}<span>${isCleaning ? '正在清理…' : `立即清理${selectedBytes > 0 ? ` (${formatBytesShort(selectedBytes)})` : ''}`}</span>
            </button>
          </div>
        </div>
        ${isScanning ? `
          <div class="qk-progress-track">
            <div class="qk-progress-fill" id="qk-cleaner-progress-bar" style="width:${pct}%"></div>
          </div>` : ''}
      </div>

      ${cleanerState.result ? `
        <div class="qk-result-banner">
          <div>
            <div class="qk-clean-row-title">${svg('check')}<span>本次清理完成 · 共释放 ${formatBytesShort(cleanerState.result.freedBytes)}</span></div>
            <div class="qk-clean-row-desc" style="margin-top:3px">已清理 ${cleanerState.result.deletedFiles || 0} 个冗余文件${cleanerState.result.skippedFiles ? `，静默跳过 ${cleanerState.result.skippedFiles} 个正在被系统或应用占用的文件` : ''}</div>
          </div>
          <button class="btn btn-secondary" id="btn-go-cdrive">前往 C 盘专清深挖空间 ${svg('chevron-right')}</button>
        </div>` : ''}

      ${d ? `
        <div class="qk-clean-group-head">
          <span class="qk-clean-group-title">安全清理（系统临时、报错归档、浏览器与客户端可再生缓存）</span>
          <span class="qk-clean-group-meta">${formatBytesShort(safeItems.reduce((s, x) => s + x.bytes, 0))}</span>
        </div>
        <div class="action-list qk-list-shell">
          ${safeItems.map(renderGroupRow).join('')}
        </div>

        <div class="qk-clean-group-head">
          <span class="qk-clean-group-title">按需确认（回收站与离线包缓存，默认不主动勾选）</span>
          <span class="qk-clean-group-meta">${formatBytesShort(confirmItems.reduce((s, x) => s + x.bytes, 0))}</span>
        </div>
        <div class="action-list qk-list-shell">
          ${confirmItems.map(renderGroupRow).join('')}
        </div>
      ` : `
        <div class="action-list qk-list-shell" style="padding:26px;text-align:center;color:var(--qk-text-tertiary)">
          ${isScanning ? '正在使用原生 Win32 扫描引擎遍历缓存目录（自动跳过符号链接防误删）…' : '点击右上角“重新扫描”开始全面体检'}
        </div>
      `}
    </div>
  `;

  bindCleanerEvents(root);
}

function bindCleanerEvents(root) {
  const rescanBtn = root.querySelector('#btn-cleaner-rescan');
  if (rescanBtn) rescanBtn.onclick = () => startJunkScan();

  const cancelBtn = root.querySelector('#btn-cleaner-cancel');
  if (cancelBtn) cancelBtn.onclick = async () => {
    await api.cleanerCancel();
    cleanerState.status = cleanerState.data ? 'ready' : 'idle';
    renderContent();
  };

  const goCdrive = root.querySelector('#btn-go-cdrive');
  if (goCdrive) goCdrive.onclick = () => navigate('cdrive');

  root.querySelectorAll('input[data-clean-id]').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.cleanId;
      if (cb.checked) cleanerState.selected.add(id);
      else cleanerState.selected.delete(id);
      renderContent();
    };
  });

  root.querySelectorAll('button[data-open-folder]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      api.openPath(btn.dataset.openFolder);
    };
  });

  const runBtn = root.querySelector('#btn-cleaner-run');
  if (runBtn) {
    runBtn.onclick = async () => {
      const ids = [...cleanerState.selected];
      if (!ids.length) return;
      const items = (cleanerState.data?.items || []).filter((it) => cleanerState.selected.has(it.id));
      const hasConfirmTier = items.some((it) => it.tier === 'confirm');
      if (hasConfirmTier) {
        const names = items.filter((it) => it.tier === 'confirm').map((it) => `• ${it.name}（${formatBytesShort(it.bytes)}）`).join('\n');
        const ok = await confirmSheet({
          title: '确认清理已选中的谨慎项？',
          message: `你额外勾选了以下需确认项目：\n${names}\n\n其中回收站清空后无法还原，开发缓存清理后下次装包需重新联网下载。`,
          okText: '确认清理',
          danger: items.some((it) => it.isRecycleBin),
          icon: 'broom'
        });
        if (!ok) return;
      }

      cleanerState.status = 'cleaning';
      renderContent();
      try {
        const res = await api.cleanerExecute(ids, {});
        if (res && res.ok) {
          cleanerState.result = res;
          toast(`清理完成：已释放 ${formatBytesShort(res.freedBytes)}`, 'ok', 4500);
          cleanerState.status = 'done';
          // 重新轻扫刷新真实数字
          const fresh = await api.cleanerScan();
          if (fresh && fresh.ok) {
            cleanerState.data = fresh;
            cleanerState.selected = new Set();
          }
        } else {
          cleanerState.status = 'ready';
          toast(res?.message || '清理未能执行', 'err');
        }
      } catch (e) {
        cleanerState.status = 'ready';
        toast(`清理异常：${e.message}`, 'err');
      }
      if (state.cat === 'cleaner') renderContent();
    };
  }
}

/* ==================== C 盘专清视图 ==================== */

const cdriveState = {
  loading: false,
  bigLoading: false,
  data: null,
  bigFiles: null,
  activeTab: 'system', // system | chat | appdata | bigfiles
  chatChecked: new Set(),
  bigChecked: new Set(),
  bigFilter: 'all',
  targetDrive: ''
};

async function loadCDriveData(force = false) {
  if (cdriveState.loading && !force) return;
  cdriveState.loading = true;
  if (state.cat === 'cdrive') renderContent();

  try {
    const res = await api.cdriveInspect();
    if (res && res.ok) {
      cdriveState.data = res;
      if (!cdriveState.targetDrive && res.targetDrives && res.targetDrives[0]) {
        cdriveState.targetDrive = res.targetDrives[0].letter;
      }
      cdriveState.chatChecked.clear();
    }
  } catch (e) {
    toast(`C 盘探测失败：${e.message}`, 'err');
  } finally {
    cdriveState.loading = false;
    if (state.cat === 'cdrive') renderContent();
  }

  if (!cdriveState.bigFiles || force) {
    loadCDriveBigFiles(force);
  }
}

async function loadCDriveBigFiles(force = false) {
  if (cdriveState.bigLoading && !force) return;
  cdriveState.bigLoading = true;
  if (state.cat === 'cdrive' && cdriveState.activeTab === 'bigfiles') renderContent();
  try {
    const res = await api.cdriveScanBigFiles(100, 80);
    if (res && res.ok) {
      cdriveState.bigFiles = res.files || [];
      cdriveState.bigChecked.clear();
    }
  } catch (e) {
    toast(`大文件扫描失败：${e.message}`, 'err');
  }
  cdriveState.bigLoading = false;
  if (state.cat === 'cdrive' && cdriveState.activeTab === 'bigfiles') renderContent();
}

function classifyBigFile(ext) {
  const e = String(ext || '').toLowerCase();
  if (['.exe', '.msi', '.msix', '.iso', '.img', '.vhd', '.vhdx', '.qcow2'].includes(e)) return 'installer';
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'].includes(e)) return 'archive';
  if (['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv'].includes(e)) return 'video';
  if (['.log', '.dmp', '.tmp', '.bak', '.old'].includes(e)) return 'log';
  return 'other';
}

function renderCDriveView(root) {
  if (!cdriveState.data && !cdriveState.loading) {
    setTimeout(() => {
      if (state.cat === 'cdrive' && !cdriveState.data && !cdriveState.loading) loadCDriveData();
    }, 20);
  }

  const d = cdriveState.data;
  const cd = d && d.cDrive;
  const total = cd ? cd.totalBytes : 1;
  const free = cd ? cd.freeBytes : 0;
  const used = Math.max(0, total - free);
  const reclaim = d ? (d.reclaimableEstimate || 0) : 0;
  const usedPct = cd ? Math.round((used / total) * 100) : 0;
  const reclaimPct = cd ? Math.min(25, Math.max(reclaim > 0 ? 1 : 0, Math.round((reclaim / total) * 100))) : 0;
  const solidUsedPct = Math.max(0, usedPct - reclaimPct);
  const isFreeLow = cd && (free / total < 0.2);

  const tabBtn = (id, label, count) => `
    <button class="qk-cdrive-tab ${cdriveState.activeTab === id ? 'active' : ''}" data-cd-tab="${id}">
      <span>${label}</span>
      ${count !== null && count !== undefined ? `<span class="qk-tab-count">${count}</span>` : ''}
    </button>`;

  let tabBodyHtml = '';
  if (cdriveState.loading && !d) {
    tabBodyHtml = `
      <div class="action-list qk-list-shell" style="padding:28px;text-align:center;color:var(--qk-text-tertiary)">
        正在分析 C 盘系统大件、微信/QQ 存储位置与 AppData 占用排行榜…
      </div>`;
  } else if (d && cdriveState.activeTab === 'system') {
    const rows = (d.systemItems || []).map((item) => {
      const riskBadge = item.risk === 'danger'
        ? '<span class="qk-pill-danger">不可回退</span>'
        : item.risk === 'caution'
          ? '<span class="qk-pill-amber">请留意说明</span>'
          : '<span class="qk-pill-neutral">安全清理</span>';

      let actionBtns = '';
      if (item.id === 'wu-download') {
        actionBtns = `<button class="btn btn-secondary" data-cd-act="wu-download" ${item.bytes <= 0 ? 'disabled' : ''}>清理更新缓存</button>`;
      } else if (item.id === 'hiberfil') {
        actionBtns = item.enabled
          ? `<button class="btn btn-secondary" data-cd-act="hiberfil-reduced">减半瘦身</button>
             <button class="btn btn-secondary" data-cd-act="hiberfil-off">关闭休眠</button>`
          : `<button class="btn btn-secondary" data-cd-act="hiberfil-on">重新开启休眠</button>`;
      } else if (item.id === 'winsxs') {
        actionBtns = `<button class="btn btn-secondary" data-cd-act="winsxs-clean">运行 DISM 压缩</button>`;
      } else if (item.id === 'prefetch-old') {
        actionBtns = `<button class="btn btn-secondary" data-cd-act="prefetch-old" ${item.bytes <= 0 ? 'disabled' : ''}>清理旧预读</button>`;
      } else if (item.id === 'windows-old') {
        actionBtns = `<button class="btn btn-primary" data-cd-act="windows-old">彻底移除</button>`;
      }

      const sizeText = item.indeterminate ? '官方工具压缩' : formatBytesShort(item.bytes);
      return `
        <div class="qk-clean-row">
          <div class="qk-clean-row-left">
            <div class="row-icon">${svg('hard-drive')}</div>
            <div class="qk-clean-row-info">
              <div class="qk-clean-row-title">
                <span>${esc(item.name)}</span>
                ${riskBadge}
              </div>
              <div class="qk-clean-row-desc">${esc(item.desc)}</div>
            </div>
          </div>
          <div class="qk-clean-row-right">
            <div style="text-align:right">
              <div class="qk-size-num ${item.bytes >= 2 * 1073741824 ? 'is-amber' : ''}">${sizeText}</div>
              <div class="qk-size-sub">${esc(item.path)}</div>
            </div>
            ${actionBtns}
          </div>
        </div>`;
    }).join('');
    tabBodyHtml = `<div class="action-list qk-list-shell">${rows}</div>`;
  } else if (d && cdriveState.activeTab === 'chat') {
    const apps = d.chatApps || [];
    const cards = apps.map((app) => {
      const filesHtml = (app.largeRecvFiles || []).map((f) => {
        const ck = cdriveState.chatChecked.has(f.path);
        return `
          <div class="qk-sub-file-row">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">
              <input class="qk-checkbox" type="checkbox" data-chat-file="${esc(f.path)}" ${ck ? 'checked' : ''} />
              <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(f.path)}">${esc(f.name)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
              <span class="qk-size-sub">${formatShortDate(f.mtimeMs)}</span>
              <span class="qk-size-num" style="font-size:12px">${formatBytesShort(f.bytes)}</span>
              <button class="qk-icon-btn" data-show-in-folder="${esc(f.path)}" title="在文件夹中定位">${svg('folder')}</button>
            </div>
          </div>`;
      }).join('');

      return `
        <div class="qk-chat-card">
          <div class="qk-chat-head">
            <div>
              <div class="qk-clean-row-title">
                <span>${esc(app.app)}</span>
                ${app.onCDrive ? '<span class="qk-pill-amber">位于 C 盘</span>' : '<span class="qk-pill-neutral">非 C 盘</span>'}
                <span class="qk-pill-neutral">缓存 ${formatBytesShort(app.cacheBytes)}</span>
                <span class="qk-pill-neutral">收发文件 ${formatBytesShort(app.fileBytes)}</span>
              </div>
              <div class="qk-clean-row-desc" style="margin-top:3px">${esc(app.rootPath)} · ${esc(app.protectedNote)}</div>
            </div>
            <div class="qk-clean-actions">
              <button class="qk-icon-btn" data-open-folder="${esc(app.rootPath)}" title="打开数据目录">${svg('folder')}</button>
              <button class="btn btn-primary" data-chat-clean-cache="${esc(app.id)}" ${app.cacheBytes <= 0 ? 'disabled' : ''}>
                清理安全缓存 (${formatBytesShort(app.cacheBytes)})
              </button>
            </div>
          </div>
          ${filesHtml ? `
            <div class="qk-sub-files">
              <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px;font-size:11.5px;color:var(--qk-text-tertiary)">
                <span>历史收发大文件（默认不勾，需手动确认才进回收站）</span>
                <button class="btn btn-secondary" style="height:24px;padding:0 10px;font-size:11px" data-trash-chat-selected="${esc(app.id)}" ${cdriveState.chatChecked.size === 0 ? 'disabled' : ''}>
                  勾选移入回收站
                </button>
              </div>
              ${filesHtml}
            </div>` : ''}
        </div>`;
    }).join('');

    tabBodyHtml = `
      <div class="qk-protect-banner">
        ${svg('shield-check')}
        <span>聊天数据库锁死保护生效中：微信 <code>Msg/</code>、<code>db_storage/</code> 与 QQ <code>nt_db/</code> 已列入引擎黑名单，绝不扫描或删除任何聊天记录。</span>
      </div>
      ${cards || '<div class="action-list qk-list-shell" style="padding:24px;text-align:center;color:var(--qk-text-tertiary)">未检测到常见微信 / QQ / 钉钉客户端本地数据目录</div>'}
    `;
  } else if (d && cdriveState.activeTab === 'appdata') {
    const movedHtml = (d.movedDirs && d.movedDirs.length) ? `
      <div class="qk-clean-group-head">
        <span class="qk-clean-group-title">已无损搬家目录（通过 NTFS Junction 联接运行，可随时迁回 C 盘）</span>
        <span class="qk-clean-group-meta">${d.movedDirs.length} 项</span>
      </div>
      <div class="action-list qk-list-shell">
        ${d.movedDirs.map((m) => `
          <div class="qk-clean-row">
            <div class="qk-clean-row-left">
              <div class="row-icon">${svg('folder-move')}</div>
              <div class="qk-clean-row-info">
                <div class="qk-clean-row-title"><span>${esc(m.name)}</span><span class="qk-pill-neutral">已无损搬家</span></div>
                <div class="qk-clean-row-desc">${esc(m.srcPath)} → ${esc(m.dstPath)}</div>
              </div>
            </div>
            <div class="qk-clean-row-right">
              <span class="qk-size-num">${formatBytesShort(m.bytes)}</span>
              <button class="btn btn-secondary" data-restore-move="${esc(m.id)}">迁回 C 盘</button>
            </div>
          </div>`).join('')}
      </div>` : '';

    const drivesOpts = (d.targetDrives || []).map((drv) =>
      `<option value="${esc(drv.letter)}" ${cdriveState.targetDrive === drv.letter ? 'selected' : ''}>迁至 ${esc(drv.letter)} 盘 (余 ${formatBytesShort(drv.freeBytes)})</option>`
    ).join('');

    const rows = (d.appDataFolders || []).map((f) => {
      const kindBadge = f.kind === 'moved'
        ? '<span class="qk-pill-neutral">已做联接搬家</span>'
        : f.kind === 'cache'
          ? '<span class="qk-pill-neutral">可清缓存</span>'
          : f.kind === 'system'
            ? '<span class="qk-pill-neutral">系统受保护</span>'
            : '<span class="qk-pill-amber">大体积数据</span>';

      let actHtml = `<button class="qk-icon-btn" data-open-folder="${esc(f.path)}" title="打开目录">${svg('folder')}</button>`;
      if (f.canCleanCache) {
        actHtml += `<button class="btn btn-secondary" data-clean-appdata-cache="${esc(f.path)}" data-label="${esc(f.label)}">清缓存</button>`;
      }
      if (f.canMigrate) {
        actHtml += `<button class="btn btn-primary" data-migrate-dir="${esc(f.path)}" data-label="${esc(f.name)}">${svg('folder-move')}无损搬家</button>`;
      }

      return `
        <div class="qk-clean-row">
          <div class="qk-clean-row-left">
            <div class="row-icon">${svg(f.kind === 'system' ? 'lock' : 'folder')}</div>
            <div class="qk-clean-row-info">
              <div class="qk-clean-row-title">
                <span>${esc(f.label)}</span>
                <span class="qk-pill-neutral">${esc(f.parentTag)}</span>
                ${kindBadge}
              </div>
              <div class="qk-clean-row-desc">${esc(f.path)}</div>
            </div>
          </div>
          <div class="qk-clean-row-right">
            <div style="text-align:right">
              <div class="qk-size-num ${f.bytes >= 5 * 1073741824 ? 'is-amber' : ''}">${formatBytesShort(f.bytes)}</div>
              <div class="qk-size-sub">${f.files ? `${f.files.toLocaleString()} 个文件` : (f.isReparsePoint ? '目录联接' : '')}</div>
            </div>
            ${actHtml}
          </div>
        </div>`;
    }).join('');

    tabBodyHtml = `
      ${movedHtml}
      <div class="qk-clean-group-head">
        <span class="qk-clean-group-title">C 盘用户目录与 AppData 空间占用 Top 25</span>
        ${drivesOpts ? `<select class="qk-drive-select" id="cd-target-drive">${drivesOpts}</select>` : '<span class="qk-clean-group-meta">未发现其他 NTFS 盘，不可跨盘搬家</span>'}
      </div>
      <div class="action-list qk-list-shell">${rows || '<div style="padding:24px;text-align:center;color:var(--qk-text-tertiary)">暂无超过 20 MB 的目录</div>'}</div>
    `;
  } else if (d && cdriveState.activeTab === 'bigfiles') {
    const allBig = cdriveState.bigFiles || [];
    const filtered = allBig.filter((f) => cdriveState.bigFilter === 'all' || classifyBigFile(f.ext) === cdriveState.bigFilter);
    const chip = (id, text) => `<button class="qk-cdrive-tab ${cdriveState.bigFilter === id ? 'active' : ''}" data-big-filter="${id}">${text}</button>`;

    const rows = filtered.map((f) => {
      const checked = cdriveState.bigChecked.has(f.path);
      return `
        <div class="qk-clean-row">
          <div class="qk-clean-row-left">
            <input class="qk-checkbox" type="checkbox" data-big-file="${esc(f.path)}" ${checked ? 'checked' : ''} ${f.protectedReason ? 'disabled' : ''} />
            <div class="row-icon">${svg(f.protectedReason ? 'lock' : 'file-text')}</div>
            <div class="qk-clean-row-info">
              <div class="qk-clean-row-title">
                <span>${esc(f.name)}</span>
                ${f.protectedReason ? `<span class="qk-pill-neutral" title="${esc(f.protectedReason)}">系统保护</span>` : `<span class="qk-pill-neutral">${esc(f.ext || '文件')}</span>`}
              </div>
              <div class="qk-clean-row-desc">${esc(f.path)} · ${formatShortDate(f.mtimeMs)}</div>
            </div>
          </div>
          <div class="qk-clean-row-right">
            <span class="qk-size-num ${f.bytes >= 1073741824 ? 'is-amber' : ''}">${formatBytesShort(f.bytes)}</span>
            <button class="qk-icon-btn" data-show-in-folder="${esc(f.path)}" title="在文件夹中定位">${svg('folder')}</button>
          </div>
        </div>`;
    }).join('');

    tabBodyHtml = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div class="qk-cdrive-tabs">
          ${chip('all', `全部 (${allBig.length})`)}
          ${chip('installer', '安装包 / 镜像')}
          ${chip('archive', '压缩包')}
          ${chip('video', '视频')}
          ${chip('log', '日志 / 临时')}
        </div>
        <div class="qk-clean-actions">
          <button class="btn btn-secondary" id="btn-big-rescan" ${cdriveState.bigLoading ? 'disabled' : ''}>${cdriveState.bigLoading ? '正在后台扫 C 盘…' : '重扫大文件'}</button>
          <button class="btn btn-primary" id="btn-big-trash" ${cdriveState.bigChecked.size === 0 ? 'disabled' : ''}>移入回收站 (${cdriveState.bigChecked.size})</button>
        </div>
      </div>
      <div class="action-list qk-list-shell">
        ${cdriveState.bigLoading && !allBig.length
          ? '<div style="padding:26px;text-align:center;color:var(--qk-text-tertiary)">正在后台检索 C 盘 &gt; 100 MB 文件（已避开 Windows 与 Program Files 系统目录）…</div>'
          : (rows || '<div style="padding:26px;text-align:center;color:var(--qk-text-tertiary)">该分类下未发现大于 100 MB 的文件</div>')}
      </div>
    `;
  }

  root.innerHTML = `
    <div class="view-animate qk-clean-shell">
      <div class="qk-clean-hero">
        <div class="qk-clean-hero-top">
          <div class="qk-clean-hero-main">
            <div class="qk-clean-icon-hero">${svg('hard-drive')}</div>
            <div style="min-width:0;flex:1">
              <div class="qk-clean-hero-title">
                <span>C 盘专清 · 空间救星</span>
                ${cd ? `<span class="qk-clean-hero-num ${isFreeLow ? 'is-amber' : ''}">可用 ${formatBytesShort(free)}</span>` : ''}
                ${isFreeLow ? '<span class="qk-pill-amber">C 盘余量低于 20%</span>' : ''}
              </div>
              <div class="qk-clean-hero-sub">
                ${cd ? `总容量 ${formatBytesShort(total)} · 已用 ${usedPct}% · 预估可安全释放 ${formatBytesShort(reclaim)}` : '正在检测本地磁盘分区与系统可瘦身项目…'}
              </div>
            </div>
          </div>
          <div class="qk-clean-actions">
            <button class="btn btn-secondary" id="btn-cd-refresh" ${cdriveState.loading ? 'disabled' : ''}>${svg('refresh')}${cdriveState.loading ? '正在巡检…' : '重新巡检'}</button>
          </div>
        </div>
        ${cd ? `
          <div class="qk-cdrive-bar">
            <div class="qk-cdrive-seg-used" style="width:${solidUsedPct}%"></div>
            <div class="qk-cdrive-seg-reclaim" style="width:${reclaimPct}%"></div>
            <div class="qk-cdrive-seg-free" style="flex:1"></div>
          </div>
          <div class="qk-cdrive-legend">
            <div class="qk-legend-dots">
              <span class="qk-legend-item"><span class="qk-legend-dot" style="background:var(--qk-btn-primary-bg)"></span>已占用 ${formatBytesShort(Math.max(0, used - reclaim))}</span>
              <span class="qk-legend-item"><span class="qk-legend-dot" style="background:#D97706"></span>可安全释放 ${formatBytesShort(reclaim)}</span>
              <span class="qk-legend-item"><span class="qk-legend-dot" style="background:var(--qk-surface-pill);border:1px solid var(--qk-border-hairline)"></span>剩余空闲 ${formatBytesShort(free)}</span>
            </div>
          </div>` : ''}
      </div>

      <div class="qk-cdrive-tabs">
        ${tabBtn('system', '系统大件瘦身', d?.systemItems?.length)}
        ${tabBtn('chat', '微信 / QQ 专清', d?.chatApps?.length)}
        ${tabBtn('appdata', 'AppData 无损搬家', d?.appDataFolders?.length)}
        ${tabBtn('bigfiles', '大文件雷达', cdriveState.bigFiles ? cdriveState.bigFiles.length : null)}
      </div>

      ${tabBodyHtml}
    </div>
  `;

  bindCDriveEvents(root);
}

function bindCDriveEvents(root) {
  const refBtn = root.querySelector('#btn-cd-refresh');
  if (refBtn) refBtn.onclick = () => loadCDriveData(true);

  root.querySelectorAll('button[data-cd-tab]').forEach((b) => {
    b.onclick = () => {
      cdriveState.activeTab = b.dataset.cdTab;
      if (cdriveState.activeTab === 'bigfiles' && !cdriveState.bigFiles && !cdriveState.bigLoading) {
        loadCDriveBigFiles();
      }
      renderContent();
    };
  });

  root.querySelectorAll('button[data-open-folder]').forEach((b) => {
    b.onclick = () => api.openPath(b.dataset.openFolder);
  });
  root.querySelectorAll('button[data-show-in-folder]').forEach((b) => {
    b.onclick = () => api.showItemInFolder(b.dataset.showInFolder);
  });

  // 系统大件动作
  root.querySelectorAll('button[data-cd-act]').forEach((b) => {
    b.onclick = async () => {
      const act = b.dataset.cdAct;
      const dangerPrompts = {
        'hiberfil-off': {
          title: '确认关闭系统休眠并删除 hiberfil.sys？',
          message: '关闭休眠将释放数 GB 空间，但“休眠”和 Windows“快速启动”功能将不可用（普通“睡眠”和开关机不受影响）。需要管理员权限确认。',
          okText: '关闭并释放',
          danger: true
        },
        'windows-old': {
          title: '确认彻底删除 C:\\Windows.old？',
          message: '清理旧版系统备份后，你将无法通过 Windows 设置回退到上一版本系统，此操作不可逆。',
          okText: '确认彻底移除',
          danger: true
        },
        'winsxs-clean': {
          title: '运行 DISM 安全压缩 WinSxS 组件？',
          message: '将提权执行微软官方 Dism /StartComponentCleanup，安全清理被新版取代的更新旧组件（过程约 1~3 分钟，期间不建议关机）。',
          okText: '开始压缩',
          danger: false
        }
      };
      if (dangerPrompts[act]) {
        const ok = await confirmSheet({ ...dangerPrompts[act], icon: 'hard-drive' });
        if (!ok) return;
      }
      b.disabled = true;
      toast('正在执行系统清理，如弹出 UAC 请允许管理员授权…', 'info');
      const res = await api.cdriveAction(act, {});
      toast(res?.message || (res?.ok ? '操作完成' : '操作失败'), res?.ok ? 'ok' : 'err', 4500);
      loadCDriveData(true);
    };
  });

  // 微信/QQ 缓存清理与大文件进回收站
  root.querySelectorAll('button[data-chat-clean-cache]').forEach((b) => {
    b.onclick = async () => {
      const appId = b.dataset.chatCleanCache;
      const appObj = (cdriveState.data?.chatApps || []).find((a) => a.id === appId);
      if (!appObj) return;
      b.disabled = true;
      const res = await api.cdriveAction('chat-clean-cache', { cacheDirs: appObj.cacheDirs });
      toast(res?.message || '缓存已清理', res?.ok ? 'ok' : 'err', 4500);
      loadCDriveData(true);
    };
  });

  root.querySelectorAll('input[data-chat-file]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) cdriveState.chatChecked.add(cb.dataset.chatFile);
      else cdriveState.chatChecked.delete(cb.dataset.chatFile);
      renderContent();
    };
  });

  root.querySelectorAll('button[data-trash-chat-selected]').forEach((b) => {
    b.onclick = async () => {
      const paths = [...cdriveState.chatChecked];
      if (!paths.length) return;
      const ok = await confirmSheet({
        title: `确认将选中的 ${paths.length} 个收发文件移入回收站？`,
        message: '聊天记录数据库未受影响；移除的大文件将进入 Windows 回收站，仍可从回收站找回。',
        okText: '移入回收站',
        danger: false,
        icon: 'trash'
      });
      if (!ok) return;
      const res = await api.cdriveAction('trash-files', { paths });
      toast(res?.message || '处理完成', res?.ok ? 'ok' : 'err', 4000);
      loadCDriveData(true);
    };
  });

  // AppData 目标盘选择器、清缓存、无损搬家与回迁
  const driveSel = root.querySelector('#cd-target-drive');
  if (driveSel) {
    driveSel.onchange = () => { cdriveState.targetDrive = driveSel.value; };
  }

  root.querySelectorAll('button[data-clean-appdata-cache]').forEach((b) => {
    b.onclick = async () => {
      const p = b.dataset.cleanAppdataCache;
      const label = b.dataset.label || p;
      const ok = await confirmSheet({
        title: `清理「${label}」缓存目录？`,
        message: `将目录内容安全移入回收站：\n${p}`,
        okText: '确认清理',
        danger: false,
        icon: 'broom'
      });
      if (!ok) return;
      b.disabled = true;
      const res = await api.cdriveAction('clean-appdata-cache', { path: p });
      toast(res?.message || '清理完成', res?.ok ? 'ok' : 'err', 4000);
      loadCDriveData(true);
    };
  });

  root.querySelectorAll('button[data-migrate-dir]').forEach((b) => {
    b.onclick = async () => {
      const srcPath = b.dataset.migrateDir;
      const label = b.dataset.label || srcPath;
      const target = cdriveState.targetDrive || (cdriveState.data?.targetDrives?.[0]?.letter || '');
      if (!target) return toast('没有可用的其他 NTFS 分区', 'err');

      const ok = await confirmSheet({
        title: `将「${label}」无损搬家至 ${target} 盘？`,
        message: `源目录：${srcPath}\n目标盘：${target}:\\QuickKeysMoved\\\n\n将执行 robocopy 完整复制并建立 NTFS 目录联接，原软件可无感知继续读写；若失败会自动回滚。搬家期间请勿修改该应用数据。`,
        okText: `开始搬家到 ${target} 盘`,
        danger: false,
        icon: 'folder-move'
      });
      if (!ok) return;

      b.disabled = true;
      toast(`正在复制并校验 ${label}，大目录请耐心等待…`, 'info', 5000);
      let res = await api.migratorMove(srcPath, target, { label });
      if (res && res.needsProcessClose) {
        const killOk = await confirmSheet({
          title: '检测到应用正在运行占用目录',
          message: `${res.message}\n\n是否先关闭正在运行的进程（${(res.processes || []).join(', ')}）并继续无损搬家？`,
          okText: '关闭程序并搬家',
          danger: true,
          icon: 'power'
        });
        if (killOk) {
          res = await api.migratorMove(srcPath, target, { label, autoKill: true });
        }
      }
      toast(res?.message || '操作结束', res?.ok ? 'ok' : 'err', 5000);
      loadCDriveData(true);
    };
  });

  root.querySelectorAll('button[data-restore-move]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.restoreMove;
      b.disabled = true;
      toast('正在将数据从目标盘拷回 C 盘…', 'info', 4000);
      let res = await api.migratorRestore(id, {});
      if (res && res.needsProcessClose) {
        const killOk = await confirmSheet({
          title: '检测到应用正在占用',
          message: `${res.message}\n\n是否先关闭该程序再迁回 C 盘？`,
          okText: '关闭并迁回',
          danger: true,
          icon: 'power'
        });
        if (killOk) res = await api.migratorRestore(id, { autoKill: true });
      }
      toast(res?.message || '迁回操作结束', res?.ok ? 'ok' : 'err', 4500);
      loadCDriveData(true);
    };
  });

  // 大文件雷达
  root.querySelectorAll('button[data-big-filter]').forEach((b) => {
    b.onclick = () => {
      cdriveState.bigFilter = b.dataset.bigFilter;
      renderContent();
    };
  });

  root.querySelectorAll('input[data-big-file]').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) cdriveState.bigChecked.add(cb.dataset.bigFile);
      else cdriveState.bigChecked.delete(cb.dataset.bigFile);
      renderContent();
    };
  });

  const bigRescan = root.querySelector('#btn-big-rescan');
  if (bigRescan) bigRescan.onclick = () => loadCDriveBigFiles(true);

  const bigTrash = root.querySelector('#btn-big-trash');
  if (bigTrash) {
    bigTrash.onclick = async () => {
      const paths = [...cdriveState.bigChecked];
      if (!paths.length) return;
      const ok = await confirmSheet({
        title: `确认将选中的 ${paths.length} 个大文件移入回收站？`,
        message: '文件会先进入 Windows 回收站，确认后如有误删仍可恢复。',
        okText: '移入回收站',
        danger: true,
        icon: 'trash'
      });
      if (!ok) return;
      const res = await api.cdriveAction('trash-files', { paths });
      toast(res?.message || '清理完成', res?.ok ? 'ok' : 'err', 4000);
      loadCDriveBigFiles(true);
      loadCDriveData(true);
    };
  }
}
