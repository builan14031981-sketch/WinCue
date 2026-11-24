'use strict';

const { Tray, Menu, nativeImage, dialog } = require('electron');
const gaming = require('./gaming');

function buildTray({ iconPath, executor, onShowMain, onQuit, onOpenContextMenu }) {
  let image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  const tray = new Tray(image);
  tray.setToolTip('WinCue 轻唤盒子 - Windows 效率控制台 (Ctrl+F11 游戏瞬时加速)');

  const confirmAndSet = (mode, label, minutes) => {
    dialog.showMessageBox({
      type: 'question',
      title: `定时${label}确认`,
      message: `将在 ${minutes} 分钟后${label}电脑。`,
      detail: '该计划由 Windows 系统计时，关闭轻唤盒子依然生效。',
      buttons: ['确认', '取消'],
      defaultId: 0,
      cancelId: 1
    }).then((res) => {
      if (res.response !== 0) return;
      executor.setTimer(mode, minutes * 60).then((r) => {
        if (r && r.ok === false) {
          dialog.showErrorBox(`定时${label}设置失败`, r.message || '未知错误');
          return;
        }
        onShowMain(true);
      });
    });
  };

  // 立即类操作的二次确认（与主面板的「重大操作需确认」保持一致）
  const confirmThenRun = (title, message, detail, id) => {
    dialog.showMessageBox({
      type: 'question',
      title,
      message,
      detail,
      buttons: ['确认执行', '取消'],
      defaultId: 0,
      cancelId: 1
    }).then((res) => {
      if (res.response === 0) executor.execute(id);
    });
  };

  const rebuild = () => {
    const menu = Menu.buildFromTemplate([
      {
        label: '⚡ 游戏瞬时加速 (Ctrl+F11)',
        click: async () => {
          try {
            const res = await gaming.runInstantBoost();
            if (tray && typeof tray.displayBalloon === 'function') {
              tray.displayBalloon({
                title: '⚡ 轻唤盒子 · 游戏瞬时加速',
                content: res.message || '已成功排空待机缓存，游戏调度已提速！'
              });
            }
          } catch (_) {}
        }
      },
      {
        label: '🛠️ 右键菜单管家',
        click: () => {
          onShowMain(true);
          if (typeof onOpenContextMenu === 'function') onOpenContextMenu();
        }
      },
      { type: 'separator' },
      { label: '显示 轻唤盒子 主面板', click: () => onShowMain(true) },
      { type: 'separator' },
      { label: '区域截图（Win+Shift+S）', click: () => executor.execute('snip-region') },
      { label: '锁定计算机（Win+L）', click: () => executor.execute('lock') },
      {
        label: '睡眠',
        click: () => confirmThenRun('让电脑进入睡眠？', '当前会话将暂停。', '正在运行的任务与远程连接可能中断，请先保存工作。', 'sleep')
      },
      {
        label: '定时关机',
        submenu: [
          { label: '15 分钟后', click: () => confirmAndSet('shutdown', '关机', 15) },
          { label: '30 分钟后', click: () => confirmAndSet('shutdown', '关机', 30) },
          { label: '1 小时后', click: () => confirmAndSet('shutdown', '关机', 60) },
          { label: '2 小时后', click: () => confirmAndSet('shutdown', '关机', 120) },
          { type: 'separator' },
          { label: '取消计划关机 / 重启', click: () => executor.execute('shutdown-cancel') }
        ]
      },
      {
        label: '定时睡眠',
        submenu: [
          { label: '15 分钟后', click: () => confirmAndSet('sleep', '睡眠', 15) },
          { label: '30 分钟后', click: () => confirmAndSet('sleep', '睡眠', 30) },
          { label: '1 小时后', click: () => confirmAndSet('sleep', '睡眠', 60) },
          { type: 'separator' },
          { label: '取消定时睡眠', click: () => executor.execute('sleep-cancel') }
        ]
      },
      { type: 'separator' },
      { label: '退出 轻唤盒子', click: () => onQuit() }
    ]);
    tray.setContextMenu(menu);
  };
  rebuild();

  tray.on('click', () => onShowMain(false));
  return tray;
}

module.exports = { buildTray };
