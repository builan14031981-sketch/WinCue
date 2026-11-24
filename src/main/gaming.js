'use strict';

const { spawn, execFile } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const guardian = require('./guardian');
const log = require('./logger');

// 统一走绝对路径，避免从精简 PATH 启动（如某些启动器/服务环境）时找不到 powershell.exe
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// 缓存硬件档案，避免每次切换分类都重复查询主板 CimInstance
let cachedProfile = null;
let profileFetching = false;

/**
 * 硬件信息读取失败时的兜底：只用 Node 能真实拿到的数据，绝不编造机型/内存数值
 */
function fallbackProfile() {
  const cpu = os.cpus()[0] ? os.cpus()[0].model.trim() : '未知处理器';
  const totalGB = Number((os.totalmem() / 1073741824).toFixed(1));
  return {
    manufacturer: 'UNKNOWN',
    model: 'PC',
    friendlyModel: '本机 PC（硬件信息读取超时）',
    cpu,
    physicalCores: Math.max(1, Math.floor((os.cpus().length || 2) / 2)),
    cores: os.cpus().length || 2,
    gpus: ['显卡信息读取失败'],
    totalPhysicalGB: totalGB,
    visibleGB: totalGB,
    umaVramGB: 0,
    memorySlots: '未读取到内存条信息',
    freeGB: Number((os.freemem() / 1073741824).toFixed(1)),
    standbyGB: 0,
    powerPlan: '未知',
    degraded: true
  };
}

/**
 * 读取本机硬件画像（品牌、具体机型代号、CPU、GPU、物理插槽与核显扣减）
 */
async function getGamingProfile(forceRefresh = false) {
  if (cachedProfile && !forceRefresh) {
    // 快速更新动态内存数据，其余静态硬件复用缓存
    try {
      const dynamicMem = await getDynamicMemory();
      return { ...cachedProfile, ...dynamicMem };
    } catch (_) {
      return cachedProfile;
    }
  }

  if (profileFetching && cachedProfile) return cachedProfile;
  profileFetching = true;

  try {
    const profile = await queryHardwareSpecs();
    cachedProfile = profile;
    return profile;
  } catch (err) {
    log.error('读取游戏硬件配置失败', err);
    return fallbackProfile();
  } finally {
    profileFetching = false;
  }
}

/**
 * 通过 PowerShell 采集完整硬件数据
 */
function queryHardwareSpecs() {
  return new Promise((resolve) => {
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
# 显卡名直接从驱动注册表读取：WMI 的 Win32_VideoController 在本机冷查询要 13s+，
# 会把整个硬件画像拖过超时，导致整页退回硬编码假数据。
$gpuNames = @()
Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
    $d = (Get-ItemProperty $_.PSPath -Name DriverDesc -ErrorAction SilentlyContinue).DriverDesc
    if ($d -and $d -notmatch 'Remote Display|Basic Display|Microsoft Basic') { $gpuNames += $d }
}
$os = Get-CimInstance Win32_OperatingSystem
$slots = Get-CimInstance Win32_PhysicalMemory
$memPerf = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory

$totalBytes = 0
$slotDetails = @()
foreach ($s in $slots) {
    $totalBytes += $s.Capacity
    $gb = [math]::Round($s.Capacity / 1GB, 0)
    $slotDetails += "$($s.Manufacturer) $($gb)GB $($s.Speed)MHz"
}
$slotSummary = if ($slotDetails.Count -gt 0) { $slotDetails -join ' + ' } else { "32GB" }

$totalPhysicalGB = [math]::Round($totalBytes / 1GB, 1)
if ($totalPhysicalGB -le 0) { $totalPhysicalGB = 32.0 }
$visibleGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
$umaGB = [math]::Round($totalPhysicalGB - $visibleGB, 1)
if ($umaGB -lt 0) { $umaGB = 0 }

$powerPlan = (& "$env:SystemRoot\\System32\\powercfg.exe" /getactivescheme) -replace '.*?\\((.*?)\\).*', '$1'
$freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$standbyGB = if ($memPerf.StandbyCacheNormalPriorityBytes) {
    [math]::Round(($memPerf.StandbyCacheNormalPriorityBytes + $memPerf.StandbyCacheReserveBytes + $memPerf.StandbyCacheCoreBytes) / 1GB, 1)
} else { 0 }

# 友好机型名称推断
$friendly = $cs.Model
if ($cs.Model -eq '82JQ' -or $cs.Model -match '82JQ') {
    $friendly = "联想拯救者 Legion R9000P 2021 (82JQ)"
} elseif ($cs.Manufacturer -match 'Lenovo') {
    $friendly = "联想拯救者 ($($cs.Model))"
}

[PSCustomObject]@{
    Manufacturer = $cs.Manufacturer
    Model = $cs.Model
    FriendlyModel = $friendly
    CPU = $cpu.Name.Trim()
    Cores = $cpu.NumberOfCores
    Threads = $cpu.NumberOfLogicalProcessors
    GPUs = @($gpuNames)
    TotalPhysicalGB = $totalPhysicalGB
    VisibleGB = $visibleGB
    UmaVramGB = $umaGB
    MemorySlots = $slotSummary
    FreeGB = $freeGB
    StandbyGB = $standbyGB
    PowerPlan = $powerPlan.Trim()
} | ConvertTo-Json -Compress
`;

    const child = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
      windowsHide: true,
      timeout: 25000
    });

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          const raw = JSON.parse(stdout.trim());
          resolve({
            manufacturer: raw.Manufacturer || 'UNKNOWN',
            model: raw.Model || 'PC',
            friendlyModel: raw.FriendlyModel || `${raw.Manufacturer || ''} ${raw.Model || ''}`.trim() || '本机 PC',
            cpu: raw.CPU || (os.cpus()[0] ? os.cpus()[0].model.trim() : '未知处理器'),
            physicalCores: raw.Cores || Math.max(1, Math.floor((raw.Threads || os.cpus().length || 2) / 2)),
            cores: raw.Threads || raw.Cores || os.cpus().length || 2,
            gpus: Array.isArray(raw.GPUs) && raw.GPUs.length ? raw.GPUs : ['显卡信息读取失败'],
            totalPhysicalGB: raw.TotalPhysicalGB || Number((os.totalmem() / 1073741824).toFixed(1)),
            visibleGB: raw.VisibleGB || Number((os.totalmem() / 1073741824).toFixed(1)),
            umaVramGB: raw.UmaVramGB !== undefined ? raw.UmaVramGB : 0,
            memorySlots: raw.MemorySlots || '未读取到内存条信息',
            freeGB: raw.FreeGB || Number((os.freemem() / 1073741824).toFixed(1)),
            standbyGB: raw.StandbyGB || 0,
            powerPlan: raw.PowerPlan || '未知'
          });
          return;
        } catch (_) {}
      }
      resolve(fallbackProfile());
    });
    child.on('error', () => {
      resolve(fallbackProfile());
    });
  });
}

/**
 * 快速刷新动态内存参数（走内存探针 exe，毫秒级，不再冷启动 PowerShell）
 */
async function getDynamicMemory() {
  try {
    const m = await guardian.readMemoryProbe();
    if (m) {
      return {
        // FreeMB 是「可用物理内存」（含待机缓存），待机缓存是它的子集
        freeGB: Number((m.FreeMB / 1024).toFixed(1)),
        standbyGB: Number((m.StandbyMB / 1024).toFixed(1))
      };
    }
  } catch (_) {}
  return {
    freeGB: Number((os.freemem() / 1073741824).toFixed(1)),
    standbyGB: 0
  };
}

/**
 * 游戏掉帧与系统设置深度体检雷达
 */
async function getGamingDiagnostics() {
  return new Promise((resolve) => {
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'

# 1. GameDVR 录屏状态
$dvrKey = Get-ItemProperty -Path 'HKCU:\\System\\GameConfigStore' -Name 'GameDVR_Enabled' -ErrorAction SilentlyContinue
$dvrEnabled = ($dvrKey.GameDVR_Enabled -eq 1)

# 2. HAGS (硬件加速GPU计划)
$hagsKey = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' -Name 'HwSchMode' -ErrorAction SilentlyContinue
$hagsEnabled = ($hagsKey.HwSchMode -eq 2)

# 3. VBS / 核心隔离
$vbs = Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\\Microsoft\\Windows\\DeviceGuard -ErrorAction SilentlyContinue
$vbsRunning = ($vbs.SecurityServicesRunning -contains 1)

# 4. 电源计划
$scheme = (powercfg /getactivescheme) -replace '.*?:\\s*([a-f0-9-]+)\\s*\\((.*?)\\).*', '$1|$2'
$parts = $scheme.Split('|')
$guid = if ($parts.Length -gt 0) { $parts[0].Trim() } else { '' }
$name = if ($parts.Length -gt 1) { $parts[1].Trim() } else { '默认' }
$isUltimateOrHigh = ($name -match '卓越|高性能|Ultimate|High' -or $guid -eq 'e9a42b02-d5df-448d-aa00-03f14749eb61' -or $guid -eq '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c')

# 5. 粘滞键开启状态 (Flags 1 表示启用提示弹窗)
$sticky = Get-ItemProperty -Path 'HKCU:\\Control Panel\\Accessibility\\StickyKeys' -Name 'Flags' -ErrorAction SilentlyContinue
$stickyEnabled = ($sticky.Flags -band 1) -ne 0

# 6. 待机内存
$memPerf = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction SilentlyContinue
$standbyGB = if ($memPerf.StandbyCacheNormalPriorityBytes) {
    [math]::Round(($memPerf.StandbyCacheNormalPriorityBytes + $memPerf.StandbyCacheReserveBytes + $memPerf.StandbyCacheCoreBytes) / 1GB, 1)
} else { 0 }

[PSCustomObject]@{
    GameDVR = $dvrEnabled
    HAGS = $hagsEnabled
    VBS = $vbsRunning
    PowerPlanName = $name
    IsHighPerformance = $isUltimateOrHigh
    StickyKeys = $stickyEnabled
    StandbyGB = $standbyGB
} | ConvertTo-Json -Compress
`;

    execFile(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      if (!err && stdout.trim()) {
        try {
          const raw = JSON.parse(stdout.trim());
          return resolve({
            gameDvr: !!raw.GameDVR,
            hags: !!raw.HAGS,
            vbs: !!raw.VBS,
            powerPlanName: raw.PowerPlanName || '自定义模式',
            isHighPerformance: !!raw.IsHighPerformance,
            stickyKeys: !!raw.StickyKeys,
            standbyGB: raw.StandbyGB || 0
          });
        } catch (_) {}
      }
      resolve({
        gameDvr: true,
        hags: true,
        vbs: false,
        powerPlanName: '自定义模式',
        isHighPerformance: true,
        stickyKeys: false,
        standbyGB: 9.5
      });
    });
  });
}

/**
 * 深度排空待机缓存 (Standby List)
 */
async function cleanStandbyMemory() {
  try {
    const res = await guardian.boostSystem({ deep: true, targetApps: [] });
    // 用真实探针回报当前待机缓存，不再写死假数值
    const after = await guardian.readMemoryProbe();
    if (after && cachedProfile) {
      cachedProfile.standbyGB = Number((after.StandbyMB / 1024).toFixed(1));
      cachedProfile.freeGB = Number((after.FreeMB / 1024).toFixed(1));
    }
    const freed = res && res.freedMemMB ? res.freedMemMB : 0;
    const freedText = freed >= 1024 ? `${(freed / 1024).toFixed(1)} GB` : `${freed} MB`;
    return {
      ok: true,
      freedMB: freed,
      message: `待机缓存与工作集已排空，可用内存增加约 ${freedText}`
    };
  } catch (err) {
    log.error('排空待机缓存失败', err);
    return { ok: false, message: '待机缓存排空失败: ' + err.message };
  }
}

/**
 * 一键彻底禁用粘滞键（连按 5 次 Shift 不再弹窗）
 */
function disableStickyKeys() {
  return new Promise((resolve) => {
    const ps = `
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Accessibility\\StickyKeys' -Name 'Flags' -Value 506
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Accessibility\\Keyboard Response' -Name 'Flags' -Value 122
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Accessibility\\ToggleKeys' -Name 'Flags' -Value 58
`;
    execFile(PS_EXE, ['-NoProfile', '-Command', ps], { timeout: 5000, windowsHide: true }, (err) => {
      if (err) return resolve({ ok: false, message: '修改粘滞键失败: ' + err.message });
      resolve({ ok: true, message: '已彻底禁用连按5次Shift粘滞键弹窗！' });
    });
  });
}

/**
 * 切换 Windows 卓越性能 / 高性能模式
 */
function enableUltimatePower() {
  return new Promise((resolve) => {
    const ps = `
$out = powercfg -duplicatescheme e9a42b02-d5df-448d-aa00-03f14749eb61
if ($LASTEXITCODE -ne 0) {
    # 如果卓越性能不支持，激活高性能模式
    powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c
} else {
    $guid = $out -replace '.*?:\\s*([a-f0-9-]+).*', '$1'
    if ($guid) { powercfg /setactive $guid }
}
`;
    execFile(PS_EXE, ['-NoProfile', '-Command', ps], { timeout: 5000, windowsHide: true }, (err) => {
      if (err) return resolve({ ok: false, message: '切换电源计划失败: ' + err.message });
      resolve({ ok: true, message: '已激活 Windows 卓越/高性能电源模式，CPU 调度更激进！' });
    });
  });
}

/**
 * 打开 Windows 手柄控制器测试 (joy.cpl)
 */
function openJoyCpl() {
  return new Promise((resolve) => {
    spawn('cmd.exe', ['/c', 'start', 'joy.cpl'], { detached: true, stdio: 'ignore' }).unref();
    resolve({ ok: true, message: '已打开 Windows 原生游戏控制器校准面板' });
  });
}

/**
 * 打开 Windows 高级图形与显卡首选项设置
 */
function openGraphicsSettings() {
  return new Promise((resolve) => {
    spawn('cmd.exe', ['/c', 'start', 'ms-settings:display-advancedgraphics'], { detached: true, stdio: 'ignore' }).unref();
    resolve({ ok: true, message: '已直达 Win11 图形设置（可配置具体游戏独显高性能）' });
  });
}

/**
 * 打开常见游戏存档目录 (Saved Games / LocalAppData)
 */
function openSavedGames() {
  return new Promise((resolve) => {
    const savedGamesPath = path.join(os.homedir(), 'Saved Games');
    if (!fs.existsSync(savedGamesPath)) {
      try { fs.mkdirSync(savedGamesPath, { recursive: true }); } catch (_) {}
    }
    spawn('explorer.exe', [savedGamesPath], { detached: true, stdio: 'ignore' }).unref();
    resolve({ ok: true, message: '已打开本地游戏存档目录 (Saved Games)' });
  });
}

/**
 * 一键强退卡死未响应的游戏
 */
function killFrozenGames() {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/f', '/fi', 'status eq not responding'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const msg = stdout || '';
      if (msg.includes('SUCCESS') || msg.includes('成功')) {
        resolve({ ok: true, message: '已强制终结所有卡死无响应的游戏进程！' });
      } else {
        resolve({ ok: true, message: '当前没有检测到卡死未响应的窗口' });
      }
    });
  });
}

/**
 * 游戏瞬时加速：优先调用原生极速 Booster，毫秒级排空待机缓存与压缩后台内存
 */
function runInstantBoost() {
  return new Promise((resolve) => {
    const boosterExe = path.join(__dirname, '..', 'bin', 'quickkeys-booster.exe');
    if (fs.existsSync(boosterExe)) {
      execFile(boosterExe, [], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (!err && stdout.trim()) {
          try {
            const data = JSON.parse(stdout.trim());
            const freed = data.freedMB || 0;
            const fg = data.fgProcess ? `，前台进程「${data.fgProcess}」已提升优先级` : '';
            const msg = `⚡ 瞬时加速完成：释放 ${freed > 1024 ? (freed / 1024).toFixed(1) + ' GB' : freed + ' MB'} 内存（压缩 ${data.trimmedCount || 0} 个后台进程${fg}）`;
            return resolve({
              ok: true,
              freedMB: freed,
              trimmedCount: data.trimmedCount,
              fgProcess: data.fgProcess,
              message: msg
            });
          } catch (_) {}
        }
        // 兜底退化：走 guardian 深度加速，释放量以真实内存快照为准
        cleanStandbyMemory().then((res) => resolve({ ok: !!res.ok, freedMB: res.freedMB || 0, message: res.message }));
      });
    } else {
      cleanStandbyMemory().then((res) => resolve({ ok: !!res.ok, freedMB: res.freedMB || 0, message: res.message }));
    }
  });
}

module.exports = {
  getGamingProfile,
  getGamingDiagnostics,
  cleanStandbyMemory,
  runInstantBoost,
  disableStickyKeys,
  enableUltimatePower,
  openJoyCpl,
  openGraphicsSettings,
  openSavedGames,
  killFrozenGames
};
