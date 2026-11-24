'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const log = require('./logger');

const SCANNER_EXE = path.join(__dirname, '..', 'bin', 'quickkeys-scanner.exe');

function runExec(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      ...opts
    }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : (err ? 1 : 0);
      resolve({
        code,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error: err ? err.message : null
      });
    });
  });
}

function getFixedDrives() {
  return new Promise((resolve) => {
    if (!fs.existsSync(SCANNER_EXE)) {
      return resolve([]);
    }
    execFile(SCANNER_EXE, ['disk-info'], { windowsHide: true, encoding: 'utf8', timeout: 10000 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const parsed = JSON.parse((stdout || '').trim());
        resolve(Array.isArray(parsed.drives) ? parsed.drives : []);
      } catch (_) {
        resolve([]);
      }
    });
  });
}

function normalizeWinPath(p) {
  return path.resolve(String(p || '').trim()).replace(/[\\/]+$/, '');
}

function isProtectedMigrationPath(targetPath) {
  const norm = normalizeWinPath(targetPath).toLowerCase();
  if (!norm || norm.length <= 3) return '禁止迁移磁盘根目录';

  const userProfile = normalizeWinPath(os.homedir()).toLowerCase();
  const localAppData = normalizeWinPath(process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local')).toLowerCase();
  const roamingAppData = normalizeWinPath(process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming')).toLowerCase();
  const localLow = normalizeWinPath(path.join(userProfile, 'AppData', 'LocalLow')).toLowerCase();
  const winDir = normalizeWinPath(process.env.WINDIR || 'C:\\Windows').toLowerCase();
  const pf = normalizeWinPath(process.env.ProgramFiles || 'C:\\Program Files').toLowerCase();
  const pf86 = normalizeWinPath(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').toLowerCase();
  const progData = normalizeWinPath(process.env.ProgramData || 'C:\\ProgramData').toLowerCase();

  const exactBlocked = new Set([
    'c:\\users',
    userProfile,
    path.join(userProfile, 'appdata'),
    localAppData,
    roamingAppData,
    localLow,
    path.join(userProfile, 'desktop'),
    path.join(userProfile, 'documents'),
    path.join(userProfile, 'downloads'),
    winDir,
    pf,
    pf86,
    progData,
    path.join(localAppData, 'microsoft'),
    path.join(localAppData, 'packages'),
    path.join(localAppData, 'temp'),
    path.join(localAppData, 'wsl'),
    path.join(roamingAppData, 'microsoft'),
    path.join(progData, 'microsoft')
  ]);

  if (exactBlocked.has(norm)) {
    return '受保护的系统或用户根目录，禁止直接搬家';
  }
  if (norm.startsWith(winDir + '\\')) {
    return 'Windows 系统目录受保护，禁止搬家';
  }
  return null;
}

function measureDirQuick(dirPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SCANNER_EXE)) {
      let bytes = 0;
      let files = 0;
      const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const ent of entries) {
          if (ent.isSymbolicLink()) continue;
          const full = path.join(d, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.isFile()) {
            try { bytes += fs.statSync(full).size; files++; } catch (_) {}
          }
        }
      };
      walk(dirPath);
      return resolve({ bytes, files });
    }

    const child = execFile(SCANNER_EXE, ['dir-sizes'], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ bytes: 0, files: 0 });
      const lines = (stdout || '').trim().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj && typeof obj.bytes === 'number') {
            return resolve({ bytes: obj.bytes, files: obj.files || 0 });
          }
        } catch (_) {}
      }
      resolve({ bytes: 0, files: 0 });
    });
    child.stdin.write(`measure|0|${dirPath}\n`, 'utf8');
    child.stdin.end();
  });
}

async function detectLockingProcesses(dirPath) {
  const norm = normalizeWinPath(dirPath).toLowerCase();
  const name = path.basename(norm);
  const hints = [];
  if (norm.includes('wechat') || norm.includes('xwechat')) hints.push('WeChat', 'Weixin', 'WeChatAppEx');
  if (norm.includes('wxwork')) hints.push('WXWork');
  if (norm.includes('tencent files') || norm.includes('\\qq')) hints.push('QQ');
  if (norm.includes('dingtalk')) hints.push('DingTalk');
  if (norm.includes('\\code')) hints.push('Code');
  if (norm.includes('docker')) hints.push('Docker Desktop', 'com.docker.backend');
  if (norm.includes('chrome')) hints.push('chrome');
  if (norm.includes('edge')) hints.push('msedge');
  if (norm.includes('discord')) hints.push('Discord');
  if (norm.includes('steam')) hints.push('steam', 'steamwebhelper');
  if (norm.includes('baidunetdisk')) hints.push('BaiduNetdisk');
  if (!hints.length && name.length >= 3) hints.push(name);

  if (!hints.length) return [];
  const escaped = hints.map((h) => `'${h.replace(/'/g, "''")}'`).join(',');
  const ps = `$ErrorActionPreference='SilentlyContinue'; $names=@(${escaped}); Get-Process | Where-Object { $p=$_.ProcessName; $names | Where-Object { $p -ieq $_ } } | Select-Object -ExpandProperty ProcessName -Unique | ConvertTo-Json -Compress`;
  const r = await runExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 6000 });
  if (!r.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    return [];
  }
}

async function killProcessNames(procNames) {
  for (const name of procNames) {
    if (!/^[A-Za-z0-9_.\- ]+$/.test(name)) continue;
    const exe = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
    await runExec('taskkill.exe', ['/F', '/IM', exe, '/T'], { timeout: 5000 });
  }
  await new Promise((r) => setTimeout(r, 500));
}

function runPsEncoded(script, timeoutMs = 15000) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return runExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: timeoutMs });
}

async function createJunction(linkPath, targetPath) {
  const escL = linkPath.replace(/'/g, "''");
  const escT = targetPath.replace(/'/g, "''");
  return runPsEncoded(`$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path '${escL}' -Target '${escT}' | Out-Null`, 15000);
}

async function removeJunctionOnly(linkPath) {
  const escL = linkPath.replace(/'/g, "''");
  return runPsEncoded(`$ErrorActionPreference='Stop'; [System.IO.Directory]::Delete('${escL}', $false)`, 15000);
}

function isReparsePath(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return true;
  } catch (_) {}
  return false;
}

async function checkReparsePointWin(p) {
  if (isReparsePath(p)) return true;
  const escaped = p.replace(/'/g, "''");
  const r = await runExec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$i = Get-Item -LiteralPath '${escaped}' -Force -ErrorAction SilentlyContinue; if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { 'YES' } else { 'NO' }`
  ], { timeout: 5000 });
  return r.stdout.trim() === 'YES';
}

class Migrator {
  constructor(store) {
    this.store = store;
  }

  listMoved() {
    const list = this.store.get('movedDirs');
    return Array.isArray(list) ? list : [];
  }

  /**
   * 无损搬家：C 盘数据目录 -> 目标盘目录 + NTFS Junction 联接（带 5 步事务锁与回滚）
   */
  async migrateDirectory(srcInput, targetDriveLetter, opts = {}) {
    const srcPath = normalizeWinPath(srcInput);
    const guardErr = isProtectedMigrationPath(srcPath);
    if (guardErr) return { ok: false, message: guardErr };
    if (!fs.existsSync(srcPath)) return { ok: false, message: `源目录不存在：${srcPath}` };

    const st = fs.lstatSync(srcPath);
    if (!st.isDirectory()) return { ok: false, message: '只支持搬家文件夹' };
    if (await checkReparsePointWin(srcPath)) {
      return { ok: false, message: '该目录已经是联接/符号链接，无需重复搬家' };
    }

    const srcDrive = srcPath.slice(0, 1).toUpperCase();
    const dstLetter = String(targetDriveLetter || '').trim().replace(/[:\\]/g, '').toUpperCase();
    if (!/^[A-Z]$/.test(dstLetter)) return { ok: false, message: '目标盘符无效' };
    if (!opts.allowCustomDestDir && dstLetter === srcDrive) {
      return { ok: false, message: '目标盘符不能与源目录所在盘符相同' };
    }

    const drives = await getFixedDrives();
    const dstDriveInfo = drives.find((d) => d.letter === dstLetter);
    if (!dstDriveInfo && !opts.allowCustomDestDir) {
      return { ok: false, message: `未检测到可用磁盘 ${dstLetter}:` };
    }
    if (dstDriveInfo && String(dstDriveInfo.format).toUpperCase() !== 'NTFS') {
      return { ok: false, message: `目标盘 ${dstLetter}: 文件系统为 ${dstDriveInfo.format}，NTFS 才能建立无损目录联接` };
    }

    // 检查进程占用
    const runningProcs = opts.skipProcCheck ? [] : await detectLockingProcesses(srcPath);
    if (runningProcs.length > 0 && !opts.autoKill) {
      return {
        ok: false,
        needsProcessClose: true,
        processes: runningProcs,
        message: `检测到软件进程（${runningProcs.join(', ')}）正在运行，建议先关闭后再无损搬家`
      };
    }
    if (runningProcs.length > 0 && opts.autoKill) {
      await killProcessNames(runningProcs);
    }

    // 1. 测量体积与校验 1.2x 可用空间
    const stats = await measureDirQuick(srcPath);
    const needBytes = Math.ceil(stats.bytes * 1.2) + 50 * 1024 * 1024;
    if (dstDriveInfo && dstDriveInfo.freeBytes < needBytes) {
      const freeGB = (dstDriveInfo.freeBytes / 1073741824).toFixed(1);
      const needGB = (needBytes / 1073741824).toFixed(1);
      return { ok: false, message: `目标盘 ${dstLetter}: 剩余空间不足（可用 ${freeGB} GB，安全冗余需 ${needGB} GB）` };
    }

    const baseName = path.basename(srcPath);
    const tag = `${baseName}_${Date.now()}`;
    const dstRoot = opts.allowCustomDestDir
      ? normalizeWinPath(opts.allowCustomDestDir)
      : path.join(`${dstLetter}:\\`, 'QuickKeysMoved');
    const dstPath = path.join(dstRoot, tag);
    fs.mkdirSync(dstRoot, { recursive: true });

    // 2. robocopy 全量复制校验
    log.info('migrator', `开始搬家复制: ${srcPath} -> ${dstPath}`);
    const cp = await runExec('robocopy.exe', [
      srcPath, dstPath,
      '/E', '/COPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/MT:4'
    ], { timeout: 600000 });

    // robocopy: 0-7 成功（8 及以上代表有文件复制失败）
    if (cp.code >= 8) {
      try { fs.rmSync(dstPath, { recursive: true, force: true }); } catch (_) {}
      return {
        ok: false,
        message: `文件拷贝未完全成功（可能被其他程序锁定占用，robocopy 返回码 ${cp.code}），已自动回滚清理目标副本`
      };
    }

    // 3. 将原目录重命名为临时备份 .qk_bak_
    const bakPath = `${srcPath}.qk_bak_${Date.now()}`;
    try {
      fs.renameSync(srcPath, bakPath);
    } catch (err) {
      try { fs.rmSync(dstPath, { recursive: true, force: true }); } catch (_) {}
      return {
        ok: false,
        message: `原目录正在被系统或应用占用（无法更名交接）：${err.message}。已保留原目录零改动，并清除了临时副本。`
      };
    }

    // 4. 建立 NTFS Junction (mklink /J)
    const linkRes = await createJunction(srcPath, dstPath);
    if (linkRes.code !== 0 || !fs.existsSync(srcPath)) {
      // 回滚还原原目录
      try {
        if (fs.existsSync(srcPath)) await removeJunctionOnly(srcPath);
        fs.renameSync(bakPath, srcPath);
      } catch (rbErr) {
        log.error('migrator', `回滚原目录失败: ${rbErr.message}`);
      }
      try { fs.rmSync(dstPath, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, message: `创建目录联接失败，已自动无损恢复原目录：${linkRes.stderr || linkRes.error || ''}` };
    }

    // 验证联接可读后再清理旧备份
    try {
      fs.readdirSync(srcPath);
    } catch (verifyErr) {
      try {
        await removeJunctionOnly(srcPath);
        fs.renameSync(bakPath, srcPath);
      } catch (_) {}
      try { fs.rmSync(dstPath, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, message: `目录联接校验可读失败，已恢复原目录：${verifyErr.message}` };
    }

    // 5. 安全移除备份并写账本
    let bakResidual = false;
    try {
      fs.rmSync(bakPath, { recursive: true, force: true });
    } catch (_) {
      bakResidual = true;
    }

    const record = {
      id: `mv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: opts.label || baseName,
      srcPath,
      dstPath,
      bytes: stats.bytes,
      files: stats.files,
      movedAt: Date.now()
    };
    const list = this.listMoved();
    list.unshift(record);
    this.store.set('movedDirs', list);

    return {
      ok: true,
      record,
      bakResidual,
      freedBytes: stats.bytes,
      message: bakResidual
        ? `已无损迁至 ${dstPath} 并生效；旧备份目录有少量锁文件残留，重启后可删除`
        : `已无损迁至 ${dstPath}，C 盘已释放 ${(stats.bytes / 1073741824).toFixed(2)} GB`
    };
  }

  /**
   * 一键迁回原盘
   */
  async restoreDirectory(id, opts = {}) {
    const list = this.listMoved();
    const idx = list.findIndex((item) => item.id === id || normalizeWinPath(item.srcPath).toLowerCase() === normalizeWinPath(id).toLowerCase());
    if (idx < 0) return { ok: false, message: '未找到对应的搬家记录' };

    const rec = list[idx];
    const { srcPath, dstPath } = rec;
    if (!fs.existsSync(dstPath)) {
      return { ok: false, message: `目标盘数据目录已不存在：${dstPath}` };
    }

    const runningProcs = opts.skipProcCheck ? [] : await detectLockingProcesses(srcPath);
    if (runningProcs.length > 0 && !opts.autoKill) {
      return {
        ok: false,
        needsProcessClose: true,
        processes: runningProcs,
        message: `检测到 ${runningProcs.join(', ')} 正在运行，请先关闭后再迁回`
      };
    }
    if (runningProcs.length > 0 && opts.autoKill) {
      await killProcessNames(runningProcs);
    }

    const stagePath = `${srcPath}.qk_restore_${Date.now()}`;
    const cp = await runExec('robocopy.exe', [
      dstPath, stagePath,
      '/E', '/COPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP', '/MT:4'
    ], { timeout: 600000 });
    if (cp.code >= 8) {
      try { fs.rmSync(stagePath, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, message: `回迁拷贝未完成（robocopy 返回码 ${cp.code}），原联接保持不变` };
    }

    if (fs.existsSync(srcPath)) {
      const isJunc = await checkReparsePointWin(srcPath);
      if (!isJunc) {
        try { fs.rmSync(stagePath, { recursive: true, force: true }); } catch (_) {}
        return { ok: false, message: '原路径当前已不是联接目录，中止覆盖防误操作' };
      }
      const rmJunc = await removeJunctionOnly(srcPath);
      if (rmJunc.code !== 0 || fs.existsSync(srcPath)) {
        try { fs.rmSync(stagePath, { recursive: true, force: true }); } catch (_) {}
        return { ok: false, message: '移除原目录联接失败（可能正在被占用），已保留数据安全' };
      }
    }

    try {
      fs.renameSync(stagePath, srcPath);
    } catch (err) {
      await createJunction(srcPath, dstPath);
      try { fs.rmSync(stagePath, { recursive: true, force: true }); } catch (_) {}
      return { ok: false, message: `恢复原目录名称失败，已自动重新挂回原联接：${err.message}` };
    }

    try { fs.rmSync(dstPath, { recursive: true, force: true }); } catch (_) {}
    list.splice(idx, 1);
    this.store.set('movedDirs', list);

    return { ok: true, message: `已安全迁回原路径：${srcPath}`, movedDirs: list };
  }
}

module.exports = {
  Migrator,
  isProtectedMigrationPath,
  getFixedDrives,
  measureDirQuick,
  checkReparsePointWin
};
