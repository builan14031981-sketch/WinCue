'use strict';

// 快捷键手册：k=按键，d=说明
const TABS = [
  {
    id: 'win', name: 'Windows 通用',
    sections: [
      {
        title: '系统与开始',
        rows: [
          { k: 'Win', d: '打开开始菜单' },
          { k: 'Win + S', d: '系统搜索' },
          { k: 'Win + I', d: '系统设置' },
          { k: 'Win + E', d: '文件资源管理器' },
          { k: 'Win + R', d: '运行对话框' },
          { k: 'Win + X', d: '快捷链接菜单（设备管理器等）' },
          { k: 'Win + A', d: '快速设置（WiFi / 音量 / 亮度）' },
          { k: 'Win + N', d: '通知中心与日历' },
          { k: 'Win + W', d: '小组件面板（Win11）' },
          { k: 'Win + K', d: '无线显示器 / 音频连接' },
          { k: 'Win + P', d: '投影 / 外接显示器' },
          { k: 'Win + L', d: '锁定计算机' },
          { k: 'Win + ,', d: '临时瞥一眼桌面' },
          { k: 'Win + Pause', d: '系统关于页面' },
          { k: 'Win + U', d: '辅助功能设置' },
          { k: 'Win + H', d: '语音输入（语音转文字）' },
          { k: 'Win + Space', d: '切换输入法 / 键盘布局' },
          { k: 'Win + .', d: 'Emoji / 符号 / 颜文字面板' },
          { k: 'Win + V', d: '剪贴板历史记录' },
          { k: 'Win + 数字键', d: '启动 / 切换任务栏上第 N 个程序' }
        ]
      },
      {
        title: '任务管理与急救',
        rows: [
          { k: 'Ctrl + Shift + Esc', d: '直接打开任务管理器' },
          { k: 'Ctrl + Alt + Delete', d: '安全选项界面（锁屏 / 任务管理器）' },
          { k: 'Alt + F4', d: '关闭当前窗口 / 关机' },
          { k: 'Alt + Tab', d: '在打开的窗口间切换' },
          { k: 'Win + Ctrl + Shift + B', d: '重启显卡驱动（黑屏 / 花屏急救）' },
          { k: 'Win + Ctrl + Enter', d: '打开 / 关闭讲述人' },
          { k: 'Win + + / -', d: '打开放大镜并放大 / 缩小' },
          { k: 'Win + Esc', d: '关闭放大镜' },
          { k: 'Win + Ctrl + O', d: '屏幕键盘' }
        ]
      },
      {
        title: '通用编辑',
        rows: [
          { k: 'Ctrl + C / X / V', d: '复制 / 剪切 / 粘贴' },
          { k: 'Ctrl + Z / Y', d: '撤销 / 重做' },
          { k: 'Ctrl + A', d: '全选' },
          { k: 'Ctrl + S', d: '保存' },
          { k: 'Ctrl + Shift + Esc', d: '任务管理器' },
          { k: 'Shift + 右键', d: '扩展右键菜单（复制为路径等）' },
          { k: 'F2', d: '重命名' },
          { k: 'F5', d: '刷新' },
          { k: 'Alt + Enter', d: '查看选中项属性' },
          { k: 'Alt + 双击', d: '查看属性（鼠标版）' },
          { k: 'PrintScreen', d: '全屏截图到剪贴板' },
          { k: 'Alt + PrintScreen', d: '当前窗口截图到剪贴板' }
        ]
      }
    ]
  },
  {
    id: 'window', name: '窗口与桌面',
    sections: [
      {
        title: '窗口管理',
        rows: [
          { k: 'Win + D', d: '显示桌面，再按恢复窗口' },
          { k: 'Win + M', d: '最小化所有窗口' },
          { k: 'Win + Home', d: '只保留当前窗口，其余最小化' },
          { k: 'Win + ↑', d: '最大化' },
          { k: 'Win + ↓', d: '还原 / 最小化' },
          { k: 'Win + ← / →', d: '窗口贴靠左 / 右半屏' },
          { k: 'Win + Z', d: '贴靠布局（多窗格分屏）' },
          { k: 'Win + Shift + ← / →', d: '把窗口移到另一台显示器' },
          { k: 'Win + T', d: '在任务栏程序间循环' },
          { k: 'Win + B', d: '聚焦右下角系统托盘' }
        ]
      },
      {
        title: '虚拟桌面',
        rows: [
          { k: 'Win + Tab', d: '任务视图（总览窗口与桌面）' },
          { k: 'Win + Ctrl + D', d: '新建虚拟桌面' },
          { k: 'Win + Ctrl + F4', d: '关闭当前虚拟桌面' },
          { k: 'Win + Ctrl + ← / →', d: '切换到相邻虚拟桌面' }
        ]
      }
    ]
  },
  {
    id: 'capture', name: '截图录屏',
    sections: [
      {
        title: '截图',
        rows: [
          { k: 'Win + Shift + S', d: '区域截图（矩形 / 任意形状 / 窗口 / 全屏）' },
          { k: 'Win + PrintScreen', d: '全屏截图并自动保存到「图片\\屏幕截图」' },
          { k: 'PrintScreen', d: '全屏截图到剪贴板' },
          { k: 'Alt + PrintScreen', d: '当前窗口截图到剪贴板' }
        ]
      },
      {
        title: '录屏（Xbox Game Bar）',
        rows: [
          { k: 'Win + G', d: '打开 Game Bar' },
          { k: 'Win + Alt + R', d: '开始 / 停止录制当前窗口' },
          { k: 'Win + Alt + G', d: '录制最近 30 秒（需开启后台录制）' },
          { k: 'Win + Alt + M', d: '麦克风开关' },
          { k: 'Win + Alt + PrintScreen', d: '录制中截图' }
        ]
      }
    ]
  },
  {
    id: 'files', name: '文件资源管理器',
    sections: [
      {
        title: '浏览与定位',
        rows: [
          { k: 'Win + E', d: '打开文件资源管理器' },
          { k: 'Alt + D / Ctrl + L', d: '光标跳到地址栏' },
          { k: 'Ctrl + F / F3', d: '搜索当前文件夹' },
          { k: 'Alt + ← / Backspace', d: '后退' },
          { k: 'Alt + →', d: '前进' },
          { k: 'Alt + ↑', d: '回到上一级文件夹' },
          { k: 'Ctrl + 滚轮', d: '放大 / 缩小图标' },
          { k: 'Ctrl + Shift + 1~8', d: '切换超大图标到详细信息等视图' },
          { k: 'Alt + P', d: '打开 / 关闭预览窗格' },
          { k: 'F11', d: '全屏显示' }
        ]
      },
      {
        title: '文件操作',
        rows: [
          { k: 'Ctrl + Shift + N', d: '新建文件夹' },
          { k: 'F2', d: '重命名（选中多个可批量重命名）' },
          { k: 'Delete', d: '删除到回收站' },
          { k: 'Shift + Delete', d: '永久删除（不进回收站）' },
          { k: 'Ctrl + Z', d: '撤销删除 / 移动' },
          { k: 'Ctrl + Y', d: '重做' },
          { k: 'Alt + Enter', d: '文件属性' },
          { k: 'Shift + 右键', d: '扩展菜单：复制为路径、在此处打开终端' },
          { k: '按住 Ctrl 拖动', d: '复制文件' },
          { k: '按住 Alt 拖动', d: '创建快捷方式' }
        ]
      }
    ]
  },
  {
    id: 'browser', name: '浏览器（Edge / Chrome）',
    sections: [
      {
        title: '标签页与窗口',
        rows: [
          { k: 'Ctrl + T', d: '新建标签页' },
          { k: 'Ctrl + W', d: '关闭当前标签页' },
          { k: 'Ctrl + Shift + T', d: '恢复刚关闭的标签页' },
          { k: 'Ctrl + Tab / Ctrl + PgDn', d: '切到下一个标签页' },
          { k: 'Ctrl + 1 ~ 8', d: '切到第 N 个标签页' },
          { k: 'Ctrl + 9', d: '切到最后一个标签页' },
          { k: 'Ctrl + N', d: '新窗口' },
          { k: 'Ctrl + Shift + N', d: '新建 InPrivate / 无痕窗口' },
          { k: 'Alt + ← / →', d: '后退 / 前进' },
          { k: 'F6 / Ctrl + L / Alt + D', d: '聚焦地址栏' },
          { k: '中键点标签', d: '关闭该标签页' }
        ]
      },
      {
        title: '页面与功能',
        rows: [
          { k: 'Ctrl + F', d: '页内查找' },
          { k: 'Ctrl + D', d: '加入收藏夹' },
          { k: 'Ctrl + H', d: '历史记录' },
          { k: 'Ctrl + J', d: '下载列表' },
          { k: 'Ctrl + Shift + O', d: '收藏夹管理' },
          { k: 'Ctrl + Shift + Delete', d: '清除浏览数据' },
          { k: 'F5 / Ctrl + R', d: '刷新' },
          { k: 'Ctrl + F5', d: '强制刷新（忽略缓存）' },
          { k: 'Ctrl + + / - / 0', d: '放大 / 缩小 / 恢复缩放' },
          { k: 'F11', d: '全屏' },
          { k: 'F12', d: '开发者工具' },
          { k: 'Ctrl + P', d: '打印 / 另存为 PDF' },
          { k: 'Ctrl + S', d: '保存网页' },
          { k: 'Shift + Esc', d: '浏览器自带任务管理器' }
        ]
      }
    ]
  },
  {
    id: 'word', name: 'Word 排版',
    sections: [
      {
        title: '格式',
        rows: [
          { k: 'Ctrl + B / I / U', d: '加粗 / 斜体 / 下划线' },
          { k: 'Ctrl + ] / [', d: '字号增大 / 减小' },
          { k: 'Ctrl + D', d: '字体设置对话框' },
          { k: 'Ctrl + E / L / R / J', d: '居中 / 左对齐 / 右对齐 / 两端对齐' },
          { k: 'Ctrl + 1 / 2 / 5', d: '单倍 / 双倍 / 1.5 倍行距' },
          { k: 'Ctrl + M', d: '增加段落缩进' },
          { k: 'Ctrl + 空格', d: '清除字符格式' },
          { k: 'Ctrl + Q', d: '清除段落格式' },
          { k: 'Ctrl + Shift + C / V', d: '复制格式 / 应用格式（格式刷）' },
          { k: 'Alt + Ctrl + 1 / 2 / 3', d: '应用标题 1 / 2 / 3 样式' },
          { k: 'Shift + F3', d: '切换英文大小写' },
          { k: 'Ctrl + Shift + 8', d: '显示 / 隐藏编辑标记' }
        ]
      },
      {
        title: '编辑与文档',
        rows: [
          { k: 'Ctrl + F / H / G', d: '查找 / 替换 / 定位' },
          { k: 'Ctrl + K', d: '插入超链接' },
          { k: 'Ctrl + Enter', d: '插入分页符' },
          { k: 'Shift + Enter', d: '软回车（同段换行）' },
          { k: 'Ctrl + Home / End', d: '跳到文档开头 / 结尾' },
          { k: 'Alt + Shift + ← / →', d: '提升 / 降低大纲级别' },
          { k: 'F9', d: '更新所选域（目录 / 页码）' },
          { k: 'F7', d: '拼写和语法检查' },
          { k: 'F12', d: '另存为' },
          { k: 'Ctrl + S / N / P', d: '保存 / 新建 / 打印' }
        ]
      }
    ]
  },
  {
    id: 'excel', name: 'Excel 表格',
    sections: [
      {
        title: '移动与选择',
        rows: [
          { k: 'Ctrl + 方向键', d: '跳到当前数据区域边缘' },
          { k: 'Ctrl + Home / End', d: '跳到 A1 / 最后使用的单元格' },
          { k: 'Ctrl + Shift + 方向键', d: '选中到数据边缘' },
          { k: 'Ctrl + 空格 / Shift + 空格', d: '选中整列 / 整行' },
          { k: 'Ctrl + A / Ctrl + *', d: '全选 / 选中连续数据区域' },
          { k: 'Ctrl + PgUp / PgDn', d: '切换工作表' },
          { k: 'Ctrl + G（F5）', d: '定位（空值、常量、对象等）' }
        ]
      },
      {
        title: '输入与填充',
        rows: [
          { k: 'F2', d: '编辑当前单元格' },
          { k: 'Alt + Enter', d: '单元格内换行' },
          { k: 'Ctrl + Enter', d: '给选中区域批量输入相同内容' },
          { k: 'Ctrl + D / R', d: '向下 / 向右填充' },
          { k: 'Ctrl + E', d: '智能快速填充（拆分 / 合并文本）' },
          { k: 'Ctrl + ;', d: '输入今天日期' },
          { k: 'Ctrl + Shift + :', d: '输入当前时间' },
          { k: 'Alt + =', d: '一键自动求和' },
          { k: 'F4', d: '切换 $ 绝对 / 相对引用，或重复上一步' },
          { k: 'Ctrl + 1', d: '设置单元格格式' },
          { k: 'Ctrl + T（Ctrl + L）', d: '创建超级表' },
          { k: 'Ctrl + Shift + L', d: '开启 / 关闭筛选' },
          { k: 'Ctrl + - / Ctrl + Shift + +', d: '删除 / 插入单元格' },
          { k: 'Ctrl + `', d: '显示 / 隐藏公式' },
          { k: 'F9', d: '重新计算所有工作簿' },
          { k: 'Shift + F11', d: '新建工作表' },
          { k: 'F11', d: '一键生成图表' }
        ]
      }
    ]
  },
  {
    id: 'vscode', name: 'VS Code',
    sections: [
      {
        title: '导航与面板',
        rows: [
          { k: 'Ctrl + P', d: '快速打开文件' },
          { k: 'Ctrl + Shift + P', d: '命令面板（所有命令）' },
          { k: 'Ctrl + Shift + E / F / G', d: '资源管理器 / 搜索 / 源代码管理' },
          { k: 'Ctrl + Shift + X / D', d: '扩展 / 运行和调试' },
          { k: 'Ctrl + B', d: '切换侧边栏' },
          { k: 'Ctrl + J', d: '切换底部面板' },
          { k: 'Ctrl + `', d: '打开集成终端' },
          { k: 'Ctrl + ,', d: '设置' },
          { k: 'Ctrl + G', d: '跳转到指定行' },
          { k: 'Ctrl + Tab', d: '在打开的文件间切换' },
          { k: 'Ctrl + \\', d: '拆分编辑器' },
          { k: 'Ctrl + 1 / 2 / 3', d: '聚焦第 1 / 2 / 3 个编辑器组' }
        ]
      },
      {
        title: '编辑',
        rows: [
          { k: 'Ctrl + D', d: '选中下一个相同词（多光标）' },
          { k: 'Ctrl + Shift + L', d: '选中所有相同词' },
          { k: 'Alt + 单击', d: '插入多个光标' },
          { k: 'Ctrl + Alt + ↑ / ↓', d: '向上 / 下添加光标' },
          { k: 'Alt + ↑ / ↓', d: '上移 / 下移当前行' },
          { k: 'Shift + Alt + ↑ / ↓', d: '向上 / 下复制当前行' },
          { k: 'Ctrl + Shift + K', d: '删除当前行' },
          { k: 'Ctrl + Enter', d: '在下方插入新行' },
          { k: 'Ctrl + /', d: '切换行注释' },
          { k: 'Shift + Alt + A', d: '切换块注释' },
          { k: 'Shift + Alt + F', d: '格式化整个文档' },
          { k: 'Ctrl + ] / [', d: '增加 / 减少缩进' },
          { k: 'Ctrl + L', d: '选中当前行' },
          { k: 'Ctrl + Shift + [ / ]', d: '折叠 / 展开代码块' }
        ]
      },
      {
        title: '代码智能与调试',
        rows: [
          { k: 'F12', d: '转到定义' },
          { k: 'Alt + F12', d: '浮窗查看定义' },
          { k: 'Shift + F12', d: '查看所有引用' },
          { k: 'F2', d: '重命名符号' },
          { k: 'Ctrl + .', d: '快速修复 / 灯泡建议' },
          { k: 'Ctrl + Space', d: '触发代码补全' },
          { k: 'F5 / Shift+F5', d: '开始调试 / 停止' },
          { k: 'F9', d: '切换断点' },
          { k: 'F10 / F11', d: '步过 / 步入' },
          { k: 'Ctrl + K Ctrl + S', d: '快捷键设置' },
          { k: 'Ctrl + K Ctrl + T', d: '切换颜色主题' }
        ]
      }
    ]
  }
];

if (typeof module !== 'undefined' && module.exports) module.exports = { TABS };
