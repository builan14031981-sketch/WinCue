using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

class Program {
    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    static extern uint MapVirtualKey(uint uCode, uint uMapType);

    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;

    static readonly HashSet<byte> ExtendedKeys = new HashSet<byte> {
        0x5B, // LWIN
        0x5C, // RWIN
        0x5D, // APPS
        0x2C, // SNAPSHOT (PRTSC)
        0x2D, // INSERT
        0x2E, // DELETE
        0x24, // HOME
        0x23, // END
        0x21, // PAGE UP
        0x22, // PAGE DOWN
        0x25, // LEFT
        0x26, // UP
        0x27, // RIGHT
        0x28, // DOWN
        0x90, // NUMLOCK
        0x6F  // DIVIDE
    };

    static readonly Dictionary<string, byte> KeyMap = new Dictionary<string, byte>(StringComparer.OrdinalIgnoreCase) {
        {"LWIN", 0x5B}, {"RWIN", 0x5C}, {"WIN", 0x5B},
        {"SHIFT", 0x10}, {"LSHIFT", 0xA0}, {"RSHIFT", 0xA1},
        {"CTRL", 0x11}, {"CONTROL", 0x11}, {"LCTRL", 0xA2}, {"RCTRL", 0xA3},
        {"ALT", 0x12}, {"MENU", 0x12}, {"LALT", 0xA4}, {"RALT", 0xA5},
        {"TAB", 0x09}, {"ENTER", 0x0D}, {"RETURN", 0x0D}, {"ESC", 0x1B}, {"ESCAPE", 0x1B},
        {"SPACE", 0x20}, {"SNAPSHOT", 0x2C}, {"PRTSC", 0x2C}, {"PRTSCN", 0x2C},
        {"BACK", 0x08}, {"BACKSPACE", 0x08}, {"DEL", 0x2E}, {"DELETE", 0x2E}, {"INSERT", 0x2D},
        {"UP", 0x26}, {"DOWN", 0x28}, {"LEFT", 0x25}, {"RIGHT", 0x27},
        {"HOME", 0x24}, {"END", 0x23}, {"PAGEUP", 0x21}, {"PAGEDOWN", 0x22},
        {"F1", 0x70}, {"F2", 0x71}, {"F3", 0x72}, {"F4", 0x73},
        {"F5", 0x74}, {"F6", 0x75}, {"F7", 0x76}, {"F8", 0x77},
        {"F9", 0x78}, {"F10", 0x79}, {"F11", 0x7A}, {"F12", 0x7B}
    };

    static void Main(string[] args) {
        if (args.Length == 0) return;
        string[] tokens = args[0].Split(new[] { ',', '+', ' ' }, StringSplitOptions.RemoveEmptyEntries);
        List<byte> vks = new List<byte>();

        foreach (string t in tokens) {
            string k = t.Trim().ToUpperInvariant();
            if (KeyMap.ContainsKey(k)) {
                vks.Add(KeyMap[k]);
            } else if (k.Length == 1 && ((k[0] >= 'A' && k[0] <= 'Z') || (k[0] >= '0' && k[0] <= '9'))) {
                vks.Add((byte)k[0]);
            }
        }

        if (vks.Count == 0) return;

        // 按顺序按下组合键，微秒级极速响应
        foreach (byte vk in vks) {
            byte scan = (byte)MapVirtualKey(vk, 0);
            uint flags = ExtendedKeys.Contains(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
            keybd_event(vk, scan, flags, UIntPtr.Zero);
            Thread.Sleep(5);
        }

        Thread.Sleep(25);

        // 逆序释放按键
        for (int i = vks.Count - 1; i >= 0; i--) {
            byte vk = vks[i];
            byte scan = (byte)MapVirtualKey(vk, 0);
            uint flags = KEYEVENTF_KEYUP | (ExtendedKeys.Contains(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
            keybd_event(vk, scan, flags, UIntPtr.Zero);
            Thread.Sleep(5);
        }
    }
}
