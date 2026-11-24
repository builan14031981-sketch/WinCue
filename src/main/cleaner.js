'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const log = require('./logger');
const migrator = require('./migrator');

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

function runPs(script, timeoutMs = 25000, elevate = false) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  if (!elevate) {
    return runExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: timeoutMs });
  }
  const wrap = `
    $p = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${b64}' -Verb RunAs -PassThru -Wait
    if ($p) { exit $p.ExitCode } else { exit 1 }
  `;
  const wrapB64 = Buffer.from(wrap, 'utf16le').toString('base64');
  return runExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', wrapB64], { timeout: timeoutMs });
}

function normalizeLower(p) {
  return path.resolve(String(p || '').trim()).replace(/[\\/]+$/, '').toLowerCase();
}

/* ==================== 绝对删除保护黑名单（底层物理拦截） ==================== */

const CHAT_PROTECTED_MARKERS = [
  '\\msg\\', '\\msgmulti\\', '\\db_storage\\', '\\nt_db\\',
  'ftsmsg', 'micromsg', 'enmicromsg', 'global_config', 'chatmsg',
  'msg2.0.db', 'msg3.0.db'
];

const ALLOWLISTED_WIN_SUBDIRS = [
  'c:\\windows\\temp',
  'c:\\windows\\prefetch',
  'c:\\windows\\minidump',
  'c:\\windows\\softwaredistribution\\download',
  'c:\\windows.old'
];

function isBlockedDeleteTarget(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return '空路径';
  let norm;
  try {
    norm = normalizeLower(targetPath);
  } catch (_) {
    return '非法路径';
  }
  if (!norm || norm.length <= 3) return '禁止操作磁盘根目录';

  const winDir = normalizeLower(process.env.WINDIR || 'C:\\Windows');
  const pf = normalizeLower(process.env.ProgramFiles || 'C:\\Program Files');
  const pf86 = normalizeLower(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)');
  const userHome = normalizeLower(os.homedir());
  const localApp = normalizeLower(process.env.LOCALAPPDATA || path.join(userHome, 'AppData', 'Local'));
  const roamingApp = normalizeLower(process.env.APPDATA || path.join(userHome, 'AppData', 'Roaming'));
  const desktop = normalizeLower(path.join(userHome, 'Desktop'));
  const documents = normalizeLower(path.join(userHome, 'Documents'));

  // 1. 聊天消息库红线硬拦截（无论如何不删）
  const normSlash = norm + '\\';
  for (const mk of CHAT_PROTECTED_MARKERS) {
    if (normSlash.includes(mk) || path.basename(norm).includes(mk.replace(/\\/g, ''))) {
      return `受保护的聊天记录核心库（${mk}）`;
    }
  }

  // 2. Windows 系统保护：仅放行明确白名单清理子目录
  if (norm === winDir || norm.startsWith(winDir + '\\')) {
    const okWin = ALLOWLISTED_WIN_SUBDIRS.some((allowed) => norm === allowed || norm.startsWith(allowed + '\\'));
    if (!okWin) return 'Windows 核心系统目录受保护';
  }

  // 3. Program Files、用户根目录、桌面/文档根、AppData 根均禁止整目录清理
  const exactProtected = new Set([
    'c:\\users', 'c:\\programdata', 'c:\\windows.old\\windows\\system32',
    'c:\\pagefile.sys', 'c:\\hiberfil.sys', 'c:\\swapfile.sys', 'c:\\dumpstack.log.tmp',
    pf, pf86, userHome,
    path.join(userHome, 'appdata'),
    localApp, roamingApp,
    path.join(userHome, 'appdata', 'locallow'),
    desktop, documents,
    path.join(userHome, 'downloads')
  ]);
  if (exactProtected.has(norm)) return '核心资产或系统虚拟内存文件禁止直接清理';
  if (norm.endsWith('\\ext4.vhdx')) return 'WSL2 虚拟磁盘文件禁止当作大文件直接删除';
  if (norm.startsWith(pf + '\\') || norm.startsWith(pf86 + '\\')) return '程序安装目录受保护';
  if (norm.startsWith(desktop + '\\') && !norm.endsWith('.tmp')) return '桌面个人文件禁止批量自动清理';

  return null;
}

/* ==================== 软件目录中文身份字典 ==================== */

const APP_FOLDER_DICT = {
  'nvidia': { label: 'NVIDIA 显卡着色器与驱动缓存', kind: 'cache' },
  'nvidia corporation': { label: 'NVIDIA 组件与日志数据', kind: 'cache' },
  'google': { label: 'Google / Chrome 浏览器数据', kind: 'data' },
  'chrome': { label: 'Chrome 浏览器数据', kind: 'data' },
  'edge': { label: 'Microsoft Edge 浏览器数据', kind: 'data' },
  'code': { label: 'VS Code 编辑器扩展与状态', kind: 'data' },
  'cursor': { label: 'Cursor 编辑器数据与扩展', kind: 'data' },
  'jetbrains': { label: 'JetBrains IDE 缓存与索引', kind: 'cache' },
  'docker': { label: 'Docker 镜像与虚拟磁盘数据', kind: 'data' },
  'npm-cache': { label: 'npm Node 包本地缓存', kind: 'cache' },
  'npm': { label: 'npm 全局依赖与缓存', kind: 'data' },
  'pip': { label: 'Python pip 下载缓存', kind: 'cache' },
  'yarn': { label: 'Yarn 本地依赖缓存', kind: 'cache' },
  'nuget': { label: 'NuGet .NET 依赖缓存', kind: 'cache' },
  'temp': { label: '用户临时文件 (Temp)', kind: 'cache' },
  'crashdumps': { label: '程序崩溃转储 (CrashDumps)', kind: 'cache' },
  'tencent': { label: '腾讯系客户端缓存与配置', kind: 'data' },
  'wechat': { label: '微信电脑版配置与缓存', kind: 'data' },
  'wechat files': { label: '微信聊天记录与接收文件目录', kind: 'data' },
  'xwechat': { label: '微信 4.x 本地运行环境', kind: 'data' },
  'xwechat_files': { label: '微信 4.x 聊天与文件目录', kind: 'data' },
  'tencent files': { label: 'QQ 聊天记录与接收文件目录', kind: 'data' },
  'wxwork': { label: '企业微信本地文件目录', kind: 'data' },
  'dingtalk': { label: '钉钉办公客户端数据', kind: 'data' },
  'lark': { label: '飞书客户端数据', kind: 'data' },
  'feishu': { label: '飞书客户端数据', kind: 'data' },
  'baidunetdisk': { label: '百度网盘客户端与缓存', kind: 'data' },
  'netease': { label: '网易云音乐缓存与数据', kind: 'data' },
  'steam': { label: 'Steam 客户端与下载缓存', kind: 'data' },
  'discord': { label: 'Discord 聊天客户端数据', kind: 'data' },
  'electron': { label: 'Electron 运行时缓存', kind: 'cache' },
  'adobe': { label: 'Adobe 媒体缓存与配置', kind: 'data' },
  'jianyingpro': { label: '剪映专业版缓存与草稿数据', kind: 'data' },
  'capcut': { label: 'CapCut 剪辑缓存与工程', kind: 'data' },
  'doubao': { label: '豆包桌面端数据与缓存', kind: 'data' },
  'wsl': { label: 'WSL2 Linux 虚拟磁盘（请用 wsl --export 迁移）', kind: 'system' },
  'antigravity': { label: 'Antigravity 扩展与工作区缓存', kind: 'data' },
  'd3dscache': { label: 'DirectX 着色器缓存', kind: 'cache' },
  'amd': { label: 'AMD 显卡驱动与着色器缓存', kind: 'cache' },
  'packages': { label: 'Windows UWP / 商店应用沙盒数据', kind: 'system' },
  'microsoft': { label: 'Microsoft 系统与内置组件数据', kind: 'system' },
  'programs': { label: '用户级绿色安装程序目录', kind: 'system' }
};

function identifyAppFolder(name, fullPath) {
  const low = String(name || '').toLowerCase();
  const fullLow = String(fullPath || '').toLowerCase();
  if (APP_FOLDER_DICT[low]) return APP_FOLDER_DICT[low];
  for (const [k, v] of Object.entries(APP_FOLDER_DICT)) {
    if (low.includes(k) || fullLow.endsWith('\\' + k)) return v;
  }
  return { label: `${name} 应用数据`, kind: 'data' };
}

/* ==================== 垃圾扫描规则库 ==================== */

function collectJunkTargets() {
  const home = os.homedir();
  const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roamingApp = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const progData = process.env.ProgramData || 'C:\\ProgramData';
  const tempEnv = process.env.TEMP || path.join(localApp, 'Temp');

  const rules = [
    {
      id: 'win-user-temp',
      group: 'system',
      tier: 'safe',
      name: '用户临时文件 (%TEMP%)',
      desc: '仅清理 24 小时前的历史临时文件，规避正在安装或运行的锁文件',
      minAgeHours: 24,
      paths: [tempEnv]
    },
    {
      id: 'win-sys-temp',
      group: 'system',
      tier: 'safe',
      name: 'Windows 系统临时目录',
      desc: '清理 C:\\Windows\\Temp 中超 24 小时的系统安装与服务残留',
      minAgeHours: 24,
      paths: ['C:\\Windows\\Temp']
    },
    {
      id: 'win-crash-dumps',
      group: 'system',
      tier: 'safe',
      name: '系统错误报告与崩溃转储',
      desc: '清理 Minidump、CrashDumps 与 Windows WER 报错归档',
      minAgeHours: 0,
      paths: [
        'C:\\Windows\\Minidump',
        path.join(localApp, 'CrashDumps'),
        path.join(progData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'),
        path.join(progData, 'Microsoft', 'Windows', 'WER', 'ReportQueue')
      ]
    },
    {
      id: 'driver-unpack',
      group: 'system',
      tier: 'safe',
      name: '显卡/芯片组驱动解压残留',
      desc: '清理 C:\\NVIDIA、C:\\AMD、C:\\Intel 安装后遗留的离线包（不影响已装驱动）',
      minAgeHours: 24,
      paths: ['C:\\NVIDIA', 'C:\\AMD', 'C:\\Intel']
    },
    {
      id: 'browser-cache',
      group: 'apps',
      tier: 'safe',
      name: '浏览器网页与脚本缓存',
      desc: '仅清理 Chrome / Edge / 360 等页面渲染与 GPU 缓存，严格保留密码、书签与登录态',
      minAgeHours: 0,
      paths: findBrowserCacheDirs(localApp),
      procHint: ['chrome', 'msedge']
    },
    {
      id: 'desktop-app-cache',
      group: 'apps',
      tier: 'safe',
      name: '常用桌面端运行缓存',
      desc: '清理 VS Code、Cursor、Discord、Steam 等客户端可再生临时缓存，保留插件与登录',
      minAgeHours: 0,
      paths: [
        path.join(roamingApp, 'Code', 'Cache'),
        path.join(roamingApp, 'Code', 'CachedData'),
        path.join(roamingApp, 'Code', 'CachedExtensionVSIXs'),
        path.join(roamingApp, 'Cursor', 'Cache'),
        path.join(roamingApp, 'Cursor', 'CachedData'),
        path.join(roamingApp, 'discord', 'Cache'),
        path.join(roamingApp, 'discord', 'Code Cache'),
        path.join(localApp, 'Steam', 'htmlcache', 'Cache'),
        path.join(localApp, 'D3DSCache')
      ]
    },
    {
      id: 'recycle-bin',
      group: 'confirm',
      tier: 'confirm',
      isRecycleBin: true,
      name: '系统回收站',
      desc: '彻底清空各盘回收站文件；清空后无法从回收站还原，请确认无误删文件',
      minAgeHours: 0,
      paths: []
    },
    {
      id: 'explorer-thumbs',
      group: 'confirm',
      tier: 'confirm',
      name: '资源管理器缩略图与图标缓存',
      desc: '清理 Explorer\\thumbcache_*.db，清理后打开大图目录时会重新生成预览缩略图',
      minAgeHours: 0,
      paths: findThumbCacheFiles(localApp)
    },
    {
      id: 'dev-cache',
      group: 'confirm',
      tier: 'confirm',
      name: '开发者包管理器缓存 (npm / pip / NuGet)',
      desc: '适合释放 GB 级开发环境堆积；清理后再次安装依赖需重新联网下载',
      minAgeHours: 0,
      paths: [
        path.join(localApp, 'npm-cache'),
        path.join(roamingApp, 'npm-cache'),
        path.join(localApp, 'pip', 'Cache'),
        path.join(home, '.nuget', 'packages')
      ]
    }
  ];

  return rules;
}

function findBrowserCacheDirs(localApp) {
  const dirs = [];
  const roots = [
    path.join(localApp, 'Google', 'Chrome', 'User Data'),
    path.join(localApp, 'Microsoft', 'Edge', 'User Data'),
    path.join(localApp, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    path.join(localApp, '360ChromeX', 'Chrome', 'User Data')
  ];
  const cacheSub = ['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache'];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    let profiles = [];
    try {
      profiles = fs.readdirSync(r, { withFileTypes: true })
        .filter((d) => d.isDirectory() && (d.name === 'Default' || d.name.startsWith('Profile ')))
        .map((d) => path.join(r, d.name));
    } catch (_) {}
    for (const prof of profiles) {
      for (const sub of cacheSub) {
        const cand = path.join(prof, sub);
        if (fs.existsSync(cand)) dirs.push(cand);
      }
    }
  }
  return dirs;
}

function findThumbCacheFiles(localApp) {
  const dir = path.join(localApp, 'Microsoft', 'Windows', 'Explorer');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^thumbcache_.*\.db$/i.test(f) || /^iconcache_.*\.db$/i.test(f))
      .map((f) => path.join(dir, f));
  } catch (_) {
    return [];
  }
}

/* ==================== 调用 C# 扫描器 + Node 兜底 ==================== */

function scanDirListWithScanner(tasks, { onProgress, signal } = {}) {
  return new Promise((resolve) => {
    if (!tasks.length) return resolve([]);
    if (!fs.existsSync(SCANNER_EXE)) {
      return resolve(scanDirListFallback(tasks, { onProgress, signal }));
    }

    const child = spawn(SCANNER_EXE, ['dir-sizes'], { windowsHide: true });
    let buf = '';
    const out = [];
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      try { child.kill(); } catch (_) {}
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return resolve(out);
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          out.push(item);
          if (onProgress) onProgress(item);
        } catch (_) {}
      }
    });

    child.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (buf.trim()) {
        try {
          const item = JSON.parse(buf.trim());
          out.push(item);
          if (onProgress) onProgress(item);
        } catch (_) {}
      }
      resolve(out);
    });

    child.on('error', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(out);
    });

    if (!aborted) {
      const payload = tasks.map((t) => `${t.id}|${t.minAgeHours || 0}|${t.path}`).join('\n') + '\n';
      child.stdin.write(payload, 'utf8');
      child.stdin.end();
    }
  });
}

async function scanDirListFallback(tasks, { onProgress, signal } = {}) {
  const now = Date.now();
  const out = [];
  for (const t of tasks) {
    if (signal && signal.aborted) break;
    const cutoff = t.minAgeHours > 0 ? now - t.minAgeHours * 3600 * 1000 : 0;
    let bytes = 0;
    let files = 0;
    let skipped = 0;
    let reparseSkipped = 0;

    const walk = async (dir) => {
      if (signal && signal.aborted) return;
      let lst;
      try { lst = await fs.promises.lstat(dir); } catch (_) { skipped++; return; }
      if (lst.isSymbolicLink()) { reparseSkipped++; return; }
      if (lst.isFile()) {
        if (!cutoff || lst.mtimeMs <= cutoff) { bytes += lst.size; files++; }
        return;
      }
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { skipped++; return; }
      for (const ent of entries) {
        if (signal && signal.aborted) break;
        const full = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) { reparseSkipped++; continue; }
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile()) {
          try {
            const st = await fs.promises.lstat(full);
            if (!cutoff || st.mtimeMs <= cutoff) { bytes += st.size; files++; }
          } catch (_) { skipped++; }
        }
      }
    };

    if (fs.existsSync(t.path)) await walk(t.path);
    const res = { id: t.id, path: t.path, bytes, files, skipped, reparseSkipped, samples: [] };
    out.push(res);
    if (onProgress) onProgress(res);
  }
  return out;
}

async function queryRecycleBin() {
  if (!fs.existsSync(SCANNER_EXE)) return { allBytes: 0, allItems: 0, cBytes: 0, cItems: 0 };
  const r = await runExec(SCANNER_EXE, ['recycle-info'], { timeout: 8000 });
  if (r.code !== 0 || !r.stdout.trim()) return { allBytes: 0, allItems: 0, cBytes: 0, cItems: 0 };
  try {
    return JSON.parse(r.stdout.trim());
  } catch (_) {
    return { allBytes: 0, allItems: 0, cBytes: 0, cItems: 0 };
  }
}

async function scanTopChildren(parentSpecs, limit = 25) {
  if (!fs.existsSync(SCANNER_EXE)) return [];
  return new Promise((resolve) => {
    const child = spawn(SCANNER_EXE, ['top-children'], { windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      try { if (!child.killed) child.kill(); } catch (killErr) { log.warn('cleaner:topChildrenKill', killErr.message); }
      resolve([]);
    }, 90000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', () => {
      clearTimeout(timer);
      if (!stdout.trim()) return resolve([]);
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed.children) ? parsed.children : []);
      } catch (_) {
        resolve([]);
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    const lines = [String(limit), ...parentSpecs.map((s) => `${s.tag}|${s.path}`)].join('\n') + '\n';
    child.stdin.write(lines, 'utf8');
    child.stdin.end();
  });
}

async function scanBigFilesC(minMB = 100, limit = 80) {
  if (!fs.existsSync(SCANNER_EXE)) return [];
  const home = os.homedir();
  const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const winDir = process.env.WINDIR || 'C:\\Windows';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const progData = process.env.ProgramData || 'C:\\ProgramData';
  const excludes = [
    winDir,
    pf,
    pf86,
    'C:\\$Recycle.Bin',
    'C:\\System Volume Information',
    'C:\\Recovery',
    path.join(progData, 'Microsoft'),
    path.join(progData, 'Package Cache'),
    path.join(localApp, 'Temp'),
    path.join(localApp, 'Microsoft'),
    path.join(localApp, 'Packages'),
    path.join(localApp, 'Programs')
  ];

  const hiddenSystemNames = new Set(['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp']);

  return new Promise((resolve) => {
    const child = spawn(SCANNER_EXE, ['big-files'], { windowsHide: true });
    let stdout = '';
    const timer = setTimeout(() => {
      log.warn('cleaner:bigFiles', 'C盘大文件扫描达到 90s 超时保护上限，中止本次枚举');
      try { if (!child.killed) child.kill(); } catch (killErr) { log.warn('cleaner:bigFilesKill', killErr.message); }
      resolve([]);
    }, 90000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', () => {
      clearTimeout(timer);
      if (!stdout.trim()) return resolve([]);
      try {
        const parsed = JSON.parse(stdout.trim());
        const arr = Array.isArray(parsed.files) ? parsed.files : [];
        resolve(arr.filter((f) => !hiddenSystemNames.has(String(f.name || '').toLowerCase())));
      } catch (parseErr) {
        log.warn('cleaner:bigFilesParse', parseErr.message);
        resolve([]);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      log.warn('cleaner:bigFilesSpawn', err.message);
      resolve([]);
    });
    const lines = [`C:\\|${minMB}|${limit}`, ...excludes].join('\n') + '\n';
    child.stdin.write(lines, 'utf8');
    child.stdin.end();
  });
}

/* ==================== 国产聊天软件路径发现（严格隔离消息库） ==================== */

function discoverChatAppRoots() {
  const home = os.homedir();
  const docs = path.join(home, 'Documents');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const apps = [];

  // 1. 微信 3.x / 4.x
  const wechatRoots = new Set();
  const iniPath = path.join(roaming, 'Tencent', 'WeChat', 'All Users', 'config', '3ebffe94.ini');
  if (fs.existsSync(iniPath)) {
    try {
      const content = fs.readFileSync(iniPath, 'utf8').trim();
      if (content && content.toLowerCase() !== 'mydocument:') {
        const customRoot = path.join(content, 'WeChat Files');
        if (fs.existsSync(customRoot)) wechatRoots.add(customRoot);
        else if (fs.existsSync(content)) wechatRoots.add(content);
      }
    } catch (_) {}
  }
  const defWeChat3 = path.join(docs, 'WeChat Files');
  if (fs.existsSync(defWeChat3)) wechatRoots.add(defWeChat3);
  const defWeChat4 = path.join(docs, 'xwechat_files');
  if (fs.existsSync(defWeChat4)) wechatRoots.add(defWeChat4);

  for (const wr of wechatRoots) {
    const cacheDirs = [];
    const fileDirs = [];
    try {
      const subEntries = fs.readdirSync(wr, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink());
      for (const acc of subEntries) {
        const accPath = path.join(wr, acc.name);
        if (acc.name === 'All Users' || acc.name === 'Applet' || acc.name === 'WMPF') {
          if (acc.name === 'Applet' || acc.name === 'WMPF') cacheDirs.push(accPath);
          const subUpd = path.join(accPath, 'Update');
          if (fs.existsSync(subUpd)) cacheDirs.push(subUpd);
          continue;
        }
        // 各微信账号目录内部，严格只登记可安全清缓存与用户手动收发文件目录，绝不碰 Msg / db_storage
        for (const cName of ['Cache', 'Temp', 'Log', 'Thumb', 'SnsCache', 'Moments']) {
          const cp = path.join(accPath, 'FileStorage', cName);
          if (fs.existsSync(cp)) cacheDirs.push(cp);
          const cp2 = path.join(accPath, cName);
          if (fs.existsSync(cp2)) cacheDirs.push(cp2);
        }
        for (const fName of ['File', 'Video', 'Image']) {
          const fp = path.join(accPath, 'FileStorage', fName);
          if (fs.existsSync(fp)) fileDirs.push(fp);
        }
        const xTemp = path.join(accPath, 'temp');
        if (fs.existsSync(xTemp)) cacheDirs.push(xTemp);
      }
    } catch (_) {}

    const isV4 = wr.toLowerCase().includes('xwechat');
    apps.push({
      id: `wechat_${isV4 ? 'v4' : 'v3'}_${apps.length}`,
      app: isV4 ? '微信 4.x (xwechat)' : '微信 3.x (WeChat Files)',
      rootPath: wr,
      onCDrive: wr.toLowerCase().startsWith('c:\\'),
      protectedNote: '已隔离 Msg/ 与 db_storage/ 消息库',
      cacheDirs: [...new Set(cacheDirs)],
      fileDirs: [...new Set(fileDirs)]
    });
  }

  // 2. QQ / NTQQ
  const qqRoot = path.join(docs, 'Tencent Files');
  if (fs.existsSync(qqRoot)) {
    const cacheDirs = [];
    const fileDirs = [];
    try {
      const subEntries = fs.readdirSync(qqRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.isSymbolicLink());
      for (const acc of subEntries) {
        const accPath = path.join(qqRoot, acc.name);
        for (const cName of ['Image', 'VideoThumb', 'nt_temp', 'temp', 'Logs', 'Update']) {
          const cp = path.join(accPath, cName);
          if (fs.existsSync(cp)) cacheDirs.push(cp);
          const ntCache = path.join(accPath, 'nt_qq', 'nt_data', cName);
          if (fs.existsSync(ntCache)) cacheDirs.push(ntCache);
        }
        for (const fName of ['FileRecv', path.join('nt_qq', 'nt_data', 'File')]) {
          const fp = path.join(accPath, fName);
          if (fs.existsSync(fp)) fileDirs.push(fp);
        }
      }
    } catch (_) {}
    apps.push({
      id: 'qq_pc',
      app: 'QQ 电脑版 / NTQQ',
      rootPath: qqRoot,
      onCDrive: qqRoot.toLowerCase().startsWith('c:\\'),
      protectedNote: 'QQ 消息核心库 nt_db/ 与登录配置已隔离保护，绝不删除',
      cacheDirs: [...new Set(cacheDirs)],
      fileDirs: [...new Set(fileDirs)]
    });
  }

  // 3. 企业微信 / 钉钉
  const wxWork = path.join(docs, 'WXWork');
  if (fs.existsSync(wxWork)) {
    apps.push({
      id: 'wxwork',
      app: '企业微信',
      rootPath: wxWork,
      onCDrive: wxWork.toLowerCase().startsWith('c:\\'),
      protectedNote: '企业消息记录已隔离保护',
      cacheDirs: [path.join(wxWork, 'Log'), path.join(wxWork, 'Cache')].filter((p) => fs.existsSync(p)),
      fileDirs: []
    });
  }
  const ding = path.join(roaming, 'DingTalk');
  if (fs.existsSync(ding)) {
    apps.push({
      id: 'dingtalk',
      app: '钉钉客户端',
      rootPath: ding,
      onCDrive: ding.toLowerCase().startsWith('c:\\'),
      protectedNote: '钉钉聊天库已隔离保护',
      cacheDirs: [path.join(ding, 'cache'), path.join(ding, 'log')].filter((p) => fs.existsSync(p)),
      fileDirs: []
    });
  }

  return apps;
}

/* ==================== 安全文件删除器（软删除优先 + 白名单防穿透） ==================== */

async function deleteTargetSafely(targetPath, { minAgeHours = 0, useTrash = true, trashFn = null } = {}) {
  const blocked = isBlockedDeleteTarget(targetPath);
  if (blocked) {
    return { freedBytes: 0, deletedFiles: 0, skippedFiles: 1, blockedReason: blocked };
  }
  if (!fs.existsSync(targetPath)) {
    return { freedBytes: 0, deletedFiles: 0, skippedFiles: 0 };
  }

  // 防穿透：如果目标本身就是符号链接或 Junction，严禁递归进去删目标盘文件
  if (await migrator.checkReparsePointWin(targetPath)) {
    return { freedBytes: 0, deletedFiles: 0, skippedFiles: 1, blockedReason: '跳过符号链接/联接目录防穿透' };
  }

  const cutoff = minAgeHours > 0 ? Date.now() - minAgeHours * 3600 * 1000 : 0;
  let freedBytes = 0;
  let deletedFiles = 0;
  let skippedFiles = 0;

  const removeSingleFile = async (fp, size) => {
    const fileBlocked = isBlockedDeleteTarget(fp);
    if (fileBlocked) { skippedFiles++; return; }
    try {
      if (useTrash && typeof trashFn === 'function') {
        await trashFn(fp);
      } else {
        await fs.promises.unlink(fp);
      }
      freedBytes += size;
      deletedFiles++;
    } catch (_) {
      skippedFiles++;
    }
  };

  const st = await fs.promises.lstat(targetPath).catch(() => null);
  if (!st) return { freedBytes: 0, deletedFiles: 0, skippedFiles: 1 };

  if (st.isFile()) {
    if (!cutoff || st.mtimeMs <= cutoff) {
      await removeSingleFile(targetPath, st.size);
    }
    return { freedBytes, deletedFiles, skippedFiles };
  }

  // 如果整个目录无最小时间限制且要求进回收站（如单应用数据目录大文件），仍逐文件做边界检查后安全清理
  const stack = [targetPath];
  const dirsToPrune = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      skippedFiles++;
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        skippedFiles++;
        continue;
      }
      if (ent.isDirectory()) {
        const subBlock = isBlockedDeleteTarget(full);
        if (subBlock) { skippedFiles++; continue; }
        stack.push(full);
        dirsToPrune.push(full);
      } else if (ent.isFile()) {
        try {
          const fst = await fs.promises.lstat(full);
          if (!cutoff || fst.mtimeMs <= cutoff) {
            await removeSingleFile(full, fst.size);
          }
        } catch (_) {
          skippedFiles++;
        }
      }
    }
  }

  // 仅清理已经变空的非根目录文件夹
  for (let i = dirsToPrune.length - 1; i >= 0; i--) {
    try {
      const rest = await fs.promises.readdir(dirsToPrune[i]);
      if (rest.length === 0) await fs.promises.rmdir(dirsToPrune[i]);
    } catch (_) {}
  }

  return { freedBytes, deletedFiles, skippedFiles };
}

/* ==================== Cleaner 主服务类 ==================== */

class CleanerService {
  constructor(store, getTrashFn) {
    this.store = store;
    this.migrator = new migrator.Migrator(store);
    this.getTrashFn = getTrashFn;
    this.activeAbort = null;
    this.lastJunkScan = null;
  }

  cancelScan() {
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
      return { ok: true, message: '已中止当前扫描' };
    }
    return { ok: true };
  }

  async scanJunk(onProgress) {
    this.cancelScan();
    const ac = new AbortController();
    this.activeAbort = ac;

    const rules = collectJunkTargets();
    const dirTasks = [];
    const ruleTotals = new Map();

    for (const r of rules) {
      ruleTotals.set(r.id, {
        id: r.id,
        group: r.group,
        tier: r.tier,
        name: r.name,
        desc: r.desc,
        isRecycleBin: !!r.isRecycleBin,
        minAgeHours: r.minAgeHours || 0,
        paths: r.paths,
        bytes: 0,
        files: 0,
        skipped: 0,
        checkedDefault: r.tier === 'safe'
      });
      for (const p of r.paths) {
        if (fs.existsSync(p)) {
          dirTasks.push({ id: r.id, minAgeHours: r.minAgeHours || 0, path: p });
        }
      }
    }

    let accumBytes = 0;
    let doneCount = 0;
    const totalTasks = dirTasks.length + 1;

    // 1. 回收站快速查询
    const rb = await queryRecycleBin();
    const rbEntry = ruleTotals.get('recycle-bin');
    if (rbEntry) {
      rbEntry.bytes = rb.allBytes || 0;
      rbEntry.files = rb.allItems || 0;
      accumBytes += rbEntry.bytes;
    }
    doneCount++;
    if (onProgress) {
      onProgress({ phase: 'scanning', currentName: '系统回收站', done: doneCount, total: totalTasks, totalBytes: accumBytes });
    }

    // 2. C# 并发流式目录扫描
    const scanResults = await scanDirListWithScanner(dirTasks, {
      signal: ac.signal,
      onProgress: (item) => {
        const entry = ruleTotals.get(item.id);
        if (entry) {
          entry.bytes += item.bytes || 0;
          entry.files += item.files || 0;
          entry.skipped += item.skipped || 0;
          accumBytes += item.bytes || 0;
          doneCount++;
          if (onProgress) {
            onProgress({
              phase: 'scanning',
              currentName: entry.name,
              done: Math.min(doneCount, totalTasks),
              total: totalTasks,
              totalBytes: accumBytes
            });
          }
        }
      }
    });

    if (this.activeAbort === ac) this.activeAbort = null;

    const drives = await migrator.getFixedDrives();
    const cDrive = drives.find((d) => d.letter === 'C') || null;
    const items = [...ruleTotals.values()];
    const totalBytes = items.reduce((s, it) => s + it.bytes, 0);
    const safeBytes = items.filter((it) => it.tier === 'safe').reduce((s, it) => s + it.bytes, 0);

    const snapshot = {
      ok: true,
      aborted: ac.signal.aborted,
      scannedAt: Date.now(),
      cDrive,
      totalBytes,
      safeBytes,
      items,
      rawCount: scanResults.length
    };
    this.lastJunkScan = snapshot;
    if (onProgress) {
      onProgress({ phase: 'done', done: totalTasks, total: totalTasks, totalBytes });
    }
    return snapshot;
  }

  async cleanJunk(selectedIds = [], opts = {}) {
    const idSet = new Set(Array.isArray(selectedIds) ? selectedIds : []);
    if (!idSet.size) return { ok: false, message: '请先勾选要清理的项目' };

    const rules = collectJunkTargets().filter((r) => idSet.has(r.id));
    const trashFn = typeof this.getTrashFn === 'function' ? this.getTrashFn() : null;
    let totalFreed = 0;
    let totalFiles = 0;
    let totalSkipped = 0;
    const details = [];

    for (const rule of rules) {
      if (rule.isRecycleBin) {
        const before = await queryRecycleBin();
        const r = await runPs('Clear-RecycleBin -Force -ErrorAction SilentlyContinue; "OK"', 20000);
        const after = await queryRecycleBin();
        const delta = Math.max(0, (before.allBytes || 0) - (after.allBytes || 0));
        totalFreed += delta;
        totalFiles += Math.max(0, (before.allItems || 0) - (after.allItems || 0));
        details.push({ id: rule.id, name: rule.name, freedBytes: delta, skipped: r.code !== 0 ? 1 : 0 });
        continue;
      }

      let ruleFreed = 0;
      let ruleFiles = 0;
      let ruleSkipped = 0;
      const useTrash = opts.useTrash !== undefined ? Boolean(opts.useTrash) : (rule.tier === 'confirm');

      for (const p of rule.paths) {
        const res = await deleteTargetSafely(p, {
          minAgeHours: rule.minAgeHours || 0,
          useTrash,
          trashFn
        });
        ruleFreed += res.freedBytes;
        ruleFiles += res.deletedFiles;
        ruleSkipped += res.skippedFiles;
      }

      // 若系统临时目录或崩溃转储遇到权限跳过且允许提权，提示但不强制弹 UAC 骚扰
      totalFreed += ruleFreed;
      totalFiles += ruleFiles;
      totalSkipped += ruleSkipped;
      details.push({ id: rule.id, name: rule.name, freedBytes: ruleFreed, deletedFiles: ruleFiles, skipped: ruleSkipped });
    }

    const stats = this.store.get('cleanerStats') || { totalFreedBytes: 0, lastCleanedAt: 0 };
    stats.totalFreedBytes = (stats.totalFreedBytes || 0) + totalFreed;
    stats.lastCleanedAt = Date.now();
    this.store.set('cleanerStats', stats);

    return {
      ok: true,
      freedBytes: totalFreed,
      freedMB: Math.round((totalFreed / 1048576) * 10) / 10,
      deletedFiles: totalFiles,
      skippedFiles: totalSkipped,
      details,
      stats
    };
  }

  /**
   * 获取轻量级临时垃圾估算（供首页 / guardian 快速显示）
   */
  async quickTempSummary() {
    if (this.lastJunkScan && Date.now() - this.lastJunkScan.scannedAt < 120000) {
      return {
        totalBytes: this.lastJunkScan.totalBytes,
        safeBytes: this.lastJunkScan.safeBytes,
        cDrive: this.lastJunkScan.cDrive
      };
    }
    const tempEnv = process.env.TEMP || path.join(os.homedir(), 'AppData', 'Local', 'Temp');
    const [drives, dirStats] = await Promise.all([
      migrator.getFixedDrives(),
      scanDirListWithScanner([
        { id: 'user-temp', minAgeHours: 24, path: tempEnv },
        { id: 'sys-temp', minAgeHours: 24, path: 'C:\\Windows\\Temp' }
      ])
    ]);
    const totalBytes = dirStats.reduce((s, d) => s + (d.bytes || 0), 0);
    return {
      totalBytes,
      safeBytes: totalBytes,
      cDrive: drives.find((d) => d.letter === 'C') || null
    };
  }

  /* ==================== C 盘专清深度巡检 ==================== */

  async scanBigFiles(minMB = 100, limit = 80) {
    const rawFiles = await scanBigFilesC(minMB, limit);
    const files = rawFiles.map((f) => ({
      ...f,
      protectedReason: isBlockedDeleteTarget(f.path) || null
    }));
    return { ok: true, files };
  }

  async inspectCDrive(opts = {}) {
    const home = os.homedir();
    const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roamingApp = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localLow = path.join(home, 'AppData', 'LocalLow');
    const progData = process.env.ProgramData || 'C:\\ProgramData';
    const docs = path.join(home, 'Documents');

    const [drives, chatApps, topChildren, bigFiles] = await Promise.all([
      migrator.getFixedDrives(),
      Promise.resolve(discoverChatAppRoots()),
      scanTopChildren([
        { tag: 'AppData\\Local', path: localApp },
        { tag: 'AppData\\Roaming', path: roamingApp },
        { tag: 'AppData\\LocalLow', path: localLow },
        { tag: 'ProgramData', path: progData },
        { tag: '文档', path: docs }
      ], 25),
      opts.includeBigFiles ? scanBigFilesC(100, 80) : Promise.resolve([])
    ]);

    const cDrive = drives.find((d) => d.letter === 'C') || null;
    const targetDrives = drives.filter((d) => d.letter !== 'C' && String(d.format).toUpperCase() === 'NTFS');

    // 1. 系统大件体积精确探测
    const sysTasks = [
      { id: 'sys-wu', minAgeHours: 0, path: 'C:\\Windows\\SoftwareDistribution\\Download' },
      { id: 'sys-prefetch', minAgeHours: 720, path: 'C:\\Windows\\Prefetch' }
    ];
    if (fs.existsSync('C:\\Windows.old')) {
      sysTasks.push({ id: 'sys-winold', minAgeHours: 0, path: 'C:\\Windows.old' });
    }

    // 2. 聊天软件安全缓存 vs 接收文件体积探测
    const chatTasks = [];
    for (const app of chatApps) {
      for (const cd of app.cacheDirs) {
        chatTasks.push({ id: `chatcache::${app.id}`, minAgeHours: 0, path: cd });
      }
      for (const fd of app.fileDirs) {
        chatTasks.push({ id: `chatfile::${app.id}`, minAgeHours: 0, path: fd });
      }
    }

    const extraStats = await scanDirListWithScanner([...sysTasks, ...chatTasks]);
    const statsById = new Map();
    for (const s of extraStats) {
      const prev = statsById.get(s.id) || { bytes: 0, files: 0, samples: [] };
      prev.bytes += s.bytes || 0;
      prev.files += s.files || 0;
      statsById.set(s.id, prev);
    }

    // 休眠文件 hiberfil.sys 检查
    let hiberBytes = 0;
    try {
      if (fs.existsSync('C:\\hiberfil.sys')) {
        hiberBytes = fs.statSync('C:\\hiberfil.sys').size;
      }
    } catch (_) {}

    const wuStat = statsById.get('sys-wu') || { bytes: 0, files: 0 };
    const pfStat = statsById.get('sys-prefetch') || { bytes: 0, files: 0 };
    const winOldStat = statsById.get('sys-winold') || { bytes: 0, files: 0 };

    const systemItems = [
      {
        id: 'wu-download',
        name: 'Windows 更新下载缓存',
        path: 'C:\\Windows\\SoftwareDistribution\\Download',
        bytes: wuStat.bytes,
        files: wuStat.files,
        risk: 'safe',
        desc: '暂停更新服务后清理已完成下载的补丁安装包，不影响历史更新记录'
      },
      {
        id: 'hiberfil',
        name: '系统休眠文件 (hiberfil.sys)',
        path: 'C:\\hiberfil.sys',
        bytes: hiberBytes,
        files: hiberBytes > 0 ? 1 : 0,
        risk: 'caution',
        enabled: hiberBytes > 0,
        desc: hiberBytes > 0
          ? '用于系统“休眠”和“快速启动”；如常用台式机或只用睡眠，可精简或关闭释放数 GB 空间'
          : '当前已关闭休眠文件（未占用 C 盘空间）'
      },
      {
        id: 'winsxs',
        name: 'WinSxS 组件存储清理 (DISM)',
        path: 'C:\\Windows\\WinSxS',
        bytes: 0,
        indeterminate: true,
        risk: 'caution',
        desc: '调用微软官方 Dism /StartComponentCleanup 安全压缩被新补丁取代的旧版本系统组件'
      },
      {
        id: 'prefetch-old',
        name: '超 30 天老旧预读文件',
        path: 'C:\\Windows\\Prefetch',
        bytes: pfStat.bytes,
        files: pfStat.files,
        risk: 'safe',
        desc: '清理长期未启动程序的旧预读缓存，系统后续会自动重建常用项'
      }
    ];

    if (fs.existsSync('C:\\Windows.old')) {
      systemItems.push({
        id: 'windows-old',
        name: '旧版 Windows 系统备份 (Windows.old)',
        path: 'C:\\Windows.old',
        bytes: winOldStat.bytes,
        files: winOldStat.files,
        risk: 'danger',
        desc: '系统升级遗留的旧版回退文件；清理后将无法回滚至上一版本 Windows'
      });
    }

    // 整理聊天软件结果 + 附带文件目录内的大文件预览
    const chatResults = [];
    for (const app of chatApps) {
      const cStat = statsById.get(`chatcache::${app.id}`) || { bytes: 0, files: 0 };
      const fStat = statsById.get(`chatfile::${app.id}`) || { bytes: 0, files: 0 };
      // 采集前 20 个 > 10MB 的收发文件供用户按需勾选
      const largeRecvFiles = [];
      for (const fd of app.fileDirs) {
        if (!fs.existsSync(fd)) continue;
        const collectLarge = (d, depth = 0) => {
          if (depth > 4 || largeRecvFiles.length >= 40) return;
          let ents;
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
          for (const ent of ents) {
            if (ent.isSymbolicLink()) continue;
            const full = path.join(d, ent.name);
            if (ent.isDirectory()) collectLarge(full, depth + 1);
            else if (ent.isFile()) {
              try {
                const fst = fs.statSync(full);
                if (fst.size >= 10 * 1048576) {
                  largeRecvFiles.push({
                    path: full,
                    name: ent.name,
                    bytes: fst.size,
                    mtimeMs: fst.mtimeMs
                  });
                }
              } catch (_) {}
            }
          }
        };
        collectLarge(fd);
      }
      largeRecvFiles.sort((a, b) => b.bytes - a.bytes);

      chatResults.push({
        ...app,
        cacheBytes: cStat.bytes,
        cacheFiles: cStat.files,
        fileBytes: fStat.bytes,
        fileCount: fStat.files,
        largeRecvFiles: largeRecvFiles.slice(0, 20)
      });
    }

    // AppData Top 25 带中文身份、迁移状态标注
    const movedList = this.migrator.listMoved();
    const movedBySrc = new Map(movedList.map((m) => [normalizeLower(m.srcPath), m]));
    const appDataFolders = topChildren
      .filter((c) => c.bytes > 20 * 1048576 || c.isReparsePoint)
      .map((c) => {
        const meta = identifyAppFolder(c.name, c.path);
        const moved = movedBySrc.get(normalizeLower(c.path)) || null;
        const blockedReason = migrator.isProtectedMigrationPath(c.path);
        return {
          ...c,
          label: meta.label,
          kind: moved ? 'moved' : meta.kind,
          canMigrate: !blockedReason && !c.isReparsePoint && meta.kind !== 'system' && targetDrives.length > 0,
          canCleanCache: meta.kind === 'cache' && !isBlockedDeleteTarget(c.path) && !c.isReparsePoint,
          movedRecord: moved
        };
      });

    const reclaimableEstimate =
      systemItems.filter((s) => s.risk === 'safe').reduce((a, b) => a + b.bytes, 0) +
      chatResults.reduce((a, b) => a + b.cacheBytes, 0);

    return {
      ok: true,
      cDrive,
      targetDrives,
      reclaimableEstimate,
      systemItems,
      chatApps: chatResults,
      appDataFolders,
      movedDirs: movedList,
      bigFiles
    };
  }

  async executeCDriveAction(actionId, payload = {}) {
    const trashFn = typeof this.getTrashFn === 'function' ? this.getTrashFn() : null;

    if (actionId === 'wu-download') {
      const ps = `
        $wasRunning = (Get-Service wuauserv -ErrorAction SilentlyContinue).Status -eq 'Running'
        if ($wasRunning) { Stop-Service wuauserv -Force -ErrorAction SilentlyContinue }
        $dl = 'C:\\Windows\\SoftwareDistribution\\Download'
        $before = (Get-ChildItem $dl -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        Get-ChildItem $dl -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        $after = (Get-ChildItem $dl -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
        if ($wasRunning) { Start-Service wuauserv -ErrorAction SilentlyContinue }
        [PSCustomObject]@{ freed = [math]::Max(0, [int64]$before - [int64]$after) } | ConvertTo-Json -Compress
      `;
      const r = await runPs(ps, 45000, true);
      return { ok: r.code === 0, message: r.code === 0 ? 'Windows 更新下载缓存已安全清理' : `清理失败（可能需要取消了 UAC 提权）：${r.stderr || r.error || ''}` };
    }

    if (actionId === 'winsxs-clean') {
      const r = await runPs('dism.exe /Online /Cleanup-Image /StartComponentCleanup; exit $LASTEXITCODE', 300000, true);
      return { ok: r.code === 0, message: r.code === 0 ? 'WinSxS 组件清理完成，旧系统更新残留已压缩' : 'DISM 清理未完成或用户取消了管理员授权' };
    }

    if (actionId === 'hiberfil-off') {
      const r = await runPs('powercfg.exe -h off; exit $LASTEXITCODE', 15000, true);
      return { ok: r.code === 0, message: r.code === 0 ? '已关闭系统休眠并释放 hiberfil.sys 空间' : '设置失败（需要管理员权限）' };
    }

    if (actionId === 'hiberfil-reduced') {
      const r = await runPs('powercfg.exe /h /type reduced; exit $LASTEXITCODE', 15000, true);
      return { ok: r.code === 0, message: r.code === 0 ? '已将休眠文件精简为仅支持快速启动（体积减半）' : '设置失败（需要管理员权限）' };
    }

    if (actionId === 'hiberfil-on') {
      const r = await runPs('powercfg.exe -h on; exit $LASTEXITCODE', 15000, true);
      return { ok: r.code === 0, message: r.code === 0 ? '已重新开启系统休眠' : '设置失败（需要管理员权限）' };
    }

    if (actionId === 'prefetch-old') {
      const res = await deleteTargetSafely('C:\\Windows\\Prefetch', { minAgeHours: 720, useTrash: false });
      return { ok: true, freedBytes: res.freedBytes, message: `已清理老旧预读文件 ${res.deletedFiles} 个` };
    }

    if (actionId === 'windows-old') {
      const ps = 'cmd.exe /c "takeown /F C:\\Windows.old /R /D Y >nul 2>&1 & icacls C:\\Windows.old /grant administrators:F /T /Q >nul 2>&1 & rmdir /S /Q C:\\Windows.old"';
      const r = await runPs(ps, 180000, true);
      return { ok: r.code === 0 && !fs.existsSync('C:\\Windows.old'), message: !fs.existsSync('C:\\Windows.old') ? '已彻底移除 C:\\Windows.old' : '移除未完成或用户取消提权' };
    }

    if (actionId === 'chat-clean-cache') {
      const dirs = Array.isArray(payload.cacheDirs) ? payload.cacheDirs : [];
      let freed = 0;
      let deleted = 0;
      for (const d of dirs) {
        const res = await deleteTargetSafely(d, { minAgeHours: 0, useTrash: false });
        freed += res.freedBytes;
        deleted += res.deletedFiles;
      }
      return { ok: true, freedBytes: freed, message: `已清理缓存 ${deleted} 项，释放 ${(freed / 1048576).toFixed(1)} MB（聊天库已全量隔离保护）` };
    }

    if (actionId === 'trash-files') {
      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      let freed = 0;
      let count = 0;
      let skipped = 0;
      for (const p of paths) {
        const blocked = isBlockedDeleteTarget(p);
        if (blocked || !fs.existsSync(p)) { skipped++; continue; }
        let size = 0;
        try { size = fs.statSync(p).size; } catch (_) {}
        const res = await deleteTargetSafely(p, { useTrash: true, trashFn });
        if (res.deletedFiles > 0) {
          freed += res.freedBytes || size;
          count++;
        } else {
          skipped++;
        }
      }
      return {
        ok: count > 0 || skipped === 0,
        freedBytes: freed,
        deletedFiles: count,
        skippedFiles: skipped,
        message: `已将 ${count} 个文件移入回收站（约 ${(freed / 1048576).toFixed(1)} MB）${skipped > 0 ? `，跳过 ${skipped} 个受保护或占用文件` : ''}`
      };
    }

    if (actionId === 'clean-appdata-cache') {
      const target = payload.path;
      const blocked = isBlockedDeleteTarget(target);
      if (blocked) return { ok: false, message: blocked };
      const res = await deleteTargetSafely(target, { useTrash: true, trashFn });
      return {
        ok: true,
        freedBytes: res.freedBytes,
        message: `已将缓存移入回收站，释放 ${(res.freedBytes / 1048576).toFixed(1)} MB`
      };
    }

    return { ok: false, message: `未知 C 盘清理动作：${actionId}` };
  }
}

module.exports = {
  CleanerService,
  isBlockedDeleteTarget,
  deleteTargetSafely,
  discoverChatAppRoots,
  queryRecycleBin,
  identifyAppFolder
};
