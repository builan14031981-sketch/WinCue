'use strict';

// 忽略 stdout/stderr 管道断开（EPIPE）错误，防止在父进程意外退出时弹窗崩溃
if (process.stdout && process.stdout.on) {
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') return;
  });
}
if (process.stderr && process.stderr.on) {
  process.stderr.on('error', (err) => {
    if (err.code === 'EPIPE') return;
  });
}
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') return;
  try {
    const log = require('./logger');
    log.error('uncaughtException', err.stack || err.message);
  } catch (_) {}
  console.error('[QuickKeys Uncaught Exception]', err);
});

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, ipcMain, globalShortcut, nativeTheme,
  shell, screen, Menu, dialog, Notification
} = require('electron');
const { ConfigStore } = require('./store');
const { Executor } = require('./executor');
const { materializeScripts } = require('./scripts');
const { buildTray } = require('./tray');
const guardian = require('./guardian');
const gaming = require('./gaming');
const { CleanerService } = require('./cleaner');
const log = require('./logger');

// 开启 Chromium 硬件级平滑滚动支持，消除 Windows 滚轮大步进跳跃
app.commandLine.appendSwitch('enable-smooth-scrolling');

const isSmoke = process.argv.includes('--smoke-test');
const SMOKE_TIMEOUT = 90000;

let store, executor, cleaner, scriptsDir;
let mainWin = null;
let spotlightWin = null;
let tray = null;
let isQuitting = false;
const smoke = { errors: [], logs: [] };

/* ---------------------- 渲染就绪消息队列（防止消息丢失） ----------------------
 * 主进程可能在渲染进程尚未挂载监听器时下发广播（启动阶段的定时任务核对、
 * 窗口重建后的 open-action 等），这里按 webContents 排队，渲染进程
 * init 完成后通过 qk:renderer-ready 信令触发补发。
 */
const readyWebContents = new Set();
const pendingMessages = new Map();
const MSG_QUEUE_LIMIT = 50;

function dispatch(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (readyWebContents.has(wc.id)) {
    wc.send(channel, payload);
    return;
  }
  const queue = pendingMessages.get(wc.id) || [];
  queue.push({ channel, payload });
  if (queue.length > MSG_QUEUE_LIMIT) queue.shift();
  pendingMessages.set(wc.id, queue);
}

function markRendererReady(wc) {
  readyWebContents.add(wc.id);
  const queue = pendingMessages.get(wc.id) || [];
  pendingMessages.delete(wc.id);
  for (const msg of queue) {
    if (!wc.isDestroyed()) wc.send(msg.channel, msg.payload);
  }
  wc.once('destroyed', () => {
    readyWebContents.delete(wc.id);
    pendingMessages.delete(wc.id);
  });
}

function assetsPath(name) {
  return path.join(__dirname, '..', 'assets', name);
}
function rendererPath(name) {
  return path.join(__dirname, '..', 'renderer', name);
}

/* ------------------------------- 单实例锁 ------------------------------- */
const gotLock = app.requestSingleInstanceLock({ appId: 'com.wincue.app' });
if (!gotLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => activateMainWindow());
  app.whenReady().then(init).catch((e) => {
    console.error('[WinCue] 初始化失败:', e);
    app.exit(1);
  });
}

async function init() {
  app.setAppUserModelId('com.wincue.app');
  Menu.setApplicationMenu(null);
  log.init(app.getPath('userData'));
  log.info('main', `WinCue v${app.getVersion()} 启动，Electron ${process.versions.electron}，Node ${process.versions.node}`);
  scriptsDir = materializeScripts(app.getPath('userData'));
  store = new ConfigStore();
  executor = new Executor({ store, scriptsDir });
  cleaner = new CleanerService(store, () => (filePath) => shell.trashItem(filePath));

  applyTheme(store.get('theme'));
  applyLoginItem(store.get('openAtLogin'));

  // IPC 必须在任何窗口加载之前注册，避免渲染进程抢跑调用 getInit 时无处理器
  registerIpc();

  createMainWindow();
  createSpotlight();
  registerHotkey();
  if (store.get('trayEnabled')) createTray();

  // 右键菜单项缓存改为按需预热：用户打开右键管家时才由 IPC 触发扫描，
  // 启动阶段不再额外拉起 PowerShell。

  // 计划任务核对涉及 PowerShell 冷启动，推到启动窗口之后（20s）再执行，
  // 避免和首屏健康探测的 PowerShell 撞在一起；结果仍通过消息队列补发给渲染进程。
  setTimeout(() => {
    executor.reconcileTimers()
      .then((timers) => broadcast('qk:timers-changed', timers))
      .catch((e) => log.warn('main', `定时任务核对异常: ${e.message}`));
  }, 20000);

  if (isSmoke) runSmokeTest();
}

/* -------------------------------- 主窗口 -------------------------------- */

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    icon: assetsPath('icon.png'),
    title: 'WinCue · 轻唤盒子',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWin.loadFile(rendererPath('index.html'));
  mainWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error('main', `渲染加载失败: ${code} ${desc} ${url}`);
  });
  mainWin.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log.warn('renderer', `[console] ${message}`);
  });
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('maximize', () => mainWin.webContents.send('qk:window-maximized', true));
  mainWin.on('unmaximize', () => mainWin.webContents.send('qk:window-maximized', false));

  mainWin.on('close', (e) => {
    if (!isQuitting && store.get('trayEnabled') && store.get('minimizeToTray')) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => { mainWin = null; });

  if (isSmoke) {
    mainWin.webContents.on('console-message', (_e, _lvl, message) => {
      if (/^\[renderer-error\]/.test(message)) smoke.errors.push(`main console: ${message}`);
    });
    mainWin.webContents.on('did-fail-load', (_e, code, desc) => smoke.errors.push(`main load ${code} ${desc}`));
    mainWin.webContents.on('render-process-gone', (_e, d) => smoke.errors.push(`main renderer gone: ${d.reason}`));
  }
}

/* ------------------------------ Spotlight ------------------------------ */

function createSpotlight() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  spotlightWin = new BrowserWindow({
    width: 720,
    height: 560,
    x: Math.round((width - 720) / 2),
    y: 110,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  spotlightWin.setAlwaysOnTop(true, 'screen-saver');
  spotlightWin.loadFile(rendererPath('spotlight.html'));
  spotlightWin.on('blur', () => { if (spotlightWin && spotlightWin.isVisible()) hideSpotlight(); });

  if (isSmoke) {
    spotlightWin.webContents.on('console-message', (_e, _lvl, message) => {
      if (/^\[renderer-error\]/.test(message)) smoke.errors.push(`spotlight console: ${message}`);
    });
    spotlightWin.webContents.on('did-fail-load', (_e, code, desc) => smoke.errors.push(`spotlight load ${code} ${desc}`));
    spotlightWin.webContents.on('render-process-gone', (_e, d) => smoke.errors.push(`spotlight renderer gone: ${d.reason}`));
  }
}

function showSpotlight() {
  if (!spotlightWin) createSpotlight();
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  spotlightWin.setPosition(Math.round((width - 720) / 2), 110);
  spotlightWin.show();
  spotlightWin.focus();
  spotlightWin.webContents.send('qk:spotlight-show');
}

function hideSpotlight() {
  if (spotlightWin) {
    spotlightWin.webContents.send('qk:spotlight-hide');
    spotlightWin.hide();
  }
}

function toggleSpotlight() {
  if (!spotlightWin) { showSpotlight(); return; }
  spotlightWin.isVisible() ? hideSpotlight() : showSpotlight();
}

function showMain(focus = true) {
  if (!mainWin) {
    createMainWindow();
    mainWin.once('ready-to-show', () => mainWin.show());
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  if (focus) mainWin.focus();
  if (store && mainWin.webContents) {
    dispatch(mainWin, 'qk:timers-changed', store.get('timers'));
  }
}

function activateMainWindow() {
  if (!app.isReady()) return;
  showMain(false);
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.setAlwaysOnTop(true);
  mainWin.show();
  mainWin.focus();
  mainWin.setAlwaysOnTop(false);
}

/* -------------------------------- 托盘 -------------------------------- */

function createTray() {
  if (tray) return;
  tray = buildTray({
    iconPath: assetsPath('tray.png'),
    executor,
    onShowMain: (focus) => showMain(focus),
    onQuit: () => { isQuitting = true; app.quit(); },
    onOpenContextMenu: () => {
      showMain(true);
      if (mainWin && mainWin.webContents) {
        dispatch(mainWin, 'qk:open-action', { id: 'context-menu-manager' });
      }
    }
  });
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

/* ------------------------------ 全局快捷键 ------------------------------ */

function registerHotkey() {
  globalShortcut.unregisterAll();
  const accel = store.get('globalHotkey') || 'Alt+Space';
  const gameAccel = store.get('gameBoostHotkey') || 'Ctrl+F11';

  // 1. 注册 Spotlight 全局搜索
  let ok = false;
  let reason = '';
  try {
    ok = globalShortcut.register(accel, toggleSpotlight);
    if (!ok) reason = '可能已被其他程序占用';
  } catch (e) {
    reason = e.message;
  }
  if (!ok) {
    log.warn('main', `全局快捷键注册失败: ${accel} (${reason})`);
    broadcast('qk:hotkey-failed', { accel, reason });
  } else {
    log.info('main', `全局快捷键注册成功: ${accel}`);
  }

  // 2. 注册游戏瞬时电竞加速全局热键 (盲操秒级释放内存，零弹窗抢焦点)
  try {
    globalShortcut.register(gameAccel, async () => {
      log.info('main', `触发全局游戏瞬时加速热键: ${gameAccel}`);
      try {
        const res = await gaming.runInstantBoost();
        if (Notification && Notification.isSupported()) {
          new Notification({
            title: '⚡ 游戏瞬时加速完成',
            body: res.message || '已为前台游戏释放内存并提升进程调度优先级！',
            silent: true
          }).show();
        } else if (tray && typeof tray.displayBalloon === 'function') {
          tray.displayBalloon({
            title: '⚡ 轻唤盒子 · 游戏瞬时加速',
            content: res.message || '已成功排空待机缓存，游戏调度已提速！'
          });
        }
        broadcast('qk:game-boosted', res);
      } catch (err) {
        log.error('main:instantBoostHotkey', err.message);
      }
    });
    log.info('main', `游戏瞬时加速全局热键已就绪: ${gameAccel}`);
  } catch (e) {
    log.warn('main', `游戏瞬时加速快捷键注册失败: ${gameAccel} (${e.message})`);
  }

  return { ok, accel, reason };
}

/* ------------------------------ 偏好副作用 ------------------------------ */

function applyTheme(theme) {
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system';
}
function applyLoginItem(openAtLogin) {
  // 便携版（portable）运行时 process.execPath 指向自解压临时目录，
  // 必须使用 PORTABLE_EXECUTABLE_FILE 指向用户真正持有的 exe，否则重启后开机自启失效。
  const portablePath = process.env.PORTABLE_EXECUTABLE_FILE;
  const settings = { openAtLogin: !!openAtLogin };
  if (portablePath && fs.existsSync(portablePath)) {
    settings.path = portablePath;
  } else {
    settings.path = process.execPath;
  }
  try {
    app.setLoginItemSettings(settings);
  } catch (e) {
    log.warn('main', `开机自启设置失败: ${e.message}`);
  }
}
function broadcast(channel, payload) {
  [mainWin, spotlightWin].forEach((w) => dispatch(w, channel, payload));
}

/* -------------------------------- IPC -------------------------------- */

function registerIpc() {
  ipcMain.handle('qk:get-init', () => executor.getInitData());

  // 渲染进程 init 完成后信令：补发排队中的主进程消息
  ipcMain.handle('qk:renderer-ready', (e) => {
    markRendererReady(e.sender);
    return true;
  });

  ipcMain.handle('qk:execute', async (_e, id, params) => {
    log.info('ipc', `执行动作: ${id}${params && Object.keys(params).length ? ' params=' + JSON.stringify(params) : ''}`);
    const action = executor.findAction(id);

    // 捕获类动作避让：截图/录屏需要露出干净的桌面与目标窗口，在触发前毫秒级最小化避让主窗口
    const isCapture = action && (action.cat === 'capture' || action.hideOnRun) &&
      !['open-screenshots-folder', 'open-snipping', 'psr'].includes(id);

    if (isCapture && mainWin && mainWin.isVisible()) {
      mainWin.minimize();
      // 等待 120ms 让 DWM 完成窗口最小化动画并交还系统焦点
      await new Promise((r) => setTimeout(r, 120));
    }

    const result = await executor.execute(id, params || {});
    if (result.ok === false) {
      log.warn('ipc', `动作 ${id} 失败: ${result.message || '(无消息)'}${result.detail ? ' | ' + result.detail : ''}`);
    } else {
      log.info('ipc', `动作 ${id} 成功`);
    }
    if (result.timers) broadcast('qk:timers-changed', result.timers);
    return result;
  });

  ipcMain.handle('qk:config-patch', (_e, patch) => {
    if (patch.theme !== undefined) applyTheme(patch.theme);
    if (patch.globalHotkey !== undefined || patch.gameBoostHotkey !== undefined) {
      store.patch(patch);
      registerHotkey();
      broadcast('qk:config-changed', store.get());
      return store.get();
    }
    if (patch.openAtLogin !== undefined) applyLoginItem(patch.openAtLogin);
    if (patch.trayEnabled !== undefined) {
      patch.trayEnabled ? createTray() : destroyTray();
    }
    store.patch(patch);
    broadcast('qk:config-changed', store.get());
    return store.get();
  });

  ipcMain.handle('qk:favorite-toggle', (_e, id) => store.toggleFavorite(id));

  ipcMain.handle('qk:custom-add', (_e, action) => {
    if (!action || !action.name || !action.command) {
      return { ok: false, message: '名称和命令不能为空' };
    }
    const safe = {
      id: `custom-${Date.now()}`,
      name: String(action.name).slice(0, 40),
      desc: String(action.desc || '').slice(0, 80),
      command: String(action.command).slice(0, 2000),
      mode: ['hidden', 'terminal', 'output'].includes(action.mode) ? action.mode : 'hidden',
      icon: 'terminal'
    };
    store.addCustomAction(safe);
    broadcast('qk:custom-changed', store.get('customActions'));
    return { ok: true, action: safe, actions: executor.allActions().map(Executor.presentAction) };
  });

  ipcMain.handle('qk:custom-update', (_e, id, action) => {
    if (!action || !action.name || !action.command) {
      return { ok: false, message: '名称和命令不能为空' };
    }
    const updated = store.updateCustomAction(id, {
      name: String(action.name).slice(0, 40),
      desc: String(action.desc || '').slice(0, 80),
      command: String(action.command).slice(0, 2000),
      mode: ['hidden', 'terminal', 'output'].includes(action.mode) ? action.mode : 'hidden'
    });
    if (!updated) return { ok: false, message: '自定义命令不存在' };
    broadcast('qk:custom-changed', store.get('customActions'));
    return { ok: true, action: updated, actions: executor.allActions().map(Executor.presentAction) };
  });

  ipcMain.handle('qk:custom-remove', (_e, id) => {
    store.removeCustomAction(id);
    broadcast('qk:custom-changed', store.get('customActions'));
    return { ok: true };
  });

  ipcMain.handle('qk:win-control', (_e, action) => {
    const w = BrowserWindow.fromWebContents(_e.sender) || mainWin;
    if (!w) return undefined;
    if (action === 'min') { w.minimize(); return undefined; }
    if (action === 'max') {
      w.isMaximized() ? w.unmaximize() : w.maximize();
      return w.isMaximized();
    }
    if (action === 'close') { w.close(); return undefined; }
    if (action === 'is-maximized') return w.isMaximized();
    return undefined;
  });

  ipcMain.handle('qk:spotlight-hide', () => hideSpotlight());
  ipcMain.handle('qk:spotlight-open-action', (_e, id) => {
    hideSpotlight();
    showMain(true);
    if (mainWin) dispatch(mainWin, 'qk:open-action', id);
  });
  ipcMain.handle('qk:spotlight-open-view', (_e, view) => {
    hideSpotlight();
    showMain(true);
    if (mainWin) dispatch(mainWin, 'qk:navigate', view);
  });
  ipcMain.handle('qk:spotlight-show-output', (_e, payload) => {
    hideSpotlight();
    showMain(true);
    if (mainWin) dispatch(mainWin, 'qk:show-output', payload || {});
  });

  ipcMain.handle('qk:open-config-folder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('qk:open-logs-folder', () => shell.openPath(log.getLogDir() || path.join(app.getPath('userData'), 'logs')));
  // 只允许打开常规外链协议，避免被诱导调用 file:// 或系统危险协议
  ipcMain.handle('qk:open-external', (_e, url) => {
    const target = String(url || '');
    if (!/^(https?|mailto):/i.test(target)) return '已拦截非 http/https/mailto 协议的外链';
    return shell.openExternal(target);
  });
  ipcMain.handle('qk:open-path', (_e, targetPath) => {
    const target = String(targetPath || '');
    if (!target) return '路径为空';
    return shell.openPath(target);
  });
  ipcMain.handle('qk:show-item-in-folder', (_e, fullPath) => {
    if (fullPath) shell.showItemInFolder(fullPath);
    return true;
  });
  ipcMain.handle('qk:dialog-open-files', async (_e, options = {}) => {
    const parent = BrowserWindow.fromWebContents(_e.sender) || mainWin;
    const res = await dialog.showOpenDialog(parent, {
      title: options.title || '选择文件',
      properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: options.filters || []
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('qk:dialog-save-file', async (_e, options = {}) => {
    const parent = BrowserWindow.fromWebContents(_e.sender) || mainWin;
    const res = await dialog.showSaveDialog(parent, {
      title: options.title || '保存文件',
      defaultPath: options.defaultPath,
      filters: options.filters || []
    });
    return res.canceled ? null : res.filePath;
  });
  ipcMain.handle('qk:app-quit', () => { isQuitting = true; app.quit(); });

  /* --- 系统安全卫士与加速 IPC --- */
  ipcMain.handle('qk:guardian-health', () => guardian.getSystemHealth());
  ipcMain.handle('qk:guardian-top-procs', (_e, limit) => guardian.getTopProcesses(limit));
  ipcMain.handle('qk:guardian-boost', (_e, options) => guardian.boostSystem(options));
  ipcMain.handle('qk:guardian-startup-list', () => guardian.getStartupItems());
  ipcMain.handle('qk:guardian-startup-toggle', (_e, item, enable) => guardian.toggleStartupItem(item, enable));
  ipcMain.handle('qk:guardian-startup-remove', (_e, item) => guardian.removeStartupItem(item));
  ipcMain.handle('qk:guardian-win11-cm-get', () => guardian.getWin11ContextMenuStatus());
  ipcMain.handle('qk:guardian-win11-cm-set', (_e, classic) => guardian.setWin11ContextMenu(classic));
  ipcMain.handle('qk:guardian-cm-items', () => guardian.getContextMenuItems());
  ipcMain.handle('qk:guardian-cm-toggle', (_e, item, enable) => guardian.toggleContextMenuHandler(item, enable));
  ipcMain.handle('qk:guardian-cm-pure', () => guardian.restorePureNativeContextMenu());
  ipcMain.handle('qk:guardian-cm-restore-all', () => guardian.restoreAllContextMenuItems());
  ipcMain.handle('qk:guardian-cm-add-custom', (_e, data) => guardian.addCustomContextMenuItem(data));
  ipcMain.handle('qk:guardian-cm-delete', (_e, item) => guardian.removeContextMenuItemPermanently(item));
  ipcMain.handle('qk:guardian-cm-presets', () => guardian.getPresetContextTools());
  ipcMain.handle('qk:guardian-cm-apply-preset', (_e, id) => guardian.applyPresetContextTool(id));
  ipcMain.handle('qk:guardian-tweaks-get', () => guardian.getRegistryTweaks());
  ipcMain.handle('qk:guardian-tweak-set', (_e, id, enable) => guardian.setRegistryTweak(id, enable));

  /* --- 游戏专区与战备 IPC --- */
  ipcMain.handle('qk:gaming-profile', (_e, refresh) => gaming.getGamingProfile(refresh));
  ipcMain.handle('qk:gaming-diagnostics', () => gaming.getGamingDiagnostics());
  ipcMain.handle('qk:gaming-clean-standby', () => gaming.cleanStandbyMemory());
  ipcMain.handle('qk:gaming-instant-boost', () => gaming.runInstantBoost());
  ipcMain.handle('qk:gaming-action', (_e, action) => {
    if (action === 'disable-sticky') return gaming.disableStickyKeys();
    if (action === 'enable-power') return gaming.enableUltimatePower();
    if (action === 'open-joy') return gaming.openJoyCpl();
    if (action === 'open-graphics') return gaming.openGraphicsSettings();
    if (action === 'open-saves') return gaming.openSavedGames();
    if (action === 'kill-frozen') return gaming.killFrozenGames();
    return { ok: false, message: '未知游戏动作: ' + action };
  });

  /* --- 垃圾清理与 C 盘专清 IPC --- */
  ipcMain.handle('qk:cleaner-scan', () => cleaner.scanJunk((p) => broadcast('qk:cleaner-progress', p)));
  ipcMain.handle('qk:cleaner-cancel', () => cleaner.cancelScan());
  ipcMain.handle('qk:cleaner-execute', (_e, ids, opts) => cleaner.cleanJunk(ids, opts));
  ipcMain.handle('qk:cleaner-quick-summary', () => cleaner.quickTempSummary());
  ipcMain.handle('qk:cdrive-inspect', () => cleaner.inspectCDrive());
  ipcMain.handle('qk:cdrive-big-files', (_e, minMB, limit) => cleaner.scanBigFiles(minMB, limit));
  ipcMain.handle('qk:cdrive-action', (_e, actionId, payload) => cleaner.executeCDriveAction(actionId, payload));
  ipcMain.handle('qk:migrator-list', () => cleaner.migrator.listMoved());
  ipcMain.handle('qk:migrator-move', (_e, srcPath, targetDrive, opts) => cleaner.migrator.migrateDirectory(srcPath, targetDrive, opts));
  ipcMain.handle('qk:migrator-restore', (_e, id, opts) => cleaner.migrator.restoreDirectory(id, opts));
}

/* ------------------------------ 生命周期 ------------------------------- */
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (store && store.get('trayEnabled') && store.get('minimizeToTray')) return;
  isQuitting = true;
  app.quit();
});

/* ------------------------------- 冒烟测试 ------------------------------- */

async function runSmokeTest() {
  const check = (name, cond, detail = '') => {
    const status = cond ? 'PASS' : 'FAIL';
    const line = `[SMOKE ${status}] ${name}${detail ? ` - ${detail}` : ''}`;
    try {
      console.log(line);
    } catch (_) {}
    smoke.logs.push(line);
    if (!cond) smoke.errors.push(line);
  };

  try {
    const actions = executor.allActions();
    const icons = require('../renderer/icons.js');
    check('动作数量 >= 80', actions.length >= 80, `实际 ${actions.length} 个`);
    const ids = new Set();
    let dupes = [], missing = [], badCat = [];
    const cats = new Set(require('./actions.js').CATEGORIES.map((c) => c.id));
    for (const a of actions) {
      if (ids.has(a.id)) dupes.push(a.id);
      ids.add(a.id);
      if (!a.name || !a.desc) missing.push(a.id);
      if (!icons.hasIcon(a.icon)) missing.push(`${a.id}->${a.icon}`);
      if (!cats.has(a.cat)) badCat.push(`${a.id}->${a.cat}`);
    }
    check('动作 id 无重复', dupes.length === 0, dupes.join(','));
    check('所有图标均已定义、元数据完整', missing.length === 0, missing.slice(0, 6).join(','));
    check('动作分类合法', badCat.length === 0, badCat.slice(0, 6).join(','));

    store.set('smoke', true);
    check('配置持久化', new ConfigStore().get('smoke') === true);
    store.set('smoke', undefined);

    const echo = await executor.runUserCommand('echo QuickKeys_Smoke_OK', 'output');
    check('命令执行与输出捕获', echo.ok && /QuickKeys_Smoke_OK/.test(echo.output || ''), (echo.output || echo.message || '').slice(0, 80));

    const ipcfg = await executor.runUserCommand('ipconfig', 'output');
    check('ipconfig 输出捕获（含中文环境）', ipcfg.ok && /IPv4|IP Address/i.test(ipcfg.output || ''), `${(ipcfg.output || '').length} chars`);

    const pingR = await executor.runSpecial({ name: 'ping' }, { host: '127.0.0.1' });
    check('ping 网络诊断', pingR.ok && /TTL=|回复|Reply from/i.test(pingR.output || ''), (pingR.output || pingR.message || '').slice(0, 100));

    const portR = await executor.runSpecial({ name: 'port-check' }, { port: 135 });
    check('端口占用查询', portR.ok && typeof portR.output === 'string' && portR.output.length > 0, (portR.output || portR.message || '').slice(0, 100));

    const hashR = await executor.calculateFileHash(path.join(__dirname, '..', '..', 'package.json'));
    check('文件哈希计算引擎', hashR.ok && hashR.output.includes('SHA-256') && hashR.output.includes('MD5'), hashR.output.split('\n')[0]);

    const jsonR = executor.processJson('{"app":"QuickKeys","version":1}', 'format');
    check('JSON格式化引擎', jsonR.ok && jsonR.output.includes('\n  "app": "QuickKeys"'));
    const jsonMin = executor.processJson('{\n  "a": 1,\n  "b": [1, 2]\n}', 'minify');
    check('JSON压缩引擎', jsonMin.ok && jsonMin.output === '{"a":1,"b":[1,2]}', jsonMin.output || jsonMin.message);
    const jsonBad = executor.processJson('{"a": }', 'format');
    check('JSON错误提示', jsonBad.ok === false && /JSON 格式错误/.test(jsonBad.message || ''), jsonBad.message || '');

    const b64R = executor.processBase64('Hello QuickKeys', 'encode');
    check('Base64编码引擎', b64R.ok && b64R.output === 'SGVsbG8gUXVpY2tLZXlz');
    const b64Dec = executor.processBase64('SGVsbG8gUXVpY2tLZXlz', 'decode');
    check('Base64解码引擎', b64Dec.ok && b64Dec.output === 'Hello QuickKeys');
    const zhText = '你好，极快捷！QuickKeys';
    const b64Zh = executor.processBase64(zhText, 'encode');
    const b64ZhBack = executor.processBase64(b64Zh.output, 'decode');
    check('Base64 中文往返', b64Zh.ok && b64ZhBack.ok && b64ZhBack.output === zhText, b64Zh.output || '');

    // 自定义命令全生命周期（新增 / 编辑 / 反映到动作表 / 删除）
    const customId = `custom-smoke-${Date.now()}`;
    store.addCustomAction({ id: customId, name: '冒烟测试命令', desc: 'smoke', command: 'echo smoke', mode: 'output', icon: 'terminal' });
    const afterAdd = executor.allActions().find((a) => a.id === customId);
    check('自定义命令可创建', Boolean(afterAdd) && afterAdd.runMode === 'output', afterAdd ? afterAdd.runMode : 'not found');
    store.updateCustomAction(customId, { name: '冒烟测试命令2', mode: 'terminal' });
    const afterUpdate = executor.allActions().find((a) => a.id === customId);
    check('自定义命令可编辑（模式不丢失）', Boolean(afterUpdate) && afterUpdate.name === '冒烟测试命令2' && afterUpdate.runMode === 'terminal', afterUpdate ? `${afterUpdate.name}/${afterUpdate.runMode}` : 'not found');
    const persisted = JSON.parse(fs.readFileSync(store.filePath, 'utf8')).customActions.find((c) => c.id === customId);
    check('自定义命令持久化到配置文件', Boolean(persisted) && persisted.mode === 'terminal');
    store.removeCustomAction(customId);
    check('自定义命令可删除', !executor.allActions().some((a) => a.id === customId));

    // 终端命令编码（-EncodedCommand 使用 UTF-16LE base64，须能无损还原）
    const encSample = 'echo 中文 & echo B';
    const encRoundTrip = Buffer.from(Buffer.from(encSample, 'utf16le').toString('base64'), 'base64').toString('utf16le');
    check('终端命令编码无损还原', encRoundTrip === encSample);

    // Windows Terminal 检测（WindowsApps 别名不能用 existsSync 判断）
    let hasWtAlias = false;
    try {
      const wtDir = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps');
      hasWtAlias = fs.existsSync(wtDir) && fs.readdirSync(wtDir).some((f) => /^wt\.exe$/i.test(f));
    } catch (_) { /* ignore */ }
    check('Windows Terminal 检测与别名文件一致', hasWtAlias === executor.terminals.wt, `alias=${hasWtAlias} detected=${executor.terminals.wt}`);

    // 终端实机执行：命令必须在真实终端中被执行（不是被当字符串打印）
    const termMarker = (name) => path.join(app.getPath('temp'), `qk-smoke-term-${name}.txt`);
    const waitFile = async (file, budgetMs) => {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        if (fs.existsSync(file)) return true;
        await new Promise((r) => setTimeout(r, 400));
      }
      return fs.existsSync(file);
    };
    const originalTerminal = store.get('defaultTerminal');
    try {
      const cmdMarker = termMarker('cmd');
      const psMarker = termMarker('ps');
      try { fs.unlinkSync(cmdMarker); fs.unlinkSync(psMarker); } catch (_) {}

      store.set('defaultTerminal', 'cmd');
      const rCmd = await executor.runUserCommand(`echo ok>"${cmdMarker}"\nexit`, 'terminal');
      check('cmd 终端实机执行命令（支持多行）', rCmd.ok === true && await waitFile(cmdMarker, 15000), '标记文件: ' + fs.existsSync(cmdMarker));

      const multiLineHidden = await executor.runUserCommand('echo a\necho b', 'hidden');
      check('多行命令在后台模式给出明确提示', multiLineHidden.ok === false && /多行/.test(multiLineHidden.message || ''), multiLineHidden.message || '未拦截');

      store.set('defaultTerminal', 'powershell');
      const rPs = await executor.runUserCommand(`Set-Content -LiteralPath "${psMarker}" -Value ok; exit`, 'terminal');
      check('PowerShell 终端实机执行命令', rPs.ok === true && await waitFile(psMarker, 15000), '标记文件: ' + fs.existsSync(psMarker));

      try { fs.unlinkSync(cmdMarker); fs.unlinkSync(psMarker); } catch (_) {}
    } finally {
      store.set('defaultTerminal', originalTerminal);
    }

    // 危险命令识别（正反例抽样，避免误报把日常命令也拦下来）
    const dangerCases = [
      ['shutdown /s /t 0', true],
      ['Restart-Computer -Force', true],
      ['format D:', true],
      ['diskpart', true],
      ['rd /s /q C:\\somewhere', true],
      ['del /f /s /q "C:\\somewhere"', true],
      ['Remove-Item -Recurse -Force D:\\data', true],
      ['reg delete "HKLM\\Software\\X" /f', true],
      ['sc delete SomeService', true],
      ['taskkill /f /im foo.exe', true],
      ['bcdedit /set testsigning on', true],
      ['netsh winsock reset', true],
      ['cipher /w:C', true],
      ['echo hello', false],
      ['ipconfig /all', false],
      ['dir /s /b', false],
      ['tasklist | findstr node', false],
      ['Get-Process | Sort-Object CPU', false],
      ['explorer.exe "%TEMP%"', false],
      ['npm run build', false],
      ['git status', false]
    ];
    const dangerWrong = dangerCases
      .filter(([cmd, expect]) => (executor.isDangerousCommand(cmd).length > 0) !== expect)
      .map(([cmd, expect]) => `${cmd}(期望${expect ? '危险' : '安全'})`);
    check('危险命令识别（21 例正反抽样）', dangerWrong.length === 0, dangerWrong.slice(0, 4).join(' | '));

    // 安全门：危险命令未经确认必须被拒绝执行（用一个真实存在但无害的目录验证「确实没执行」）
    const gateDir = path.join(app.getPath('temp'), 'qk-danger-gate');
    const gateFile = path.join(gateDir, 'keep.txt');
    try {
      fs.mkdirSync(gateDir, { recursive: true });
      fs.writeFileSync(gateFile, 'keep', 'utf8');
      const gateR = await executor.runUserCommand(`del /f /s /q "${gateDir}"`, 'hidden');
      const stillThere = fs.existsSync(gateFile);
      check('危险命令被安全门拦截且未执行', gateR.ok === false && gateR.needConfirm === true && stillThere, `needConfirm=${gateR.needConfirm === true} 文件仍在=${stillThere}`);
      check('安全门拦截时给出危险类型', Array.isArray(gateR.dangerLabels) && gateR.dangerLabels.length > 0, (gateR.dangerLabels || []).join('、'));
      const passR = await executor.runUserCommand('echo gated-release-ok', 'output', true);
      check('显式确认后安全门放行', passR.ok === true && /gated-release-ok/.test(passR.output || ''), (passR.output || passR.message || '').slice(0, 60));
      try { fs.unlinkSync(gateFile); fs.rmdirSync(gateDir); } catch (_) {}
    } catch (e) {
      check('安全门测试执行', false, e.message);
    }

    const t1 = await executor.runSpecial({ name: 'set-timer' }, { mode: 'shutdown', seconds: 999999 });
    check('定时关机可创建（系统 shutdown）', t1.ok === true, t1.message || '');
    const c1 = await executor.runSpecial({ name: 'cancel-shutdown' }, {});
    check('定时关机可取消（shutdown /a）', c1.ok === true, c1.message || '');

    const t2 = await executor.runSpecial({ name: 'set-timer' }, { mode: 'sleep', seconds: 999999 });
    check('定时睡眠计划可创建（计划任务）', t2.ok === true, t2.message || '');
    const c2 = await executor.runSpecial({ name: 'cancel-sleep' }, {});
    check('定时睡眠计划可取消', c2.ok === true, c2.message || '');

    const parse = await new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('powershell.exe',
        ['-NoProfile', '-Command',
          `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(scriptsDir, 'hotkey.ps1')}',[ref]$null,[ref]$e); if($e.Count -eq 0){'PARSE_OK'}else{$e[0].Message}`],
        { windowsHide: true, timeout: 15000 }, (_err, stdout) => resolve((stdout || '').trim()));
    });
    check('hotkey.ps1 语法正确', parse === 'PARSE_OK', parse.slice(0, 120));

    const parseWord = await new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('powershell.exe',
        ['-NoProfile', '-Command',
          `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(scriptsDir, 'word-to-pdf.ps1')}',[ref]$null,[ref]$e); if($e.Count -eq 0){'PARSE_OK'}else{$e[0].Message}`],
        { windowsHide: true, timeout: 15000 }, (_err, stdout) => resolve((stdout || '').trim()));
    });
    check('word-to-pdf.ps1 语法正确', parseWord === 'PARSE_OK', parseWord.slice(0, 120));

    const tmpTxt = path.join(app.getPath('temp'), 'qk-test.txt');
    const tmpPdf = path.join(app.getPath('temp'), 'qk-test.pdf');
    fs.writeFileSync(tmpTxt, 'QuickKeys Markdown/TXT to PDF Engine Verification', 'utf8');
    const txtPdfR = await executor.textToPdf(tmpTxt, tmpPdf);
    check('纯文本转PDF引擎', txtPdfR.ok && fs.existsSync(tmpPdf));
    try { fs.unlinkSync(tmpTxt); fs.unlinkSync(tmpPdf); } catch (_) {}

    // 图片合并转 PDF（顺便覆盖 pathToFileURL 与零边距导出路径）
    const imgSrc = path.join(__dirname, '..', 'assets', 'icon.png');
    const imgPdf = path.join(app.getPath('temp'), 'qk-smoke-images.pdf');
    try { fs.unlinkSync(imgPdf); } catch (_) {}
    const imgPdfR = await executor.imagesToPdf([imgSrc, imgSrc], imgPdf);
    const imgPdfSize = fs.existsSync(imgPdf) ? fs.statSync(imgPdf).size : 0;
    check('图片合并转PDF引擎（含中文/空格路径安全）', imgPdfR.ok && imgPdfSize > 1000, `${imgPdfSize} bytes`);
    try { fs.unlinkSync(imgPdf); } catch (_) {}

    await new Promise((r) => setTimeout(r, 4500));
    const mainCards = await mainWin.webContents.executeJavaScript(
      'document.querySelectorAll(".action-card").length').catch((e) => `ERR:${e.message}`);
    check('主窗口渲染动作卡片', typeof mainCards === 'number' && mainCards > 0, `${mainCards} 张卡片`);
    const windowControls = await mainWin.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll(".window-control")).map((el) => ({ id: el.id, visible: el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== "none" }))'
    ).catch(() => []);
    check('Windows 窗口控制按钮完整可见', windowControls.length === 3 && windowControls.every((item) => item.visible), JSON.stringify(windowControls));
    const spotlightOk = await spotlightWin.webContents.executeJavaScript(
      '!!document.querySelector("#spotlight-input")').catch((e) => `ERR:${e.message}`);
    check('Spotlight 搜索框渲染', spotlightOk === true);

    const { isBlockedDeleteTarget } = require('./cleaner');
    check('垃圾清理黑名单拦截系统核心与微信Msg库',
      Boolean(isBlockedDeleteTarget('C:\\Windows\\System32')) &&
      Boolean(isBlockedDeleteTarget('C:\\Users\\test\\Documents\\WeChat Files\\wxid_1\\Msg\\MicroMsg.db')) &&
      Boolean(isBlockedDeleteTarget('C:\\pagefile.sys'))
    );
    const tempSum = await cleaner.quickTempSummary();
    check('垃圾扫描磁盘水位接口可用', Boolean(tempSum && tempSum.cDrive && tempSum.cDrive.totalBytes > 0));
    const cleanViewsOk = await mainWin.webContents.executeJavaScript(`(() => {
      navigate('cleaner');
      const h1 = !!document.querySelector('.qk-clean-hero');
      navigate('cdrive');
      const h2 = !!document.querySelector('.qk-cdrive-tabs');
      navigate('home');
      return h1 && h2;
    })()`).catch(() => false);
    check('垃圾清理与C盘专清视图可正常切换渲染', cleanViewsOk === true);

    // 主题切换做真实断言（原实现只切换不校验，属于空检查）
    const themeBefore = nativeTheme.themeSource;
    nativeTheme.themeSource = 'dark';
    await new Promise((r) => setTimeout(r, 200));
    const darkOk = nativeTheme.shouldUseDarkColors === true;
    nativeTheme.themeSource = 'light';
    await new Promise((r) => setTimeout(r, 200));
    const lightOk = nativeTheme.shouldUseDarkColors === false;
    nativeTheme.themeSource = themeBefore || 'system';
    check('深浅色主题切换真实生效', darkOk && lightOk, `dark=${darkOk} light=${lightOk}`);

    const dangerousNoConfirm = actions.filter((a) => a.danger && !a.confirm).map((a) => a.id);
    check('危险动作均有二次确认', dangerousNoConfirm.length === 0, dangerousNoConfirm.join(','));
  } catch (e) {
    check('冒烟测试无异常', false, e.stack);
  }

  console.log(`\n[SMOKE] 结果：${smoke.errors.length === 0 ? '全部通过' : `${smoke.errors.length} 项失败`}`);
  try {
    const fs = require('fs');
    const report = JSON.stringify({ ok: smoke.errors.length === 0, errors: smoke.errors, logs: smoke.logs, at: new Date().toISOString() }, null, 2);
    fs.writeFileSync(path.join(app.getPath('userData'), 'smoke-result.json'), report, 'utf8');
    fs.writeFileSync(path.join(app.getAppPath(), 'smoke-result.json'), report, 'utf8');
  } catch (e) {
    console.error('[SMOKE] 报告写入失败:', e.message);
  }
  setTimeout(() => app.exit(smoke.errors.length === 0 ? 0 : 1), 1500);
}

if (isSmoke) {
  setTimeout(() => {
    console.log('[SMOKE FAIL] 超时未完成');
    app.exit(2);
  }, SMOKE_TIMEOUT);
}
