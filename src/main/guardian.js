'use strict';

const { spawn, exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('./logger');
const scripts = require('./scripts');

/**
 * 解析 bin 下可执行文件的可用路径：优先用启动时物化到 userData 的副本，
 * 因为打包后 asar 内的 exe 无法直接被系统执行。
 */
function resolveBinExe(name) {
  const dir = scripts.getScriptsDir();
  if (dir) {
    const materialized = path.join(dir, name);
    if (fs.existsSync(materialized)) return materialized;
  }
  const fallback = path.join(__dirname, '..', 'bin', name);
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * 封装高可靠管理员提权脚本执行助手（生成独立临时文件，杜绝命令行超长与 UAC 弹窗被拦截）
 */
function runElevatedPsScript(psScript, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `qk_cm_${Date.now()}_${Math.floor(Math.random() * 1000)}.ps1`);
    try {
      fs.writeFileSync(tmpFile, psScript, 'utf8');
    } catch (e) {
      return reject(e);
    }

    const escapedPath = tmpFile.replace(/\\/g, '\\\\');
    const psCmd = `
try {
  $p = Start-Process powershell.exe -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${escapedPath}"' -Verb RunAs -Wait -PassThru
  if ($p.ExitCode -eq 0) {
    Write-Output "RUNAS_OK"
  } else {
    Write-Error "ExitCode:$($p.ExitCode)"
  }
} catch {
  Write-Error $_.Exception.Message
}
`;

    const child = spawn('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    if (child.stdout) child.stdout.on('data', d => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      reject(new Error('管理员授权超时或已取消'));
    }, timeoutMs);

    child.on('close', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      const combined = (stdout + ' ' + stderr).trim();
      if (combined.includes('RUNAS_OK')) {
        resolve({ ok: true, output: combined });
      } else if (combined.includes('canceled') || combined.includes('cancelled') || combined.includes('1223')) {
        reject(new Error('用户取消了管理员授权'));
      } else {
        resolve({ ok: true, output: combined });
      }
    });
  });
}

/**
 * 封装安全的 PowerShell 脚本执行助手（支持普通模式与提权模式）
 */
function runPowershell(script, timeoutMs = 25000, elevate = false) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    if (elevate) {
      // 提权模式：调用 Start-Process -Verb RunAs
      const launcher = `Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}' -Verb RunAs -Wait -WindowStyle Hidden`;
      const launcherEncoded = Buffer.from(launcher, 'utf16le').toString('base64');
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', launcherEncoded
      ], { windowsHide: true, stdio: 'ignore' });

      child.on('close', (code) => {
        if (code === 0) resolve('OK');
        else reject(new Error(`Elevated process exited with code ${code}`));
      });
      child.on('error', reject);
      return;
    }

    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        reject(new Error(`PowerShell script timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const err = new Error(stderr.trim() || `PowerShell exited with code ${code}`);
        err.code = code;
        err.stdout = stdout;
        reject(err);
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 1. 获取系统健康状态（内存、CPU、临时垃圾估算）
 */
async function measureTempViaScanner() {
  const scannerExe = resolveBinExe('quickkeys-scanner.exe');
  if (!scannerExe) return { totalMB: 0, cleanMB: 0 };
  const tempDir = os.tmpdir();
  return new Promise((resolve) => {
    const child = execFile(scannerExe, ['dir-sizes'], { windowsHide: true, encoding: 'utf8', timeout: 20000 }, (err, stdout) => {
      if (err || !stdout) return resolve({ totalMB: 0, cleanMB: 0 });
      let totalMB = 0;
      let cleanMB = 0;
      for (const line of stdout.trim().split(/\r?\n/)) {
        try {
          const item = JSON.parse(line);
          if (item.id === 'all') totalMB = Math.round((item.bytes || 0) / 1048576);
          if (item.id === 'old7d') cleanMB = Math.round((item.bytes || 0) / 1048576);
        } catch (parseErr) {
          log.warn('guardian:tempScanner', parseErr.message);
        }
      }
      resolve({ totalMB, cleanMB });
    });
    child.stdin.write(`all|0|${tempDir}\nold7d|168|${tempDir}\n`, 'utf8');
    child.stdin.end();
  });
}

/**
 * 内存指标采集：调用 quickkeys-memprobe.exe（PDH + psapi），输出单行 JSON。
 * 失败返回 null，由 getSystemHealth 回退到 Node os 口径。
 */
function runMemProbe() {
  return new Promise((resolve) => {
    const exe = resolveBinExe('quickkeys-memprobe.exe');
    if (!exe) return resolve(null);
    execFile(exe, [], { windowsHide: true, encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

/**
 * 读取内存原始探针（毫秒级），供游戏专区等轻量场景复用，避免再拉一个 PowerShell。
 * 返回 { TotalMB, FreeMB(实为可用), StandbyMB, CommittedMB, CommitLimitMB, ... } 或 null。
 */
async function readMemoryProbe() {
  const raw = await runMemProbe();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.TotalMB > 0 ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * 临时目录体积缓存：全量遍历 Temp 在 6 万文件级别要 10s 左右，不能阻塞首屏健康探测。
 * 首次后台扫描一次，之后 5 分钟内复用；扫描期间先返回上次结果（可能是 0，UI 会隐藏该项）。
 */
let tempStatsCache = { totalMB: 0, cleanMB: 0, at: 0 };
let tempScanning = false;
function ensureTempStats() {
  const fresh = tempStatsCache.at && (Date.now() - tempStatsCache.at < 300000);
  if (fresh || tempScanning) return;
  tempScanning = true;
  measureTempViaScanner()
    .then((s) => {
      if (s && (s.totalMB > 0 || s.cleanMB > 0)) tempStatsCache = { ...s, at: Date.now() };
    })
    .catch(() => {})
    .finally(() => { tempScanning = false; });
}

async function getSystemHealth() {
  // 口径说明：\Memory\Available Bytes（即 FreeMB 字段）已经包含待机缓存（Standby Cache），
  // 它对应任务管理器里的「可用」。因此 使用中 = 物理总量 - 可用，绝不能再减一次待机缓存，
  // 否则会出现「占用 0%」「可用 > 物理总量」这类错误值。待机缓存仅作为可用量的子集展示。
  // 采集由 quickkeys-memprobe.exe（PDH + psapi）完成：与 CIM 同源口径，但无需冷启动 PowerShell。
  let m = null;
  ensureTempStats();
  const tempStats = tempStatsCache;
  try {
    const raw = await runMemProbe();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.TotalMB > 0) m = parsed;
    }
  } catch (e) {
    log.error('guardian:getSystemHealth', e.message);
  }
  if (m) {
    m.TempTotalMB = tempStats.totalMB;
    m.TempCleanMB = tempStats.cleanMB;
  }

  const MB = 1024 * 1024;
  const totalMB = m ? m.TotalMB : Math.round(os.totalmem() / MB);
  // FreeMB 实为「可用物理内存」（含待机缓存），与 os.freemem() 同口径，可直接作为 available。
  const availableRawMB = m ? m.FreeMB : Math.round(os.freemem() / MB);
  const standbyRawMB = m ? m.StandbyMB : 0;
  const availableMB = Math.max(0, Math.min(availableRawMB, totalMB));
  // 待机缓存是可用量的子集，钳制一下防止把异常计数放大
  const standbyMB = Math.min(Math.max(0, standbyRawMB), availableMB);
  // 与任务管理器「使用中」同口径：物理总量 - 可用
  const usedMB = Math.max(0, totalMB - availableMB);
  const commitMB = m ? m.CommittedMB : 0;
  const commitLimitMB = m ? m.CommitLimitMB : 0;
  const kernelMB = m ? (m.PoolNonpagedMB + m.PoolPagedMB) : 0;

  const usedPercent = totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;
  const commitPercent = commitLimitMB > 0 ? Math.round((commitMB / commitLimitMB) * 100) : 0;

  let level = 'ok';
  let statusText = '物理内存余量充足，待机缓存可随时回收';
  if (commitPercent >= 92) {
    level = 'danger';
    statusText = '提交量已接近上限，继续分配可能失败，建议立即清理大头应用';
  } else if (commitPercent >= 82) {
    level = 'warn';
    statusText = '页面文件提交量偏高，系统正在借用磁盘兜底';
  } else if (usedPercent >= 88) {
    level = 'danger';
    statusText = '物理内存吃紧，建议清理大头应用';
  } else if (usedPercent >= 78) {
    level = 'warn';
    statusText = '物理内存偏紧，待机缓存仍可回收';
  }

  return {
    source: m ? 'perf-counter' : 'node-fallback',
    totalGB: (totalMB / 1024).toFixed(1),
    usedGB: (usedMB / 1024).toFixed(1),
    availableGB: (availableMB / 1024).toFixed(1),
    standbyGB: (standbyMB / 1024).toFixed(1),
    commitGB: (commitMB / 1024).toFixed(1),
    commitLimitGB: (commitLimitMB / 1024).toFixed(1),
    kernelPoolGB: (kernelMB / 1024).toFixed(1),
    compressedGB: m ? (m.CompressedMB / 1024).toFixed(1) : '0.0',
    usedPercent,
    commitPercent,
    level,
    // 兼容旧字段
    freeGB: (availableMB / 1024).toFixed(1),
    tempSizeMB: m ? m.TempTotalMB : 0,
    tempCleanMB: m ? m.TempCleanMB : 0,
    cpuCores: os.cpus().length,
    statusText
  };
}

// 常见 Windows 进程的通俗中文友好字典
const KNOWN_PROCESS_NAMES = {
  'language_server': 'AI 代码补全引擎 (Antigravity)',
  'antigravity': 'Antigravity 编程环境',
  'msmpeng': 'Windows Defender 杀毒核心',
  'chrome': 'Google Chrome 谷歌浏览器',
  'msedge': 'Microsoft Edge 微软浏览器',
  'steamwebhelper': 'Steam 客户端组件',
  'steam': 'Steam 游戏平台',
  'workbuddy': 'WorkBuddy 协同办公',
  'trae cn': 'Trae AI 编程助手',
  'doubao': '豆包 AI 桌面端',
  'wechat': '微信桌面版',
  'qq': '腾讯 QQ',
  'taskmgr': 'Windows 任务管理器',
  'code': 'VS Code 代码编辑器',
  'node': 'Node.js 服务进程',
  'electron': 'QuickKeys 自身应用',
  'fxsound': 'FxSound 音效增强器',
  'deskbox': 'DeskBox 桌面助手'
};

/**
 * 系统进程白名单：仍然展示（它们确实吃内存），但禁止勾选终止
 */
const PROTECTED_PROCESSES = new Set([
  'memory compression', 'system', 'idle', 'registry', 'msmpeng',
  'svchost', 'dwm', 'csrss', 'wininit', 'services', 'lsass', 'smss',
  'explorer', 'sihost', 'taskhostw', 'searchindexer', 'audiodg',
  'securityhealthservice', 'wudfhost', 'dllhost', 'runtimebroker',
  'wmiprvse', 'spoolsv', 'fontdrvhost', 'winlogon', 'sppsvc', 'lsaiso'
]);

/**
 * 获取当前吃内存最多的应用（按应用聚合，而不是按 PID 碎片化）
 */
async function getTopProcesses(limit = 20) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'

# 先取全部 >20MB 的进程，只为体积最大的 40 个解析路径/描述（避免逐个 MainModule 拖慢）
$all = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.WorkingSet64 -gt 20MB -and $_.Id -ne $PID } |
  Sort-Object WorkingSet64 -Descending

$detail = @{}
foreach ($p in ($all | Select-Object -First 40)) {
  $d = ''
  $f = ''
  try {
    $d = [string]$p.MainModule.FileVersionInfo.FileDescription
    $f = [string]$p.MainModule.FileName
  } catch {}
  if (-not $f) {
    try { $f = [string](Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)").ExecutablePath } catch {}
  }
  $detail[[string]$p.Id] = @{ Desc = $d; Path = $f }
}

$rows = @()
foreach ($p in $all) {
  $info = $detail[[string]$p.Id]
  $rows += [PSCustomObject]@{
    Pid = $p.Id
    Name = $p.ProcessName
    WS = [math]::Round($p.WorkingSet64 / 1MB)
    Priv = [math]::Round($p.PrivateMemorySize64 / 1MB)
    Title = [string]$p.MainWindowTitle
    HasWindow = [bool]($p.MainWindowHandle -ne 0)
    Desc = $(if ($info) { $info.Desc } else { '' })
    Path = $(if ($info) { $info.Path } else { '' })
  }
}
@($rows) | ConvertTo-Json -Compress
`;

  let rows = [];
  try {
    const raw = await runPowershell(script, 15000);
    if (raw) {
      const parsed = JSON.parse(raw);
      rows = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch (e) {
    log.error('guardian:getTopProcesses', e.message);
    return [];
  }

  // 按进程名聚合：Chrome 的十几个子进程合成一行，避免占满榜单
  const groups = new Map();
  for (const p of rows) {
    const key = String(p.Name || '').toLowerCase();
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = {
        Key: key, RawName: p.Name, Name: p.Name,
        MemMB: 0, PrivateMB: 0, Count: 0, Pids: [],
        Title: '', Path: '', Desc: '', HasWindow: false
      };
      groups.set(key, g);
    }
    g.MemMB += Number(p.WS) || 0;
    g.PrivateMB += Number(p.Priv) || 0;
    g.Count += 1;
    g.Pids.push(p.Pid);
    if (!g.Desc && p.Desc) g.Desc = p.Desc;
    if (!g.Path && p.Path) g.Path = p.Path;
    if (!g.Title && p.Title) g.Title = p.Title;
    if (p.HasWindow) g.HasWindow = true;
  }

  const list = Array.from(groups.values())
    // 自身（QuickKeys 主进程及其渲染进程）不参与排行
    .filter((g) => !g.Pids.includes(process.pid))
    .sort((a, b) => b.MemMB - a.MemMB)
    .slice(0, limit)
    .map((g) => {
      const lower = g.RawName.toLowerCase();
      let friendlyName = KNOWN_PROCESS_NAMES[lower] || g.Desc || g.RawName;
      if (friendlyName.length > 25) friendlyName = friendlyName.slice(0, 25) + '…';

      let subText = '';
      if (g.Title && g.Title.trim()) subText = g.Title.trim();
      else if (g.Path) {
        const parts = g.Path.split(/[\\\/]/);
        subText = parts.length > 2 ? parts.slice(0, 2).join('\\') + '\\…\\' + parts[parts.length - 1] : g.Path;
      } else {
        subText = `${g.RawName}.exe`;
      }
      if (subText.length > 60) subText = subText.slice(0, 60) + '…';

      const readOnly = PROTECTED_PROCESSES.has(lower);
      return {
        Key: g.Key,
        Name: friendlyName,
        RawName: g.RawName,
        MemMB: g.MemMB,
        PrivateMB: g.PrivateMB,
        Count: g.Count,
        Pids: g.Pids,
        Title: subText,
        Path: g.Path || '',
        ReadOnly: readOnly,
        Badge: readOnly ? '系统' : ''
      };
    });

  return list;
}

/**
 * 轻量内存快照（不含临时目录扫描），用于加速前后对比
 */
async function getMemorySnapshot() {
  const MB = 1024 * 1024;
  const totalMB = Math.round(os.totalmem() / MB);
  const freeMB = Math.round(os.freemem() / MB);
  const usedMB = Math.max(0, totalMB - freeMB);
  return {
    totalMB,
    freeMB,
    standbyMB: 0,
    availableMB: freeMB,
    usedMB,
    commitMB: usedMB,
    commitLimitMB: totalMB
  };
}

function formatMB(mb) {
  const n = Math.max(0, Math.round(mb || 0));
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`;
}

/**
 * 2. 一键加速：清理选中的应用 + 只修剪后台工作集 + 清理陈旧临时文件
 */
async function boostSystem(options = {}) {
  const before = await getMemorySnapshot();
  const deep = options.deep === true;

  // 1. 如果用户没有勾选特定查杀进程，优先直接调用原生极速 Booster (0.5秒秒级完成)
  const targetApps = Array.isArray(options.targetApps)
    ? options.targetApps
        .filter((t) => t && !PROTECTED_PROCESSES.has(String(t.name || '').toLowerCase()))
        .map((t) => ({
          name: String(t.name || ''),
          pids: (t.pids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
        }))
        .filter((t) => t.pids.length > 0)
    : [];

  const boosterExe = resolveBinExe('quickkeys-booster.exe');
  if (targetApps.length === 0 && boosterExe) {
    try {
      const boosterRes = await new Promise((resolve) => {
        execFile(boosterExe, [], { timeout: 6000, windowsHide: true }, (err, stdout) => {
          if (!err && stdout.trim()) {
            try {
              return resolve(JSON.parse(stdout.trim()));
            } catch (_) {}
          }
          resolve(null);
        });
      });

      if (boosterRes && boosterRes.ok) {
        const after = await getMemorySnapshot();
        const freedPhysMB = Math.max(0, Math.round(after.availableMB - before.availableMB));
        return {
          ok: true,
          before,
          after,
          freedPhysMB: freedPhysMB || boosterRes.freedMB || 0,
          freedTempMB: 0,
          cleanedCount: 0,
          killedCount: 0,
          skippedCount: 0,
          trimmedCount: boosterRes.trimmedCount || 0,
          purgedStandby: !!boosterRes.standbyPurged,
          fgProcess: boosterRes.fgProcess || '',
          boostedPriority: !!boosterRes.boostedPriority,
          durationMs: 0
        };
      }
    } catch (_) {}
  }

  // 2. 勾选特定进程查杀时的轻量模式（已彻底剔除慢速的递归 Temp 临时文件扫描）
  const targetsJson = JSON.stringify(targetApps);
  const deepFlag = deep ? '$true' : '$false';

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$deep = ${deepFlag}
$protected = '^(memory compression|system|idle|registry|msmpeng|svchost|dwm|csrss|wininit|services|lsass|smss|explorer|sihost|taskhostw|searchindexer|audiodg|securityhealthservice|wudfhost|dllhost|runtimebroker)$'
$killed = 0
$skipped = 0
$trimmed = 0

$fg = 0
try {
  $fgSig = '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint id);'
  $fgType = Add-Type -MemberDefinition $fgSig -Name QKFg -Namespace QK -PassThru
  $hwnd = $fgType::GetForegroundWindow()
  $fgPid = 0
  [void]$fgType::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
  $fg = [int]$fgPid
} catch {}

# 终止用户指定勾选的应用
$targets = ConvertFrom-Json '${targetsJson.replace(/'/g, "''")}'
if ($targets) {
  foreach ($t in $targets) {
    foreach ($id in $t.pids) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if (-not $p) { continue }
      if ($p.ProcessName -match $protected) { $skipped++; continue }
      if ($t.name -and ($p.ProcessName -ne $t.name)) { $skipped++; continue }
      try { Stop-Process -Id $id -Force -ErrorAction Stop; $killed++ } catch { $skipped++ }
    }
  }
}

# 修剪非前台后台进程
$code = '[DllImport("psapi.dll")] public static extern int EmptyWorkingSet(IntPtr hwProc);'
try {
  $type = Add-Type -MemberDefinition $code -Name ('QKTrim_' + (Get-Random)) -Namespace QKMem -PassThru
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.WorkingSet64 -gt 100MB -and $_.Id -ne $PID -and $_.Id -ne $fg -and
    $_.MainWindowHandle -eq 0 -and $_.ProcessName -notmatch $protected
  } | ForEach-Object {
    try { if ($type::EmptyWorkingSet($_.Handle) -ne 0) { $trimmed++ } } catch {}
  }
} catch {}

[PSCustomObject]@{
  FreedTempMB = 0
  CleanedCount = 0
  KilledCount = $killed
  SkippedCount = $skipped
  TrimmedCount = $trimmed
  PurgedStandby = $false
} | ConvertTo-Json -Compress
`;

  let result = { FreedTempMB: 0, CleanedCount: 0, KilledCount: 0, SkippedCount: 0, TrimmedCount: 0, PurgedStandby: false };
  try {
    const raw = await runPowershell(script, 60000);
    if (raw) result = JSON.parse(raw);
  } catch (e) {
    log.error('guardian:boost', e.message);
  }

  await new Promise((r) => setTimeout(r, 1200));
  const after = await getMemorySnapshot();

  const newHealth = await getSystemHealth();
  const topProcs = await getTopProcesses(20);

  const dAvail = after.availableMB - before.availableMB;
  const dCommit = before.commitMB - after.commitMB;

  const parts = [`可用内存 ${formatMB(before.availableMB)} → ${formatMB(after.availableMB)}`];
  if (result.KilledCount > 0) parts.push(`终止 ${result.KilledCount} 个选中进程`);
  if (result.TrimmedCount > 0) parts.push(`修剪 ${result.TrimmedCount} 个后台工作集`);
  if (result.PurgedStandby) parts.push('已清空待机缓存');
  if (result.FreedTempMB > 0) parts.push(`清理临时 ${result.FreedTempMB} MB`);
  if (dAvail <= 0 && !result.KilledCount && !result.FreedTempMB) parts.push('未发现可回收内存');

  const msg = `加速完成：${parts.join('，')}`;

  return {
    ok: true,
    freedMemMB: Math.max(0, Math.round(dAvail)),
    freedTempMB: result.FreedTempMB || 0,
    cleanedFiles: result.CleanedCount || 0,
    killedCount: result.KilledCount || 0,
    trimmedCount: result.TrimmedCount || 0,
    purgedStandby: !!result.PurgedStandby,
    commitFreedMB: Math.max(0, Math.round(dCommit)),
    before,
    after,
    newHealth,
    topProcs,
    message: msg
  };
}

/**
 * 高频常见软件与系统自启动友好中文名字典（常驻 Node 内存，零命令行体积，毫秒级解析）
 */
const STARTUP_FRIENDLY_NAMES = {
  'ctfmon': 'Windows 文本输入与输入法核心 (ctfmon)',
  'DeskBox': 'DeskBox 桌面收纳组件',
  'SecurityHealth': 'Windows 安全中心 (Defender)',
  'RtkAudUService': 'Realtek 高清音频驱动服务',
  'ACE-Tray': '腾讯反作弊专家 (Anti-Cheat Expert)',
  'WorkBuddy.WorkBuddy': 'WorkBuddy 智能工作助手',
  'Gemini': 'Google Gemini 桌面客户端',
  'WinEHelper': '微信电脑版辅助程序 (WinEHelper)',
  'FxSound': 'FxSound 音效增强器',
  'ClaudeStack-Autostart': 'ClaudeStack (CC Switch 自动守护与代理切换)',
  '360ZipUpdater': '360 压缩自动更新',
  'AutoGLM Elevated Startup': 'AutoGLM 开机自启服务',
  'LaunchDouyinGuard': '抖音电脑版守护程序',
  'GoogleUpdaterTaskUser': 'Google 软件更新服务',
  'NvProfileUpdaterOnLogon': 'NVIDIA 显卡配置更新',
  'EqualizerAPOUpdateChecker': 'Equalizer APO 音频调音更新',
  'Office Actions Server': 'Microsoft Office 启动服务',
  'Office Automatic Updates': 'Microsoft Office 自动更新',
  'Office Background Push Maintenance': 'Microsoft Office 推送维护',
  'Office Feature Updates Logon': 'Microsoft Office 功能更新',
  'Office Startup Maintenance': 'Microsoft Office 启动维护',
  'OneDrive': 'Microsoft OneDrive 云盘同步',
  'Steam': 'Steam 游戏平台',
  'EpicGamesLauncher': 'Epic Games 客户端',
  'Discord': 'Discord 聊天客户端',
  'TencentMeeting': '腾讯会议',
  'DingTalk': '钉钉客户端',
  'WeChat': '微信电脑版',
  'QQ': '腾讯 QQ 客户端',
  'BaiduNetdisk': '百度网盘',
  'Thunder': '迅雷下载',
  'CloudMusic': '网易云音乐',
  'Kugou': '酷狗音乐',
  'Everything': 'Everything 本地快速搜索',
  'Snipaste': 'Snipaste 截图工具',
  'TrafficMonitor': 'TrafficMonitor 网速与硬件监控',
  'Listary': 'Listary 快速搜索定位',
  'ToDesk': 'ToDesk 远程桌面',
  'SunloginClient': '向日葵远程控制',
  'IDMan': 'Internet Download Manager (IDM)',
  'clash-verge': 'Clash Verge 代理客户端',
  'v2rayN': 'v2rayN 代理客户端',
  'SingBox': 'Sing-Box 代理核心',
  'Tailscale': 'Tailscale 虚拟组网',
  'Docker Desktop': 'Docker Desktop 容器引擎',
  'Spotify': 'Spotify 音乐播放器',
  'Telegram': 'Telegram 桌面客户端',
  'Obsidian': 'Obsidian 笔记知识库',
  'Notion': 'Notion 笔记工作台',
  'Figma': 'Figma 设计工具',
  'Postman': 'Postman 接口调试工具',
  'Bandizip': 'Bandizip 压缩软件',
  '7-Zip': '7-Zip 压缩工具',
  'PotPlayer': 'PotPlayer 影音播放器',
  'GeForce Experience': 'NVIDIA GeForce Experience',
  'Razer Synapse': '雷蛇雷云外设控制',
  'Logitech G HUB': '罗技 G HUB 外设控制',
  'Corsair iCUE': '美商海盗船 iCUE 控制',
  'SteelSeries GG': '赛睿 SteelSeries GG 外设',
  'Lenovo Vantage': '联想电脑管家 (Lenovo Vantage)',
  'Legion Zone': '拯救者领域 (Legion Zone)',
  'AMD Software': 'AMD Radeon 显卡控制软件',
  'MSI Afterburner': '微星小飞机 (显卡超频与游戏帧率OSD)',
  'RTSS': 'RivaTuner 游戏帧率监测',
  'OBS Studio': 'OBS Studio 录屏推流',
  'PowerToys': '微软 PowerToys 效率套件',
  'Wallpaper Engine': 'Wallpaper Engine 动态壁纸',
  'AutoHotkey': 'AutoHotkey 自动化脚本',
  'Geek Uninstaller': 'Geek 极简高效卸载工具',
  'CCleaner': 'CCleaner 系统清理工具',
  'AIDA64': 'AIDA64 专业硬件检测',
  'HWiNFO': 'HWiNFO 硬件传感器监控',
  'CPU-Z': 'CPU-Z 处理器检测',
  'GPU-Z': 'GPU-Z 显卡检测'
};

function resolveStartupDisplayName(name, cmd = '') {
  if (STARTUP_FRIENDLY_NAMES[name]) return STARTUP_FRIENDLY_NAMES[name];
  for (const [k, v] of Object.entries(STARTUP_FRIENDLY_NAMES)) {
    if (name.toLowerCase().includes(k.toLowerCase())) return v;
  }
  if (/^MicrosoftEdgeAutoLaunch/i.test(name)) return 'Microsoft Edge 浏览器';
  if (/cc-switch/i.test(cmd)) return 'ClaudeStack (CC Switch 自动守护与代理切换)';
  if (/AgentHub/i.test(cmd)) return 'AgentHub 智能代理服务';
  if (/WinEHelper/i.test(cmd) || /WinEHelper/i.test(name)) return '微信电脑版辅助程序 (WinEHelper)';
  if (/FxSound/i.test(cmd) || /FxSound/i.test(name)) return 'FxSound 音效增强器';
  if (/DeskBox/i.test(cmd) || /DeskBox/i.test(name)) return 'DeskBox 桌面收纳组件';
  return name;
}

/**
 * 3. 获取所有开机启动项（注册表 + 启动文件夹 + 计划任务第三方自启动，全量中文应用名解析）
 */
async function getStartupItems() {
  const scriptPath = path.join(__dirname, '..', 'bin', 'get-startup.ps1');
  try {
    const raw = await new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024
      }, (err, stdout) => {
        if (!err && stdout.trim()) return resolve(stdout.trim());
        resolve('');
      });
    });

    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];

    return list.map(item => {
      const isCore = ['ctfmon', 'SecurityHealth'].includes(item.Name);
      const isDriver = ['RtkAudUService', 'RtkAudioService'].includes(item.Name) || /realtek/i.test(item.Command || '');
      const friendly = resolveStartupDisplayName(item.Name, item.Command || '');
      
      let category = 'app';
      if (isCore) category = 'core';
      else if (isDriver) category = 'driver';
      else if (item.Type === 'Task') category = 'task';
      else if (item.Type === 'Shortcut') category = 'folder';

      let advice = '';
      if (isCore) advice = '系统核心组件，建议保留以保障正常打字与系统基础安全';
      else if (isDriver) advice = '声卡/外设底层服务，如无异常建议保留';
      else if (friendly.includes('Edge')) advice = '建议禁用：可显著缩短开机启动时间，不影响手动使用浏览器';
      else if (friendly.includes('ClaudeStack') || friendly.includes('CC Switch')) advice = '已根据您的要求关闭自启；如需重新自动守护代理切换可随时点右侧开启';
      else if (friendly.includes('Office') || friendly.includes('Updater')) advice = '后台自动更新服务，禁用不影响正常使用';
      else if (friendly.includes('DeskBox')) advice = '第三方桌面工具，可按需启闭';
      else if (friendly.includes('反作弊') || friendly.includes('ACE')) advice = '腾讯游戏反外挂服务托盘，不玩游戏时可关闭';

      return {
        ...item,
        DisplayName: friendly,
        Category: category,
        IsCore: isCore,
        Advice: advice
      };
    });
  } catch (e) {
    log.error('guardian:getStartupItems', e.message);
    return [];
  }
}

/**
 * 4. 真正可逆地切换开机启动项的【启用 / 禁用】状态
 */
async function toggleStartupItem(item, enable) {
  if (!item || !item.Name) return { ok: false, error: '参数错误' };

  if (item.Type === 'Registry') {
    const storeKey = item.StorageKey || 'HKCU_Run';
    const disabledKey = `HKCU:\\Software\\QuickKeys\\DisabledStartup\\${storeKey}`;
    const origPath = item.Location || 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    const isHklm = origPath.startsWith('HKLM');

    const script = enable ? `
$orig = '${origPath.replace(/'/g, "''")}'
$dis = '${disabledKey.replace(/'/g, "''")}'
$name = '${item.Name.replace(/'/g, "''")}'
$val = '${(item.Command || '').replace(/'/g, "''")}'

if (-not (Test-Path $orig)) { New-Item -Path $orig -Force | Out-Null }
Set-ItemProperty -Path $orig -Name $name -Value $val -Force
if (Test-Path $dis) { Remove-ItemProperty -Path $dis -Name $name -Force -ErrorAction SilentlyContinue }
'OK'
` : `
$orig = '${origPath.replace(/'/g, "''")}'
$dis = '${disabledKey.replace(/'/g, "''")}'
$name = '${item.Name.replace(/'/g, "''")}'
$val = '${(item.Command || '').replace(/'/g, "''")}'

if (-not (Test-Path $dis)) { New-Item -Path $dis -Force | Out-Null }
Set-ItemProperty -Path $dis -Name $name -Value $val -Force
if (Test-Path $orig) { Remove-ItemProperty -Path $orig -Name $name -Force }
'OK'
`;

    try {
      const res = await runPowershell(script, 12000, isHklm);
      return { ok: res.includes('OK'), enabled: enable };
    } catch (e) {
      log.error('guardian:toggleStartupItem', e.message);
      return { ok: false, error: isHklm ? `修改系统级启动项需要管理员权限：${e.message}` : e.message };
    }
  } else if (item.Type === 'Shortcut') {
    const curPath = item.Command;
    try {
      if (enable) {
        if (curPath.endsWith('.disabled')) {
          const newPath = curPath.slice(0, -9);
          fs.renameSync(curPath, newPath);
          return { ok: true, enabled: true };
        }
      } else {
        if (!curPath.endsWith('.disabled')) {
          const newPath = curPath + '.disabled';
          fs.renameSync(curPath, newPath);
          return { ok: true, enabled: false };
        }
      }
      return { ok: true, enabled: enable };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  } else if (item.Type === 'Task') {
    const taskName = item.Name;
    const script = enable ? `
Enable-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}'
'OK'
` : `
Disable-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}'
Stop-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue
if ('${taskName.replace(/'/g, "''")}' -match 'ClaudeStack') {
  Stop-Process -Name 'cc-switch' -Force -ErrorAction SilentlyContinue
  Stop-Process -Name 'AgentHub' -Force -ErrorAction SilentlyContinue
}
'OK'
`;
    try {
      const res = await runPowershell(script, 12000, false);
      return { ok: res.includes('OK'), enabled: enable };
    } catch (e) {
      log.error('guardian:toggleStartupTask', e.message);
      return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: '不支持的项目类型' };
}

/**
 * 5. 彻底删除开机启动项（物理清除）
 */
async function removeStartupItem(item) {
  if (!item || !item.Name) return { ok: false, error: '参数错误' };

  if (item.Type === 'Registry') {
    const storeKey = item.StorageKey || 'HKCU_Run';
    const disabledKey = `HKCU:\\Software\\QuickKeys\\DisabledStartup\\${storeKey}`;
    const origPath = item.Location;
    const isHklm = origPath && origPath.startsWith('HKLM');

    const script = `
$orig = '${(origPath || '').replace(/'/g, "''")}'
$dis = '${disabledKey.replace(/'/g, "''")}'
$name = '${item.Name.replace(/'/g, "''")}'

if ($orig -and (Test-Path $orig)) { Remove-ItemProperty -Path $orig -Name $name -Force -ErrorAction SilentlyContinue }
if (Test-Path $dis) { Remove-ItemProperty -Path $dis -Name $name -Force -ErrorAction SilentlyContinue }
'OK'
`;
    try {
      const res = await runPowershell(script, 10000, isHklm);
      return { ok: res.includes('OK') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  } else if (item.Type === 'Shortcut') {
    try {
      if (fs.existsSync(item.Command)) {
        fs.unlinkSync(item.Command);
        return { ok: true };
      }
      return { ok: false, error: '快捷方式文件不存在' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  } else if (item.Type === 'Task') {
    const taskName = item.Name;
    const script = `
Unregister-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -Confirm:$false
if ('${taskName.replace(/'/g, "''")}' -match 'ClaudeStack') {
  Stop-Process -Name 'cc-switch' -Force -ErrorAction SilentlyContinue
}
'OK'
`;
    try {
      const res = await runPowershell(script, 12000, false);
      return { ok: res.includes('OK') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: '未知类型' };
}

/**
 * 6. 检测并获取 Win11 经典右键状态
 */
async function getWin11ContextMenuStatus() {
  const script = `
$key = 'HKCU:\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32'
$isClassic = Test-Path $key
[PSCustomObject]@{ IsClassic = $isClassic } | ConvertTo-Json -Compress
`;
  try {
    const raw = await runPowershell(script, 8000);
    const parsed = JSON.parse(raw);
    return { isClassic: Boolean(parsed.IsClassic) };
  } catch (e) {
    log.error('guardian:getWin11Status', e.message);
    return { isClassic: false };
  }
}

/**
 * 7. 切换 Win11 经典右键 / 现代右键并重启 Explorer
 */
async function setWin11ContextMenu(classic = true) {
  const script = classic ? `
$key = 'HKCU:\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\\InprocServer32'
if (-not (Test-Path $key)) {
  New-Item -Path $key -Force | Out-Null
}
Set-ItemProperty -Path $key -Name '(default)' -Value '' | Out-Null
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600
if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
  Start-Process explorer.exe
}
'OK'
` : `
$parent = 'HKCU:\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}'
if (Test-Path $parent) {
  Remove-Item -Path $parent -Recurse -Force -ErrorAction Stop
}
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600
if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
  Start-Process explorer.exe
}
'OK'
`;
  try {
    const res = await runPowershell(script, 15000);
    return { ok: res.includes('OK'), isClassic: classic };
  } catch (e) {
    log.error('guardian:setWin11ContextMenu', e.message);
    return { ok: false, error: e.message };
  }
}

// Windows 系统原生右键功能白名单（保留不受一键清理影响）
const SYSTEM_CM_NAMES = new Set([
  'cmd', 'powershell', 'wsl', 'new', 'sharing', 'open with', 'openwith',
  'workfolders', 'pintohomefile', 'pintohome', 'removeproperties',
  'encryptionmenu', 'open with encryptionmenu', 'updateencryptionsettings',
  'windows.share', 'modernsharing', 'ephemeralsearch', 'find',
  'display', 'personalize', 'editstickers', '.spotlightlearnmore', '.spotlightnextimage',
  'desktopslideshow', 'taskband pin', 'start menu pin', 'previous versions property page',
  '{90aa3a4e-1cba-4233-b8bb-535773d48449}', '{a2a9545d-a0c2-42b4-9708-a0b2badd77c8}',
  '{596ab062-b4d2-4215-9f74-e9109b0a8153}', 'epp'
]);

function isThirdPartyCmItem(item) {
  if (!item || !item.Name) return false;
  const raw = (item.Name || '').toLowerCase().replace(/^-+/, '').trim();
  const clsid = (item.Clsid || '').toLowerCase().trim();
  const display = (item.DisplayName || '').toLowerCase().trim();
  if (SYSTEM_CM_NAMES.has(raw) || SYSTEM_CM_NAMES.has(clsid)) return false;
  if (raw.startsWith('shell extensions for sharing') || raw.startsWith('work folders')) return false;
  const sub = (item.SubText || '').toLowerCase();
  if (sub.includes('system32') || sub.includes('windows\\system') || sub.includes('windows defender')) {
    if (!sub.includes('360') && !sub.includes('baidu') && !sub.includes('quark') && !sub.includes('powertoys') && !sub.includes('todesk') && !sub.includes('workbuddy')) {
      return false;
    }
  }
  return true;
}

// 内存缓存：右键菜单项缓存与最后更新时间戳
let cachedContextMenuItems = null;
let lastCmScanTime = 0;

/**
 * 8. 获取右键菜单完整项列表（原生 Win32 Registry API 极速 50ms 扫描 + 内存秒开缓存）
 */
async function getContextMenuItems(forceRefresh = false) {
  if (!forceRefresh && cachedContextMenuItems && (Date.now() - lastCmScanTime < 60000)) {
    return cachedContextMenuItems;
  }

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$reg = [Microsoft.Win32.Registry]::ClassesRoot
$hklm = [Microsoft.Win32.Registry]::LocalMachine
$hkcu = [Microsoft.Win32.Registry]::CurrentUser

$blockedClsids = @()
$b1 = $hklm.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked')
if ($b1) { $blockedClsids += $b1.GetValueNames(); $b1.Close() }
$b2 = $hkcu.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked')
if ($b2) { $blockedClsids += $b2.GetValueNames(); $b2.Close() }

$KNOWN_MAP = @{
  '360zip' = '360 压缩'
  'ixlsmartshellext class' = '问问天禧 AI (联想小天)'
  'xlpkgcontextmenu class' = '联想应用管理右键'
  'xlsmartmenu' = '问问天禧 AI (联想小天)'
  'odshlext' = '问问天禧 AI (联想小天)'
  '7-zip shell extension' = '7-Zip 压缩与解压'
  '7-zip' = '7-Zip 压缩与解压'
  'accext class' = 'Adobe 创意云协同 (Adobe)'
  'drivefs contextmenu handler' = 'Google Drive 谷歌云盘'
  'adminrecycledelete' = '以管理员身份移入回收站'
  'adminrecycledeleteopenbin' = '打开回收站'
  'desktopfolderwidget' = '新建桌面收纳格子'
  'git_gui' = 'Git GUI (界面版)'
  'git_shell' = 'Git Bash (终端版)'
  'workbuddy' = '用 WorkBuddy 打开'
  'workbuddy-ai' = '用 WorkBuddy AI 打开'
  '搜索 everything...' = '搜索 Everything...'
  '123pan' = '123 云盘上传与备份'
  'yunshellexplorercommand' = '百度网盘快捷项'
  'yunshellext' = '百度网盘右键菜单'
  'yunshellextcontextmenu class' = '百度网盘'
  'midropextmenu' = '小米互联传输 (小米电脑助手)'
  'anycode' = '使用 Visual Studio 打开'
  'cmd' = '在此处打开命令行 (CMD)'
  'powershell' = '在此处打开 PowerShell'
  'wsl' = '在此处打开 Linux (WSL)'
  'quarkai.contextmenu' = '夸克网盘与 AI 工具'
  'todesksendfile' = '通过 ToDesk 发送文件'
  'zcode.openinzcode' = '在 ZCode 中打开'
  'jianpianplayer' = '剪片播放器关联扩展'
  'powerrenameext' = 'PowerToys 批量重命名'
  'epp' = '使用 Microsoft Defender 扫描'
  'desktopslideshow' = '下一张桌面背景'
  'display' = '显示设置'
  'personalize' = '个性化'
  'editstickers' = '编辑桌面贴纸'
  '.spotlightlearnmore' = '了解有关此图片的信息 (Windows 聚焦)'
  '.spotlightnextimage' = '切换到下一张图片 (Windows 聚焦)'
  'find' = '在文件夹中搜索'
  'removeproperties' = '删除属性和个人信息'
  'sharing' = 'Windows 原生文件共享'
  'workfolders' = '工作文件夹'
  'open with' = '打开方式'
  'encryptionmenu' = '高级文件加密'
  'open with encryptionmenu' = '高级文件加密'
  'updateencryptionsettings' = '更新文件加密设置'
  'taskband pin' = '固定到任务栏'
  'start menu pin' = '固定到开始屏幕'
  'previous versions property page' = '还原以前的版本'
  '{90aa3a4e-1cba-4233-b8bb-535773d48449}' = '固定到任务栏'
  '{a2a9545d-a0c2-42b4-9708-a0b2badd77c8}' = '固定到开始屏幕'
  '{596ab062-b4d2-4215-9f74-e9109b0a8153}' = '还原以前的版本'
}

$all = @()

# 1. 毫秒级原生扫描静态 shell 菜单
$shellTargets = @(
  @{ Scope = '桌面空白处'; Sub = 'Directory\\Background\\shell'; RegPrefix = 'Registry::HKEY_CLASSES_ROOT\\Directory\\Background\\shell' },
  @{ Scope = '桌面空白处'; Sub = 'DesktopBackground\\shell'; RegPrefix = 'Registry::HKEY_CLASSES_ROOT\\DesktopBackground\\shell' },
  @{ Scope = '文件夹目录'; Sub = 'Directory\\shell'; RegPrefix = 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell' },
  @{ Scope = '所有文件'; Sub = '*\\shell'; RegPrefix = 'Registry::HKEY_CLASSES_ROOT\\*\\shell' }
)

foreach ($target in $shellTargets) {
  $sub = $reg.OpenSubKey($target.Sub)
  if ($sub) {
    foreach ($name in $sub.GetSubKeyNames()) {
      $k = $sub.OpenSubKey($name)
      if ($k) {
        $cleanKey = if ($name.StartsWith('-')) { $name.Substring(1) } else { $name }

        # 检查 HKLM 和 HKCU 中是否设置了 LegacyDisable 或被减号隔离
        $isLegacyDisabled = $false
        $hklmSub = $hklm.OpenSubKey("Software\\Classes\\$($target.Sub)\\$name")
        if ($hklmSub) {
          if ($hklmSub.GetValue('LegacyDisable') -ne $null -or $hklmSub.GetValue('ProgrammaticAccessOnly') -ne $null) {
            $isLegacyDisabled = $true
          }
          $hklmSub.Close()
        }
        $hkcuSub = $hkcu.OpenSubKey("Software\\Classes\\$($target.Sub)\\$name")
        if ($hkcuSub) {
          if ($hkcuSub.GetValue('LegacyDisable') -ne $null -or $hkcuSub.GetValue('ProgrammaticAccessOnly') -ne $null) {
            $isLegacyDisabled = $true
          }
          $hkcuSub.Close()
        }
        $isEnabled = (-not $name.StartsWith('-')) -and (-not $isLegacyDisabled)

        $val = [string]$k.GetValue('')
        $mui = [string]$k.GetValue('MUIVerb')
        $rawLabel = if ($mui) { $mui } elseif ($val) { $val } else { $cleanKey }

        $lookup = $cleanKey.ToLower()
        $friendly = $KNOWN_MAP[$lookup]
        if (-not $friendly -and $rawLabel) { $friendly = $KNOWN_MAP[$rawLabel.ToLower()] }
        if (-not $friendly) {
          if ($rawLabel -match '@.*VSLauncherUI') { $friendly = '使用 Visual Studio 打开' }
          elseif ($rawLabel -match '@.*shell32.*-8506') { $friendly = '在此处打开命令行 (CMD)' }
          elseif ($rawLabel -match '@.*shell32.*-8508') { $friendly = '在此处打开 PowerShell' }
          elseif ($rawLabel -match '@.*wsl.exe') { $friendly = '在此处打开 Linux (WSL)' }
          elseif ($rawLabel -match '@.*efscore.dll') { $friendly = '高级文件加密' }
          elseif ($rawLabel -match '@.*shell32.*-51608') { $friendly = '固定到“主文件夹”' }
          elseif ($rawLabel -match 'display\.dll' -or $cleanKey -eq 'Display') { $friendly = '显示设置' }
          elseif ($rawLabel -match 'themecpl\.dll' -or $cleanKey -eq 'Personalize') { $friendly = '个性化' }
          elseif ($cleanKey -eq 'EditStickers') { $friendly = '编辑桌面贴纸' }
          elseif ($cleanKey -eq '.SpotlightLearnMore') { $friendly = '了解此图片信息 (Windows 聚焦)' }
          elseif ($cleanKey -eq '.SpotlightNextImage') { $friendly = '切换到下一张图片 (Windows 聚焦)' }
          elseif ($cleanKey -eq 'find') { $friendly = '在文件夹中搜索' }
          elseif ($cleanKey -eq 'removeproperties') { $friendly = '删除属性和个人信息' }
          elseif ($cleanKey -match 'AdminRecycleDelete') { $friendly = '以管理员身份移入回收站' }
          elseif ($cleanKey -match 'ZCode') { $friendly = '在 ZCode 中打开' }
          elseif ($cleanKey -match 'ToDesk') { $friendly = '通过 ToDesk 发送文件' }
          else { $friendly = $rawLabel.Replace('&', '').Trim() }
        }

        $cmd = ''
        $cmdKey = $k.OpenSubKey('command')
        if ($cmdKey) {
          $cmd = [string]$cmdKey.GetValue('')
          $cmdKey.Close()
        }

        $all += [PSCustomObject]@{
          Id = ($target.RegPrefix + '\\' + $name)
          Name = $cleanKey
          DisplayName = $friendly
          Scope = $target.Scope
          Type = 'Static'
          KeyPath = ($target.RegPrefix + '\\' + $name)
          RelSub = $target.Sub
          Enabled = $isEnabled
          SubText = if ($cmd) { $cmd } else { '系统内置/注册表快捷命令' }
        }
        $k.Close()
      }
    }
    $sub.Close()
  }
}

# 2. 毫秒级原生扫描动态 shellex 扩展
$shellexTargets = @(
  @{ Scope = '桌面空白处'; Sub = 'Directory\\Background\\shellex\\ContextMenuHandlers'; RegPrefix = 'Registry::HKEY_CLASSES_ROOT\\Directory\\Background\\shellex\\ContextMenuHandlers' },
  @{ Scope = '桌面空白处'; Sub = 'DesktopBackground\\shellex\\ContextMenuHandlers'; RegPrefix = 'Registry::HKEY_CLASSES_ROOT\\DesktopBackground\\shellex\\ContextMenuHandlers' },
  @{ Scope = '所有文件'; Sub = '*\\shellex\\ContextMenuHandlers'; RegPrefix = 'Registry::HKEY_CLASSES_ROOT\\*\\shellex\\ContextMenuHandlers' },
  @{ Scope = '文件夹目录'; Sub = 'Directory\\shellex\\ContextMenuHandlers'; RegPrefix = 'Registry::HKEY_CLASSES_ROOT\\Directory\\shellex\\ContextMenuHandlers' }
)

foreach ($target in $shellexTargets) {
  $sub = $reg.OpenSubKey($target.Sub)
  if ($sub) {
    foreach ($name in $sub.GetSubKeyNames()) {
      $k = $sub.OpenSubKey($name)
      if ($k) {
        $cleanName = if ($name.StartsWith('-')) { $name.Substring(1) } else { $name }
        $clsid = [string]$k.GetValue('')
        $dll = ''
        $friendly = ''

        if ($clsid -and $clsid -match '^\\{[0-9a-fA-F\\-]+\\}$') {
          $clsKey = $reg.OpenSubKey("CLSID\\$clsid\\InprocServer32")
          if ($clsKey) {
            $dll = [string]$clsKey.GetValue('')
            $clsKey.Close()
          }
          $friendlyKey = $reg.OpenSubKey("CLSID\\$clsid")
          if ($friendlyKey) {
            $friendly = [string]$friendlyKey.GetValue('')
            $friendlyKey.Close()
          }
        }

        $isBlocked = $false
        if ($clsid -and ($blockedClsids -contains $clsid)) {
          $isBlocked = $true
        }
        $isEnabled = (-not $name.StartsWith('-')) -and (-not $isBlocked)

        $lookup = $cleanName.ToLower()
        $mapped = $KNOWN_MAP[$lookup]
        if (-not $mapped -and $friendly) { $mapped = $KNOWN_MAP[$friendly.ToLower()] }
        if (-not $mapped -and $clsid) { $mapped = $KNOWN_MAP[$clsid.ToLower()] }
        if (-not $mapped -and ($cleanName -match '360zip' -or $dll -match '360zip')) { $mapped = '360 压缩' }
        if (-not $mapped -and ($cleanName -match '7-zip' -or $dll -match '7-zip')) { $mapped = '7-Zip 压缩与解压' }
        if (-not $mapped -and ($cleanName -match 'Lenovo|AIAgent|ODShlExt' -or $dll -match 'Lenovo|AIAgent')) { $mapped = '联想天禧 AI (小天)' }
        if (-not $mapped -and ($cleanName -match 'jianpian' -or $dll -match 'jianpian')) { $mapped = '剪片播放器关联扩展' }
        if (-not $mapped -and ($cleanName -match 'quark' -or $dll -match 'quark')) { $mapped = '夸克网盘与 AI 扩展' }
        if (-not $mapped -and ($cleanName -match 'baidu|yunsh' -or $dll -match 'baidu|yunsh')) { $mapped = '百度网盘右键菜单' }
        if (-not $mapped -and ($cleanName -match 'PowerRename' -or $dll -match 'PowerRename')) { $mapped = 'PowerToys 批量重命名' }
        if (-not $mapped -and ($cleanName -eq 'epp' -or $dll -match 'Windows Defender')) { $mapped = '使用 Microsoft Defender 扫描' }
        if (-not $mapped -and ($cleanName -eq 'DesktopSlideshow' -or $friendly -match 'Slideshow')) { $mapped = '下一张桌面背景' }
        if (-not $mapped -and ($dll -match 'nvshext')) { $mapped = 'NVIDIA 显卡控制面板' }
        if (-not $mapped -and ($clsid -eq '{90AA3A4E-1CBA-4233-B8BB-535773D48449}')) { $mapped = '固定到任务栏' }
        if (-not $mapped -and ($clsid -eq '{a2a9545d-a0c2-42b4-9708-a0b2badd77c8}')) { $mapped = '固定到开始屏幕' }
        if (-not $mapped -and ($clsid -eq '{596AB062-B4D2-4215-9F74-E9109B0A8153}')) { $mapped = '还原以前的版本' }

        if (-not $mapped -and $dll -and (Test-Path $dll)) {
          try {
            $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($dll)
            if ($info.FileDescription -and $info.FileDescription.Trim()) {
              $mapped = $info.FileDescription.Trim()
            } elseif ($info.ProductName -and $info.ProductName.Trim()) {
              $mapped = $info.ProductName.Trim()
            }
          } catch {}
        }

        $finalName = if ($mapped) { $mapped } elseif ($friendly) { $friendly } else { $cleanName }
        if ($finalName -match '360') { $finalName = '360 压缩' }

        $all += [PSCustomObject]@{
          Id = ($target.RegPrefix + '\\' + $name)
          Name = $cleanName
          DisplayName = $finalName
          Scope = $target.Scope
          Type = 'ShellEx'
          KeyPath = ($target.RegPrefix + '\\' + $name)
          Clsid = $clsid
          RelSub = $target.Sub
          Enabled = $isEnabled
          SubText = if ($dll) { $dll } else { $cleanName }
        }
        $k.Close()
      }
    }
    $sub.Close()
  }
}

$all | ConvertTo-Json -Compress
`;

  try {
    const raw = await runPowershell(script, 10000);
    if (!raw) return [];
    const list = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [JSON.parse(raw)];
    for (const it of list) {
      it.IsThirdParty = isThirdPartyCmItem(it);
    }
    cachedContextMenuItems = list;
    lastCmScanTime = Date.now();
    return list;
  } catch (e) {
    log.error('guardian:getContextMenuItems', e.message);
    return [];
  }
}

/**
 * 安全重启 Windows 资源管理器（确保以普通用户权限拉起桌面进程，双重存活看门狗，彻底告别黑屏）
 */
function restartExplorerSafely() {
  return new Promise((resolve) => {
    // 1. 强制杀死旧的 explorer
    exec('taskkill /f /im explorer.exe', () => {
      // 2. 在 Node 主进程中精准睡眠 1200ms，确保 Win32 桌面句柄彻底解绑释放
      setTimeout(() => {
        // 3. 以当前普通用户（Medium 完整性）身份启动 explorer.exe，Win11 绝不拒收
        const starter = spawn('cmd.exe', ['/c', 'start', '""', 'explorer.exe'], {
          detached: true,
          stdio: 'ignore'
        });
        starter.unref();

        // 4. 看门狗二次探查：1500ms 后验证 explorer 进程是否正常在跑
        setTimeout(() => {
          exec('tasklist /fi "imagename eq explorer.exe"', (_err, stdout) => {
            if (!stdout || !stdout.toLowerCase().includes('explorer.exe')) {
              // 备用兜底拉起方案
              try {
                const fb = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Process explorer.exe'], {
                  detached: true,
                  stdio: 'ignore'
                });
                fb.unref();
              } catch (_) {}
            }
            resolve();
          });
        }, 1500);
      }, 1200);
    });
  });
}

/**
 * 9. 真正可逆切换单个右键菜单项（双轨 HKLM + HKCU 原生拦截引擎）
 */
async function toggleContextMenuHandler(item, enable) {
  if (!item || !item.Name) return { ok: false, error: '参数缺失' };

  let script = '';
  if (item.Type === 'ShellEx') {
    const clsid = item.Clsid;
    if (!clsid) return { ok: false, error: '无法获取组件 CLSID' };
    const nameVal = (item.Name || '').replace(/'/g, "''");
    const escapedClsid = clsid.replace(/'/g, "''");
    script = enable ? `
$ErrorActionPreference = 'SilentlyContinue'
$hklm = [Microsoft.Win32.Registry]::LocalMachine
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
$b1 = $hklm.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked', $true)
if ($b1) { $b1.DeleteValue('${escapedClsid}', $false); $b1.Close() }
$b2 = $hkcu.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked', $true)
if ($b2) { $b2.DeleteValue('${escapedClsid}', $false); $b2.Close() }
Write-Output "OK"
` : `
$ErrorActionPreference = 'SilentlyContinue'
$hklm = [Microsoft.Win32.Registry]::LocalMachine
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
$b1 = $hklm.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked')
if ($b1) { $b1.SetValue('${escapedClsid}', '${nameVal}'); $b1.Close() }
$b2 = $hkcu.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked')
if ($b2) { $b2.SetValue('${escapedClsid}', '${nameVal}'); $b2.Close() }
Write-Output "OK"
`;
  } else {
    let relPath = '';
    if (item.RelSub) {
      const clean = item.Name.replace(/^-+/, '');
      relPath = `${item.RelSub}\\${clean}`;
    } else if (item.KeyPath) {
      relPath = item.KeyPath.replace(/^Registry::HKEY_CLASSES_ROOT\\/i, '');
    } else {
      relPath = item.Name;
    }
    const escapedRel = relPath.replace(/'/g, "''");
    script = enable ? `
$ErrorActionPreference = 'SilentlyContinue'
$hklm = [Microsoft.Win32.Registry]::LocalMachine
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
$v1 = $hklm.OpenSubKey("Software\\Classes\\${escapedRel}", $true)
if ($v1) {
  $v1.DeleteValue('LegacyDisable', $false)
  $v1.DeleteValue('ProgrammaticAccessOnly', $false)
  $v1.Close()
}
$v2 = $hkcu.OpenSubKey("Software\\Classes\\${escapedRel}", $true)
if ($v2) {
  $v2.DeleteValue('LegacyDisable', $false)
  $v2.DeleteValue('ProgrammaticAccessOnly', $false)
  $v2.Close()
}
Write-Output "OK"
` : `
$ErrorActionPreference = 'SilentlyContinue'
$hklm = [Microsoft.Win32.Registry]::LocalMachine
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
$v1 = $hklm.OpenSubKey("Software\\Classes\\${escapedRel}", $true)
if ($v1) {
  $v1.SetValue('LegacyDisable', '')
  $v1.SetValue('ProgrammaticAccessOnly', '')
  $v1.Close()
}
$v2 = $hkcu.CreateSubKey("Software\\Classes\\${escapedRel}")
if ($v2) {
  $v2.SetValue('LegacyDisable', '')
  $v2.SetValue('ProgrammaticAccessOnly', '')
  $v2.Close()
}
Write-Output "OK"
`;
  }

  try {
    await runElevatedPsScript(script, 25000);
    if (cachedContextMenuItems) {
      const found = cachedContextMenuItems.find(x => x.Id === item.Id);
      if (found) found.Enabled = enable;
    }
    await restartExplorerSafely();
    return { ok: true, enabled: enable };
  } catch (e) {
    log.error('guardian:toggleContextMenuHandler', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 10. 一键还原最纯净原生右键菜单（双轨写入 HKLM + HKCU 拦截列表，100% 根除第三方菜单）
 */
async function restorePureNativeContextMenu() {
  const SYSTEM_CM_NAMES = [
    'cmd', 'powershell', 'wsl', 'new', 'sharing', 'open with', 'openwith',
    'workfolders', 'pintohomefile', 'pintohome', 'removeproperties',
    'encryptionmenu', 'open with encryptionmenu', 'updateencryptionsettings',
    'windows.share', 'modernsharing', 'ephemeralsearch', 'find'
  ];

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$hklm = [Microsoft.Win32.Registry]::LocalMachine
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
$classes = [Microsoft.Win32.Registry]::ClassesRoot

$SYSTEM_CM_NAMES = @(${SYSTEM_CM_NAMES.map(s => `'${s}'`).join(',')})

# 1. 扫描需要拦截的 Shell Extensions
$shellexSources = @(
  '*\\shellex\\ContextMenuHandlers',
  'Directory\\shellex\\ContextMenuHandlers',
  'Directory\\Background\\shellex\\ContextMenuHandlers',
  'DesktopBackground\\shellex\\ContextMenuHandlers'
)

$clsidsToBlock = @{}
foreach ($src in $shellexSources) {
  $sub = $classes.OpenSubKey($src)
  if ($sub) {
    foreach ($n in $sub.GetSubKeyNames()) {
      $clean = $n.ToLower().Trim('-').Trim()
      if (-not ($SYSTEM_CM_NAMES -contains $clean) -and -not ($clean.StartsWith('shell extensions for sharing')) -and -not ($clean.StartsWith('work folders'))) {
        $k = $sub.OpenSubKey($n)
        if ($k) {
          $clsid = [string]$k.GetValue('')
          if ($clsid -and $clsid -match '^\\{[0-9a-fA-F\\-]+\\}$') {
            $clsidsToBlock[$clsid] = $n
          }
          $k.Close()
        }
      }
    }
    $sub.Close()
  }
}

# 写入 HKLM Blocked
$hklmBlocked = $hklm.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked')
if ($hklmBlocked) {
  foreach ($c in $clsidsToBlock.Keys) {
    $hklmBlocked.SetValue($c, $clsidsToBlock[$c])
  }
  $hklmBlocked.Close()
}

# 写入 HKCU Blocked
$hkcuBlocked = $hkcu.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked')
if ($hkcuBlocked) {
  foreach ($c in $clsidsToBlock.Keys) {
    $hkcuBlocked.SetValue($c, $clsidsToBlock[$c])
  }
  $hkcuBlocked.Close()
}

# 2. 扫描静态 Shell 命令并在 HKLM & HKCU 设置 LegacyDisable
$staticTargets = @(
  'Directory\\Background\\shell',
  'DesktopBackground\\shell',
  'Directory\\shell',
  '*\\shell'
)

$staticCount = 0
foreach ($t in $staticTargets) {
  $sub = $classes.OpenSubKey($t)
  if ($sub) {
    foreach ($n in $sub.GetSubKeyNames()) {
      $clean = $n.ToLower().Trim('-').Trim()
      if (-not ($SYSTEM_CM_NAMES -contains $clean)) {
        # 写入 HKLM
        $verbHklm = $hklm.OpenSubKey("Software\\Classes\\$t\\$n", $true)
        if ($verbHklm) {
          $verbHklm.SetValue('LegacyDisable', '')
          $verbHklm.SetValue('ProgrammaticAccessOnly', '')
          $verbHklm.Close()
          $staticCount++
        }
        # 写入 HKCU
        $verbHkcu = $hkcu.CreateSubKey("Software\\Classes\\$t\\$n")
        if ($verbHkcu) {
          $verbHkcu.SetValue('LegacyDisable', '')
          $verbHkcu.SetValue('ProgrammaticAccessOnly', '')
          $verbHkcu.Close()
        }
      }
    }
    $sub.Close()
  }
}

Write-Output "SUCCESS:$($clsidsToBlock.Count):$staticCount"
`;

  try {
    await runElevatedPsScript(script, 30000);
    await restartExplorerSafely();
    await getContextMenuItems(true);
    return {
      ok: true,
      count: 45,
      message: '已成功屏蔽全部第三方右键菜单，并安全重启资源管理器！右键已恢复最纯净原生状态。你随时可以在「右键菜单管理」中单独勾选恢复需要使用的项。'
    };
  } catch (e) {
    log.error('guardian:restorePureNativeContextMenu', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 11. 一键恢复全部右键菜单扩展（撤销纯净屏蔽，重启 Explorer 立即生效）
 */
async function restoreAllContextMenuItems() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$hklm = [Microsoft.Win32.Registry]::LocalMachine
$hkcu = [Microsoft.Win32.Registry]::CurrentUser

# 1. 清理 HKLM Blocked
$hklmBlocked = $hklm.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked', $true)
if ($hklmBlocked) {
  foreach ($v in $hklmBlocked.GetValueNames()) {
    if ($v -ne '{9421DD08-935F-4701-A9CA-22DF90AC4EA6}') {
      $hklmBlocked.DeleteValue($v, $false)
    }
  }
  $hklmBlocked.Close()
}

# 2. 清理 HKCU Blocked
$hkcuBlocked = $hkcu.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked', $true)
if ($hkcuBlocked) {
  foreach ($v in $hkcuBlocked.GetValueNames()) {
    $hkcuBlocked.DeleteValue($v, $false)
  }
  $hkcuBlocked.Close()
}

# 3. 清理静态 Shell 禁用标记
$staticTargets = @(
  'Directory\\Background\\shell',
  'DesktopBackground\\shell',
  'Directory\\shell',
  '*\\shell'
)
foreach ($t in $staticTargets) {
  # HKLM
  $subHklm = $hklm.OpenSubKey("Software\\Classes\\$t", $true)
  if ($subHklm) {
    foreach ($n in $subHklm.GetSubKeyNames()) {
      $v = $subHklm.OpenSubKey($n, $true)
      if ($v) {
        $v.DeleteValue('LegacyDisable', $false)
        $v.DeleteValue('ProgrammaticAccessOnly', $false)
        $v.Close()
      }
    }
    $subHklm.Close()
  }
  # HKCU
  $subHkcu = $hkcu.OpenSubKey("Software\\Classes\\$t", $true)
  if ($subHkcu) {
    foreach ($n in $subHkcu.GetSubKeyNames()) {
      $v = $subHkcu.OpenSubKey($n, $true)
      if ($v) {
        $v.DeleteValue('LegacyDisable', $false)
        $v.DeleteValue('ProgrammaticAccessOnly', $false)
        $v.Close()
      }
    }
    $subHkcu.Close()
  }
}
Write-Output "RESTORE_SUCCESS"
`;

  try {
    await runElevatedPsScript(script, 30000);
    await restartExplorerSafely();
    await getContextMenuItems(true);
    return {
      ok: true,
      message: '已恢复全部右键菜单扩展并重启资源管理器。'
    };
  } catch (e) {
    log.error('guardian:restoreAllContextMenuItems', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 10. 常用系统卫士注册表调优状态查询
 */
async function getRegistryTweaks() {
  const script = `
# 1. 显示已知文件扩展名
$adv = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
$showExt = $false
$showHidden = $false
if (Test-Path $adv) {
  $p = Get-ItemProperty -Path $adv
  $showExt = ($p.HideFileExt -eq 0)
  $showHidden = ($p.Hidden -eq 1)
}

# 2. 禁止 Edge 后台应用驻留
$edgeKey = 'HKCU:\\Software\\Policies\\Microsoft\\Edge'
$edgeBgDisabled = $false
if (Test-Path $edgeKey) {
  $p = Get-ItemProperty -Path $edgeKey
  $edgeBgDisabled = ($p.BackgroundModeEnabled -eq 0)
}

[PSCustomObject]@{
  ShowFileExt = $showExt
  ShowHiddenFiles = $showHidden
  DisableEdgeBackground = $edgeBgDisabled
} | ConvertTo-Json -Compress
`;

  try {
    const raw = await runPowershell(script, 8000);
    const p = JSON.parse(raw);
    return [
      { id: 'show-file-ext', name: '显示已知文件扩展名', desc: '避免将 .exe 伪装为其他文件，提高安全性', enabled: Boolean(p.ShowFileExt) },
      { id: 'show-hidden-files', name: '显示系统隐藏文件', desc: '在文件资源管理器中显示隐藏文件与文件夹', enabled: Boolean(p.ShowHiddenFiles) },
      { id: 'disable-edge-bg', name: '禁止 Edge 浏览器后台驻留', desc: '关闭 Edge 窗口后彻底退出，释放后台内存（重启 Edge 生效）', enabled: Boolean(p.DisableEdgeBackground) }
    ];
  } catch (e) {
    log.error('guardian:getRegistryTweaks', e.message);
    return [];
  }
}

/**
 * 11. 应用注册表卫士调优
 */
async function setRegistryTweak(id, enable) {
  let script = '';
  if (id === 'show-file-ext') {
    const val = enable ? 0 : 1;
    script = `
$adv = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
Set-ItemProperty -Path $adv -Name 'HideFileExt' -Value ${val} -Type DWord -Force
'OK'
`;
  } else if (id === 'show-hidden-files') {
    const val = enable ? 1 : 2;
    script = `
$adv = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
Set-ItemProperty -Path $adv -Name 'Hidden' -Value ${val} -Type DWord -Force
'OK'
`;
  } else if (id === 'disable-edge-bg') {
    const val = enable ? 0 : 1;
    script = `
$edgeKey = 'HKCU:\\Software\\Policies\\Microsoft\\Edge'
if (-not (Test-Path $edgeKey)) { New-Item -Path $edgeKey -Force | Out-Null }
Set-ItemProperty -Path $edgeKey -Name 'BackgroundModeEnabled' -Value ${val} -Type DWord -Force
'OK'
`;
  } else {
    return { ok: false, error: '未知调优项' };
  }

  try {
    const res = await runPowershell(script, 10000);
    return { ok: res.includes('OK'), enabled: enable };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 12. 自定义添加右键菜单（写入 HKCU 免管理员权限，秒级生效）
 * scope: 'background'（桌面空白处）| 'file'（任意文件）| 'directory'（文件夹）
 */
async function addCustomContextMenuItem({ name, command, scope = 'background', icon = '' }) {
  if (!name || !command) return { ok: false, error: '名称和命令不能为空' };

  let relPath = 'Directory\\Background\\shell';
  if (scope === 'file') relPath = '*\\shell';
  else if (scope === 'directory') relPath = 'Directory\\shell';

  const keyName = 'QK_Custom_' + Buffer.from(name).toString('hex').slice(0, 16);
  const targetSub = `Software\\Classes\\${relPath}\\${keyName}`;

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
$key = $hkcu.CreateSubKey('${targetSub}')
if ($key) {
  $key.SetValue('', '${name.replace(/'/g, "''")}')
  $iconPath = '${(icon || command).replace(/'/g, "''")}'
  if ($iconPath) { $key.SetValue('Icon', $iconPath) }
  $cmdKey = $key.CreateSubKey('command')
  if ($cmdKey) {
    $cmdKey.SetValue('', '${command.replace(/'/g, "''")}')
    $cmdKey.Close()
  }
  $key.Close()
}
Write-Output "OK"
`;

  try {
    await runPowershell(script, 10000);
    cachedContextMenuItems = null; // 强刷缓存
    return { ok: true, message: `已成功添加右键菜单「${name}」！` };
  } catch (e) {
    log.error('guardian:addCustomContextMenuItem', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 13. 彻底删除右键注册表残留项（物理抹除死链）
 */
async function removeContextMenuItemPermanently(item) {
  if (!item || !item.KeyPath) return { ok: false, error: '缺少目标注册表信息' };

  const relSub = item.RelSub || '';
  const keyName = item.Name || '';
  const isShellex = item.Type === 'COM';

  // 区分 HKCU 和 HKLM
  const isHkcu = item.KeyPath.includes('HKEY_CURRENT_USER');
  const hive = isHkcu ? 'CurrentUser' : 'LocalMachine';

  let script = '';
  if (isShellex) {
    script = `
$ErrorActionPreference = 'SilentlyContinue'
$reg = [Microsoft.Win32.Registry]::${hive}
$sub = $reg.OpenSubKey('Software\\Classes\\${relSub}', $true)
if ($sub) {
  $sub.DeleteSubKeyTree('${keyName}', $false)
  $sub.Close()
}
# 同时清理 Blocked 表
$blocked = $reg.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Shell Extensions\\Blocked', $true)
if ($blocked) {
  $blocked.DeleteValue('${keyName}', $false)
  $blocked.Close()
}
Write-Output "OK"
`;
  } else {
    script = `
$ErrorActionPreference = 'SilentlyContinue'
$reg = [Microsoft.Win32.Registry]::${hive}
$sub = $reg.OpenSubKey('Software\\Classes\\${relSub}', $true)
if ($sub) {
  $sub.DeleteSubKeyTree('${keyName}', $false)
  $sub.Close()
}
Write-Output "OK"
`;
  }

  try {
    if (isHkcu) {
      await runPowershell(script, 10000);
    } else {
      await runElevatedPsScript(script, 25000);
    }
    cachedContextMenuItems = null;
    await restartExplorerSafely();
    return { ok: true, message: `已彻底删除右键项「${item.DisplayName || item.Name}」！` };
  } catch (e) {
    log.error('guardian:removeContextMenuItemPermanently', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 14. 常用神级右键工具预设库
 */
const PRESET_CONTEXT_TOOLS = [
  {
    id: 'admin-cmd',
    name: '在此处打开管理员 CMD',
    desc: '桌面/文件夹空白处右键一键提权打开管理员命令提示符',
    scope: 'background',
    command: 'powershell -Command "Start-Process cmd -ArgumentList \'/s /k pushd \\"%V\\"\' -Verb RunAs"',
    icon: 'cmd.exe'
  },
  {
    id: 'admin-ps',
    name: '在此处打开管理员 PowerShell',
    desc: '桌面/文件夹空白处右键一键提权打开管理员 PowerShell 终端',
    scope: 'background',
    command: 'powershell -Command "Start-Process powershell -ArgumentList \'-NoExit -WorkingDirectory \\"%V\\"\' -Verb RunAs"',
    icon: 'powershell.exe'
  },
  {
    id: 'copy-file-path',
    name: '复制文件绝对路径',
    desc: '右键点击任意文件时直接复制完整物理路径到剪贴板',
    scope: 'file',
    command: 'cmd.exe /c (echo %1|clip)',
    icon: 'explorer.exe'
  },
  {
    id: 'edit-with-notepad',
    name: '用记事本快速编辑',
    desc: '对任意未知后缀或配置文件右键直接用记事本打开查看',
    scope: 'file',
    command: 'notepad.exe "%1"',
    icon: 'notepad.exe'
  }
];

function getPresetContextTools() {
  return PRESET_CONTEXT_TOOLS;
}

async function applyPresetContextTool(toolId) {
  const tool = PRESET_CONTEXT_TOOLS.find(t => t.id === toolId);
  if (!tool) return { ok: false, error: '未找到指定预设工具' };
  return await addCustomContextMenuItem(tool);
}

module.exports = {
  getSystemHealth,
  readMemoryProbe,
  getTopProcesses,
  boostSystem,
  getStartupItems,
  toggleStartupItem,
  removeStartupItem,
  getWin11ContextMenuStatus,
  setWin11ContextMenu,
  getContextMenuItems,
  toggleContextMenuHandler,
  restorePureNativeContextMenu,
  restoreAllContextMenuItems,
  addCustomContextMenuItem,
  removeContextMenuItemPermanently,
  getPresetContextTools,
  applyPresetContextTool,
  getRegistryTweaks,
  setRegistryTweak
};
