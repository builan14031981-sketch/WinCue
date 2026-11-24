using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

class QuickBooster {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public class MEMORYSTATUSEX {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
        public MEMORYSTATUSEX() { this.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)); }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct PROCESSENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("psapi.dll")]
    static extern int EmptyWorkingSet(IntPtr hwProc);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint id);

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct LUID { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID_AND_ATTRIBUTES Privilege; }

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr h, int acc, out IntPtr ph);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool LookupPrivilegeValue(string host, string name, ref LUID luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool AdjustTokenPrivileges(IntPtr h, bool dis, ref TOKEN_PRIVILEGES np, int len, IntPtr prev, IntPtr relen);

    [DllImport("ntdll.dll")]
    public static extern int NtSetSystemInformation(int cls, ref int buf, int len);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    static bool PurgeStandbyList() {
        try {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x0020 | 0x0008, out token)) return false;
            LUID luid = new LUID();
            if (!LookupPrivilegeValue(null, "SeProfileSingleProcessPrivilege", ref luid)) return false;
            TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES();
            tp.PrivilegeCount = 1;
            tp.Privilege.Luid = luid;
            tp.Privilege.Attributes = 2; // SE_PRIVILEGE_ENABLED
            if (!AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero)) return false;
            int command = 4; // MemoryPurgeStandbyList
            return NtSetSystemInformation(80, ref command, 4) == 0;
        } catch {
            return false;
        }
    }

    static ulong GetAvailPhysMB() {
        MEMORYSTATUSEX m = new MEMORYSTATUSEX();
        if (GlobalMemoryStatusEx(m)) {
            return m.ullAvailPhys / (1024 * 1024);
        }
        return 0;
    }

    static void Main(string[] args) {
        Stopwatch sw = Stopwatch.StartNew();
        ulong beforeMB = GetAvailPhysMB();

        // 1. 获取前台焦点游戏窗口并提升优先级
        uint fgPid = 0;
        string fgProcessName = "";
        bool boostedPriority = false;
        try {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd != IntPtr.Zero) {
                GetWindowThreadProcessId(hwnd, out fgPid);
                if (fgPid > 0) {
                    using (Process fgP = Process.GetProcessById((int)fgPid)) {
                        fgProcessName = fgP.ProcessName;
                        string low = fgProcessName.ToLowerInvariant();
                        if (!low.Contains("explorer") && !low.Contains("quickkeys") && !low.Contains("taskmgr") && !low.Contains("cmd") && !low.Contains("powershell")) {
                            try {
                                if (fgP.PriorityClass != ProcessPriorityClass.High && fgP.PriorityClass != ProcessPriorityClass.RealTime) {
                                    fgP.PriorityClass = ProcessPriorityClass.High;
                                    boostedPriority = true;
                                }
                            } catch {}
                        }
                    }
                }
            }
        } catch {}

        // 2. 尝试深度清空待机缓存
        bool standbyPurged = PurgeStandbyList();

        // 3. 原生快照极速修剪后台进程（仅申请 PROCESS_SET_QUOTA，毫秒级直接清理，跳过昂贵的内存结构全量查询）
        int trimmedCount = 0;
        uint myPid = (uint)Process.GetCurrentProcess().Id;
        IntPtr snap = CreateToolhelp32Snapshot(0x00000002, 0); // TH32CS_SNAPPROCESS
        if (snap != IntPtr.Zero && snap != (IntPtr)(-1)) {
            PROCESSENTRY32 pe = new PROCESSENTRY32();
            pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32First(snap, ref pe)) {
                do {
                    if (pe.th32ProcessID <= 4 || pe.th32ProcessID == myPid || pe.th32ProcessID == fgPid) continue;
                    string name = pe.szExeFile.ToLowerInvariant();
                    // 保护核心进程
                    if (name.StartsWith("system") || name.StartsWith("csrss") || name.StartsWith("dwm") ||
                        name.StartsWith("lsass") || name.StartsWith("explorer") || name.StartsWith("audiodg") ||
                        name.StartsWith("quickkeys")) {
                        continue;
                    }

                    // 0x0100 (PROCESS_SET_QUOTA) 足够调用 EmptyWorkingSet
                    IntPtr hProc = OpenProcess(0x0100 | 0x0400, false, pe.th32ProcessID);
                    if (hProc != IntPtr.Zero) {
                        if (EmptyWorkingSet(hProc) != 0) {
                            trimmedCount++;
                        }
                        CloseHandle(hProc);
                    }
                } while (Process32Next(snap, ref pe));
            }
            CloseHandle(snap);
        }

        ulong afterMB = GetAvailPhysMB();
        long freedMB = (long)afterMB - (long)beforeMB;
        if (freedMB < 0) freedMB = 0;
        sw.Stop();

        Console.OutputEncoding = Encoding.UTF8;
        Console.WriteLine("{{\"ok\":true,\"freedMB\":{0},\"trimmedCount\":{1},\"standbyPurged\":{2},\"durationMs\":{3},\"fgProcess\":\"{4}\",\"boostedPriority\":{5}}}",
            freedMB, trimmedCount, standbyPurged ? "true" : "false", sw.ElapsedMilliseconds, fgProcessName.Replace("\"", "\\\""), boostedPriority ? "true" : "false");
    }
}
