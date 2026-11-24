$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$items = @()

# 1. 扫描当前启用的注册表启动项
$regPaths = @(
  @{ Path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; Scope = '当前用户注册表'; Key = 'HKCU_Run' },
  @{ Path = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'; Scope = '系统注册表 (64位)'; Key = 'HKLM_Run' },
  @{ Path = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; Scope = '系统注册表 (32位)'; Key = 'HKLM_WOW64_Run' }
)

foreach ($r in $regPaths) {
  if (Test-Path $r.Path) {
    $props = (Get-ItemProperty -Path $r.Path).PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }
    foreach ($p in $props) {
      $items += [PSCustomObject]@{
        Id = ($r.Path + '::' + $p.Name)
        Name = $p.Name
        Command = [string]$p.Value
        Location = $r.Path
        Scope = $r.Scope
        StorageKey = $r.Key
        Type = 'Registry'
        Enabled = $true
      }
    }
  }
}

# 2. 扫描被 QuickKeys 隔离禁用的注册表启动项
$disabledBase = 'HKCU:\Software\QuickKeys\DisabledStartup'
if (Test-Path $disabledBase) {
  Get-ChildItem -Path $disabledBase | ForEach-Object {
    $storeKey = $_.PSChildName
    $subPath = $_.PSPath
    $props = (Get-ItemProperty -Path $subPath).PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' }
    foreach ($p in $props) {
      $origScope = '已禁用启动项'
      $origLocation = ''
      if ($storeKey -eq 'HKCU_Run') { $origLocation = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'; $origScope = '当前用户注册表 (已禁用)' }
      elseif ($storeKey -eq 'HKLM_Run') { $origLocation = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'; $origScope = '系统注册表 (已禁用)' }
      elseif ($storeKey -eq 'HKLM_WOW64_Run') { $origLocation = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'; $origScope = '系统注册表 (已禁用)' }

      $items += [PSCustomObject]@{
        Id = ($disabledBase + '\' + $storeKey + '::' + $p.Name)
        Name = $p.Name
        Command = [string]$p.Value
        Location = $origLocation
        StorageKey = $storeKey
        Type = 'Registry'
        Enabled = $false
      }
    }
  }
}

# 3. 扫描启动文件夹（过滤 desktop.ini）
$startupDirs = @(
  @{ Dir = [Environment]::GetFolderPath('Startup'); Scope = '当前用户启动目录' },
  @{ Dir = [Environment]::GetFolderPath('CommonStartup'); Scope = '公用启动目录' }
)

foreach ($s in $startupDirs) {
  if (Test-Path $s.Dir) {
    Get-ChildItem -Path $s.Dir -Force | Where-Object { -not $_.PSIsContainer -and $_.Name -notmatch '^desktop\.ini' } | ForEach-Object {
      $isDis = $_.Name.EndsWith('.disabled')
      $rawName = if ($isDis) { $_.Name -replace '\.disabled$', '' } else { $_.Name }
      $baseName = [System.IO.Path]::GetFileNameWithoutExtension($rawName)
      $items += [PSCustomObject]@{
        Id = ('Folder::' + $_.FullName)
        Name = $baseName
        Command = $_.FullName
        Location = $s.Dir
        Scope = $s.Scope
        Type = 'Shortcut'
        Enabled = (-not $isDis)
      }
    }
  }
}

# 4. 扫描非系统级计划任务自启动（抓取 CC Switch / ClaudeStack 等）
$schedTasks = Get-ScheduledTask | Where-Object {
  $_.TaskPath -notmatch '^\\Microsoft\\Windows\\' -and
  ($_.Triggers | Where-Object { $_.CimClass.CimClassName -match 'Logon|Boot' })
}

foreach ($t in $schedTasks) {
  $actList = @()
  foreach ($a in $t.Actions) {
    $actList += ($a.Execute + ' ' + $a.Arguments).Trim()
  }
  $items += [PSCustomObject]@{
    Id = ('Task::' + $t.TaskName)
    Name = $t.TaskName
    Command = ($actList -join ' ; ').Trim()
    Location = $t.TaskPath
    Scope = '系统计划任务'
    Type = 'Task'
    Enabled = ($t.State -ne 'Disabled')
  }
}

$items | ConvertTo-Json -Compress
