'use strict';

/**
 * QuickKeys 执行器：所有系统级操作的唯一出口。
 * 固定动作来自 actions.js，自定义动作来自配置；渲染进程只拿到元数据，拿不到 run 细节。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { shell, BrowserWindow } = require('electron');
const { CATEGORIES, ACTIONS, CUSTOM_ADD } = require('./actions');
const log = require('./logger');
const mgga = require('./mgga');
const guardian = require('./guardian');

const SLEEP_TASK_NAME = 'QuickKeys_Sleep';
const DEFAULT_TIMEOUT = 20000;

function getSanitizedWinEnv(extraEnv = {}) {
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const sysDrive = process.env.SystemDrive || process.env.SYSTEMDRIVE || (sysRoot.slice(0, 2) || 'C:');
  return {
    SystemDrive: sysDrive,
    SystemRoot: sysRoot,
    ComSpec: process.env.ComSpec || process.env.COMSPEC || path.join(sysRoot, 'system32', 'cmd.exe'),
    COMPUTERNAME: process.env.COMPUTERNAME || 'LOCALHOST',
    ALLUSERSPROFILE: process.env.ALLUSERSPROFILE || process.env.PROGRAMDATA || 'C:\\ProgramData',
    PUBLIC: process.env.PUBLIC || 'C:\\Users\\Public',
    ...process.env,
    ...extraEnv
  };
}

function promiseExecFile(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const env = getSanitizedWinEnv(options.env);
    const child = execFile(cmd, args, {
      windowsHide: true,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      maxBuffer: 12 * 1024 * 1024,
      encoding: 'utf8',
      ...options,
      env
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code || 1) : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error: err ? err.message : null
      });
    });
    if (options.detached) child.unref();
  });
}

// cmd /c start "" <command>：用于 .msc/.cpl、shell: 协议、带文件关联的程序
// 关键：用 exec 而不是 spawn，让 cmd 自己解析整个命令行字符串，避免 Node 拼参数时引号转义出错。
// fire-and-forget：启动后立即返回，不等待子进程。
function shellStart(command) {
  const { exec } = require('child_process');
  const child = exec(`start "" ${command}`, {
    windowsHide: true,
    detached: true
  }, (error) => {
    if (error) log.warn('executor', `shellStart 错误: ${command} -> ${error.message}`);
  });
  child.unref();
  log.info('executor', `shellStart: ${command}`);
  return Promise.resolve({ code: 0, stdout: '', stderr: '', error: null });
}

// 捕获 cmd 输出，统一先 chcp 65001 解决中文乱码
function cmdOutput(command, timeout) {
  return promiseExecFile('cmd.exe', ['/c', `chcp 65001>nul & ${command}`], { timeout: timeout || DEFAULT_TIMEOUT });
}

function psRun(script, timeout) {
  const wrapped = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
  return promiseExecFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
    { timeout: timeout || DEFAULT_TIMEOUT });
}

// 提权并在可见窗口中运行（-Verb RunAs 会弹 UAC）
function elevatedVisible(argumentListForCmd) {
  const arg = argumentListForCmd.replace(/'/g, "''");
  return promiseExecFile('powershell.exe',
    ['-NoProfile', '-Command', `Start-Process cmd.exe -ArgumentList '/k ${arg}' -Verb RunAs`],
    { windowsHide: false });
}

function sanitizeToken(s) {
  return String(s).replace(/["&|<>%^`$\\]/g, '').trim();
}

/**
 * 稳健的文件存在性判断。
 * WindowsApps 下的 AppExecutionAlias（如 wt.exe）是重解析点，
 * fs.statSync / fs.existsSync 会因 EACCES 返回 false，但 lstat 可用。
 */
function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (_) {
    try { return fs.existsSync(p); } catch (_) { return false; }
  }
}

/**
 * 危险命令识别规则：用户自定义命令 / 「执行任意命令」在真正执行前，
 * 命中任一规则即要求二次确认（yes / no），避免误执行造成不可逆后果。
 * 规则同时下发给渲染层（getInitData.dangerRules），保证前后端判断一致。
 */
const DANGEROUS_COMMAND_RULES = [
  { label: '关机 / 重启系统', re: /\b(shutdown|Stop-Computer|Restart-Computer)\b/i },
  { label: '注销当前用户', re: /\blogoff\b/i },
  { label: '删除文件 / 目录', re: /\b(del|erase|rd|rmdir|rm|Remove-Item|Remove-ItemProperty|Clear-Content|unlink)\b/i },
  { label: '格式化 / 磁盘分区', re: /\bformat\s+[a-z]:|\b(format-volume|diskpart|clear-disk|initialize-disk|remove-partition|new-partition)\b/i },
  { label: '结束进程', re: /\b(taskkill|Stop-Process)\b/i },
  { label: '注册表 / 服务 / 账户修改', re: /\breg\s+(delete|import|restore|load)\b|\bsc\s+delete\b|\bnet\s+(user|localgroup)\b[^&|]*\/delete\b/i },
  { label: '引导 / 备份 / 还原点操作', re: /\b(bcdedit|bootrec|vssadmin|wbadmin)\b/i },
  { label: '重置网络协议栈', re: /\bnetsh\b[^&|]*\breset\b/i },
  { label: '擦除磁盘空闲空间', re: /\bcipher\b[^&|]*\/w\b/i }
];

class Executor {
  constructor({ store, scriptsDir }) {
    this.store = store;
    this.scriptsDir = scriptsDir;
    this.terminals = { wt: false, powershell: true, cmd: true };
    this.detectTerminals();
  }

  /* ----------------------------- 初始化数据 ----------------------------- */

  commandExists(command) {
    const pathEntries = (process.env.PATH || '').split(path.delimiter);
    const pathExt = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM;.MSC;.CPL').split(';');
    const hasExtension = path.extname(command) !== '';
    return pathEntries.some((entry) => {
      if (!entry) return false;
      if (hasExtension) return pathExists(path.join(entry, command));
      return pathExt.some((extension) => pathExists(path.join(entry, command + extension.toLowerCase())) || pathExists(path.join(entry, command + extension.toUpperCase())));
    });
  }

  detectTerminals() {
    const wtPath = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
    this.wtPath = pathExists(wtPath) ? wtPath : null;
    this.terminals = {
      wt: Boolean(this.wtPath),
      powershell: true,
      cmd: true
    };
    return this.terminals;
  }

  // 返回命中的危险操作标签（空数组 = 安全）
  isDangerousCommand(command) {
    const text = String(command || '');
    if (!text.trim()) return [];
    const labels = [];
    for (const rule of DANGEROUS_COMMAND_RULES) {
      rule.re.lastIndex = 0;
      if (rule.re.test(text) && !labels.includes(rule.label)) labels.push(rule.label);
    }
    return labels;
  }

  customActions() {
    return this.store.get('customActions').map((c) => ({
      id: c.id, cat: 'custom', icon: c.icon || 'terminal', name: c.name,
      desc: c.desc || c.command,
      keywords: c.keywords || [c.name, c.command],
      custom: true,
      runMode: c.mode || 'hidden',
      command: c.command,
      run: { type: 'special', name: 'run-command', command: c.command, mode: c.mode || 'hidden' }
    }));
  }

  allActions() {
    return [...ACTIONS, ...this.customActions(), CUSTOM_ADD];
  }

  findAction(id) {
    return this.allActions().find((a) => a.id === id);
  }

  static buildActionCli(a, params = null) {
    if (!a) return '';
    if (a.cli) return a.cli;
    const r = a.run;
    if (!r) return '';
    if (r.type === 'spawn') {
      const cmd = String(r.cmd || '').replace(/\.exe$/i, '');
      const args = Array.isArray(r.args) ? r.args.join(' ') : '';
      return `${cmd}${args ? ` ${args}` : ''}`.trim();
    }
    if (r.type === 'shell' && r.command && !/\r|\n/.test(r.command) && r.command.length <= 64) {
      return r.command.trim();
    }
    if (r.type === 'special') {
      if (r.name === 'set-timer') {
        const mode = (params && params.mode) || a.ui?.mode || 'shutdown';
        const sec = params && Number.isFinite(Number(params.seconds)) ? Math.floor(Number(params.seconds)) : null;
        if (mode === 'sleep') return sec ? `schtasks (sleep ${sec}s)` : 'schtasks /create';
        const flag = mode === 'restart' ? '/r' : '/s';
        return sec ? `shutdown ${flag} /t ${sec}` : `shutdown ${flag} /t <sec>`;
      }
      if (r.name === 'cancel-shutdown') return 'shutdown /a';
      if (r.name === 'cancel-sleep') return 'schtasks /delete';
      if (r.name === 'monitor-off') return 'SendMessage (WM_SYSCOMMAND)';
      if (r.name === 'restart-explorer') return 'taskkill /f /im explorer.exe';
      if (r.name === 'flush-dns') return 'ipconfig /flushdns';
      if (r.name === 'wifi-password') return params?.ssid ? `netsh wlan show profile "${params.ssid}"` : 'netsh wlan show profile';
      if (r.name === 'port-check' && params?.port) return `netstat -ano | findstr :${params.port}`;
      if (r.name === 'ping' && params?.host) return `ping ${params.host}`;
      if (r.name === 'run-command' && params?.command && !/\r|\n/.test(params.command)) {
        return String(params.command).trim().slice(0, 64);
      }
    }
    return '';
  }

  // 下发给渲染进程：剥离 run 字段，附加只读 CLI 展示胶囊提示
  static presentAction(a) {
    const { run, ...meta } = a;
    const cliHint = Executor.buildActionCli(a);
    return cliHint ? { ...meta, cliHint } : meta;
  }

  windowsVersionName() {
    const release = os.release();
    const m = release.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (m) {
      const build = Number(m[3]);
      if (Number(m[1]) >= 10 && build >= 22000) return `Windows 11（内部版本 ${build}）`;
      if (Number(m[1]) >= 10) return `Windows 10（内部版本 ${build}）`;
    }
    return `Windows ${release}`;
  }

  getInitData() {
    return {
      categories: CATEGORIES,
      actions: this.allActions().map(Executor.presentAction),
      config: this.store.get(),
      terminals: this.terminals,
      // 危险命令规则下发给渲染层，供「执行任意命令」等入口做执行前确认
      dangerRules: DANGEROUS_COMMAND_RULES.map((r) => ({ label: r.label, source: r.re.source, flags: r.re.flags })),
      system: {
        platform: process.platform,
        osName: this.windowsVersionName(),
        hostname: os.hostname(),
        user: os.userInfo().username,
        arch: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        appVersion: require('../../package.json').version
      }
    };
  }

  /* ------------------------------- 执行入口 ------------------------------ */

  async execute(id, params = {}) {
    const action = this.findAction(id);
    if (!action) return { ok: false, message: `未找到动作：${id}` };
    if (!action.run) return { ok: true, view: action.ui && action.ui.kind === 'custom-add' ? 'custom-add' : undefined };

    // 应用内视图
    if (action.run.type === 'view') {
      return { ok: true, view: action.run.name };
    }

    const run = action.run;
    let result;
    try {
      switch (run.type) {
        case 'spawn':
          result = await this.runSpawn(run, params);
          break;
        case 'shell': {
          const executable = run.command.trim().match(/^"?([^"\s]+\.(?:exe|msc|cpl))\b/i)?.[1];
          if (executable && !/[\\/]/.test(executable) && !this.commandExists(executable)) {
            result = { ok: false, message: `当前系统未安装或找不到 ${executable}` };
            break;
          }
          const shellResult = await shellStart(run.command);
          result = shellResult.code === 0
            ? { ok: true }
            : { ok: false, message: shellResult.stderr.trim() || shellResult.error || `无法启动：${run.command}` };
          break;
        }
        case 'uri': {
          const error = await shell.openExternal(run.uri);
          result = error ? { ok: false, message: error } : { ok: true };
          break;
        }
        case 'ps':
          result = await this.runPs(run);
          break;
        case 'output':
          result = await this.runOutput(run);
          break;
        case 'hotkey':
          result = await this.runHotkey(run.keys);
          break;
        case 'special':
          result = await this.runSpecial(run, params, action);
          break;
        default:
          result = { ok: false, message: `未知执行类型：${run.type}` };
      }
    } catch (e) {
      log.error('executor', `动作 ${id} 异常: ${e.stack || e.message}`);
      result = { ok: false, message: e.message, detail: e.stack || '' };
    }

    if (result && result.ok !== false) {
      const cli = Executor.buildActionCli(action, params);
      this.store.trackRun(id, cli);
      result.ok = true;
      result.recents = this.store.get().recents;
    }
    return result || { ok: true };
  }

  async runSpawn(run) {
    const opts = { windowsHide: true, detached: true, stdio: 'ignore' };
    if (run.elevated) {
      const args = (run.args || []).map((a) => `"${a}"`).join(' ');
      await promiseExecFile('powershell.exe',
        ['-NoProfile', '-Command', `Start-Process -FilePath '${run.cmd}' ${args ? `-ArgumentList '${args.replace(/'/g, "''")}'` : ''} -Verb RunAs`],
        { windowsHide: false });
      log.info('executor', `提权启动: ${run.cmd} ${(run.args || []).join(' ')}`);
      return { ok: true };
    }
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(run.cmd, run.args || [], opts);
      } catch (e) {
        resolve({ ok: false, message: `无法启动 ${run.cmd}: ${e.message}`, detail: e.stack });
        return;
      }
      let settled = false;
      child.once('spawn', () => {
        settled = true;
        child.unref();
        log.info('executor', `启动: ${run.cmd} ${(run.args || []).join(' ')}`);
        resolve({ ok: true });
      });
      child.once('error', (error) => {
        if (!settled) {
          log.error('executor', `启动失败 ${run.cmd}: ${error.message}`);
          resolve({ ok: false, message: `无法启动 ${run.cmd}: ${error.message}`, detail: error.stack });
        }
      });
    });
  }

  async runPs(run) {
    const r = run.scriptFile
      ? await promiseExecFile('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.scriptsDir, run.scriptFile)],
          { windowsHide: true, timeout: run.timeout || 60000 })
      : await psRun(run.script, run.timeout);
    if (r.code !== 0 && !r.stdout.trim()) {
      const msg = r.stderr.trim() || r.error || 'PowerShell 执行失败';
      log.warn('executor', `PowerShell 失败 (code=${r.code}): ${msg.slice(0, 200)}`);
      return { ok: false, message: msg, detail: `退出码 ${r.code}\nstderr: ${r.stderr}` };
    }
    return { ok: true, output: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || '执行完成。' };
  }

  async runOutput(run) {
    const r = await cmdOutput(run.command, run.timeout);
    if (r.code !== 0 && !r.stdout.trim()) {
      const msg = r.stderr.trim() || r.error || '命令执行失败';
      log.warn('executor', `命令失败 (code=${r.code}): ${run.command} -> ${msg.slice(0, 200)}`);
      return { ok: false, message: msg, detail: `退出码 ${r.code}\n命令: ${run.command}\nstderr: ${r.stderr}` };
    }
    return { ok: true, output: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || '命令没有输出。' };
  }

  async runHotkey(keys) {
    const exePath = path.join(this.scriptsDir, 'quickkeys-hotkey.exe');
    const binExe = path.join(__dirname, '..', 'bin', 'quickkeys-hotkey.exe');
    const targetExe = fs.existsSync(exePath) ? exePath : (fs.existsSync(binExe) ? binExe : null);

    if (targetExe) {
      const r = await promiseExecFile(targetExe, [keys.join(',')], { timeout: 5000 });
      if (r.code === 0) return { ok: true };
      log.warn('executor', `quickkeys-hotkey.exe 执行失败 (code=${r.code}): ${r.stderr || r.error}`);
    }

    // 备用降级方案：PowerShell
    const script = path.join(this.scriptsDir, 'hotkey.ps1');
    const r = await promiseExecFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Keys', keys.join(',')],
      { windowsHide: true, timeout: 15000 });
    if (r.code !== 0) return { ok: false, message: r.stderr.trim() || '热键发送失败' };
    return { ok: true };
  }

  /* ------------------------------ 特殊动作 ------------------------------- */

  async runSpecial(run, params, action) {
    switch (run.name) {
      case 'antigravity-hot-update':
        return mgga.runHotUpdate();
      case 'set-timer':
        return this.setTimer(params.mode || action.ui?.mode, Number(params.seconds));
      case 'cancel-shutdown':
        return this.cancelShutdown();
      case 'cancel-sleep':
        return this.cancelSleep();
      case 'monitor-off': {
        await promiseExecFile('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.scriptsDir, 'monitor-off.ps1')],
          { windowsHide: true, detached: true });
        return { ok: true, message: '显示器已关闭，移动鼠标或按任意键唤醒' };
      }
      case 'open-terminal':
        return this.openTerminal(params.which);
      case 'run-command':
        return this.runUserCommand(run.command || params.command, run.mode || params.mode, params.confirmed === true);
      case 'ping':
        return this.ping(params.host);
      case 'port-check':
        return this.portCheck(params.port);
      case 'wifi-password':
        return this.wifiPassword(params.ssid);
      case 'snip-region':
        return this.snipRegion();
      case 'open-screenshots':
        return this.openScreenshots();
      case 'clean-temp':
        return this.cleanTemp();
      case 'restart-explorer':
        return this.restartExplorer();
      case 'gaming-boost-now': {
        const gaming = require('./gaming');
        return gaming.runInstantBoost();
      }
      case 'pure-native-context-menu':
        return guardian.restorePureNativeContextMenu();
      case 'sfc':
        await elevatedVisible('sfc /scannow');
        return { ok: true, message: '已在管理员命令行中启动系统文件扫描，请按 UAC 提示确认' };
      case 'dism':
        await elevatedVisible('DISM /Online /Cleanup-Image /RestoreHealth');
        return { ok: true, message: '已在管理员命令行中启动系统映像修复，请按 UAC 提示确认' };
      case 'edit-hosts': {
        const hosts = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
        await promiseExecFile('powershell.exe',
          ['-NoProfile', '-Command', `Start-Process notepad.exe -ArgumentList '${hosts}' -Verb RunAs`],
          { windowsHide: false });
        return { ok: true, message: '已请求管理员权限打开 hosts 文件' };
      }
      case 'defender-scan':
        return this.defenderScan();
      case 'battery-report':
        return this.batteryReport();
      case 'file-hash':
        return this.calculateFileHash(params.file);
      case 'images-to-pdf':
        return this.imagesToPdf(params.images, params.savePath);
      case 'word-to-pdf':
        return this.wordToPdf(params.file, params.savePath);
      case 'text-to-pdf':
        return this.textToPdf(params.file, params.savePath);
      case 'json-tool':
        return this.processJson(params.text, params.mode);
      case 'base64-tool':
        return this.processBase64(params.text, params.mode);
      case 'fix-icon-cache':
        return this.fixIconCache();
      case 'repair-network':
        return this.repairNetwork();
      default:
        return { ok: false, message: `未实现的特殊动作：${run.name}` };
    }
  }

  /* ------------------------------ 定时任务 ------------------------------- */

  async setTimer(mode, seconds) {
    if (!['shutdown', 'restart', 'sleep'].includes(mode)) {
      return { ok: false, message: '未知的定时模式' };
    }
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 315360000) {
      return { ok: false, message: '时间需在 1 秒 ~ 10 年之间' };
    }
    seconds = Math.floor(seconds);

    if (mode === 'sleep') {
      const r = await psRun(
        `$a = New-ScheduledTaskAction -Execute 'rundll32.exe' -Argument 'powrprof.dll,SetSuspendState 0,1,0';` +
        `$t = New-ScheduledTaskTrigger -Once -At ([datetime]::Now.AddSeconds(${seconds}));` +
        `Register-ScheduledTask -TaskName '${SLEEP_TASK_NAME}' -Action $a -Trigger $t -Force | Out-Null; 'OK'`,
        20000);
      if (!r.stdout.includes('OK')) {
        return { ok: false, message: r.stderr.trim() || '睡眠计划创建失败' };
      }
    } else {
      // ===== FIX 1: shutdown.exe 「设置 → 探测 → 重试」 三段式保证 =====
      // 历史坑：electron 子进程 + windowsHide:true 时，某些 Windows 11 构建版本中
      // shutdown.exe 虽返回 code=0，但系统级倒计时 / Toast 实际未登记。
      // 解决：设置后立刻用 shutdown.exe /a 的返回码做一次"活性探测"，
      //       能被取消（code=0）= 真的挂上了；否则最多重试 2 次，并附 /c 注释让 Toast 强制可见。
      const flag = mode === 'shutdown' ? '/s' : '/r';
      const label = mode === 'shutdown' ? '关机' : '重启';
      const comment = `QuickKeys 定时${label}：${seconds} 秒后执行（点击\"取消计划关机\"可取消）`;
      const MAX_TRY = 3;
      let lastErr = null;
      let armed = false;

      for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
        // 先确保没有旧的倒计时，避免"已有计划中"被静默跳过
        await promiseExecFile('shutdown.exe', ['/a'], { windowsHide: true }).catch(() => {});

        const r = await promiseExecFile('shutdown.exe',
          [flag, '/t', String(seconds), '/c', comment],
          { windowsHide: true });
        if (r.code !== 0) {
          lastErr = (r.stderr || r.error || `设置失败 (退出码 ${r.code})`).trim();
          continue;
        }

        // 活性探测：调用 /a，返回 0 代表刚才的计划真的存在
        const probe = await promiseExecFile('shutdown.exe', ['/a'], { windowsHide: true });
        if (probe.code === 0) {
          // 探测用的 /a 把我们刚挂的取消了 → 立刻再挂一次（原样参数）
          const r2 = await promiseExecFile('shutdown.exe',
            [flag, '/t', String(seconds), '/c', comment],
            { windowsHide: true });
          if (r2.code === 0) {
            armed = true;
            break;
          }
          lastErr = (r2.stderr || r2.error || '重挂失败').trim();
        } else {
          lastErr = `探测失败：设置命令返回成功，但系统未登记倒计时（/a 退出码=${probe.code}）`;
        }
      }

      if (!armed) {
        return {
          ok: false,
          message: `连续 ${MAX_TRY} 次尝试后仍未设置成功：${lastErr || '未知原因'}。请尝试手动打开命令行执行或改用\"立即${label}\"。`,
          detail: lastErr || ''
        };
      }
    }

    const timers = this.store.get('timers');
    timers[mode] = { at: Date.now() + seconds * 1000, seconds };
    this.store.set('timers', timers);
    return { ok: true, message: `已设定${mode === 'shutdown' ? '关机' : mode === 'restart' ? '重启' : '睡眠'}倒计时`, timers };
  }

  async cancelShutdown() {
    // FIX 2 (a): 取消时也做一次「活性探测」，即使没有挂也不报错，但告诉 UI 真实情况
    const r = await promiseExecFile('shutdown.exe', ['/a'], { windowsHide: true });
    const timers = this.store.get('timers');
    timers.shutdown = null;
    timers.restart = null;
    this.store.set('timers', timers);
    // code=0 → 真的存在一个计划且被取消了；code=1116 → 本来就没有
    const actuallyCancelled = r.code === 0;
    return {
      ok: true,
      message: actuallyCancelled
        ? '已取消计划关机 / 重启'
        : '当前没有进行中的关机或重启倒计时（无需取消）',
      actuallyCancelled,
      timers
    };
  }

  async cancelSleep() {
    const r = await psRun(`Unregister-ScheduledTask -TaskName '${SLEEP_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue; 'OK'`);
    const timers = this.store.get('timers');
    timers.sleep = null;
    this.store.set('timers', timers);
    return { ok: true, message: '已取消定时睡眠', timers };
  }

  /**
   * FIX 2 (b) + FIX 4: 真·探测系统中「当前是否有 active 的关机/重启倒计时」。
   * 之前 reconcileTimers 只看 store 里记的 at 时间——但如果用户用其它程序挂了倒计时、
   * 或者 store 中写入后系统实际没挂上，UI 就会和真实状态不一致。
   * 
   * 方法：用一次 shutdown.exe /a 探测：
   *   code=0   → 系统里真的挂着一个倒计时（被这次探测取消了）
   *   code=1116 → 系统里本来就没有倒计时
   * 如果探测发现有一个，我们立刻按原秒数（或根据 /a 的事件日志反推）重挂并记到 store。
   * 
   * 为了避免"探测=取消"对用户造成副作用，这个方法有一个 sideEffectSafe 参数：
   *   sideEffectSafe=false（默认，只在"取消计划关机"按钮 UI 交互时不用）
   *     → 如果探测发现有倒计时，会自动原样重挂；如果重挂失败，至少清 store。
   *   sideEffectSafe=true（在取消逻辑里用）→ 不做重挂（因为用户就是想取消）。
   */
  async _probeActiveShutdownTimer(sideEffectSafe = false, hint = null) {
    const probe = await promiseExecFile('shutdown.exe', ['/a'], { windowsHide: true });
    if (probe.code !== 0) return null; // 系统里没有任何倒计时（code 1116）

    // 探测 /a 已经把真实倒计时取消了
    if (sideEffectSafe) {
      return { cancelled: true };
    }

    // 没有 store 里的计划作依据时，不要凭空重挂（历史上这里默认按 900 秒重挂，
    // 会把用户/其它软件设定的倒计时悄悄改成 15 分钟）。此时如实返回"已取消外部倒计时"。
    if (!hint || !hint.type) {
      return { cancelledExternal: true };
    }

    // 以 store 记录的绝对目标时间反推剩余秒数，重挂原计划
    const remain = Math.max(60, Math.round((hint.at - Date.now()) / 1000));
    const typeFlag = hint.type === 'restart' ? '/r' : '/s';
    const label = hint.type === 'restart' ? '重启' : '关机';
    const r2 = await promiseExecFile('shutdown.exe',
      [typeFlag, '/t', String(remain), '/c', `QuickKeys 恢复原有定时${label}`], { windowsHide: true });
    if (r2.code === 0) {
      return {
        type: hint.type,
        at: Date.now() + remain * 1000,
        seconds: remain,
        restored: true
      };
    }
    return { cancelledButRestoreFailed: true };
  }

  // 启动时核对计划任务是否仍然存在（返回核对后的 timers，供调用方广播）
  // FIX 4：加入 active countdown 探测，UI 永不失准
  async reconcileTimers() {
    const timers = this.store.get('timers');
    try {
      const r = await psRun(
        `$t = Get-ScheduledTask -TaskName '${SLEEP_TASK_NAME}' -ErrorAction SilentlyContinue;` +
        `if ($t -and $t.State -ne 'Disabled') { $s=$t.Triggers[0].StartBoundary; "EXISTS $s" } else { 'NONE' }`);
      const out = r.stdout.trim();
      if (out.startsWith('EXISTS')) {
        const dateStr = out.replace('EXISTS ', '').trim();
        const at = Date.parse(dateStr);
        if (Number.isFinite(at) && at > Date.now()) {
          timers.sleep = { at, seconds: Math.round((at - Date.now()) / 1000) };
        } else {
          timers.sleep = null;
        }
      } else {
        timers.sleep = null;
      }

      // 先按 store 清掉过期的关机/重启记录
      for (const k of ['shutdown', 'restart']) {
        if (timers[k] && timers[k].at < Date.now()) timers[k] = null;
      }

      // 重点：真·探测系统状态。
      // 只有 store 里确实记录着本应用设定的关机/重启计划时才探测（/a 探测会取消系统倒计时），
      // 没有记录就完全不动系统，避免误取消用户或其它软件设置的倒计时。
      const pendingKey = timers.shutdown ? 'shutdown' : (timers.restart ? 'restart' : null);
      if (pendingKey) {
        const active = await this._probeActiveShutdownTimer(false, {
          type: pendingKey,
          at: timers[pendingKey].at
        });
        if (active && active.type) {
          timers[active.type] = {
            at: active.at,
            seconds: active.seconds,
            restored: active.restored || false
          };
        } else {
          // 系统里已经没有倒计时（或还原失败）→ 清掉 store，避免 UI 一直显示假倒计时
          timers.shutdown = null;
          timers.restart = null;
        }
      }

      this.store.set('timers', timers);
    } catch (e) {
      console.error('[QuickKeys] 定时任务核对失败:', e.message);
    }
    return timers;
  }

  /* ------------------------------ 终端 / 命令 ----------------------------- */

  async openTerminal(which) {
    const pref = which || this.store.get('defaultTerminal');
    let term = pref;
    if (pref === 'auto') term = this.terminals.wt ? 'wt' : 'powershell';
    const map = { wt: this.wtLauncher(), powershell: 'powershell.exe', cmd: 'cmd.exe' };
    if (!map[term]) return { ok: false, message: '未知终端类型' };
    await shellStart(map[term]);
    return { ok: true };
  }

  async runUserCommand(command, mode = 'hidden', confirmed = false) {
    // 统一换行符；除换行外的控制字符一律拒绝
    command = String(command || '').replace(/\r\n?/g, '\n').trim();
    if (!command) return { ok: false, message: '命令不能为空' };
    if (/[\x00-\x09\x0B-\x1F]/.test(command)) return { ok: false, message: '命令中包含非法控制字符' };
    if (command.includes('\n') && mode !== 'terminal') {
      // 后台执行 / 捕获输出基于单行 cmd /c，无法可靠承载多行；终端模式则原生支持
      return { ok: false, message: '「后台执行 / 捕获输出」不支持多行命令，请改用「终端中运行」' };
    }

    // 危险命令安全门：未获得用户显式确认（confirmed）时不执行，交由上层弹窗询问
    const dangerLabels = this.isDangerousCommand(command);
    if (dangerLabels.length && confirmed !== true) {
      return {
        ok: false,
        needConfirm: true,
        dangerLabels,
        message: `检测到潜在危险操作：${dangerLabels.join('、')}`
      };
    }

    if (mode === 'output') {
      const r = await cmdOutput(command, 30000);
      const output = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim();
      return r.code === 0
        ? { ok: true, output: output || '命令没有输出。' }
        : { ok: false, output: output || r.error || `命令执行失败（返回码 ${r.code}）` };
    }
    if (mode === 'terminal') {
      return this.openInTerminal(command);
    }

    // ===== FIX 3: hidden 后台静默执行 =====
    // 旧坑：execFile + stdio:'ignore' 对于 shutdown.exe / taskkill 这类"需要分配控制台上下文
    //        才能正确登记系统级 Toast/副作用"的命令，会出现"命令进程返回成功但系统没反应"。
    // 方案：
    //   ・普通命令 → 沿用原实现（stdio:ignore，完全静默不占资源）
    //   ・命中 DANGEROUS_COMMAND_RULES 的命令（shutdown/taskkill/del 等）→
    //      改用 cmdOutput 方式真正捕获 stdout/stderr，并把 code 和输出都返回给 UI，
    //      这样即使失败了用户也能在卡片上看到具体原因（而不是"静默无事发生"）。
    const isDangerous = DANGEROUS_COMMAND_RULES.some((rule) => rule.re.test(command));
    if (isDangerous) {
      const r = await cmdOutput(command, 45000);
      return r.code === 0
        ? { ok: true, message: '命令已执行（后台捕获模式）', output: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || '执行完成。' }
        : {
            ok: false,
            message: `命令执行失败（返回码 ${r.code}）`,
            detail: `命令: ${command}\nstdout: ${r.stdout}\nstderr: ${r.stderr}\nerror: ${r.error || ''}`,
            output: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || (r.error || `执行失败（返回码 ${r.code}）`)
          };
    }

    // 非危险命令 → 完全静默 fire-and-forget（原行为）
    return new Promise((resolve) => {
      const child = execFile('cmd.exe', ['/c', command], { windowsHide: true, detached: true, stdio: 'ignore' });
      let settled = false;
      child.once('spawn', () => {
        settled = true;
        child.unref();
        resolve({ ok: true, message: '命令已在后台执行' });
      });
      child.once('error', (error) => {
        if (!settled) resolve({ ok: false, message: `后台命令启动失败：${error.message}` });
      });
    });
  }

  /**
   * 在可见终端中运行命令。
   * - PowerShell / Windows Terminal：使用 -EncodedCommand（base64 + UTF-16LE）传递，
   *   彻底避免单引号、双引号、& | > 等字符被 cmd / PowerShell 提前解析。
   *   （历史实现用单引号包裹命令，实测 PowerShell 只会把命令当字符串打印出来，根本不会执行。）
   * - CMD：把命令写入临时 .cmd 文件后用 cmd /k 执行，避免 & | > 在 start 外层被拆分。
   */
  async openInTerminal(command) {
    const pref = this.store.get('defaultTerminal');
    const term = pref === 'auto' ? (this.terminals.wt ? 'wt' : 'powershell') : pref;
    if (!['wt', 'powershell', 'cmd'].includes(term)) {
      return { ok: false, message: '未知终端类型' };
    }
    if (term === 'cmd') {
      const batPath = this.writeTerminalScript(command);
      await shellStart(`cmd.exe /k "${batPath}"`);
    } else {
      const encoded = Buffer.from(command, 'utf16le').toString('base64');
      if (term === 'wt') {
        // 用绝对路径启动 wt，避免依赖 PATH 中的 WindowsApps 别名解析
        await shellStart(`${this.wtLauncher()} powershell.exe -NoExit -EncodedCommand ${encoded}`);
      } else {
        await shellStart(`powershell.exe -NoExit -EncodedCommand ${encoded}`);
      }
    }
    return { ok: true, message: '已在终端中运行' };
  }

  // Windows Terminal 启动前缀：优先绝对路径（含引号），否则退回 PATH 中的 wt.exe
  wtLauncher() {
    const wtPath = this.wtPath || path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
    return pathExists(wtPath) ? `"${wtPath}"` : 'wt.exe';
  }

  // 把命令写成 UTF-8 临时脚本（配合 chcp 65001，保证中文命令不乱码），只保留最近 20 个
  writeTerminalScript(command) {
    const dir = path.join(this.scriptsDir, 'run');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `quickkeys-${Date.now()}-${process.pid}.cmd`);
    const content = [
      '@echo off',
      'chcp 65001>nul',
      'rem Generated by QuickKeys - safe to delete',
      String(command).replace(/\n/g, '\r\n'),
      ''
    ].join('\r\n');
    fs.writeFileSync(file, content, 'utf8');
    try {
      const olds = fs.readdirSync(dir)
        .filter((f) => /^quickkeys-\d+-\d+\.cmd$/.test(f))
        .sort()
        .slice(0, -20);
      for (const f of olds) fs.unlinkSync(path.join(dir, f));
    } catch (_) { /* 清理失败不影响主流程 */ }
    return file;
  }

  /* -------------------------------- 网络 -------------------------------- */

  async ping(host) {
    // 去除空白，防止通过附加参数注入命令行选项
    host = sanitizeToken(host).replace(/\s+/g, '');
    if (!host) return { ok: false, message: '请输入域名或 IP 地址' };
    const r = await cmdOutput(`ping -n 4 ${host}`, 20000);
    const output = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim();
    return r.code === 0
      ? { ok: true, output: output || '没有输出。' }
      : { ok: false, output: output || r.error || '目标不可达' };
  }

  async portCheck(port) {
    port = Number(String(port).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, message: '请输入 1-65535 的端口号' };
    }
    const [net, tasks] = await Promise.all([
      cmdOutput('netstat -ano -p tcp', 15000),
      cmdOutput('tasklist /fo csv /nh', 15000)
    ]);
    if (net.code !== 0) {
      return { ok: false, message: net.stderr.trim() || net.error || '无法读取 TCP 端口状态' };
    }
    const lines = net.stdout.split(/\r?\n/).filter((l) => {
      const cols = l.trim().split(/\s+/);
      return cols.length >= 4 && cols[1] && cols[1].endsWith(`:${port}`);
    });
    if (!lines.length) {
      return { ok: true, output: `端口 ${port} 当前没有任何 TCP 连接 / 监听，未被占用。` };
    }
    const pidName = new Map();
    for (const line of tasks.stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]*)","(\d+)"/);
      if (m) pidName.set(m[2], m[1]);
    }
    const seen = new Set();
    const out = lines.map((l) => {
      const cols = l.trim().split(/\s+/);
      const proto = cols[0], local = cols[1], foreign = cols[2], state = cols[3] || '', pid = cols[4] || '';
      const key = `${local}-${pid}-${state}`;
      if (seen.has(key)) return '';
      seen.add(key);
      const name = pidName.get(pid) || '未知进程';
      return `${proto.padEnd(7)} ${local.padEnd(24)} → ${foreign.padEnd(24)} ${(state || '-').padEnd(12)} PID ${pid}  ${name}`;
    }).filter(Boolean);
    return {
      ok: true,
      output: `端口 ${port} 占用情况：\n\n${out.join('\n')}\n\n提示：任务管理器中可按 PID 结束对应进程。`
    };
  }

  async wifiPassword(ssid) {
    ssid = ssid ? sanitizeToken(ssid) : '';
    if (!ssid) {
      const ifaces = await promiseExecFile('netsh.exe', ['wlan', 'show', 'interfaces'], { windowsHide: true });
      const m = ifaces.stdout.match(/^\s*SSID\s*:\s*(.+)$/m);
      if (!m) return { ok: false, message: '未检测到当前连接的 WiFi，请在输入框中填写 WiFi 名称' };
      ssid = m[1].trim();
    }
    if (!ssid) return { ok: false, message: '无法识别 WiFi 名称' };
    const r = await promiseExecFile('netsh.exe', ['wlan', 'show', 'profile', `name=${ssid}`, 'key=clear'], { windowsHide: true, timeout: 15000 });
    const text = r.stdout;
    if (/系统上没有该配置文件|not found|找不到|not exist|profile.*not|does not exist/i.test(text)) {
      return { ok: false, message: `未找到 WiFi 配置文件「${ssid}」，请确认名称与当前系统语言（曾连接过的网络才可查看）` };
    }
    return { ok: true, output: text.trim() || '没有输出。' };
  }

  /* -------------------------------- 截图与系统维护 -------------------------------- */

  async snipRegion() {
    // 必须使用原生 ShellExecute（SW_SHOWNORMAL），严禁带 windowsHide 导致截图工具沦为后台隐身僵尸
    try {
      const err = await shell.openExternal('ms-screenclip:');
      if (err) throw new Error(err);
      log.info('executor', 'snipRegion: shell.openExternal ms-screenclip: 触发成功');
      return { ok: true, message: '截图工具已启动' };
    } catch (e) {
      log.warn('executor', `snipRegion 协议拉起异常: ${e.message}`);
      return { ok: false, message: `无法启动截图工具: ${e.message}` };
    }
  }

  async openScreenshots() {
    const candidates = [
      path.join(os.homedir(), 'Pictures', 'Screenshots'),
      path.join(os.homedir(), 'Pictures', '屏幕截图'),
      path.join(os.homedir(), 'Pictures'),
      os.homedir()
    ];
    let target = candidates.find((p) => fs.existsSync(p)) || candidates[0];
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    const err = await shell.openPath(target);
    return err ? { ok: false, message: err } : { ok: true };
  }

  async cleanTemp() {
    const script = [
      '$p = $env:TEMP',
      '$self = (Get-Process -Id $PID).Path | Split-Path -Parent',
      "$skip = @('QuickKeys','electron-builder','.electron')",
      '$before = (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum',
      'Get-ChildItem $p -Force -ErrorAction SilentlyContinue | ForEach-Object {',
      '  $name = $_.Name',
      '  if ($skip | Where-Object { $name -like "*$_*" }) { return }',
      '  if ($_.FullName -like "$self*") { return }',
      '  Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue',
      '}',
      '$after = (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum',
      '$freed = [math]::Round((($before - $after) / 1MB), 1)',
      "if ($freed -lt 0) { $freed = 0 }",
      "'清理完成，释放约 $freed MB 空间（正在使用的文件与本软件运行目录已自动跳过）'"
    ].join('; ');
    const r = await psRun(script, 120000);
    if (r.code !== 0) return { ok: false, message: r.stderr.trim() || r.error || '临时文件清理失败' };
    return { ok: true, output: r.stdout.trim() || '清理完成。' };
  }

  async restartExplorer() {
    const r = await promiseExecFile('cmd.exe', ['/c', 'taskkill /f /im explorer.exe & timeout /t 1 /nobreak>nul & start explorer.exe'],
      { windowsHide: true, detached: true });
    return r.code === 0
      ? { ok: true, message: '资源管理器正在重启，任务栏会短暂消失' }
      : { ok: false, message: r.stderr.trim() || r.error || '资源管理器重启失败' };
  }

  async defenderScan() {
    const mpCmd = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe');
    if (!fs.existsSync(mpCmd)) return { ok: false, message: '未找到 Windows Defender 命令行工具' };
    const r = await promiseExecFile(mpCmd, ['-Scan', '-ScanType', '1'], { windowsHide: true, timeout: 600000 });
    const out = (r.stdout + r.stderr).trim();
    const map = { 0: '未发现威胁，扫描完成。', 2: '扫描完成，但发现了潜在威胁，请在安全中心查看处理。' };
    return [0, 2].includes(r.code)
      ? { ok: true, output: `${map[r.code]}\n\n${out}`.trim() }
      : { ok: false, output: `扫描失败（返回码 ${r.code}）\n\n${out || r.error || '未返回详细信息'}`.trim() };
  }

  async batteryReport() {
    const desktop = path.join(os.homedir(), 'Desktop');
    const dir = fs.existsSync(desktop) ? desktop : os.homedir();
    const file = path.join(dir, 'battery-report.html');
    const previousModifiedAt = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
    // 直接用 execFile 传参数数组，避免 cmd /c 引号嵌套错乱
    const r = await promiseExecFile('powercfg.exe', ['/batteryreport', '/output', file], { windowsHide: true, timeout: 30000 });
    const generated = fs.existsSync(file) && fs.statSync(file).mtimeMs > previousModifiedAt;
    if (r.code !== 0 || !generated) {
      return { ok: false, message: (r.stdout || r.stderr || r.error || '报告生成失败（台式机无电池时无法生成）').trim() };
    }
    const err = await shell.openPath(file);
    return err
      ? { ok: false, output: `电池报告已生成，但无法自动打开：\n${file}\n${err}` }
      : { ok: true, output: `电池报告已生成并打开：\n${file}` };
  }

  /* -------------------------- 离线数据与格式引擎 -------------------------- */

  async calculateFileHash(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, message: '请选择有效的文件' };
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, message: '选择的路径不是有效文件' };

    const formatSize = (bytes) => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };

    return new Promise((resolve) => {
      const md5 = crypto.createHash('md5');
      const sha1 = crypto.createHash('sha1');
      const sha256 = crypto.createHash('sha256');

      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => {
        md5.update(chunk);
        sha1.update(chunk);
        sha256.update(chunk);
      });
      stream.on('end', () => {
        const out = [
          `文件名: ${path.basename(filePath)}`,
          `路径: ${filePath}`,
          `大小: ${formatSize(stat.size)} (${stat.size.toLocaleString()} 字节)`,
          '----------------------------------------',
          `MD5:    ${md5.digest('hex').toUpperCase()}`,
          `SHA-1:  ${sha1.digest('hex').toUpperCase()}`,
          `SHA-256:${sha256.digest('hex').toUpperCase()}`
        ].join('\n');
        resolve({ ok: true, output: out, filePath });
      });
      stream.on('error', (err) => {
        resolve({ ok: false, message: `计算失败: ${err.message}` });
      });
    });
  }

  async imagesToPdf(images, savePath) {
    if (!Array.isArray(images) || images.length === 0) {
      return { ok: false, message: '请至少选择一张图片' };
    }
    const validImages = images.filter((img) => fs.existsSync(img));
    if (validImages.length === 0) {
      return { ok: false, message: '所选图片文件不存在' };
    }
    if (!savePath) {
      return { ok: false, message: '未指定 PDF 保存路径' };
    }

    let win = null;
    try {
      win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 1600,
        webPreferences: { webSecurity: false }
      });

      const pagesHtml = validImages.map((img) => {
        // pathToFileURL 正确处理空格、#、中文等字符，避免手工拼接 file:/// 出错
        const uri = pathToFileURL(img).href;
        return `<div class="page"><img src="${uri.replace(/"/g, '%22')}" /></div>`;
      }).join('\n');

      const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          @page { size: auto; margin: 0; }
          body { background: #fff; }
          .page { page-break-after: always; width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; }
          .page:last-child { page-break-after: avoid; }
          img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
        </style>
      </head><body>${pagesHtml}</body></html>`;

      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
      // 稍微等待渲染
      await new Promise((r) => setTimeout(r, 600));

      const pdfBuffer = await win.webContents.printToPDF({
        printBackground: true,
        // Electron 44 的 margins 为英寸四边数值（marginType 写法已被移除并忽略），
        // 显式置 0 才能让图片满版铺开，不再出现约 1cm 的白边
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        pageSize: 'A4'
      });

      fs.writeFileSync(savePath, pdfBuffer);
      win.close();
      win = null;

      return {
        ok: true,
        message: `成功导出 PDF（共 ${validImages.length} 页图片）`,
        output: `PDF 已成功生成！\n\n页数：${validImages.length} 页\n保存路径：${savePath}`,
        filePath: savePath
      };
    } catch (err) {
      if (win && !win.isDestroyed()) win.close();
      return { ok: false, message: `PDF 生成失败：${err.message}` };
    }
  }

  async wordToPdf(inputPath, savePath) {
    if (!inputPath || !fs.existsSync(inputPath)) {
      return { ok: false, message: '请选择有效的 Word 文档 (.docx / .doc)' };
    }
    if (!savePath) {
      return { ok: false, message: '未指定导出的 PDF 保存路径' };
    }
    const script = path.join(this.scriptsDir, 'word-to-pdf.ps1');
    const r = await promiseExecFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-InputPath', inputPath, '-OutputPath', savePath],
      { windowsHide: true, timeout: 60000 });

    if (r.code !== 0 || !fs.existsSync(savePath)) {
      const err = r.stderr.trim() || r.error || 'Word 转换失败';
      return { ok: false, message: err };
    }
    return {
      ok: true,
      message: 'Word 文档已成功转为 PDF！',
      output: `转换完成！\n\n源文档：${inputPath}\n输出文件：${savePath}`,
      filePath: savePath
    };
  }

  async textToPdf(inputPath, savePath) {
    if (!inputPath || !fs.existsSync(inputPath)) {
      return { ok: false, message: '请选择有效的文本文件 (.txt / .md)' };
    }
    if (!savePath) {
      return { ok: false, message: '未指定导出的 PDF 保存路径' };
    }

    let win = null;
    try {
      const rawText = fs.readFileSync(inputPath, 'utf8');
      win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 1600
      });

      const title = path.basename(inputPath);
      const safeText = rawText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8">
        <title>${title}</title>
        <style>
          @page { size: A4; margin: 20mm 15mm; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
            color: #111;
            line-height: 1.7;
            font-size: 13.5px;
            white-space: pre-wrap;
            word-break: break-word;
          }
          .doc-header {
            border-bottom: 2px solid #333;
            padding-bottom: 8px;
            margin-bottom: 16px;
            font-size: 18px;
            font-weight: bold;
          }
        </style>
      </head><body><div class="doc-header">${title}</div>${safeText}</body></html>`;

      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
      await new Promise((r) => setTimeout(r, 400));

      const pdfBuffer = await win.webContents.printToPDF({
        printBackground: true,
        // 与 CSS 中 20mm 上下 / 15mm 左右 的设计边距对齐（英寸）
        margins: { top: 0.79, bottom: 0.79, left: 0.59, right: 0.59 },
        pageSize: 'A4'
      });

      fs.writeFileSync(savePath, pdfBuffer);
      win.close();
      win = null;

      return {
        ok: true,
        message: '文本文件已成功排版并导出为 PDF！',
        output: `转换完成！\n\n源文本：${inputPath}\n输出文件：${savePath}`,
        filePath: savePath
      };
    } catch (err) {
      if (win && !win.isDestroyed()) win.close();
      return { ok: false, message: `文本转 PDF 失败：${err.message}` };
    }
  }

  processJson(text, mode = 'format') {
    text = (text || '').trim();
    if (!text) return { ok: false, message: '请输入 JSON 内容' };
    try {
      const parsed = JSON.parse(text);
      if (mode === 'minify') {
        return { ok: true, output: JSON.stringify(parsed) };
      }
      return { ok: true, output: JSON.stringify(parsed, null, 2) };
    } catch (e) {
      return { ok: false, message: `JSON 格式错误：${e.message}` };
    }
  }

  processBase64(text, mode = 'encode') {
    text = text || '';
    if (!text) return { ok: false, message: '请输入文本内容' };
    try {
      if (mode === 'decode') {
        const decoded = Buffer.from(text, 'base64').toString('utf8');
        return { ok: true, output: decoded };
      }
      const encoded = Buffer.from(text, 'utf8').toString('base64');
      return { ok: true, output: encoded };
    } catch (e) {
      return { ok: false, message: `转换失败：${e.message}` };
    }
  }

  async fixIconCache() {
    const script = [
      'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue',
      'Start-Sleep -Milliseconds 500',
      "$ic = Join-Path $env:LOCALAPPDATA 'IconCache.db'",
      'if (Test-Path $ic) { Remove-Item $ic -Force -ErrorAction SilentlyContinue }',
      "$exDir = Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Explorer'",
      'if (Test-Path $exDir) { Get-ChildItem $exDir -Filter "iconcache_*.db" | Remove-Item -Force -ErrorAction SilentlyContinue; Get-ChildItem $exDir -Filter "thumbcache_*.db" | Remove-Item -Force -ErrorAction SilentlyContinue }',
      'Start-Sleep -Milliseconds 300',
      'Start-Process explorer.exe'
    ].join('; ');
    const r = await psRun(script, 30000);
    if (r.code !== 0) {
      return { ok: false, message: r.stderr.trim() || r.error || '图标缓存清理失败' };
    }
    return {
      ok: true,
      output: '图标与缩略图缓存已清除，资源管理器已重新加载。\n\n提示：如果图标仍有异常，重启电脑后会自动重建缓存。'
    };
  }

  async repairNetwork() {
    const script = `
      netsh winsock reset
      netsh int ip reset
      ipconfig /flushdns
      arp -d *
    `;
    // 用 /k 保持管理员窗口不自动关闭，用户可以完整看到每一步的执行结果
    await promiseExecFile('powershell.exe',
      ['-NoProfile', '-Command', `Start-Process cmd.exe -ArgumentList '/k ${script.replace(/\r?\n/g, ' & ')}' -Verb RunAs`],
      { windowsHide: false });
    return {
      ok: true,
      output: '已请求管理员权限重置网络协议栈并刷新 DNS 缓存！\n\n提示：若需完全生效，建议稍后重启一次计算机。'
    };
  }
}

module.exports = { Executor, DANGEROUS_COMMAND_RULES };
