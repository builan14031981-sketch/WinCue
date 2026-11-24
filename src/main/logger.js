'use strict';

/**
 * QuickKeys 文件日志：写到 userData/logs/quickkeys-YYYY-MM-DD.log
 * 同时保留 console 输出，方便开发时看。
 */

const fs = require('fs');
const path = require('path');

let logDir = null;
let currentFile = null;
let currentDate = null;

function init(userDataPath) {
  logDir = path.join(userDataPath, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
}

function logFilePath() {
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (dateStr !== currentDate) {
    currentDate = dateStr;
    currentFile = path.join(logDir, `quickkeys-${dateStr}.log`);
  }
  return currentFile;
}

function write(level, tag, msg) {
  if (!logDir) return;
  const d = new Date();
  // 使用本地时间（原实现用 toISOString 输出 UTC，排查日志时会差 8 小时）
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const line = `[${ts}] [${level}] [${tag}] ${msg}\n`;
  try {
    fs.appendFileSync(logFilePath(), line, 'utf8');
  } catch (_) { /* 日志写失败不影响主流程 */ }
  // 同时输出到 console（防 EPIPE 管道破裂导致崩溃）
  try {
    const consoleFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    consoleFn(line.trim());
  } catch (_) {}
}

module.exports = {
  init,
  info: (tag, msg) => write('INFO', tag, String(msg)),
  warn: (tag, msg) => write('WARN', tag, String(msg)),
  error: (tag, msg) => write('ERROR', tag, String(msg)),
  getLogDir: () => logDir
};
