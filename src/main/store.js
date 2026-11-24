'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  theme: 'system',            // system | light | dark
  accent: 'blue',             // blue | graphite | green | purple | orange
  globalHotkey: 'Alt+Space',  // Electron accelerator
  gameBoostHotkey: 'Ctrl+F11', // 游戏瞬时加速全局热键
  defaultTerminal: 'auto',    // auto | wt | powershell | cmd
  openAtLogin: false,
  minimizeToTray: true,
  trayEnabled: true,
  favorites: [],
  recents: [],                // [{id, t}]
  runCounts: {},              // {id: count}
  customActions: [],          // [{id,name,desc,command,mode:'hidden'|'terminal'|'output'}]
  timers: { shutdown: null, restart: null, sleep: null }, // {at: epochMs}
  movedDirs: [],              // [{id,name,srcPath,dstPath,bytes,files,movedAt}]
  cleanerStats: { totalFreedBytes: 0, lastCleanedAt: 0 }
};

class ConfigStore {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'quickkeys-config.json');
    this.data = structuredClone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data = this._merge(structuredClone(DEFAULTS), raw);
      }
    } catch (e) {
      console.error('[QuickKeys] 配置读取失败，使用默认配置:', e.message);
      // 保留损坏文件副本，避免用户自定义命令 / 收藏被静默丢弃
      try {
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.filePath, backup);
        console.error(`[QuickKeys] 已备份损坏配置到 ${backup}`);
      } catch (_) { /* 备份失败不阻塞启动 */ }
    }
    return this.data;
  }

  _merge(base, override) {
    for (const k of Object.keys(base)) {
      const bv = base[k];
      if (bv && typeof bv === 'object' && !Array.isArray(bv) &&
          override[k] && typeof override[k] === 'object' && !Array.isArray(override[k])) {
        base[k] = this._merge(bv, override[k]);
      } else if (override[k] !== undefined) {
        base[k] = override[k];
      }
    }
    // 保留默认结构之外的额外键
    for (const k of Object.keys(override)) {
      if (!(k in base) && override[k] !== undefined) base[k] = override[k];
    }
    return base;
  }

  // 原子写入：先写临时文件再 rename，避免掉电 / 崩溃时把配置写坏
  save() {
    const tmpPath = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
      return true;
    } catch (e) {
      console.error('[QuickKeys] 配置保存失败:', e.message);
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
      return false;
    }
  }

  get(key) {
    return key === undefined ? this.data : this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return this.data[key];
  }

  patch(obj) {
    Object.assign(this.data, obj);
    this.save();
    return this.data;
  }

  // 收藏
  toggleFavorite(id) {
    const i = this.data.favorites.indexOf(id);
    if (i >= 0) this.data.favorites.splice(i, 1);
    else this.data.favorites.unshift(id);
    this.save();
    return this.data.favorites;
  }

  // 使用记录
  trackRun(id, cli = '') {
    const rc = this.data.runCounts;
    rc[id] = (rc[id] || 0) + 1;
    const entry = cli ? { id, t: Date.now(), cli: String(cli).slice(0, 120) } : { id, t: Date.now() };
    this.data.recents = [entry, ...this.data.recents.filter((r) => r.id !== id)].slice(0, 12);
    this.save();
  }

  // 自定义命令
  addCustomAction(action) {
    this.data.customActions.push(action);
    this.save();
    return action;
  }

  updateCustomAction(id, patchData) {
    const a = this.data.customActions.find((x) => x.id === id);
    if (a) Object.assign(a, patchData);
    this.save();
    return a;
  }

  removeCustomAction(id) {
    this.data.customActions = this.data.customActions.filter((x) => x.id !== id);
    this.data.favorites = this.data.favorites.filter((f) => f !== id);
    this.save();
  }
}

module.exports = { ConfigStore, DEFAULTS };
