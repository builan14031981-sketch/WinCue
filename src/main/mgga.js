'use strict';

/**
 * 反重力热更新：直接调用 MGGA 项目的 hot_update.js（单一补丁实现），
 * 避免 QuickKeys 内再维护一套打包逻辑。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MGGA_DIR = process.env.QK_MGGA_DIR || '';
const HOT_UPDATE = MGGA_DIR ? path.join(MGGA_DIR, 'hot_update.js') : '';

function resolveNode() {
  if (process.env.QK_NODE && fs.existsSync(process.env.QK_NODE)) return process.env.QK_NODE;
  for (const dir of String(process.env.PATH || '').split(';')) {
    if (!dir) continue;
    const p = path.join(dir, 'node.exe');
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  for (const p of ['C:\\Program Files\\nodejs\\node.exe', 'E:\\Program Files\\nodejs\\node.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return 'node';
}

function pickJson(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch {}
  }
  return null;
}

async function runHotUpdate() {
  if (!MGGA_DIR || !fs.existsSync(HOT_UPDATE)) {
    return { ok: false, message: '未配置外部热更新脚本目录（请设置环境变量 QK_MGGA_DIR）' };
  }

  const node = resolveNode();
  let stdout = '';
  let stderr = '';
  let code = 0;

  try {
    const r = await execFileAsync(node, [HOT_UPDATE, '--json'], {
      cwd: MGGA_DIR,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 240000,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = r.stdout || '';
    stderr = r.stderr || '';
  } catch (e) {
    code = typeof e.code === 'number' ? e.code : 1;
    stdout = e.stdout || '';
    stderr = e.stderr || e.message || '';
  }

  const payload = pickJson(stdout);
  if (!payload) {
    return {
      ok: false,
      message: `热更新脚本没有返回有效结果（退出码 ${code}）`,
      output: `${stdout}\n${stderr}`.trim(),
    };
  }

  const actionText = {
    noop: '补丁已是健康状态，无需重建',
    rebuilt: `补丁已重建（v${payload.toVersion || '?'}，${payload.sizeMB || '?'}MB）`,
    healthy: '补丁健康',
    'needs-patch': '检测到官方更新，需要打补丁',
    broken: '补丁损坏，需要重建',
    failed: '热更新失败',
  }[payload.action] || String(payload.action || '未知结果');

  let message = actionText;
  if (payload.ok !== true && Array.isArray(payload.issues) && payload.issues.length) {
    message += `：${payload.issues.join('；')}`;
  }

  return {
    ok: payload.ok === true,
    message,
    // 成功时只给一句提示（走 toast），失败时才把完整日志铺开
    output: payload.ok === true ? undefined : (payload.log || `${stdout}\n${stderr}`.trim()),
    detail: payload,
  };
}

module.exports = { runHotUpdate, MGGA_DIR, HOT_UPDATE, resolveNode };
