'use strict';

/**
 * 需要落地到 userData 的 PowerShell 脚本。
 * 打包后脚本在 asar 内无法被 powershell.exe 直接读取，因此在启动时物化到 userData\\scripts。
 */

const fs = require('fs');
const path = require('path');

// 通用组合键发送器：-Keys "LWIN,SHIFT,S"，使用 keybd_event（可发送 Win 键，WScript.SendKeys 做不到）
const HOTKEY_PS1 = `# QuickKeys hotkey sender
param(
  [Parameter(Mandatory=$true)][string]$Keys
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class QKKeySend {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern uint MapVirtualKey(uint uCode, uint uMapType);
}
"@
$map = @{
  'LWIN'=0x5B;'RWIN'=0x5C;'SHIFT'=0x10;'CONTROL'=0x11;'CTRL'=0x11;'MENU'=0x12;'ALT'=0x12;
  'TAB'=0x09;'RETURN'=0x0D;'ENTER'=0x0D;'ESC'=0x1B;'ESCAPE'=0x1B;'SPACE'=0x20;
  'LEFT'=0x25;'UP'=0x26;'RIGHT'=0x27;'DOWN'=0x28;
  'HOME'=0x24;'END'=0x23;'DELETE'=0x2E;'DEL'=0x2E;'INSERT'=0x2D;'SNAPSHOT'=0x2C;'PRTSC'=0x2C;
  'PAGEUP'=0x21;'PAGEDOWN'=0x22;'CAPSLOCK'=0x14;'NUMLOCK'=0x90;'SCROLLLOCK'=0x91;
  'BACK'=0x08;'BACKSPACE'=0x08;'APPS'=0x5D;'PRINT'=0x2A;
  'F1'=0x70;'F2'=0x71;'F3'=0x72;'F4'=0x73;'F5'=0x74;'F6'=0x75;'F7'=0x76;'F8'=0x77;
  'F9'=0x78;'F10'=0x79;'F11'=0x7A;'F12'=0x7B;
  'OEM_PERIOD'=0xBE;'OEM_COMMA'=0xBC;'OEM_1'=0xBA;'OEM_2'=0xBF;'OEM_3'=0xC0;
  'OEM_4'=0xDB;'OEM_5'=0xDC;'OEM_6'=0xDD;'OEM_7'=0xDE;'OEM_PLUS'=0xBB;'OEM_MINUS'=0xBD;
  'VOLUME_MUTE'=0xAD;'VOLUME_DOWN'=0xAE;'VOLUME_UP'=0xAF;
  'MEDIA_NEXT'=0xB0;'MEDIA_PREV'=0xB1;'MEDIA_STOP'=0xB2;'MEDIA_PLAY'=0xB3;
}
$tokens = $Keys -split ','
$vks = New-Object System.Collections.Generic.List[uint32]
foreach ($t in $tokens) {
  $k = $t.Trim().ToUpper()
  if ([string]::IsNullOrWhiteSpace($k)) { continue }
  if ($map.ContainsKey($k)) { $vks.Add($map[$k]) }
  elseif ($k -match '^[A-Z0-9]$') { $vks.Add([uint32][char]$k) }
  else { Write-Error "Unknown key: $k"; exit 2 }
}
foreach ($v in $vks) {
  $scan = [QKKeySend]::MapVirtualKey($v, 0)
  $ext = if ($v -in 0x5B, 0x5C, 0x5D, 0x2C, 0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x90, 0x6F) { 1 } else { 0 }
  [QKKeySend]::keybd_event([byte]$v, [byte]$scan, $ext, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 15
}
Start-Sleep -Milliseconds 50
for ($i = $vks.Count; $i -gt 0; $i--) {
  $v = $vks[$i-1]
  $scan = [QKKeySend]::MapVirtualKey($v, 0)
  $ext = if ($v -in 0x5B, 0x5C, 0x5D, 0x2C, 0x2D, 0x2E, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x90, 0x6F) { 1 } else { 0 }
  [QKKeySend]::keybd_event([byte]$v, [byte]$scan, [uint32](2 -bor $ext), [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 10
}
`;

// 关闭显示器：发送 SC_MONITORPOWER=2
const MONITOR_OFF_PS1 = `# QuickKeys monitor off
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class QKMonitor {
  [DllImport("user32.dll")]
  public static extern int SendMessage(int hWnd, int hMsg, int wParam, int lParam);
}
"@
[QKMonitor]::SendMessage(0xFFFF, 0x0112, 0xF170, 2) | Out-Null
Start-Sleep -Milliseconds 800
`;

// Word 文档 (.docx / .doc) 转 PDF 自动化脚本
const WORD_TO_PDF_PS1 = `# QuickKeys Word to PDF
param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $InputPath)) {
  Write-Error "待转换的 Word 文件不存在：$InputPath"
  exit 1
}
try {
  $word = New-Object -ComObject Word.Application
} catch {
  Write-Error "系统未安装 Microsoft Word 或兼容 Office。Word 转 PDF 需依赖本地 Word/WPS，请安装后重试。"
  exit 2
}
$word.Visible = $false
try {
  $doc = $word.Documents.Open($InputPath, $false, $true)
  # 17 表示 wdExportFormatPDF
  $doc.ExportAsFixedFormat($OutputPath, 17)
  $doc.Close([ref]$false)
  Write-Output "OK"
} catch {
  Write-Error "Word 转换失败：$($_.Exception.Message)"
  exit 3
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
`;

// NetKit：一键网络清理（清代理环境变量 / 关系统代理 / 刷 DNS）
const NET_CLEAN_PS1 = `# QuickKeys NetKit - proxy cleanup
param(
  [switch]$NoExplorer
)
$ErrorActionPreference = 'SilentlyContinue'
$L = @()
$is = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

foreach ($v in @('HTTP_PROXY','HTTPS_PROXY','NO_PROXY','ALL_PROXY','http_proxy','https_proxy','no_proxy','all_proxy')) {
    [Environment]::SetEnvironmentVariable($v, $null, 'User')
}
$machineTried = @()
foreach ($v in @('HTTP_PROXY','HTTPS_PROXY','NO_PROXY','ALL_PROXY')) {
    if ([Environment]::GetEnvironmentVariable($v, 'Machine')) {
        [Environment]::SetEnvironmentVariable($v, $null, 'Machine')
        $machineTried += $v
    }
}

Set-ItemProperty $is -Name ProxyEnable -Value 0
Set-ItemProperty $is -Name ProxyServer -Value ''
Set-ItemProperty $is -Name AutoConfigURL -Value ''
ipconfig /flushdns | Out-Null

$L += '=== 一键网络清理 ==='
$L += '[完成] 代理环境变量已清空（用户级，含大小写变体）'
if ($machineTried.Count -gt 0) {
    $L += ('[提示] 系统级变量需管理员权限，本次已尝试清理: ' + ($machineTried -join ', '))
} else {
    $L += '[完成] 系统级环境变量本来就干净'
}
$L += '[完成] 系统代理已关闭，代理地址已清空'
$L += '[完成] DNS 缓存已刷新'

$procs = Get-Process -Name bby, v2rayN, xray, sing-box -ErrorAction SilentlyContinue
if ($procs) {
    $L += ''
    $L += '仍在运行的代理 / 加速器进程：'
    foreach ($p in $procs) { $L += ('  - ' + $p.ProcessName + '.exe (PID ' + $p.Id + ')') }
    $L += '[提示] 加速器开着时可能把设置再写回来；彻底退出它之后再清理一次最稳。'
} else {
    $L += '[完成] 当前没有代理 / 加速器进程在运行'
}

# 关键一步：环境变量写进注册表后，已经跑着的资源管理器还在用旧快照。
# 重启 explorer.exe 让它重新读一遍，此后从桌面/任务栏/开始菜单启动的程序才能拿到新值。
$L += ''
if ($NoExplorer) {
    $L += '[提示] 跳过资源管理器重启（由调用方自行处理）'
} else {
    $L += '=== 重启资源管理器 ==='
    $hadExp = [bool](Get-Process -Name explorer -ErrorAction SilentlyContinue)
    if ($hadExp) {
        Get-Process -Name explorer -ErrorAction SilentlyContinue | Stop-Process -Force
        # 面板会闪一下（任务栏短暂消失再回来），这是正常的
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 150
            if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { break }
        }
    }
    if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
        Start-Process explorer.exe
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 150
            if (Get-Process -Name explorer -ErrorAction SilentlyContinue) { break }
        }
    }
    if (Get-Process -Name explorer -ErrorAction SilentlyContinue) {
        $L += '[完成] 资源管理器已重启，新环境变量对新启动的程序立即生效'
        $L += '[完成] 现在直接开游戏 / 开软件就行，不用再注销或重启电脑'
    } else {
        $L += '[注意] 资源管理器没能自动拉起，手动救一下：'
        $L += '       Ctrl+Shift+Esc → 任务管理器 → 运行新任务 → 输入 explorer.exe → 确定'
    }
}

Write-Output ($L -join [Environment]::NewLine)
`;

// NetKit：反重力体检（端口 / 环境变量 / 系统代理 / 进程 / 日志 → 直接给结论）
const NET_DOCTOR_PS1 = `# QuickKeys NetKit - Antigravity doctor
$ErrorActionPreference = 'SilentlyContinue'
$L = @()
$issues = @()
$verdict = @()

# 端口探测：只跑一次 netstat 建索引，比每个端口调一次 Get-NetTCPConnection 快一个数量级
$script:ListenSet = @{}
foreach ($ln in (netstat -ano -p TCP)) {
    if ($ln -match '^\\s*TCP\\s+\\S+:(\\d+)\\s+\\S+\\s+LISTENING') { $script:ListenSet[[int]$Matches[1]] = 1 }
}
function Test-Port([int]$Port) {
    return $script:ListenSet.ContainsKey($Port)
}
function Test-Net([int]$Port) {
    $code = & curl.exe -s -o NUL -w '%{http_code}' -x ('http://127.0.0.1:' + $Port) --max-time 5 https://www.gstatic.com/generate_204 2>$null
    return "$code"
}

$L += '=== 反重力体检 ==='
$L += ('时间: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

$uEnv = Get-ItemProperty 'HKCU:\\Environment'
$mEnv = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

$L += ''
$L += '[1] Electron / Node 环境变量'
$regBad = @()
foreach ($n in @('ELECTRON_RUN_AS_NODE','NODE_OPTIONS')) {
    if ($uEnv.$n) { $regBad += ($n + ' (用户级)') }
    if ($mEnv.$n) { $regBad += ($n + ' (系统级)') }
}
if ($regBad.Count -gt 0) {
    $L += ('  [问题] 系统环境变量被写死: ' + ($regBad -join ', '))
    $issues += '系统环境变量污染'
    $verdict += '启动即秒退：ELECTRON_RUN_AS_NODE / NODE_OPTIONS 被写进系统，Electron 应用会变裸 Node 直接退出。'
} else {
    $L += '  [正常] 系统级没有污染'
}

$L += ''
$L += '[2] 全局代理环境变量'
if ($uEnv.HTTP_PROXY) {
    $L += ('  [问题] 仍存在: HTTP_PROXY=' + $uEnv.HTTP_PROXY)
    $issues += '全局代理变量残留'
    if ("$($uEnv.HTTP_PROXY)" -match ':(\\d+)') {
        $pp = [int]$Matches[1]
        if (Test-Port $pp) { $L += ('  [注意] 变量指向的端口 ' + $pp + ' 当前活着') }
        else {
            $L += ('  [问题] 变量指向的端口 ' + $pp + ' 没人监听 —— 这就是毒药')
            $verdict += ('连不上的元凶：全局环境变量指向死端口 ' + $pp + '。')
        }
    }
} else {
    $L += '  [正常] 用户级没有代理环境变量'
}
if ($mEnv.HTTP_PROXY) { $L += ('  [问题] 系统级仍存在: ' + $mEnv.HTTP_PROXY) } else { $L += '  [正常] 系统级没有代理环境变量' }

$L += ''
$L += '[3] Windows 系统代理'
$is = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
if ($is.ProxyEnable -eq 1) {
    $L += ('  [注意] 已开启 -> ' + $is.ProxyServer)
    if ("$($is.ProxyServer)" -match ':(\\d+)') {
        $sp = [int]$Matches[1]
        if (-not (Test-Port $sp)) {
            $L += ('  [问题] 端口 ' + $sp + ' 没有监听（死代理）')
            $issues += '系统代理指向死端口'
            $verdict += ('系统代理指向死端口 ' + $sp + '，浏览器和客户端都会连不上网。')
        } else { $L += ('  [正常] 端口 ' + $sp + ' 有监听') }
    }
} else {
    $L += '  [正常] 已关闭'
}

$L += ''
$L += '[4] 本地代理端口'
$live = @()
foreach ($p in @(10808,7890,7897,18809)) {
    if (Test-Port $p) {
        $code = Test-Net $p
        if ("$code" -eq '204') { $L += ('  [正常] ' + $p + ' 存活且能出网'); $live += $p }
        else { $L += ('  [注意] ' + $p + ' 有监听但出网失败 (code=' + $code + ')') }
    } else { $L += ('  ' + $p + ' 无监听') }
}
if ($live.Count -eq 0) {
    $issues += '没有任何可用代理'
    $verdict += '登录 / 白屏：当前没有任何可用代理，后端无法访问 Google。'
}

$L += ''
$L += '[5] 进程与安装'
$procs = Get-Process -Name Antigravity -ErrorAction SilentlyContinue
$instStart = $null
if ($procs) {
    $instStart = ($procs | Sort-Object StartTime | Select-Object -First 1).StartTime
    $L += ('  [正常] 正在运行，进程数 ' + $procs.Count + '，启动于 ' + $instStart.ToString('HH:mm:ss'))
} else {
    $L += '  [注意] 当前没有运行'
}
$app = Join-Path $env:LOCALAPPDATA 'Programs\\antigravity\\Antigravity.exe'
if (Test-Path $app) { $L += ('  [正常] 程序存在: ' + $app) }
else { $L += '  [问题] 标准路径下找不到 Antigravity.exe'; $issues += '程序路径丢失' }
$res = Join-Path (Split-Path $app -Parent) 'resources'
if (Test-Path (Join-Path $res 'app.asar.patched.bak')) { $L += '  [注意] 检测到 patch 痕迹（app.asar 被改过）' }

$L += ''
$L += '[6] 启动记录'
$lastRun = Join-Path $env:LOCALAPPDATA 'AntigravityLauncher\\last_run.log'
if (Test-Path $lastRun) {
    $tail = (Get-Content $lastRun -Tail 1)
    $L += ('  ' + $tail)
    if ($tail -match 'PORT=(\\d+)') {
        $up = [int]$Matches[1]
        if (Test-Port $up) { $L += ('  [正常] 上次用的端口 ' + $up + ' 还活着') }
        else {
            $L += ('  [问题] 上次用的端口 ' + $up + ' 已经死了，正在运行的实例还拿它连 Google')
            $issues += '运行中实例的代理已失效'
            $verdict += ('断线：启动时的代理端口 ' + $up + ' 后来死了（加速器退出或空闲回收），重启程序即可换代理。')
        }
    }
} else { $L += '  没有启动记录' }

$L += ''
$L += '[7] 日志'
$mainLog = Join-Path $env:APPDATA 'Antigravity\\logs\\main.log'
$lsLog = Join-Path $env:APPDATA 'Antigravity\\logs\\language_server.log'
if (Test-Path $mainLog) {
    $errs = Get-Content $mainLog -Tail 300 | Select-String 'Failed to load URL|ERR_TIMED_OUT|ERR_CONNECTION'
    $fresh = @()
    foreach ($e in $errs) {
        if ($e.Line -match '\\[(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})') {
            $t = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', $null)
            if ($instStart -and $t -lt $instStart.AddSeconds(-60)) { } else { $fresh += $e }
        } else { $fresh += $e }
    }
    if ($fresh.Count -gt 0) {
        $L += ('  [问题] 本次运行有加载错误: ' + ($fresh | Select-Object -Last 1).Line.Trim())
        $issues += 'UI 加载超时'
        $verdict += '白屏：本机 UI 服务加载超时，通常伴随后端崩溃或代理不通。'
    } else {
        $L += '  [正常] 本次运行没有加载错误（历史错误已忽略）'
    }
}
if (Test-Path $lsLog) {
    $size = (Get-Item $lsLog).Length
    if ($size -eq 0) {
        $L += '  [问题] language_server.log 是 0 字节，后端从未启动成功'
        $issues += '语言服务器未启动'
        $verdict += '白屏：语言服务器压根没起来，多见于启动瞬间被环境变量污染或代理不可用。'
    } else {
        $L += ('  [正常] language_server.log 大小 ' + $size + ' 字节')
        $refused = Get-Content $lsLog -Tail 150 | Select-String 'proxyconnect|connection refused|actively refused'
        if ($refused) {
            $L += ('  [问题] 后端代理被拒: ' + ($refused | Select-Object -Last 1).Line.Trim())
            $issues += '后端代理被拒'
            $verdict += '登录失败：后端正在用一个已死的代理端口（日志里有 refused），重启程序即可。'
        }
    }
}

$L += ''
$L += '=== 结论 ==='
if ($verdict.Count -eq 0) {
    if ($procs) { $L += '一切正常：程序在跑、代理可用、日志无明显异常。' }
    else { $L += '没有发现故障项，程序当前没运行，可直接启动。' }
} else {
    $i = 1
    foreach ($v in $verdict) { $L += ($i.ToString() + '. ' + $v); $i++ }
}
if ($issues.Count -gt 0) { $L += ('命中问题项: ' + ($issues -join ' / ')) }

Write-Output ($L -join [Environment]::NewLine)
`;

// NetKit：启动反重力（自动挑能出网的代理，只注入它自己的进程）
const NET_START_PS1 = `# QuickKeys NetKit - launch Antigravity with a live proxy
$ErrorActionPreference = 'SilentlyContinue'

$app = Join-Path $env:LOCALAPPDATA 'Programs\\antigravity\\Antigravity.exe'
if (-not (Test-Path $app)) {
    $found = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Recurse -Filter 'Antigravity.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($found) { $app = $found.FullName }
}
if (-not (Test-Path $app)) {
    Write-Output '[问题] 找不到 Antigravity.exe（可能更新后换了目录），请让 WorkBuddy 修复路径。'
    exit 1
}

$listen = @{}
foreach ($ln in (netstat -ano -p TCP)) {
    if ($ln -match '^\\s*TCP\\s+\\S+:(\\d+)\\s+\\S+\\s+LISTENING') { $listen[[int]$Matches[1]] = 1 }
}
$picked = 0
foreach ($p in @(10808, 7890, 7897, 18809)) {
    if (-not $listen.ContainsKey($p)) { continue }
    $code = & curl.exe -s -o NUL -w '%{http_code}' -x ('http://127.0.0.1:' + $p) --max-time 5 https://www.gstatic.com/generate_204 2>$null
    if ("$code" -eq '204') { $picked = $p; break }
}
if ($picked -eq 0) {
    Write-Output '[问题] 没有可用代理：10808 / 7890 / 7897 / 18809 都连不出去。先启动 v2rayN 或加速器，再点一次。'
    exit 1
}

$env:HTTP_PROXY = 'http://127.0.0.1:' + $picked
$env:HTTPS_PROXY = 'http://127.0.0.1:' + $picked
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Start-Process -FilePath $app

$logDir = Join-Path $env:LOCALAPPDATA 'AntigravityLauncher'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Add-Content -Path (Join-Path $logDir 'last_run.log') -Value ((Get-Date -Format 'yyyy/MM/dd HH:mm:ss') + ' PORT=' + $picked + ' APP=' + $app + ' SRC=QuickKeys')

Write-Output ('[完成] 已用代理 127.0.0.1:' + $picked + ' 启动反重力')
Write-Output '如果 30 秒内还没有界面，点一次「反重力体检」看是哪一环没过。'
`;

// NetKit：先清理再启动
const NET_FIX_PS1 = `# QuickKeys NetKit - clean then launch
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$c = Join-Path $root 'net-clean.ps1'
$s = Join-Path $root 'net-start.ps1'
if (Test-Path $c) { & $c -NoExplorer }
Start-Sleep -Milliseconds 500
if (Test-Path $s) { & $s }
`;

// NetKit：给系统代理的"绕过列表"补上国产软件域名（剪映/抖音等），让它们直连
const PROXY_BYPASS_PS1 = `# QuickKeys NetKit - domestic bypass list
$ErrorActionPreference = 'SilentlyContinue'
$L = @()
$is = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

# 内网 / 回环，必留
$base = @('<local>','localhost','127.*','10.*','172.16.*','172.17.*','172.18.*','172.19.*','172.20.*','172.21.*','172.22.*','172.23.*','172.24.*','172.25.*','172.26.*','172.27.*','172.28.*','172.29.*','172.30.*','172.31.*','192.168.*')

# 剪映 / 抖音（字节系）——访问这些域名时绕开代理
$cn = @(
    'jianying.com','*.jianying.com',
    'ulikecam.com','*.ulikecam.com',
    'capcut.com','*.capcut.com',
    'byteimg.com','*.byteimg.com',
    'bytedance.com','*.bytedance.com',
    'snssdk.com','*.snssdk.com',
    'pstatp.com','*.pstatp.com',
    'amemv.com','*.amemv.com',
    'zjcdn.com','*.zjcdn.com',
    'volccdn.com','*.volccdn.com',
    'volcvideo.com','*.volcvideo.com',
    'bytecdn.cn','*.bytecdn.cn',
    'bytednsdoc.com','*.bytednsdoc.com',
    'douyin.com','*.douyin.com',
    'douyinvod.com','*.douyinvod.com',
    'ibytedapm.com','*.ibytedapm.com',
    'toutiao.com','*.toutiao.com'
)

$cur = [string](Get-ItemProperty $is).ProxyOverride
$list = New-Object System.Collections.Generic.List[string]
foreach ($s in @($cur -split ';')) {
    $t = $s.Trim()
    if ($t -and -not $list.Contains($t)) { $list.Add($t) }
}
$before = $list.Count
foreach ($b in $base) { if (-not $list.Contains($b)) { $list.Add($b) } }
$added = @()
foreach ($d in $cn) {
    if (-not $list.Contains($d)) { $list.Add($d); $added += $d }
}
$new = ($list -join ';')
Set-ItemProperty $is -Name ProxyOverride -Value $new

$pe = (Get-ItemProperty $is).ProxyEnable
$ps = (Get-ItemProperty $is).ProxyServer
$L += '=== 国产软件直连白名单 ==='
if ($pe -eq 1) { $L += ('[注意] 系统代理仍然开着 -> ' + $ps + '（浏览器等照旧走它，不受影响）') }
else { $L += '[完成] 系统代理当前是关闭状态，白名单先备着，等加速器再开也能用' }
if ($added.Count -gt 0) {
    $L += ('[完成] 新增 ' + $added.Count + ' 条绕过规则: ' + (($added | Select-Object -First 8) -join ', ') + $(if ($added.Count -gt 8) { ' ...' } else { '' }))
} else {
    $L += '[完成] 白名单本来就在，没有缺失'
}
$L += ('[完成] 绕过列表共 ' + $list.Count + ' 条，已写入注册表')
$L += ''
$L += '[下一步] 剪映如果正在运行，退出后重新打开才会生效（它启动时读一次代理配置）'
$L += '[提示] 加速器重启后可能把这段列表重写掉，再点一次这个动作即可'

Write-Output ($L -join [Environment]::NewLine)
`;

let materializedDir = null;

function materializeScripts(userDataPath) {
  const dir = path.join(userDataPath, 'scripts');
  materializedDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'hotkey.ps1': HOTKEY_PS1,
    'monitor-off.ps1': MONITOR_OFF_PS1,
    'word-to-pdf.ps1': WORD_TO_PDF_PS1,
    'net-clean.ps1': NET_CLEAN_PS1,
    'net-doctor.ps1': NET_DOCTOR_PS1,
    'net-start.ps1': NET_START_PS1,
    'net-fix.ps1': NET_FIX_PS1,
    'proxy-bypass.ps1': PROXY_BYPASS_PS1
  };
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') : null;
    if (old !== content) {
      // BOM + UTF-8：PowerShell 5.1 只有看到 BOM 才按 UTF-8 解析中文
      fs.writeFileSync(p, '\uFEFF' + content, 'utf8');
    }
  }

  // 落地可执行文件到 userData（asar 内的 exe 无法被直接执行，打包版必须走这里）
  // hotkey: 原生毫秒级按键触发器；scanner: 临时目录体积扫描；booster: 内存加速；
  // memprobe: 内存指标采集（替代启动期的 PowerShell + CIM）
  for (const exeName of ['quickkeys-hotkey.exe', 'quickkeys-scanner.exe', 'quickkeys-booster.exe', 'quickkeys-memprobe.exe']) {
    const targetExe = path.join(dir, exeName);
    const sourceExe = path.join(__dirname, '..', 'bin', exeName);
    if (!fs.existsSync(sourceExe)) continue;
    try {
      const needCopy = !fs.existsSync(targetExe) || fs.statSync(targetExe).size !== fs.statSync(sourceExe).size;
      if (needCopy) fs.copyFileSync(sourceExe, targetExe);
    } catch (_) {}
  }

  return dir;
}

module.exports = {
  materializeScripts,
  getScriptsDir: () => materializedDir,
  HOTKEY_PS1,
  MONITOR_OFF_PS1,
  WORD_TO_PDF_PS1,
  NET_CLEAN_PS1,
  NET_DOCTOR_PS1,
  NET_START_PS1,
  NET_FIX_PS1,
  PROXY_BYPASS_PS1
};
