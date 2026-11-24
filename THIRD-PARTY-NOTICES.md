# Third-Party Notices & Open-Source Attribution

WinCue（轻唤盒子）本身的软件源码采用 **MIT License** 开源（见根目录 `LICENSE`）。以下第三方依赖与内置字体资源分别遵循其各自原始许可协议，不适用根目录的 MIT 协议再授权：

## 1. 内置离线字体资源

### MiSans (`src/renderer/fonts/misans/`)
- **版权归属**：Copyright © Beijing Xiaomi Mobile Software Co., Ltd.
- **授权条款**：《MiSans 字体知识产权许可协议》（允许个人与商业软件及开源项目免费内嵌使用；未修改原始字形与编码，不得单独提取或售卖字库本身）。
- **分包来源**：`misans@5.0.0`（打包脚本依据 Apache-2.0，见 `src/renderer/fonts/misans/LICENSE` 与 `NOTICE.txt`）。

### 霞鹜文楷 Lite / LXGW WenKai Lite (`src/renderer/fonts/wenkai/`)
- **版权归属**：Copyright © LXGW（落霞孤鹜）
- **授权条款**：**SIL Open Font License 1.1 (OFL-1.1)**（全文见 `src/renderer/fonts/wenkai/OFL.txt`）。
- **分包来源**：`lxgw-wenkai-lite-webfont@1.7.0`（by Chawye Hsu，切片工具与说明见 `NOTICE.json`）。

## 2. 原生辅助二进制说明 (`src/bin/`)

为保证克隆仓库后可开箱即用、`npm start` 无需临时安装编译链，`src/bin/` 中附带了 4 个小型 Windows 原生辅助可执行文件，其完整 C# 源码均同目录公开可审计：
- `quickkeys-booster.exe` ← 编译自 `src/bin/QuickBooster.cs`
- `quickkeys-hotkey.exe` ← 编译自 `src/bin/QuickHotkey.cs`
- `quickkeys-memprobe.exe` ← 编译自 `src/bin/QuickMemProbe.cs`
- `quickkeys-scanner.exe` ← 编译自 `src/bin/QuickScanner.cs`

如需本地自行从源码重编覆盖，可在 Windows 下使用系统内置 .NET Framework `csc.exe`：
```powershell
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /optimize+ /out:src\bin\quickkeys-booster.exe src\bin\QuickBooster.cs
& $csc /nologo /optimize+ /out:src\bin\quickkeys-hotkey.exe src\bin\QuickHotkey.cs
& $csc /nologo /optimize+ /out:src\bin\quickkeys-memprobe.exe src\bin\QuickMemProbe.cs
& $csc /nologo /optimize+ /out:src\bin\quickkeys-scanner.exe src\bin\QuickScanner.cs
```

## 3. 核心运行时依赖
- Electron (`MIT`), `@electron/asar` (`MIT`), `electron-builder` (`MIT`)
