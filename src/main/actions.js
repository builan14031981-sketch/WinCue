'use strict';

/**
 * QuickKeys 动作注册表（纯数据，可被 Node 单测直接引用）
 * run 字段仅在主进程执行器中使用，下发给渲染进程时会被剥离。
 *
 * run.type:
 *   spawn  : 直接启动程序 { cmd, args, elevated?, visible? }
 *   shell  : cmd /c start 打开（文件关联 / applet / shell: 协议）{ command }
 *   uri    : 系统协议 { uri }
 *   ps     : 执行 PowerShell（可捕获输出）{ script, output? }
 *   output : cmd 命令并捕获输出 { command, timeout? }
 *   hotkey: 发送组合键 { keys: ['LWIN','SHIFT','S'] }
 *   special: 执行器内置特殊处理 { name }
 *   view   : 打开应用内视图 { name }
 */

const CATEGORIES = [
  { id: 'home', name: '首页', icon: 'home', virtual: true },
  { id: 'gaming', name: '游戏专区', icon: 'gamepad', virtual: true },
  { id: 'guardian', name: '安全卫士', icon: 'shield', virtual: true },
  { id: 'cleaner', name: '垃圾清理', icon: 'broom', virtual: true },
  { id: 'cdrive', name: 'C 盘专清', icon: 'hard-drive', virtual: true },
  { id: 'contextmenu', name: '右键管家', icon: 'menu', virtual: true },
  { id: 'power', name: '电源关机', icon: 'power' },
  { id: 'capture', name: '截图录屏', icon: 'camera' },
  { id: 'launch', name: '快捷启动', icon: 'rocket' },
  { id: 'systools', name: '系统工具', icon: 'cpu' },
  { id: 'network', name: '网络远程', icon: 'wifi' },
  { id: 'maintain', name: '系统维护', icon: 'wrench' },
  { id: 'convert', name: '格式转换', icon: 'file-text' },
  { id: 'window', name: '窗口桌面', icon: 'window' },
  { id: 'tools', name: '效率工具', icon: 'grid' },
  { id: 'custom', name: '自定义命令', icon: 'terminal', virtual: true },
  { id: 'shortcuts', name: '快捷键手册', icon: 'keyboard', virtual: true },
  { id: 'settings', name: '设置', icon: 'settings', virtual: true }
];

const A = (o) => Object.freeze(o);

const ACTIONS = [

  /* ============================== 电源与关机 ============================== */
  A({
    id: 'shutdown-now', cat: 'power', icon: 'power', name: '立即关机',
    desc: '关闭计算机（shutdown /s /t 0）',
    keywords: ['关机', 'shutdown', 'power off', '关闭电脑', '断电'],
    danger: true, confirm: { title: '立即关机？', message: '所有未保存的工作将会丢失，请确认已保存文件。', okText: '关机' },
    run: { type: 'spawn', cmd: 'shutdown.exe', args: ['/s', '/t', '0'] }
  }),
  A({
    id: 'restart-now', cat: 'power', icon: 'restart', name: '立即重启',
    desc: '重新启动计算机（shutdown /r /t 0）',
    keywords: ['重启', 'restart', 'reboot', '重新启动', '重启电脑'],
    danger: true, confirm: { title: '立即重启？', message: '计算机将立即重新启动，请先保存所有工作。', okText: '重启' },
    run: { type: 'spawn', cmd: 'shutdown.exe', args: ['/r', '/t', '0'] }
  }),
  A({
    id: 'shutdown-timer', cat: 'power', icon: 'timer', name: '定时关机（睡前/下载挂机）',
    desc: '预设时间或倒计时自动关机，无需心算秒数（关闭本软件依然有效）',
    keywords: ['定时关机', '倒计时关机', '自动关机', 'timer shutdown', '预约关机', '延时关机', 'dsgj', '睡前关机', '半小时后关机', '1小时后关机'],
    ui: { kind: 'timer', mode: 'shutdown' },
    run: { type: 'special', name: 'set-timer' }
  }),
  A({
    id: 'restart-timer', cat: 'power', icon: 'timer-restart', name: '定时重启',
    desc: '设定倒计时，时间到自动重启',
    keywords: ['定时重启', '倒计时重启', '自动重启', 'timer restart', '预约重启'],
    ui: { kind: 'timer', mode: 'restart' },
    run: { type: 'special', name: 'set-timer' }
  }),
  A({
    id: 'shutdown-cancel', cat: 'power', icon: 'timer-off', name: '取消计划关机 / 重启',
    desc: '取消已经设定的系统关机或重启倒计时（shutdown /a）',
    keywords: ['取消关机', '取消重启', '取消定时', 'shutdown /a', 'abort'],
    run: { type: 'special', name: 'cancel-shutdown' }
  }),
  A({
    id: 'lock', cat: 'power', icon: 'lock', name: '锁定计算机',
    desc: '回到锁屏界面（Win + L）',
    keywords: ['锁屏', '锁定', 'lock', 'win+l', '密码锁'],
    run: { type: 'spawn', cmd: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] }
  }),
  A({
    id: 'logoff', cat: 'power', icon: 'logout', name: '注销当前用户',
    desc: '退出当前登录账户（shutdown /l）',
    keywords: ['注销', '退出登录', 'logoff', 'sign out', '切换用户'],
    danger: true, confirm: { title: '注销当前用户？', message: '所有打开的程序将被关闭。', okText: '注销' },
    run: { type: 'spawn', cmd: 'shutdown.exe', args: ['/l'] }
  }),
  A({
    id: 'sleep', cat: 'power', icon: 'moon', name: '睡眠',
    desc: '让计算机进入睡眠状态（不可用时自动转为休眠）',
    keywords: ['睡眠', 'sleep', '待机', 'suspend', '挂起'],
    danger: true, confirm: { title: '让电脑进入睡眠？', message: '当前会话将暂停，远程连接和正在运行的任务可能中断。请先保存工作。', okText: '进入睡眠' },
    run: { type: 'spawn', cmd: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0', '1', '0'] }
  }),
  A({
    id: 'hibernate', cat: 'power', icon: 'bed', name: '休眠',
    desc: '将当前状态写入硬盘后完全断电（shutdown /h，需已启用休眠）',
    keywords: ['休眠', 'hibernate', 'hibernation', '深度睡眠'],
    danger: true, confirm: { title: '让电脑进入休眠？', message: '当前会话将暂停，远程连接和正在运行的任务可能中断。请先保存工作。', okText: '进入休眠' },
    run: { type: 'spawn', cmd: 'shutdown.exe', args: ['/h'] }
  }),
  A({
    id: 'sleep-timer', cat: 'power', icon: 'timer-moon', name: '定时睡眠',
    desc: '设定倒计时，时间到自动睡眠（通过系统计划任务实现）',
    keywords: ['定时睡眠', '定时待机', '自动睡眠', 'timer sleep', '预约睡眠'],
    ui: { kind: 'timer', mode: 'sleep' },
    run: { type: 'special', name: 'set-timer' }
  }),
  A({
    id: 'sleep-cancel', cat: 'power', icon: 'timer-off', name: '取消定时睡眠',
    desc: '取消已设定的睡眠计划任务',
    keywords: ['取消睡眠', '取消定时睡眠'],
    run: { type: 'special', name: 'cancel-sleep' }
  }),
  A({
    id: 'monitor-off', cat: 'power', icon: 'monitor-off', name: '关闭显示器',
    desc: '立即关闭屏幕（移动鼠标或按任意键唤醒），下载/挂机能继续运行',
    keywords: ['关屏幕', '关闭显示器', '熄屏', 'monitor off', '关屏', '黑屏'],
    run: { type: 'special', name: 'monitor-off' }
  }),
  A({
    id: 'hybrid-shutdown', cat: 'power', icon: 'fast-forward', name: '快速启动关机',
    desc: '混合关机（/hybrid），下次开机更快',
    keywords: ['快速启动', '混合关机', 'hybrid shutdown', 'fast startup'],
    danger: true, confirm: { title: '执行快速启动关机？', message: '计算机关闭前请保存好工作。', okText: '关机' },
    run: { type: 'spawn', cmd: 'shutdown.exe', args: ['/s', '/hybrid', '/t', '0'] }
  }),

  /* ============================== 截图与录屏 ============================== */
  A({
    id: 'snip-region', cat: 'capture', icon: 'crop', name: '区域截图',
    desc: '启动系统截图工具栏，可框选矩形 / 任意形状 / 窗口 / 全屏（Win + Shift + S）',
    keywords: ['截图', '截屏', '区域截图', 'snipping', 'snip', 'win+shift+s', '屏幕截图', '框选'],
    run: { type: 'special', name: 'snip-region' }
  }),
  A({
    id: 'capture-fullscreen', cat: 'capture', icon: 'camera', name: '全屏截图（自动保存）',
    desc: '截取整个屏幕并自动保存到「图片 \\ 屏幕截图」文件夹（Win + PrtScn）',
    keywords: ['全屏截图', 'prtscn', 'printscreen', '保存截图', '整屏截图'],
    run: { type: 'hotkey', keys: ['LWIN', 'SNAPSHOT'] }
  }),
  A({
    id: 'open-snipping', cat: 'capture', icon: 'scissors', name: '打开截图工具',
    desc: '打开 Windows 截图工具主程序，可标注、延时截图、录屏',
    keywords: ['截图工具', 'snipping tool', '剪取工具', '屏幕草图', '录屏'],
    run: { type: 'shell', command: 'explorer.exe "shell:AppsFolder\\Microsoft.ScreenSketch_8wekyb3d8bbwe!App"' }
  }),
  A({
    id: 'open-screenshots-folder', cat: 'capture', icon: 'folder-image', name: '打开截图保存文件夹',
    desc: '打开「图片 \\ 屏幕截图」文件夹，查看自动保存的截图',
    keywords: ['截图文件夹', 'screenshots', '图片', '截图保存位置'],
    run: { type: 'special', name: 'open-screenshots' }
  }),
  A({
    id: 'record-toggle', cat: 'capture', icon: 'video', name: '开始 / 停止屏幕录制',
    desc: '调用 Xbox Game Bar 录制当前窗口（Win + Alt + R），再按一次停止',
    keywords: ['录屏', '屏幕录制', '录制', 'record', 'game bar', 'win+alt+r', '视频录制'],
    run: { type: 'hotkey', keys: ['LWIN', 'MENU', 'R'] }
  }),
  A({
    id: 'gamebar', cat: 'capture', icon: 'gamepad', name: '打开 Xbox Game Bar',
    desc: '打开游戏栏，可录屏、录音、查看性能与小组件（Win + G）',
    keywords: ['game bar', 'xbox', '游戏栏', 'win+g', '性能浮窗'],
    run: { type: 'hotkey', keys: ['LWIN', 'G'] }
  }),
  A({
    id: 'psr', cat: 'capture', icon: 'record-steps', name: '步骤记录器',
    desc: '自动记录操作步骤并逐屏截图，生成图文报告（psr），适合做教程 / 报 bug',
    keywords: ['步骤记录器', 'psr', '问题步骤记录', '操作记录', '教程录制'],
    run: { type: 'shell', command: 'psr.exe' }
  }),

  /* ============================== 快捷启动 ============================== */
  A({
    id: 'terminal', cat: 'launch', icon: 'terminal', name: '打开终端',
    desc: '按设置启动 Windows Terminal / PowerShell / 命令提示符',
    keywords: ['终端', 'terminal', 'cmd', 'powershell', 'wt', '命令行', '控制台', 'shell'],
    ui: { kind: 'terminal' },
    run: { type: 'special', name: 'open-terminal' }
  }),
  A({
    id: 'run-dialog', cat: 'launch', icon: 'play', name: '运行对话框',
    desc: '打开「运行」窗口，快速启动程序或路径（Win + R）',
    keywords: ['运行', 'run', 'win+r', '运行框', '打开程序'],
    run: { type: 'hotkey', keys: ['LWIN', 'R'] }
  }),
  A({
    id: 'run-command', cat: 'launch', icon: 'chevrons', name: '执行任意命令',
    desc: '输入任意 cmd / 程序命令，可后台执行、在终端中运行或捕获输出',
    keywords: ['执行命令', '运行命令', 'cmd', '命令', 'run command', '指令'],
    ui: { kind: 'runbox' },
    run: { type: 'special', name: 'run-command' }
  }),
  A({
    id: 'explorer', cat: 'launch', icon: 'folder', name: '文件资源管理器',
    desc: '打开文件资源管理器（Win + E）',
    keywords: ['资源管理器', 'explorer', '文件夹', '文件管理器', 'win+e', '此电脑'],
    run: { type: 'shell', command: 'explorer.exe' }
  }),
  A({
    id: 'thispc', cat: 'launch', icon: 'monitor', name: '此电脑',
    desc: '打开「此电脑」，查看磁盘与设备',
    keywords: ['此电脑', '我的电脑', 'my computer', '磁盘', 'this pc'],
    run: { type: 'shell', command: 'explorer.exe shell:MyComputerFolder' }
  }),
  A({
    id: 'taskmgr', cat: 'launch', icon: 'activity', name: '任务管理器',
    desc: '查看进程、性能、启动项并结束任务（Ctrl + Shift + Esc）',
    keywords: ['任务管理器', 'task manager', '进程', '结束进程', 'taskmgr', '性能'],
    run: { type: 'shell', command: 'taskmgr.exe' }
  }),
  A({
    id: 'settings', cat: 'launch', icon: 'settings', name: 'Windows 设置',
    desc: '打开系统设置（Win + I）',
    keywords: ['设置', 'settings', 'ms-settings', 'win+i', '系统设置'],
    run: { type: 'uri', uri: 'ms-settings:' }
  }),
  A({
    id: 'control-panel', cat: 'launch', icon: 'sliders', name: '控制面板',
    desc: '打开传统控制面板',
    keywords: ['控制面板', 'control panel', 'control', '传统设置'],
    run: { type: 'shell', command: 'control.exe' }
  }),
  A({
    id: 'win-search', cat: 'launch', icon: 'search', name: '系统搜索',
    desc: '打开 Windows 搜索（Win + S）',
    keywords: ['搜索', 'search', 'win+s', '查找'],
    run: { type: 'hotkey', keys: ['LWIN', 'S'] }
  }),
  A({
    id: 'winx-menu', cat: 'launch', icon: 'menu', name: '快捷链接菜单',
    desc: '打开开始按钮右键菜单（Win + X），直达设备管理器等',
    keywords: ['winx', '右键菜单', '快捷菜单', 'win+x', '开始菜单'],
    run: { type: 'hotkey', keys: ['LWIN', 'X'] }
  }),

  /* ============================== 系统工具 ============================== */
  A({
    id: 'devmgmt', cat: 'systools', icon: 'cpu', name: '设备管理器',
    desc: '查看与管理硬件设备、驱动程序（devmgmt.msc）',
    keywords: ['设备管理器', 'devmgmt', '驱动', '硬件', '设备'],
    run: { type: 'shell', command: 'devmgmt.msc' }
  }),
  A({
    id: 'diskmgmt', cat: 'systools', icon: 'hard-drive', name: '磁盘管理',
    desc: '分区、格式化、更改驱动器号（diskmgmt.msc）',
    keywords: ['磁盘管理', 'diskmgmt', '分区', '格式化', '硬盘', '盘符'],
    run: { type: 'shell', command: 'diskmgmt.msc' }
  }),
  A({
    id: 'compmgmt', cat: 'systools', icon: 'layers', name: '计算机管理',
    desc: '集成本地用户、磁盘、服务、事件查看等（compmgmt.msc）',
    keywords: ['计算机管理', 'compmgmt', '管理控制台'],
    run: { type: 'shell', command: 'compmgmt.msc' }
  }),
  A({
    id: 'services', cat: 'systools', icon: 'gear-loop', name: '服务',
    desc: '管理 Windows 后台服务的启动 / 停止（services.msc）',
    keywords: ['服务', 'services', 'services.msc', '后台服务'],
    run: { type: 'shell', command: 'services.msc' }
  }),
  A({
    id: 'regedit', cat: 'systools', icon: 'registry', name: '注册表编辑器',
    desc: '查看与修改系统注册表（regedit），操作前建议先导出备份',
    keywords: ['注册表', 'regedit', 'registry', '注册编辑'],
    danger: true, confirm: { title: '打开注册表编辑器？', message: '错误修改注册表可能导致系统故障，请在操作前备份。', okText: '我知道了，打开' },
    run: { type: 'shell', command: 'regedit.exe' }
  }),
  A({
    id: 'eventvwr', cat: 'systools', icon: 'list-search', name: '事件查看器',
    desc: '查看系统、应用程序日志与错误记录（eventvwr）',
    keywords: ['事件查看器', 'eventvwr', '日志', '系统日志', '错误日志'],
    run: { type: 'shell', command: 'eventvwr.msc' }
  }),
  A({
    id: 'msinfo32', cat: 'systools', icon: 'info', name: '系统信息',
    desc: '查看完整硬件与系统配置摘要（msinfo32）',
    keywords: ['系统信息', 'msinfo32', '配置', '硬件信息', '电脑配置'],
    run: { type: 'shell', command: 'msinfo32.exe' }
  }),
  A({
    id: 'perfmon', cat: 'systools', icon: 'pulse', name: '性能监视器',
    desc: '实时监控 CPU、磁盘、内存等性能计数器（perfmon）',
    keywords: ['性能监视器', 'perfmon', '性能监控', '计数器'],
    run: { type: 'shell', command: 'perfmon.exe' }
  }),
  A({
    id: 'resmon', cat: 'systools', icon: 'activity', name: '资源监视器',
    desc: '查看进程占用的 CPU、内存、磁盘和网络（resmon）',
    keywords: ['资源监视器', 'resmon', '资源占用', '网络占用'],
    run: { type: 'shell', command: 'resmon.exe' }
  }),
  A({
    id: 'dxdiag', cat: 'systools', icon: 'display', name: 'DirectX 诊断工具',
    desc: '查看显卡、声卡、DirectX 信息并诊断问题（dxdiag）',
    keywords: ['dxdiag', 'directx', '显卡', '显卡信息', '图形诊断'],
    run: { type: 'shell', command: 'dxdiag.exe' }
  }),
  A({
    id: 'gpedit', cat: 'systools', icon: 'shield', name: '本地组策略编辑器',
    desc: '编辑系统与账户策略（gpedit.msc，仅专业版 / 企业版提供）',
    keywords: ['组策略', 'gpedit', 'gpedit.msc', '策略编辑', '专业版'],
    run: { type: 'shell', command: 'gpedit.msc' }
  }),
  A({
    id: 'secpol', cat: 'systools', icon: 'shield-check', name: '本地安全策略',
    desc: '管理密码策略、用户权限、安全选项（secpol.msc）',
    keywords: ['安全策略', 'secpol', '本地策略', '权限'],
    run: { type: 'shell', command: 'secpol.msc' }
  }),
  A({
    id: 'appwiz', cat: 'systools', icon: 'box', name: '程序和功能（卸载）',
    desc: '卸载或更改已安装的程序、启用 Windows 功能（appwiz.cpl）',
    keywords: ['卸载', '卸载程序', '程序和功能', 'appwiz', '添加删除程序'],
    run: { type: 'shell', command: 'appwiz.cpl' }
  }),
  A({
    id: 'sysdm-advanced', cat: 'systools', icon: 'sliders', name: '系统属性 · 高级',
    desc: '直达性能配置、环境变量、启动和故障恢复设置',
    keywords: ['环境变量', '系统属性', '高级设置', 'path', 'SystemPropertiesAdvanced'],
    run: { type: 'shell', command: 'SystemPropertiesAdvanced.exe' }
  }),
  A({
    id: 'rstrui', cat: 'systools', icon: 'history', name: '系统还原',
    desc: '将系统文件还原到以前的还原点（rstrui）',
    keywords: ['系统还原', '还原点', 'rstrui', '恢复系统'],
    run: { type: 'shell', command: 'rstrui.exe' }
  }),
  A({
    id: 'power-options', cat: 'systools', icon: 'plug', name: '电源选项',
    desc: '设置电源计划、睡眠 / 屏幕关闭时间、电源按钮功能',
    keywords: ['电源选项', 'powercfg', '电源计划', '睡眠时间'],
    run: { type: 'shell', command: 'powercfg.cpl' }
  }),
  A({
    id: 'printers', cat: 'systools', icon: 'printer', name: '设备和打印机',
    desc: '查看与管理打印机、鼠标等设备',
    keywords: ['打印机', '设备', 'printers', '打印'],
    run: { type: 'shell', command: 'control.exe printers' }
  }),
  A({
    id: 'credential', cat: 'systools', icon: 'key', name: '凭据管理器',
    desc: '管理 Windows 保存的网站、网络共享登录凭据',
    keywords: ['凭据管理器', 'credential', '密码管理', 'windows凭据'],
    run: { type: 'shell', command: 'control.exe /name Microsoft.CredentialManager' }
  }),
  A({
    id: 'firewall', cat: 'systools', icon: 'shield', name: '高级安全防火墙',
    desc: '配置入站 / 出站规则（wf.msc）',
    keywords: ['防火墙', 'firewall', 'wf.msc', '端口放行', '入站规则'],
    run: { type: 'shell', command: 'wf.msc' }
  }),
  A({
    id: 'taskschd', cat: 'systools', icon: 'calendar-clock', name: '任务计划程序',
    desc: '创建定时运行的任务（taskschd.msc）',
    keywords: ['任务计划', '定时任务', 'taskschd', '计划任务'],
    run: { type: 'shell', command: 'taskschd.msc' }
  }),
  A({
    id: 'msconfig', cat: 'systools', icon: 'settings-tool', name: '系统配置',
    desc: '管理启动项、引导选项与服务（msconfig）',
    keywords: ['系统配置', 'msconfig', '启动项', '引导'],
    run: { type: 'shell', command: 'msconfig.exe' }
  }),
  A({
    id: 'mdsched', cat: 'systools', icon: 'memory', name: '内存诊断',
    desc: '检测内存硬件问题，下次重启时运行（mdsched）',
    keywords: ['内存诊断', 'mdsched', '内存检测', '内存条'],
    run: { type: 'shell', command: 'mdsched.exe' }
  }),
  A({
    id: 'optionalfeatures', cat: 'systools', icon: 'puzzle', name: 'Windows 功能',
    desc: '启用或关闭 Hyper-V、WSL、.NET 等 Windows 功能',
    keywords: ['windows功能', '可选功能', 'hyper-v', 'wsl', 'optionalfeatures', '.net'],
    run: { type: 'shell', command: 'optionalfeatures.exe' }
  }),

  /* ============================== 网络与远程 ============================== */
  A({
    id: 'ncpa', cat: 'network', icon: 'network', name: '网络连接',
    desc: '查看网卡、设置 IP / DNS（ncpa.cpl）',
    keywords: ['网络连接', 'ncpa', '网卡', 'ip设置', 'dns设置', '适配器'],
    run: { type: 'shell', command: 'ncpa.cpl' }
  }),
  A({
    id: 'net-settings', cat: 'network', icon: 'wifi', name: '网络设置',
    desc: '打开网络和 Internet 设置页',
    keywords: ['网络设置', '网络状态', 'network settings'],
    run: { type: 'uri', uri: 'ms-settings:network' }
  }),
  A({
    id: 'wifi-settings', cat: 'network', icon: 'wifi', name: 'WLAN 设置',
    desc: '管理 WiFi 连接、已知网络',
    keywords: ['wifi', 'wlan', '无线', '无线网络'],
    run: { type: 'uri', uri: 'ms-settings:network-wifi' }
  }),
  A({
    id: 'proxy-settings', cat: 'network', icon: 'globe', name: '代理设置',
    desc: '配置系统代理 / PAC 脚本',
    keywords: ['代理', 'proxy', '代理服务器', 'pac', '科学上网'],
    run: { type: 'uri', uri: 'ms-settings:network-proxy' }
  }),
  A({
    id: 'ipconfig', cat: 'network', icon: 'info', name: '查看 IP 配置',
    desc: '查看本机所有网卡的 IPv4 / IPv6 / 网关 / DNS（ipconfig /all）',
    keywords: ['ip', 'ipconfig', 'ip地址', '查看ip', 'mac地址', '网关', 'dns'],
    run: { type: 'output', command: 'ipconfig /all' }
  }),
  A({
    id: 'flushdns', cat: 'network', icon: 'refresh-dns', name: '网页打不开急救（刷新 DNS）',
    desc: '清理电脑网络解析缓存，解决部分网页突然进不去、连不上的问题',
    keywords: ['刷新dns', 'flushdns', 'dns缓存', '清缓存', '域名解析', '打不开网页', '网络急救', '断网', '上不去网'],
    run: { type: 'output', command: 'ipconfig /flushdns' }
  }),
  A({
    id: 'net-clean-proxy', cat: 'network', icon: 'trash-2', name: '一键网络清理（清代理 + 重启资源管理器）',
    desc: '删除 HTTP(S)_PROXY 环境变量、关闭系统代理、刷新 DNS，并自动重启资源管理器让新变量立刻生效（不用重启电脑）',
    keywords: ['清理代理', '代理残留', '网络清理', 'proxy', '环境变量', '系统代理', '断网', '白屏', '急救', '重启资源管理器', 'netkit'],
    danger: true,
    confirm: {
      title: '清理网络代理并重启资源管理器？',
      message: '此操作将执行以下系统级改动：\n1. 清理系统与用户级 HTTP(S)_PROXY 环境变量\n2. 关闭系统代理开关并刷新本地 DNS 缓存\n3. 短暂重启资源管理器以使新变量立即生效（当前打开的文件窗口会瞬间重新加载）。\n\n是否确认执行？',
      okText: '确认清理并重启'
    },
    run: { type: 'ps', scriptFile: 'net-clean.ps1', timeout: 45000 }
  }),
  A({
    id: 'proxy-bypass-cn', cat: 'network', icon: 'shield-check', name: '国产软件直连白名单（剪映别走代理）',
    desc: '给系统代理补上剪映 / 抖音等字节系域名的绕过规则：访问这些域名直连，其他程序照旧走代理，不用关代理',
    keywords: ['剪映', 'jianying', '抖音', '白名单', '绕过', 'bypass', 'proxyoverride', '不走代理', '加速器', 'netkit'],
    confirm: {
      title: '应用国内软件直连白名单？',
      message: '将向 Windows 系统代理配置中追加剪映、抖音等常用域名白名单，避免国内软件流量误走外网代理。',
      okText: '确认应用'
    },
    run: { type: 'ps', scriptFile: 'proxy-bypass.ps1', timeout: 30000 }
  }),
  A({
    id: 'net-doctor', cat: 'network', icon: 'shield-search', name: '反重力体检（查清哪里坏了）',
    desc: '逐项检查代理端口、环境变量、系统代理、进程与日志，直接给出结论：是端口死了还是变量残留',
    keywords: ['反重力', 'antigravity', '体检', '诊断', '白屏', '打不开', '连不上', '登录失败', 'netkit'],
    run: { type: 'ps', scriptFile: 'net-doctor.ps1', timeout: 90000 }
  }),
  A({
    id: 'net-fix-antigravity', cat: 'network', icon: 'settings-tool', name: '修复并启动反重力',
    desc: '先清理代理残留，再自动挑选能出网的代理启动反重力（一步到位）',
    keywords: ['修复反重力', '启动反重力', 'antigravity', '白屏修复', 'netkit'],
    danger: true,
    confirm: {
      title: '修复并启动反重力开发环境？',
      message: '将清理残留的代理配置，自动探测可用出网端口并注入环境变量启动反重力服务。',
      okText: '确认修复启动'
    },
    run: { type: 'ps', scriptFile: 'net-fix.ps1', timeout: 60000 }
  }),
  A({
    id: 'net-start-antigravity', cat: 'network', icon: 'fast-forward', name: '启动反重力（自动选代理）',
    desc: '探测 10808/7890/7897/18809 中能出网的代理，只给反重力进程注入后启动，不动系统设置',
    keywords: ['启动反重力', 'antigravity', '启动器', '代理启动', 'netkit'],
    run: { type: 'ps', scriptFile: 'net-start.ps1', timeout: 45000 }
  }),
  A({
    id: 'renewip', cat: 'network', icon: 'refresh', name: '释放并续约 IP',
    desc: '重新向 DHCP（路由器）获取 IP 地址',
    keywords: ['续约ip', '释放ip', 'dhcp', 'renew', 'ipconfig /renew', '断网修复'],
    danger: true, confirm: { title: '释放并续约网络地址？', message: '网络会短暂断开，VPN、远程桌面、下载和在线会话可能中断。', okText: '确认续约' },
    run: { type: 'output', command: 'ipconfig /release & ipconfig /renew', timeout: 30000 }
  }),
  A({
    id: 'ping', cat: 'network', icon: 'radio', name: 'Ping 网络测试',
    desc: '测试到目标地址的连通性与延迟，如 baidu.com',
    keywords: ['ping', '连通性', '延迟', '网络测试', '丢包', '测网络'],
    ui: { kind: 'input', field: 'host', placeholder: '输入域名或 IP，如 baidu.com / 192.168.1.1', label: '目标地址', pattern: '^[a-zA-Z0-9.\\-:\\[\\]]+$' },
    run: { type: 'special', name: 'ping' }
  }),
  A({
    id: 'portcheck', cat: 'network', icon: 'port', name: '端口占用查询',
    desc: '查询某个端口被哪个进程占用（netstat + tasklist），开发排错常用',
    keywords: ['端口', '端口占用', 'netstat', 'port', '3000', '8080', '占用端口', 'pid'],
    ui: { kind: 'input', field: 'port', placeholder: '输入端口号，如 3000、8080、3306', label: '端口号', inputType: 'number', pattern: '^\\d{1,5}$' },
    run: { type: 'special', name: 'port-check' }
  }),
  A({
    id: 'wifipass', cat: 'network', icon: 'key', name: '查看本机 WiFi 密码',
    desc: '大字明文显示电脑连过的无线网络密码，朋友来家里免找路由器',
    keywords: ['wifi密码', '无线密码', 'wlan密码', 'netsh wlan', '查看wifi密码', '热点密码', 'wifi', 'wf', '密码', '无线网密码'],
    ui: { kind: 'input', field: 'ssid', placeholder: '留空=当前连接的 WiFi，或输入 WiFi 名称', label: 'WiFi 名称（可选）', required: false },
    run: { type: 'special', name: 'wifi-password' }
  }),
  A({
    id: 'route-print', cat: 'network', icon: 'route', name: '查看路由表',
    desc: '显示本机 IPv4 路由表（route print -4）',
    keywords: ['路由表', 'route', 'route print', '静态路由', '网关路由'],
    run: { type: 'output', command: 'route print -4' }
  }),
  A({
    id: 'mstsc', cat: 'network', icon: 'monitor-share', name: '远程桌面连接',
    desc: '连接到另一台开启远程桌面的 Windows 电脑（mstsc）',
    keywords: ['远程桌面', 'mstsc', 'rdp', '远程控制', '远程连接'],
    run: { type: 'shell', command: 'mstsc.exe' }
  }),
  A({
    id: 'quickassist', cat: 'network', icon: 'help', name: '快速助手',
    desc: '通过微软 Quick Assist 远程协助他人或寻求协助',
    keywords: ['快速助手', 'quick assist', '远程协助', '远程帮助'],
    run: { type: 'shell', command: 'quickassist.exe' }
  }),
  A({
    id: 'repair-network', cat: 'network', icon: 'refresh', name: '一键重置网络协议栈',
    desc: '修复无法上网、DNS 污染或 Winsock 损坏（需管理员权限，建议稍后重启）',
    keywords: ['网络修复', '重置网络', 'winsock reset', '打不开网页', '网络急救', '断网修复'],
    danger: true, confirm: { title: '确认一键重置网络协议栈？', message: '将执行 winsock reset、ip reset 并刷新 DNS。网络会短暂中断，若需完全恢复建议随后重启计算机。', okText: '开始重置' },
    run: { type: 'special', name: 'repair-network' }
  }),

  /* ============================== 安全卫士与系统管理 ============================== */
  A({
    id: 'gaming-boost-now', cat: 'gaming', icon: 'zap', name: '游戏瞬时极速加速',
    desc: '毫秒级排空待机缓存 (Standby List)、修剪后台无关内存，并提升当前游戏前台调度优先级（全局热键 Ctrl+F11）',
    keywords: ['游戏加速', '瞬时加速', '极速加速', '电竞加速', '清理内存', '排空待机', 'fps优化', '掉帧', 'boost', 'game'],
    run: { type: 'special', name: 'gaming-boost-now' }
  }),
  A({
    id: 'cleaner-junk', cat: 'cleaner', icon: 'broom', name: '垃圾清理（临时文件与软件缓存）',
    desc: '分级扫描系统临时文件、浏览器缓存、桌面客户端冗余与回收站，默认安全清理不误删',
    keywords: ['垃圾清理', '清理垃圾', '缓存清理', '临时文件', '清理缓存', 'clean', 'junk'],
    run: { type: 'view', name: 'cleaner' }
  }),
  A({
    id: 'cdrive-clean', cat: 'cdrive', icon: 'hard-drive', name: 'C 盘专清（系统瘦身 / 微信QQ / 无损搬家）',
    desc: '针对 C 盘爆红深度清理系统更新缓存与休眠文件、隔离聊天数据库清理微信 QQ 缓存并支持 AppData 跨盘搬家',
    keywords: ['C盘清理', 'C盘专清', '空间不足', '微信清理', 'AppData搬家', '大文件', 'cdrive'],
    run: { type: 'view', name: 'cdrive' }
  }),
  A({
    id: 'sys-boost', cat: 'maintain', icon: 'zap', name: '一键极速优化加速',
    desc: '深度整理进程工作集内存、清理临时垃圾文件并刷新 DNS 缓存',
    keywords: ['一键加速', '加速', '内存加速', '清理垃圾', '清理内存', '释放内存', '卡顿', '提速'],
    run: { type: 'view', name: 'boost' }
  }),
  A({
    id: 'startup-manager', cat: 'maintain', icon: 'rocket', name: '开机自启动管理',
    desc: '查看与管理注册表及启动文件夹中的开机启动程序，防止开机卡慢',
    keywords: ['自启动', '开机启动', '启动项', '自启动管理', '开机加速', '禁止自启'],
    run: { type: 'view', name: 'startup' }
  }),
  A({
    id: 'context-menu-manager', cat: 'maintain', icon: 'menu', name: '右键菜单管理',
    desc: '管理桌面与文件右键菜单扩展，一键切换 Win11 经典/新版右键',
    keywords: ['右键菜单', '经典右键', 'win11右键', '右键管理', '折叠菜单', '显示更多选项'],
    run: { type: 'view', name: 'context-menu' }
  }),
  A({
    id: 'pure-native-context-menu', cat: 'maintain', icon: 'shield', name: '一键纯净原生右键',
    desc: '一键屏蔽所有第三方软件注入的右键菜单，还原纯净原生右键（可随时按需重新开启）',
    keywords: ['纯净右键', '原生右键', '清理右键', '默认右键', '右键清理', '系统右键', '恢复原生', '还原右键', '干净右键'],
    danger: false,
    confirm: {
      title: '确认一键还原纯净原生右键？',
      message: '将一键屏蔽所有第三方扩展（如 360压缩、7-Zip、网盘、Git、第三方AI等），自动重启资源管理器以恢复最干净的系统原生右键。\n\n该操作 100% 可逆：你随时可以在「右键菜单管理」中单独勾选开启你需要的软件。',
      okText: '立即还原纯净'
    },
    run: { type: 'special', name: 'pure-native-context-menu' }
  }),
  A({
    id: 'registry-tweaks', cat: 'maintain', icon: 'shield', name: '系统卫士与注册表调优',
    desc: '一键切换常用系统开关：显示文件扩展名、显示隐藏文件、禁用后台驻留等',
    keywords: ['注册表', '扩展名', '隐藏文件', '系统调优', '卫士开关', '后缀名'],
    run: { type: 'view', name: 'registry' }
  }),

  /* ============================== 系统维护 ============================== */
  A({
    id: 'recycle-empty', cat: 'maintain', icon: 'trash', name: '清空回收站',
    desc: '永久删除所有磁盘回收站中的文件',
    keywords: ['清空回收站', '回收站', 'recycle bin', '删除垃圾', 'clear recycle'],
    danger: true, confirm: { title: '清空所有回收站？', message: '回收站中的文件将被永久删除，无法恢复。', okText: '全部清空' },
    run: { type: 'ps', script: "Clear-RecycleBin -Force -ErrorAction SilentlyContinue; if($?){'回收站已清空'}" }
  }),
  A({
    id: 'cleanmgr', cat: 'maintain', icon: 'broom', name: '磁盘清理',
    desc: '使用系统磁盘清理工具删除临时文件、更新缓存（cleanmgr）',
    keywords: ['磁盘清理', 'cleanmgr', '清理垃圾', 'c盘清理', '释放空间'],
    run: { type: 'shell', command: 'cleanmgr.exe' }
  }),
  A({
    id: 'temp-folder', cat: 'maintain', icon: 'folder', name: '打开临时文件夹',
    desc: '打开 %TEMP%，手动检查与清理临时文件',
    keywords: ['临时文件夹', 'temp', '%temp%', '缓存文件夹'],
    run: { type: 'shell', command: 'explorer.exe "%TEMP%"' }
  }),
  A({
    id: 'temp-clean', cat: 'maintain', icon: 'broom', name: '安全清理系统临时垃圾',
    desc: '安全释放用户临时缓存与无用碎片，绝不误删照片和个人文件（占用中的文件自动跳过）',
    keywords: ['清理临时文件', '删缓存', '清temp', '一键清理', '垃圾文件', 'c盘清理', '释放空间', '清理垃圾', 'c盘满', '电脑卡'],
    danger: true, confirm: { title: '清理系统临时垃圾？', message: '将清理系统与用户临时目录无用缓存文件，正在运行中的软件文件会自动安全跳过。', okText: '开始安全清理' },
    run: { type: 'special', name: 'clean-temp' }
  }),
  A({
    id: 'clipboard-clear', cat: 'maintain', icon: 'clipboard-off', name: '清空剪贴板',
    desc: '清除剪贴板中复制的内容（含敏感的密码、文本）',
    keywords: ['清空剪贴板', '剪贴板', 'clipboard', '清除复制', '隐私'],
    danger: true, confirm: { title: '清空剪贴板？', message: '当前复制的文本、图片和文件引用将被清除，无法撤销。', okText: '确认清空' },
    run: { type: 'ps', script: "Set-Clipboard -Value ''; '剪贴板已清空'" }
  }),
  A({
    id: 'restart-explorer', cat: 'maintain', icon: 'refresh', name: '桌面 / 任务栏卡死急救刷新',
    desc: '桌面图标消失、任务栏转圈卡死时一键复原，无需重启整台电脑',
    keywords: ['重启资源管理器', 'explorer', '任务栏卡死', '桌面卡死', '任务栏没反应', '卡死急救', '图标没了'],
    danger: true, confirm: { title: '急救刷新 Windows 桌面与任务栏？', message: '任务栏、桌面和文件夹窗口会瞬间重载并自动恢复正常。', okText: '确认刷新' },
    run: { type: 'special', name: 'restart-explorer' }
  }),
  A({
    id: 'kill-not-responding', cat: 'maintain', icon: 'power', name: '强退卡死未响应软件',
    desc: '一键结束所有卡死、白屏、未响应的程序，精准救急不拔电源',
    keywords: ['强退', '卡死', '未响应', '强制关闭', '关闭卡死', '急救', 'taskkill', '死机', '游戏卡死', '白屏'],
    danger: true, confirm: { title: '强退所有未响应卡死程序？', message: '系统将强制关闭当前处于卡死/未响应状态的程序窗口，正常运行的程序不受影响。', okText: '一键强退' },
    run: { type: 'output', command: 'taskkill /f /fi "status eq not responding"' }
  }),
  A({
    id: 'sfc', cat: 'maintain', icon: 'shield-check', name: '系统文件修复（SFC）',
    desc: '以管理员身份扫描并修复受保护的系统文件（sfc /scannow）',
    keywords: ['sfc', '系统修复', 'sfc /scannow', '系统文件', '修复系统'],
    danger: true, confirm: { title: '启动系统文件修复？', message: '将请求管理员权限并执行 sfc /scannow。扫描可能持续较长时间，请勿中途关闭命令窗口。', okText: '继续并申请权限' },
    run: { type: 'special', name: 'sfc' }
  }),
  A({
    id: 'dism', cat: 'maintain', icon: 'shield-check', name: '系统映像修复（DISM）',
    desc: '以管理员身份修复 Windows 系统映像，SFC 无效时使用',
    keywords: ['dism', '映像修复', 'restorehealth', '修复windows', '系统修复'],
    danger: true, confirm: { title: '启动系统映像修复？', message: '将请求管理员权限并执行 DISM RestoreHealth。过程可能耗时较长并使用网络。', okText: '继续并申请权限' },
    run: { type: 'special', name: 'dism' }
  }),
  A({
    id: 'startup-folder', cat: 'maintain', icon: 'rocket', name: '打开启动文件夹',
    desc: '放入该文件夹的程序会在开机登录后自动启动（shell:startup）',
    keywords: ['启动文件夹', '开机启动', '自启动', 'startup', 'shell:startup'],
    run: { type: 'shell', command: 'explorer.exe shell:startup' }
  }),
  A({
    id: 'fonts-folder', cat: 'maintain', icon: 'type', name: '字体文件夹',
    desc: '安装 / 删除字体（把字体文件拖入即可安装）',
    keywords: ['字体', 'fonts', '安装字体', '字体文件夹'],
    run: { type: 'shell', command: 'explorer.exe shell:fonts' }
  }),
  A({
    id: 'hosts-edit', cat: 'maintain', icon: 'file-edit', name: '以管理员编辑 hosts',
    desc: '用记事本以管理员权限打开 hosts 文件，修改域名指向',
    keywords: ['hosts', 'hosts文件', '域名指向', '改hosts', '本地解析'],
    danger: true, confirm: { title: '以管理员权限编辑 hosts？', message: '错误内容会影响网站和网络服务访问。保存前请确认域名与 IP 配置。', okText: '确认打开' },
    run: { type: 'special', name: 'edit-hosts' }
  }),
  A({
    id: 'windows-update', cat: 'maintain', icon: 'download', name: 'Windows 更新',
    desc: '检查并安装系统更新',
    keywords: ['windows更新', '系统更新', 'update', '补丁', '升级'],
    run: { type: 'uri', uri: 'ms-settings:windowsupdate' }
  }),
  A({
    id: 'defender', cat: 'maintain', icon: 'shield', name: 'Windows 安全中心',
    desc: '打开杀毒、防火墙与设备安全设置',
    keywords: ['安全中心', 'defender', '杀毒', 'windows defender', '防护'],
    run: { type: 'uri', uri: 'windowsdefender:' }
  }),
  A({
    id: 'defender-scan', cat: 'maintain', icon: 'shield-search', name: '快速杀毒扫描',
    desc: '调用 Defender 执行一次快速扫描并显示结果',
    keywords: ['杀毒扫描', '快速扫描', '病毒扫描', 'defender scan', 'mpcmdrun'],
    confirm: {
      title: '启动 Windows Defender 快速病毒查杀？',
      message: '将调用系统安全中心对内存与关键开机自启区域进行深度病毒与安全威胁排查。',
      okText: '开始扫描'
    },
    run: { type: 'special', name: 'defender-scan' }
  }),
  A({
    id: 'battery-report', cat: 'maintain', icon: 'battery', name: '生成电池报告',
    desc: '生成电池健康度 / 损耗报告 HTML 并自动打开（笔记本适用）',
    keywords: ['电池报告', '电池健康', '电池损耗', 'batteryreport', 'powercfg', '笔记本电池'],
    run: { type: 'special', name: 'battery-report' }
  }),
  A({
    id: 'fix-icon-cache', cat: 'maintain', icon: 'refresh', name: '修复桌面图标黑块 / 异常',
    desc: '清理 Windows 图标与缩略图缓存并重建，解决图标变白、黑块与不显示',
    keywords: ['修复图标', '图标黑块', '图标白块', '图标缓存', '缩略图损坏', '桌面图标异常'],
    danger: true, confirm: { title: '修复桌面图标缓存？', message: '将重启资源管理器并清除 IconCache 数据库，任务栏和桌面会短暂刷新一次。', okText: '确认修复' },
    run: { type: 'special', name: 'fix-icon-cache' }
  }),

  /* ============================== 格式与数据转换 ============================== */
  A({
    id: 'images-to-pdf', cat: 'convert', icon: 'file-image', name: '图片转 PDF（纯本地免费）',
    desc: '多张发票、照片、身份证一键拼成 PDF，不限页数、不传云端、纯本地隐私保护',
    keywords: ['图片转pdf', 'img to pdf', '合并pdf', '导出pdf', '离线转换', '转pdf', '照片转pdf', '免费pdf', '发票合并'],
    ui: { kind: 'image-pdf' },
    run: { type: 'special', name: 'images-to-pdf' }
  }),
  A({
    id: 'word-to-pdf', cat: 'convert', icon: 'file-text', name: 'Word 转 PDF（纯本地免费）',
    desc: '直接调用本机 Office/WPS 导出高保真 PDF，免去网上找付费转换工具的烦恼',
    keywords: ['word转pdf', 'doc转pdf', 'docx转pdf', 'word to pdf', '导出pdf', '免费pdf', 'word转'],
    ui: { kind: 'single-convert', inputType: 'word' },
    run: { type: 'special', name: 'word-to-pdf' }
  }),
  A({
    id: 'text-to-pdf', cat: 'convert', icon: 'file-text', name: '文本 / Markdown 转 PDF',
    desc: '纯本地排版，将 TXT 或 Markdown 笔记转换为格式整齐的 A4 打印级 PDF',
    keywords: ['txt转pdf', 'md转pdf', 'markdown转pdf', '文本转pdf', 'txt to pdf'],
    ui: { kind: 'single-convert', inputType: 'text' },
    run: { type: 'special', name: 'text-to-pdf' }
  }),
  A({
    id: 'file-hash', cat: 'convert', icon: 'hash', name: '文件哈希与校验（MD5/SHA）',
    desc: '纯本地计算任意文件的 MD5、SHA-1 和 SHA-256，核对安装包或文件完整性',
    keywords: ['哈希', 'md5', 'sha256', 'sha1', '文件校验', '完整性', 'hash'],
    ui: { kind: 'file-hash' },
    run: { type: 'special', name: 'file-hash' }
  }),
  A({
    id: 'json-tool', cat: 'convert', icon: 'code', name: 'JSON 格式化 / 压缩校验',
    desc: '本地离线美化 JSON、格式校验并排查语法错误，或压缩成单行',
    keywords: ['json', '格式化', 'json格式化', '压缩json', '格式校验', '代码美化'],
    ui: { kind: 'text-tool', toolType: 'json' },
    run: { type: 'special', name: 'json-tool' }
  }),
  A({
    id: 'base64-tool', cat: 'convert', icon: 'binary', name: 'Base64 快速编码 / 解码',
    desc: '本地快速进行 UTF-8 文本与 Base64 字符串的相互转换',
    keywords: ['base64', '编码', '解码', 'base64转换', '解密'],
    ui: { kind: 'text-tool', toolType: 'base64' },
    run: { type: 'special', name: 'base64-tool' }
  }),

  /* ============================== 窗口与桌面 ============================== */
  A({
    id: 'show-desktop', cat: 'window', icon: 'minimize', name: '显示桌面',
    desc: '最小化所有窗口，再按一次恢复（Win + D）',
    keywords: ['显示桌面', 'win+d', '桌面', '最小化全部', '回到桌面'],
    run: { type: 'hotkey', keys: ['LWIN', 'D'] }
  }),
  A({
    id: 'task-view', cat: 'window', icon: 'layers', name: '任务视图',
    desc: '查看所有打开的窗口与虚拟桌面（Win + Tab）',
    keywords: ['任务视图', 'win+tab', '窗口切换', '虚拟桌面总览'],
    run: { type: 'hotkey', keys: ['LWIN', 'TAB'] }
  }),
  A({
    id: 'vd-new', cat: 'window', icon: 'plus-square', name: '新建虚拟桌面',
    desc: '创建一个新的虚拟桌面（Win + Ctrl + D）',
    keywords: ['虚拟桌面', '新建桌面', 'win+ctrl+d', '多桌面'],
    run: { type: 'hotkey', keys: ['LWIN', 'CONTROL', 'D'] }
  }),
  A({
    id: 'vd-close', cat: 'window', icon: 'x-square', name: '关闭虚拟桌面',
    desc: '关闭当前虚拟桌面，窗口移至相邻桌面（Win + Ctrl + F4）',
    keywords: ['关闭桌面', 'win+ctrl+f4', '关闭虚拟桌面'],
    run: { type: 'hotkey', keys: ['LWIN', 'CONTROL', 'F4'] }
  }),
  A({
    id: 'vd-left', cat: 'window', icon: 'arrow-left', name: '切换到左侧虚拟桌面',
    desc: 'Win + Ctrl + ←',
    keywords: ['切换桌面', '虚拟桌面左', 'win+ctrl+left'],
    run: { type: 'hotkey', keys: ['LWIN', 'CONTROL', 'LEFT'] }
  }),
  A({
    id: 'vd-right', cat: 'window', icon: 'arrow-right', name: '切换到右侧虚拟桌面',
    desc: 'Win + Ctrl + →',
    keywords: ['切换桌面', '虚拟桌面右', 'win+ctrl+right'],
    run: { type: 'hotkey', keys: ['LWIN', 'CONTROL', 'RIGHT'] }
  }),
  A({
    id: 'snap-left', cat: 'window', icon: 'panel-left', name: '窗口贴靠左半屏',
    desc: 'Win + ←，继续按可调整分屏比例',
    keywords: ['分屏', '左半屏', '贴靠', 'snap left', 'win+left'],
    run: { type: 'hotkey', keys: ['LWIN', 'LEFT'] }
  }),
  A({
    id: 'snap-right', cat: 'window', icon: 'panel-right', name: '窗口贴靠右半屏',
    desc: 'Win + →',
    keywords: ['分屏', '右半屏', '贴靠', 'snap right', 'win+right'],
    run: { type: 'hotkey', keys: ['LWIN', 'RIGHT'] }
  }),
  A({
    id: 'win-maximize', cat: 'window', icon: 'maximize', name: '最大化窗口',
    desc: 'Win + ↑',
    keywords: ['最大化', 'win+up', '全屏窗口'],
    run: { type: 'hotkey', keys: ['LWIN', 'UP'] }
  }),
  A({
    id: 'win-minimize', cat: 'window', icon: 'minimize', name: '还原 / 最小化窗口',
    desc: 'Win + ↓',
    keywords: ['最小化', '还原窗口', 'win+down'],
    run: { type: 'hotkey', keys: ['LWIN', 'DOWN'] }
  }),
  A({
    id: 'minimize-others', cat: 'window', icon: 'minimize', name: '最小化其他窗口',
    desc: '只保留当前窗口，其余全部最小化（Win + Home）',
    keywords: ['最小化其他', 'win+home', '桌面清爽'],
    run: { type: 'hotkey', keys: ['LWIN', 'HOME'] }
  }),
  A({
    id: 'project', cat: 'window', icon: 'cast', name: '投影 / 外接显示器',
    desc: '切换复制、扩展、仅第二屏幕（Win + P）',
    keywords: ['投影', '外接显示器', '扩展屏', '投屏', 'win+p', '第二屏幕', '投影仪'],
    run: { type: 'hotkey', keys: ['LWIN', 'P'] }
  }),
  A({
    id: 'quick-settings', cat: 'window', icon: 'sliders', name: '快速设置',
    desc: '打开音量 / WiFi / 亮度面板（Win + A）',
    keywords: ['快速设置', 'win+a', '音量面板', 'wifi面板'],
    run: { type: 'hotkey', keys: ['LWIN', 'A'] }
  }),
  A({
    id: 'notifications', cat: 'window', icon: 'bell', name: '通知中心 / 日历',
    desc: '打开通知与日历面板（Win + N）',
    keywords: ['通知中心', '日历', 'win+n', '通知'],
    run: { type: 'hotkey', keys: ['LWIN', 'N'] }
  }),
  A({
    id: 'snap-layouts', cat: 'window', icon: 'layout', name: '贴靠布局',
    desc: '悬停最大化按钮的同款布局菜单（Win + Z）',
    keywords: ['贴靠布局', 'snap layouts', 'win+z', '分屏布局'],
    run: { type: 'hotkey', keys: ['LWIN', 'Z'] }
  }),
  A({
    id: 'input-switch', cat: 'window', icon: 'languages', name: '切换输入法 / 键盘布局',
    desc: 'Win + Space',
    keywords: ['切换输入法', '输入法', 'win+space', '中英文切换', '键盘布局'],
    run: { type: 'hotkey', keys: ['LWIN', 'SPACE'] }
  }),
  A({
    id: 'window-switch', cat: 'window', icon: 'repeat', name: '切换到上一个窗口',
    desc: 'Alt + Tab',
    keywords: ['alt+tab', '切换窗口', '窗口切换'],
    run: { type: 'hotkey', keys: ['MENU', 'TAB'] }
  }),

  /* ============================== 效率工具 ============================== */
  A({
    id: 'antigravity-hanhua', cat: 'tools', icon: 'languages', name: '反重力汉化',
    desc: '官方更新后一键热更新汉化（自动检测版本；只在需要时重建，失败自动回滚官方版）',
    keywords: ['反重力', 'antigravity', '汉化', '汉化补丁', '中文化', '重打包', 'repack', 'agy', '翻译补丁', '热更新'],
    confirm: {
      title: '反重力热更新？',
      message: '会先检测补丁状态：健康就直接跳过；官方刚更新或补丁损坏时，才会关闭并重启反重力重建补丁，失败自动回滚官方版。',
      okText: '开始'
    },
    run: { type: 'special', name: 'antigravity-hot-update' }
  }),
  A({
    id: 'calc', cat: 'tools', icon: 'calculator', name: '计算器',
    desc: '打开系统计算器（标准 / 科学 / 程序员 / 换算）',
    keywords: ['计算器', 'calc', 'calculator', '计算'],
    run: { type: 'shell', command: 'calc.exe' }
  }),
  A({
    id: 'notepad', cat: 'tools', icon: 'file-text', name: '记事本',
    desc: '轻量纯文本编辑器',
    keywords: ['记事本', 'notepad', '文本', 'txt', '笔记'],
    run: { type: 'shell', command: 'notepad.exe' }
  }),
  A({
    id: 'paint', cat: 'tools', icon: 'brush', name: '画图',
    desc: '简单绘图与图片标注、裁剪、转换格式（mspaint）',
    keywords: ['画图', 'paint', 'mspaint', '绘图', '图片编辑'],
    run: { type: 'shell', command: 'mspaint.exe' }
  }),
  A({
    id: 'charmap', cat: 'tools', icon: 'type', name: '字符映射表',
    desc: '查找并复制特殊符号、生僻字、字体图标（charmap）',
    keywords: ['字符映射表', 'charmap', '特殊符号', '特殊字符', '符号'],
    run: { type: 'shell', command: 'charmap.exe' }
  }),
  A({
    id: 'magnifier', cat: 'tools', icon: 'zoom', name: '放大镜',
    desc: '放大屏幕局部，演示 / 看小字（magnify）',
    keywords: ['放大镜', 'magnifier', '放大', 'zoom', '老花'],
    run: { type: 'shell', command: 'magnify.exe' }
  }),
  A({
    id: 'osk', cat: 'tools', icon: 'keyboard', name: '屏幕键盘',
    desc: '物理键盘失灵或需要安全输入密码时使用（osk）',
    keywords: ['屏幕键盘', 'osk', '软键盘', '虚拟键盘', '键盘坏了'],
    run: { type: 'shell', command: 'osk.exe' }
  }),
  A({
    id: 'sticky-notes', cat: 'tools', icon: 'sticky-note', name: '便签',
    desc: '桌面便签，随手记录待办',
    keywords: ['便签', '便利贴', 'sticky notes', '备忘', '便笺'],
    run: { type: 'shell', command: 'explorer.exe "shell:AppsFolder\\Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe!App"' }
  }),
  A({
    id: 'clock', cat: 'tools', icon: 'clock', name: '闹钟和时钟',
    desc: '闹钟、计时器、秒表、世界时钟',
    keywords: ['闹钟', '时钟', '计时器', '秒表', '世界时钟', '专注'],
    run: { type: 'uri', uri: 'ms-clock:' }
  }),
  A({
    id: 'sound-recorder', cat: 'tools', icon: 'mic', name: '语音录音机',
    desc: '录制麦克风 / 系统声音',
    keywords: ['录音', '录音机', 'sound recorder', '语音录制', '音频录制'],
    run: { type: 'shell', command: 'explorer.exe "shell:AppsFolder\\Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe!App"' }
  }),
  A({
    id: 'camera', cat: 'tools', icon: 'camera', name: '相机',
    desc: '调用摄像头拍照、录像',
    keywords: ['相机', '摄像头', 'camera', '拍照', ' webcam'],
    run: { type: 'shell', command: 'explorer.exe "shell:AppsFolder\\Microsoft.WindowsCamera_8wekyb3d8bbwe!App"' }
  }),
  A({
    id: 'clipboard-history', cat: 'tools', icon: 'clipboard', name: '剪贴板历史记录',
    desc: '调出最近复制的多条内容并可粘贴（Win + V，需在设置中开启）',
    keywords: ['剪贴板历史', 'win+v', '复制历史', 'clipboard history', '多段复制'],
    run: { type: 'hotkey', keys: ['LWIN', 'V'] }
  }),
  A({
    id: 'emoji-panel', cat: 'tools', icon: 'smile', name: '表情 / 符号 / 颜文字面板',
    desc: '输入 Emoji、特殊符号、颜文字（Win + .）',
    keywords: ['emoji', '表情', '颜文字', '特殊符号', 'win+.', '表情面板'],
    run: { type: 'hotkey', keys: ['LWIN', 'OEM_PERIOD'] }
  }),

  /* ============================== 应用内视图（可被搜索） ============================== */
  A({
    id: 'view-shortcuts', cat: 'shortcuts', icon: 'keyboard', name: '快捷键手册',
    desc: 'Windows / 浏览器 / Word / Excel / VS Code 常用快捷键速查',
    keywords: ['快捷键', '手册', 'cheatsheet', '快捷键大全', '键盘', '速查表', '组合键'],
    run: { type: 'view', name: 'shortcuts' }
  }),
  A({
    id: 'view-settings', cat: 'settings', icon: 'settings', name: '设置',
    desc: '主题、全局快捷键、开机自启、默认终端等偏好设置',
    keywords: ['设置', '偏好', '主题', '深色模式', '开机自启', 'settings', '配置'],
    run: { type: 'view', name: 'settings' }
  })
];

// 供自定义命令工厂使用（运行时由执行器合并用户自定义动作）
const CUSTOM_ADD = Object.freeze({
  id: 'custom-add', cat: 'custom', icon: 'plus-circle', name: '新建自定义命令',
  desc: '把常用命令、脚本、程序路径保存成一张卡片，一键执行',
  keywords: ['新建命令', '添加命令', '自定义', 'add command', '我的命令'],
  ui: { kind: 'custom-add' },
  run: { type: 'view', name: 'custom-add' }
});

const ACTION_MAP = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

module.exports = { CATEGORIES, ACTIONS, ACTION_MAP, CUSTOM_ADD };
