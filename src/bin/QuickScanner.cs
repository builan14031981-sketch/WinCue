using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class QuickScanner {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHQUERYRBINFO {
        public uint cbSize;
        public long i64Size;
        public long i64NumItems;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHQueryRecycleBinW(string pszRootPath, ref SHQUERYRBINFO pSHQueryRBInfo);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr FindFirstFileExW(
        string lpFileName,
        int fInfoLevelId,
        out WIN32_FIND_DATAW lpFindFileData,
        int fSearchOp,
        IntPtr lpSearchFilter,
        int dwAdditionalFlags
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool FindNextFileW(IntPtr hFindFile, out WIN32_FIND_DATAW lpFindFileData);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FindClose(IntPtr hFindFile);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WIN32_FIND_DATAW {
        public uint dwFileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;
        public uint dwReserved0;
        public uint dwReserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string cFileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
        public string cAlternateFileName;
    }

    const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
    const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
    const int FIND_FIRST_EX_LARGE_FETCH = 2;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    static long FileTimeToEpochMs(System.Runtime.InteropServices.ComTypes.FILETIME ft) {
        long h = (uint)ft.dwHighDateTime;
        long l = (uint)ft.dwLowDateTime;
        long fileTime = (h << 32) | l;
        if (fileTime <= 0) return 0;
        // Unix epoch offset from Windows file time (100ns ticks since 1601-01-01)
        return (fileTime - 116444736000000000L) / 10000L;
    }

    static string JsonEscape(string s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.Length + 8);
        sb.Append('"');
        for (int i = 0; i < s.Length; i++) {
            char c = s[i];
            switch (c) {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    static string ToLongPath(string p) {
        if (string.IsNullOrEmpty(p)) return p;
        if (p.StartsWith(@"\\?\")) return p;
        if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
        return @"\\?\" + p;
    }

    static bool IsReparsePoint(string path) {
        try {
            FileAttributes attr = File.GetAttributes(path);
            return (attr & FileAttributes.ReparsePoint) != 0;
        } catch {
            return false;
        }
    }

    struct ScanStats {
        public long Bytes;
        public long Files;
        public long Skipped;
        public long ReparseSkipped;
    }

    static void WalkDirStats(string rootDir, long maxMtimeMs, ref ScanStats stats, List<string> sampleFiles, int maxSamples) {
        if (!Directory.Exists(rootDir)) return;
        if (IsReparsePoint(rootDir)) {
            stats.ReparseSkipped++;
            return;
        }

        Stack<string> stack = new Stack<string>();
        stack.Push(rootDir);

        while (stack.Count > 0) {
            string dir = stack.Pop();
            string pattern = ToLongPath(dir.TrimEnd('\\')) + @"\*";
            WIN32_FIND_DATAW data;
            IntPtr h = FindFirstFileExW(pattern, 1 /* FindExInfoBasic */, out data, 0, IntPtr.Zero, FIND_FIRST_EX_LARGE_FETCH);
            if (h == INVALID_HANDLE_VALUE) {
                stats.Skipped++;
                continue;
            }
            try {
                do {
                    string name = data.cFileName;
                    if (name == "." || name == "..") continue;
                    bool isDir = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                    bool isReparse = (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
                    string full = Path.Combine(dir, name);

                    if (isDir) {
                        if (isReparse) {
                            stats.ReparseSkipped++;
                        } else {
                            stack.Push(full);
                        }
                    } else {
                        if (maxMtimeMs > 0) {
                            long mtimeMs = FileTimeToEpochMs(data.ftLastWriteTime);
                            if (mtimeMs > maxMtimeMs) continue;
                        }
                        long fsize = (((long)data.nFileSizeHigh) << 32) | (uint)data.nFileSizeLow;
                        stats.Bytes += fsize;
                        stats.Files++;
                        if (sampleFiles != null && sampleFiles.Count < maxSamples) {
                            sampleFiles.Add(full);
                        }
                    }
                } while (FindNextFileW(h, out data));
            } finally {
                FindClose(h);
            }
        }
    }

    static void CmdDirSizes() {
        long nowMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            line = line.Trim();
            if (line.Length == 0) continue;
            // Format: id|minAgeHours|path
            string[] parts = line.Split(new char[] { '|' }, 3);
            if (parts.Length < 3) continue;
            string id = parts[0];
            double ageHours = 0;
            double.TryParse(parts[1], out ageHours);
            string targetPath = parts[2];
            long maxMtimeMs = ageHours > 0 ? nowMs - (long)(ageHours * 3600.0 * 1000.0) : 0;

            ScanStats stats = new ScanStats();
            List<string> samples = new List<string>();
            if (File.Exists(targetPath)) {
                try {
                    FileInfo fi = new FileInfo(targetPath);
                    long mtime = (long)(fi.LastWriteTimeUtc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
                    if (maxMtimeMs <= 0 || mtime <= maxMtimeMs) {
                        stats.Bytes = fi.Length;
                        stats.Files = 1;
                        samples.Add(targetPath);
                    }
                } catch {
                    stats.Skipped++;
                }
            } else if (Directory.Exists(targetPath)) {
                WalkDirStats(targetPath, maxMtimeMs, ref stats, samples, 8);
            }

            StringBuilder sb = new StringBuilder();
            sb.Append("{\"id\":").Append(JsonEscape(id));
            sb.Append(",\"path\":").Append(JsonEscape(targetPath));
            sb.Append(",\"bytes\":").Append(stats.Bytes);
            sb.Append(",\"files\":").Append(stats.Files);
            sb.Append(",\"skipped\":").Append(stats.Skipped);
            sb.Append(",\"reparseSkipped\":").Append(stats.ReparseSkipped);
            sb.Append(",\"samples\":[");
            for (int i = 0; i < samples.Count; i++) {
                if (i > 0) sb.Append(',');
                sb.Append(JsonEscape(samples[i]));
            }
            sb.Append("]}");
            Console.WriteLine(sb.ToString());
            Console.Out.Flush();
        }
    }

    class ChildFolderInfo {
        public string Path;
        public string Name;
        public string ParentTag;
        public long Bytes;
        public long Files;
        public bool IsReparsePoint;
    }

    static void CmdTopChildren() {
        // Stdin format:
        // LINE 1: limit (integer, e.g. 25)
        // LINES 2+: tag|dirPath
        string limitStr = Console.In.ReadLine();
        int limit = 25;
        if (!string.IsNullOrEmpty(limitStr)) int.TryParse(limitStr.Trim(), out limit);
        if (limit <= 0) limit = 25;

        List<ChildFolderInfo> list = new List<ChildFolderInfo>();
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            line = line.Trim();
            if (line.Length == 0) continue;
            string[] parts = line.Split(new char[] { '|' }, 2);
            if (parts.Length < 2) continue;
            string tag = parts[0];
            string parentDir = parts[1];
            if (!Directory.Exists(parentDir) || IsReparsePoint(parentDir)) continue;

            try {
                string[] subDirs = Directory.GetDirectories(parentDir);
                for (int i = 0; i < subDirs.Length; i++) {
                    string sd = subDirs[i];
                    string name = Path.GetFileName(sd);
                    bool isReparse = IsReparsePoint(sd);
                    ScanStats st = new ScanStats();
                    if (!isReparse) {
                        WalkDirStats(sd, 0, ref st, null, 0);
                    }
                    ChildFolderInfo info = new ChildFolderInfo();
                    info.Path = sd;
                    info.Name = name;
                    info.ParentTag = tag;
                    info.Bytes = st.Bytes;
                    info.Files = st.Files;
                    info.IsReparsePoint = isReparse;
                    list.Add(info);
                }
            } catch { }
        }

        list.Sort(delegate(ChildFolderInfo a, ChildFolderInfo b) {
            return b.Bytes.CompareTo(a.Bytes);
        });

        int take = Math.Min(limit, list.Count);
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"children\":[");
        for (int i = 0; i < take; i++) {
            ChildFolderInfo c = list[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"path\":").Append(JsonEscape(c.Path));
            sb.Append(",\"name\":").Append(JsonEscape(c.Name));
            sb.Append(",\"parentTag\":").Append(JsonEscape(c.ParentTag));
            sb.Append(",\"bytes\":").Append(c.Bytes);
            sb.Append(",\"files\":").Append(c.Files);
            sb.Append(",\"isReparsePoint\":").Append(c.IsReparsePoint ? "true" : "false");
            sb.Append('}');
        }
        sb.Append("]}");
        Console.WriteLine(sb.ToString());
    }

    class BigFileInfo {
        public string Path;
        public string Name;
        public string Ext;
        public long Bytes;
        public long MtimeMs;
    }

    static bool ShouldExcludeDir(string fullPath, List<string> excludedPrefixes) {
        string norm = fullPath.TrimEnd('\\').ToLowerInvariant();
        for (int i = 0; i < excludedPrefixes.Count; i++) {
            string p = excludedPrefixes[i];
            if (norm == p || norm.StartsWith(p + "\\")) return true;
        }
        return false;
    }

    static void CmdBigFiles() {
        // Stdin:
        // LINE 1: rootDir|minMB|limit
        // LINES 2+: excluded prefix paths (lowercase or any case)
        string header = Console.In.ReadLine();
        if (string.IsNullOrEmpty(header)) { Console.WriteLine("{\"files\":[]}"); return; }
        string[] hparts = header.Split('|');
        string rootDir = hparts.Length > 0 ? hparts[0].Trim() : @"C:\";
        long minMB = 100;
        int limit = 100;
        if (hparts.Length > 1) long.TryParse(hparts[1], out minMB);
        if (hparts.Length > 2) int.TryParse(hparts[2], out limit);
        if (minMB <= 0) minMB = 50;
        if (limit <= 0) limit = 100;
        long minBytes = minMB * 1024L * 1024L;

        List<string> excludes = new List<string>();
        string exLine;
        while ((exLine = Console.In.ReadLine()) != null) {
            exLine = exLine.Trim().TrimEnd('\\').ToLowerInvariant();
            if (exLine.Length > 0) excludes.Add(exLine);
        }

        List<BigFileInfo> found = new List<BigFileInfo>();
        if (Directory.Exists(rootDir) && !IsReparsePoint(rootDir)) {
            Stack<string> stack = new Stack<string>();
            stack.Push(rootDir);

            while (stack.Count > 0) {
                string dir = stack.Pop();
                if (ShouldExcludeDir(dir, excludes)) continue;

                string pattern = ToLongPath(dir.TrimEnd('\\')) + @"\*";
                WIN32_FIND_DATAW data;
                IntPtr h = FindFirstFileExW(pattern, 1, out data, 0, IntPtr.Zero, FIND_FIRST_EX_LARGE_FETCH);
                if (h == INVALID_HANDLE_VALUE) continue;

                try {
                    do {
                        string name = data.cFileName;
                        if (name == "." || name == "..") continue;
                        bool isDir = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
                        bool isReparse = (data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
                        string full = Path.Combine(dir, name);

                        if (isDir) {
                            if (!isReparse && !ShouldExcludeDir(full, excludes)) {
                                stack.Push(full);
                            }
                        } else {
                            long fsize = (((long)data.nFileSizeHigh) << 32) | (uint)data.nFileSizeLow;
                            if (fsize >= minBytes) {
                                BigFileInfo bf = new BigFileInfo();
                                bf.Path = full;
                                bf.Name = name;
                                bf.Ext = Path.GetExtension(name).ToLowerInvariant();
                                bf.Bytes = fsize;
                                bf.MtimeMs = FileTimeToEpochMs(data.ftLastWriteTime);
                                found.Add(bf);
                            }
                        }
                    } while (FindNextFileW(h, out data));
                } finally {
                    FindClose(h);
                }
            }
        }

        found.Sort(delegate(BigFileInfo a, BigFileInfo b) {
            return b.Bytes.CompareTo(a.Bytes);
        });

        int take = Math.Min(limit, found.Count);
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"files\":[");
        for (int i = 0; i < take; i++) {
            BigFileInfo f = found[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"path\":").Append(JsonEscape(f.Path));
            sb.Append(",\"name\":").Append(JsonEscape(f.Name));
            sb.Append(",\"ext\":").Append(JsonEscape(f.Ext));
            sb.Append(",\"bytes\":").Append(f.Bytes);
            sb.Append(",\"mtimeMs\":").Append(f.MtimeMs);
            sb.Append('}');
        }
        sb.Append("]}");
        Console.WriteLine(sb.ToString());
    }

    static void CmdRecycleInfo() {
        SHQUERYRBINFO infoAll = new SHQUERYRBINFO();
        infoAll.cbSize = (uint)Marshal.SizeOf(typeof(SHQUERYRBINFO));
        int hrAll = SHQueryRecycleBinW(null, ref infoAll);

        SHQUERYRBINFO infoC = new SHQUERYRBINFO();
        infoC.cbSize = (uint)Marshal.SizeOf(typeof(SHQUERYRBINFO));
        int hrC = SHQueryRecycleBinW(@"C:\", ref infoC);

        Console.WriteLine(string.Format(
            "{{\"ok\":true,\"allBytes\":{0},\"allItems\":{1},\"cBytes\":{2},\"cItems\":{3}}}",
            hrAll == 0 ? infoAll.i64Size : 0,
            hrAll == 0 ? infoAll.i64NumItems : 0,
            hrC == 0 ? infoC.i64Size : 0,
            hrC == 0 ? infoC.i64NumItems : 0
        ));
    }

    static void CmdDiskInfo() {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"drives\":[");
        DriveInfo[] drives = DriveInfo.GetDrives();
        bool first = true;
        for (int i = 0; i < drives.Length; i++) {
            DriveInfo d = drives[i];
            try {
                if (!d.IsReady || d.DriveType != DriveType.Fixed) continue;
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":").Append(JsonEscape(d.Name));
                sb.Append(",\"letter\":").Append(JsonEscape(d.Name.Substring(0, 1).ToUpperInvariant()));
                sb.Append(",\"format\":").Append(JsonEscape(d.DriveFormat));
                sb.Append(",\"totalBytes\":").Append(d.TotalSize);
                sb.Append(",\"freeBytes\":").Append(d.AvailableFreeSpace);
                sb.Append('}');
            } catch { }
        }
        sb.Append("]}");
        Console.WriteLine(sb.ToString());
    }

    static int Main(string[] args) {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length == 0) {
            Console.Error.WriteLine("Usage: quickkeys-scanner.exe <dir-sizes|top-children|big-files|recycle-info|disk-info>");
            return 1;
        }
        string cmd = args[0].ToLowerInvariant();
        if (cmd == "dir-sizes") CmdDirSizes();
        else if (cmd == "top-children") CmdTopChildren();
        else if (cmd == "big-files") CmdBigFiles();
        else if (cmd == "recycle-info") CmdRecycleInfo();
        else if (cmd == "disk-info") CmdDiskInfo();
        else {
            Console.Error.WriteLine("Unknown command: " + cmd);
            return 1;
        }
        return 0;
    }
}
