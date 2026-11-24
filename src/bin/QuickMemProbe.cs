// QuickMemProbe：以 PDH 性能计数器 + psapi 采集内存指标，输出单行 JSON。
// 目的：替换原来启动期调用的 PowerShell + CIM 采集，避免冷启动 PowerShell 造成的启动卡顿。
// 与旧口径对齐方式（值与 Win32_PerfFormattedData_PerfOS_Memory / Win32_OperatingSystem 同源）：
//   TotalMB         <- GetPerformanceInfo.PhysicalTotal（等于 TotalVisibleMemorySize）
//   FreeMB          <- \Memory\Available Bytes（等于 FreePhysicalMemory，注意：已包含待机缓存，是「可用」而非「空闲」）
//   StandbyMB       <- \Memory\Standby Cache Normal Priority Bytes + \Memory\Standby Cache Reserve Bytes（是 FreeMB 的子集）
//   CommittedMB     <- \Memory\Committed Bytes
//   CommitLimitMB   <- \Memory\Commit Limit
//   PoolNonpagedMB  <- \Memory\Pool Nonpaged Bytes
//   PoolPagedMB     <- \Memory\Pool Paged Bytes
//   CompressedMB    <- \Process(Memory Compression)\Working Set
// 编译：csc.exe /nologo /optimize+ /target:exe /out:quickkeys-memprobe.exe QuickMemProbe.cs
using System;
using System.Runtime.InteropServices;
using System.Text;

class QuickMemProbe
{
    // PDH_FMT_COUNTERVALUE：CStatus 在偏移 0，取值联合体在偏移 8（x64 对齐）。
    // 用 PDH_FMT_DOUBLE（0x200）取值，内存类计数器均为字节数。
    [StructLayout(LayoutKind.Explicit, Size = 16)]
    struct PdhVal
    {
        [FieldOffset(0)] public uint CStatus;
        [FieldOffset(8)] public double value;
    }

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern uint PdhOpenQueryW(string dataSource, IntPtr userData, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr userData, out IntPtr counter);
    [DllImport("pdh.dll")]
    static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll")]
    static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, ref PdhVal value);
    [DllImport("pdh.dll")]
    static extern uint PdhCloseQuery(IntPtr query);

    [StructLayout(LayoutKind.Sequential)]
    struct PERFORMANCE_INFORMATION
    {
        public uint cb;
        public IntPtr CommitTotal;
        public IntPtr CommitLimit;
        public IntPtr CommitPeak;
        public IntPtr PhysicalTotal;
        public IntPtr PhysicalAvailable;
        public IntPtr SystemCache;
        public IntPtr KernelTotal;
        public IntPtr KernelPaged;
        public IntPtr KernelNonpaged;
        public IntPtr PageSize;
        public uint HandleCount;
        public uint ProcessCount;
        public uint ThreadCount;
    }

    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool GetPerformanceInfo(out PERFORMANCE_INFORMATION p, uint cb);

    const uint PDH_FMT_DOUBLE = 0x00000200u;

    static readonly string[] CounterPaths = new string[]
    {
        @"\Memory\Available Bytes",
        @"\Memory\Standby Cache Normal Priority Bytes",
        @"\Memory\Standby Cache Reserve Bytes",
        @"\Memory\Committed Bytes",
        @"\Memory\Commit Limit",
        @"\Memory\Pool Nonpaged Bytes",
        @"\Memory\Pool Paged Bytes"
    };

    static double Read(IntPtr counter)
    {
        if (counter == IntPtr.Zero) return 0;
        uint type;
        var v = new PdhVal();
        if (PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, out type, ref v) != 0) return 0;
        if (v.CStatus != 0) return 0;
        return v.value;
    }

    static long ToMB(double bytes)
    {
        return (long)Math.Round(bytes / 1048576.0);
    }

    static void Main()
    {
        IntPtr query;
        if (PdhOpenQueryW(null, IntPtr.Zero, out query) != 0)
        {
            Console.WriteLine("{\"error\":\"pdh-open-failed\"}");
            return;
        }

        var handles = new IntPtr[CounterPaths.Length];
        for (int i = 0; i < CounterPaths.Length; i++)
        {
            IntPtr h;
            if (PdhAddEnglishCounterW(query, CounterPaths[i], IntPtr.Zero, out h) != 0) h = IntPtr.Zero;
            handles[i] = h;
        }
        // 压缩内存是进程实例计数器，老系统/关闭压缩时取不到，取不到按 0 处理。
        IntPtr compressedCounter;
        if (PdhAddEnglishCounterW(query, @"\Process(Memory Compression)\Working Set", IntPtr.Zero, out compressedCounter) != 0)
        {
            compressedCounter = IntPtr.Zero;
        }

        PdhCollectQueryData(query);

        double availableBytes = Read(handles[0]);
        double standbyNormal = Read(handles[1]);
        double standbyReserve = Read(handles[2]);
        double committedBytes = Read(handles[3]);
        double commitLimitBytes = Read(handles[4]);
        double poolNonpagedBytes = Read(handles[5]);
        double poolPagedBytes = Read(handles[6]);
        double compressedBytes = Read(compressedCounter);
        PdhCloseQuery(query);

        PERFORMANCE_INFORMATION pi;
        pi.cb = (uint)Marshal.SizeOf(typeof(PERFORMANCE_INFORMATION));
        bool okPi = GetPerformanceInfo(out pi, pi.cb);
        long pageSize = okPi ? pi.PageSize.ToInt64() : 4096;
        long totalMB = okPi ? pi.PhysicalTotal.ToInt64() * pageSize / 1048576 : 0;
        if (totalMB <= 0) totalMB = (long)Math.Round(GC.GetTotalMemory(false) / 1048576.0); // 兜底值，正常不会走到

        var sb = new StringBuilder(256);
        sb.Append('{');
        sb.Append("\"TotalMB\":").Append(totalMB);
        sb.Append(",\"FreeMB\":").Append(ToMB(availableBytes));
        sb.Append(",\"StandbyMB\":").Append(ToMB(standbyNormal + standbyReserve));
        sb.Append(",\"CommittedMB\":").Append(ToMB(committedBytes));
        sb.Append(",\"CommitLimitMB\":").Append(ToMB(commitLimitBytes));
        sb.Append(",\"PoolNonpagedMB\":").Append(ToMB(poolNonpagedBytes));
        sb.Append(",\"PoolPagedMB\":").Append(ToMB(poolPagedBytes));
        sb.Append(",\"CompressedMB\":").Append(ToMB(compressedBytes));
        sb.Append('}');
        Console.WriteLine(sb.ToString());
    }
}
