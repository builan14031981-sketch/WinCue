# QuickKeys 图标生成脚本（System.Drawing，无外部依赖）
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assetDir = Join-Path $root 'src\assets'
$buildDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

# 闪电顶点（24x24 坐标系）
$bolt = @(
  @{ x = 13; y = 2 },
  @{ x = 4;  y = 14 },
  @{ x = 10; y = 14 },
  @{ x = 9;  y = 22 },
  @{ x = 18; y = 10 },
  @{ x = 12; y = 10 }
)

function RoundedRectPath($size, $radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-AppIcon($size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $radius = [int]($size * 0.225)
  $path = RoundedRectPath $size $radius
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    [System.Drawing.Color]::FromArgb(255, 244, 245, 248),
    [System.Drawing.Color]::FromArgb(255, 176, 178, 188), 90)
  $g.FillPath($bg, $path)

  # 顶部高光
  $hlPath = RoundedRectPath $size $radius
  $g.SetClip($hlPath)
  $hl = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    [System.Drawing.Color]::FromArgb(70, 255, 255, 255),
    [System.Drawing.Color]::FromArgb(0, 255, 255, 255), 90)
  $g.FillRectangle($hl, 0, 0, $size, [int]($size * 0.55))
  $g.ResetClip()

  # 细描边
  $penW = [math]::Max(1.0, $size / 170)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(46, 255, 255, 255), [single]$penW)
  $g.DrawPath($pen, $path)

  # 蓝色闪电
  $pad = [int]($size * 0.17)
  $scale = ($size - 2 * $pad) / 24.0
  $pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
  foreach ($p in $bolt) {
    $pts.Add((New-Object System.Drawing.PointF([single]($p.x * $scale + $pad), [single]($p.y * $scale + $pad))))
  }
  $boltBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    [System.Drawing.Color]::FromArgb(255, 20, 138, 255),
    [System.Drawing.Color]::FromArgb(255, 0, 101, 210), 90)
  $g.FillPolygon($boltBrush, $pts.ToArray())

  $g.Dispose()
  return $bmp
}

function New-TrayIcon($size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $pad = [int]($size * 0.16)
  $scale = ($size - 2 * $pad) / 24.0
  $pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'
  foreach ($p in $bolt) {
    $pts.Add((New-Object System.Drawing.PointF([single]($p.x * $scale + $pad), [single]($p.y * $scale + $pad))))
  }
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 64, 64, 70))
  $g.FillPolygon($brush, $pts.ToArray())
  $g.Dispose()
  return $bmp
}

$icon256 = New-AppIcon 256
$icon256.Save((Join-Path $assetDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$icon256.Save((Join-Path $buildDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$icon32 = New-AppIcon 32
$icon32.Save((Join-Path $assetDir 'icon-32.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$tray = New-TrayIcon 32
$tray.Save((Join-Path $assetDir 'tray.png'), [System.Drawing.Imaging.ImageFormat]::Png)

Write-Host 'icons generated:'
Get-ChildItem $assetDir | Select-Object Name, Length
Get-ChildItem $buildDir | Select-Object Name, Length
