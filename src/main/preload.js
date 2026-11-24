'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ALLOWED_EVENTS = [
  'qk:config-changed',
  'qk:timers-changed',
  'qk:custom-changed',
  'qk:open-action',
  'qk:navigate',
  'qk:show-output',
  'qk:spotlight-show',
  'qk:spotlight-hide',
  'qk:window-maximized',
  'qk:hotkey-failed',
  'qk:game-boosted',
  'qk:cleaner-progress'
];

contextBridge.exposeInMainWorld('api', {
  getInit: () => ipcRenderer.invoke('qk:get-init'),
  rendererReady: () => ipcRenderer.invoke('qk:renderer-ready'),
  execute: (id, params) => ipcRenderer.invoke('qk:execute', id, params),
  configPatch: (patch) => ipcRenderer.invoke('qk:config-patch', patch),
  toggleFavorite: (id) => ipcRenderer.invoke('qk:favorite-toggle', id),
  customAdd: (action) => ipcRenderer.invoke('qk:custom-add', action),
  customUpdate: (id, action) => ipcRenderer.invoke('qk:custom-update', id, action),
  customRemove: (id) => ipcRenderer.invoke('qk:custom-remove', id),
  winControl: (action) => ipcRenderer.invoke('qk:win-control', action),
  hideSpotlight: () => ipcRenderer.invoke('qk:spotlight-hide'),
  spotlightOpenAction: (id) => ipcRenderer.invoke('qk:spotlight-open-action', id),
  spotlightOpenView: (view) => ipcRenderer.invoke('qk:spotlight-open-view', view),
  spotlightShowOutput: (payload) => ipcRenderer.invoke('qk:spotlight-show-output', payload),
  openConfigFolder: () => ipcRenderer.invoke('qk:open-config-folder'),
  openLogsFolder: () => ipcRenderer.invoke('qk:open-logs-folder'),
  openExternal: (url) => ipcRenderer.invoke('qk:open-external', url),
  openPath: (p) => ipcRenderer.invoke('qk:open-path', p),
  showItemInFolder: (p) => ipcRenderer.invoke('qk:show-item-in-folder', p),
  selectFiles: (opts) => ipcRenderer.invoke('qk:dialog-open-files', opts),
  saveFile: (opts) => ipcRenderer.invoke('qk:dialog-save-file', opts),
  quit: () => ipcRenderer.invoke('qk:app-quit'),
  // 系统安全卫士与加速
  guardianGetHealth: () => ipcRenderer.invoke('qk:guardian-health'),
  guardianGetTopProcs: (limit) => ipcRenderer.invoke('qk:guardian-top-procs', limit),
  guardianBoost: (options) => ipcRenderer.invoke('qk:guardian-boost', options),
  guardianGetStartup: () => ipcRenderer.invoke('qk:guardian-startup-list'),
  guardianToggleStartup: (item, enable) => ipcRenderer.invoke('qk:guardian-startup-toggle', item, enable),
  guardianRemoveStartup: (item) => ipcRenderer.invoke('qk:guardian-startup-remove', item),
  guardianGetWin11CM: () => ipcRenderer.invoke('qk:guardian-win11-cm-get'),
  guardianSetWin11CM: (classic) => ipcRenderer.invoke('qk:guardian-win11-cm-set', classic),
  guardianGetCMItems: () => ipcRenderer.invoke('qk:guardian-cm-items'),
  guardianToggleCM: (item, enable) => ipcRenderer.invoke('qk:guardian-cm-toggle', item, enable),
  guardianPureCM: () => ipcRenderer.invoke('qk:guardian-cm-pure'),
  guardianRestoreAllCM: () => ipcRenderer.invoke('qk:guardian-cm-restore-all'),
  guardianAddCustomCM: (data) => ipcRenderer.invoke('qk:guardian-cm-add-custom', data),
  guardianDeleteCM: (item) => ipcRenderer.invoke('qk:guardian-cm-delete', item),
  guardianGetCMPresets: () => ipcRenderer.invoke('qk:guardian-cm-presets'),
  guardianApplyCMPreset: (id) => ipcRenderer.invoke('qk:guardian-cm-apply-preset', id),
  guardianGetTweaks: () => ipcRenderer.invoke('qk:guardian-tweaks-get'),
  guardianSetTweak: (id, enable) => ipcRenderer.invoke('qk:guardian-tweak-set', id, enable),
  // 游戏专区与战备
  gamingGetProfile: (refresh) => ipcRenderer.invoke('qk:gaming-profile', refresh),
  gamingGetDiagnostics: () => ipcRenderer.invoke('qk:gaming-diagnostics'),
  gamingCleanStandby: () => ipcRenderer.invoke('qk:gaming-clean-standby'),
  gamingInstantBoost: () => ipcRenderer.invoke('qk:gaming-instant-boost'),
  gamingAction: (action) => ipcRenderer.invoke('qk:gaming-action', action),
  // 垃圾清理与 C 盘专清
  cleanerScan: () => ipcRenderer.invoke('qk:cleaner-scan'),
  cleanerCancel: () => ipcRenderer.invoke('qk:cleaner-cancel'),
  cleanerExecute: (ids, opts) => ipcRenderer.invoke('qk:cleaner-execute', ids, opts),
  cleanerQuickSummary: () => ipcRenderer.invoke('qk:cleaner-quick-summary'),
  cdriveInspect: () => ipcRenderer.invoke('qk:cdrive-inspect'),
  cdriveScanBigFiles: (minMB, limit) => ipcRenderer.invoke('qk:cdrive-big-files', minMB, limit),
  cdriveAction: (actionId, payload) => ipcRenderer.invoke('qk:cdrive-action', actionId, payload),
  migratorList: () => ipcRenderer.invoke('qk:migrator-list'),
  migratorMove: (srcPath, targetDrive, opts) => ipcRenderer.invoke('qk:migrator-move', srcPath, targetDrive, opts),
  migratorRestore: (id, opts) => ipcRenderer.invoke('qk:migrator-restore', id, opts),
  getDroppedPath: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
  },
  on(channel, cb) {
    if (!ALLOWED_EVENTS.includes(channel)) return;
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
  }
});
