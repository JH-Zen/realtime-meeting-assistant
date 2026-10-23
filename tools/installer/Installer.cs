using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal sealed class InstallOptions
{
    internal string Target;
    internal bool Quiet;
    internal bool DesktopShortcut = true;
    internal bool StartMenuShortcut = true;
}

internal sealed class InstallProgress
{
    internal int Percent;
    internal string Message;
    internal InstallProgress(int percent, string message) { Percent = percent; Message = message; }
}

internal sealed class InstallResult
{
    internal string Target;
    internal int Files;
    internal long Bytes;
    internal List<string> Warnings = new List<string>();
}

internal sealed class InstallEntry
{
    internal ZipArchiveEntry Entry;
    internal string Destination;
    internal bool Preserve;
}

internal sealed class Installer
{
    private readonly Dictionary<string, string> manifest = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    internal string Label { get { return Value("label", "实时会议助手"); } }
    internal string Version { get { return Value("version", "未标注"); } }
    internal string Launcher { get { return Value("launcher", "RCC.bat"); } }
    internal string ShortcutName { get { return Value("shortcut", ""); } }
    internal string LogPath { get; private set; }

    internal Installer()
    {
        Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("rcc-manifest.txt");
        if (source != null) using (source) using (StreamReader reader = new StreamReader(source, Encoding.UTF8))
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                int equals = line.IndexOf('=');
                if (equals > 0) manifest[line.Substring(0, equals).Trim()] = line.Substring(equals + 1).Trim();
            }
        }
        string logs = Environment.GetEnvironmentVariable("RCC_INSTALLER_LOG_DIR");
        if (string.IsNullOrEmpty(logs)) logs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RCC-Installer", "logs");
        LogPath = Path.Combine(logs, "install-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".log");
    }

    private string Value(string key, string fallback)
    {
        string value;
        return manifest.TryGetValue(key, out value) && value.Length > 0 ? value : fallback;
    }

    internal string DefaultTarget()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", Value("defaultFolder", "RCC"));
    }

    internal static string NormalizeTarget(string target)
    {
        if (string.IsNullOrWhiteSpace(target)) throw new IOException("请填写安装文件夹。");
        target = target.Trim();
        if (target.Length < 3 || !char.IsLetter(target[0]) || target[1] != ':' || (target[2] != '\\' && target[2] != '/')) throw new IOException("请填写完整的本机安装路径，例如 D:\\Apps\\实时会议助手-桌面预览。");
        string full = Path.GetFullPath(target.Trim()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (full.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("请选择本机磁盘中的文件夹。");
        if (string.Equals(full, Path.GetPathRoot(full).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) throw new IOException("请在磁盘中选择一个专用文件夹，不能直接安装到磁盘根目录。");
        if (File.Exists(full)) throw new IOException("这个路径是文件，请选择文件夹。");
        foreach (string reserved in new string[] { Environment.GetFolderPath(Environment.SpecialFolder.Windows), Environment.GetFolderPath(Environment.SpecialFolder.System), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
            if (!string.IsNullOrEmpty(reserved) && string.Equals(full, reserved.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) throw new IOException("请为应用选择专用文件夹。");
        return full;
    }

    internal void Record(string message)
    {
        try { Directory.CreateDirectory(Path.GetDirectoryName(LogPath)); File.AppendAllText(LogPath, DateTime.Now.ToString("o") + " " + message + Environment.NewLine, new UTF8Encoding(false)); }
        catch (Exception) { /* A log write must not replace the original error. */ }
    }

    internal InstallResult Install(InstallOptions options, Action<InstallProgress> progress)
    {
        string target = NormalizeTarget(options.Target);
        string id;
        using (SHA256 digest = SHA256.Create()) id = BitConverter.ToString(digest.ComputeHash(Encoding.UTF8.GetBytes(target.ToUpperInvariant()))).Replace("-", "");
        using (Mutex guard = new Mutex(false, "Local\\RCC-Installer-" + id))
        {
            bool acquired;
            try { acquired = guard.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new IOException("另一安装程序正在更新此目录，请等待它完成后再重试。");
            try { return InstallLocked(target, options, progress); } finally { guard.ReleaseMutex(); }
        }
    }

    private InstallResult InstallLocked(string target, InstallOptions options, Action<InstallProgress> progress)
    {
        Record("BEGIN version=" + Version + " target=" + target);
        InstallResult result = new InstallResult(); result.Target = target;
        progress(new InstallProgress(0, "正在检查安装文件和目标目录…"));
        Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
        if (payload == null) throw new IOException("安装包缺少程序文件，请重新获取完整安装包。");
        using (payload) using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read))
        {
            List<InstallEntry> plan = new List<InstallEntry>();
            string root = target + Path.DirectorySeparatorChar;
            long total = 0;
            // Check every destination and existing-file lock before changing any application file.
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                string name = entry.FullName.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
                if (name.StartsWith("." + Path.DirectorySeparatorChar)) name = name.Substring(2);
                if (name.Length == 0 || name == "." || name.EndsWith(Path.DirectorySeparatorChar.ToString())) continue;
                string destination = Path.GetFullPath(Path.Combine(root, name));
                if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new IOException("安装包包含无效路径，请重新获取安装包。");
                RejectLinks(destination);
                string first = name.Split(Path.DirectorySeparatorChar)[0];
                bool preserve = File.Exists(destination) && (string.Equals(Path.GetFileName(name), ".env", StringComparison.OrdinalIgnoreCase) || string.Equals(first, "models", StringComparison.OrdinalIgnoreCase) || string.Equals(first, "var", StringComparison.OrdinalIgnoreCase) || string.Equals(first, "data", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".sqlite", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".db", StringComparison.OrdinalIgnoreCase));
                if (File.Exists(destination) && !preserve)
                {
                    try { using (FileStream check = new FileStream(destination, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { } }
                    catch (Exception ex) { throw new IOException("无法更新文件：" + destination + "\n请先正常退出此目录中的应用，再重试；也可以选择其他安装位置。", ex); }
                }
                plan.Add(new InstallEntry { Entry = entry, Destination = destination, Preserve = preserve });
                total += entry.Length;
            }
            if (plan.Count == 0) throw new IOException("安装包中的程序文件为空。");
            Directory.CreateDirectory(target);
            long processed = 0;
            Stopwatch notify = Stopwatch.StartNew();
            foreach (InstallEntry item in plan)
            {
                if (!item.Preserve)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(item.Destination));
                    string temp = item.Destination + ".rcc-install-" + Guid.NewGuid().ToString("N") + ".tmp";
                    try
                    {
                        using (Stream input = item.Entry.Open()) using (FileStream output = File.Create(temp)) input.CopyTo(output);
                        if (new FileInfo(temp).Length != item.Entry.Length) throw new IOException("安装文件不完整，请重新获取安装包。");
                        if (File.Exists(item.Destination)) File.Replace(temp, item.Destination, null); else File.Move(temp, item.Destination);
                        result.Files++; result.Bytes += item.Entry.Length;
                    }
                    finally { if (File.Exists(temp)) File.Delete(temp); }
                }
                processed += item.Entry.Length;
                if (notify.ElapsedMilliseconds > 60 || processed == total)
                {
                    progress(new InstallProgress((int)(processed * 95 / Math.Max(1, total)), "正在安装程序文件…")); notify.Restart();
                }
            }
        }
        string required = Value("required", "");
        if (required.Length > 0 && !File.Exists(Path.Combine(target, required))) throw new IOException("安装后未找到必要文件：" + required + "。请重新安装。");
        progress(new InstallProgress(97, "正在创建快捷方式并检查安装结果…"));
        if (ShortcutName.Length > 0)
        {
            if (options.DesktopShortcut) TryShortcut(target, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), result);
            if (options.StartMenuShortcut) TryShortcut(target, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), ShortcutName), result);
        }
        File.WriteAllText(Path.Combine(target, "installed-version.txt"), Version + Environment.NewLine, new UTF8Encoding(false));
        Record("SUCCESS files=" + result.Files + " bytes=" + result.Bytes + " warnings=" + result.Warnings.Count);
        progress(new InstallProgress(100, "安装完成")); return result;
    }

    private static void RejectLinks(string path)
    {
        for (string current = path; !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装路径包含文件夹链接，请选择普通文件夹：" + current);
            if (current == Path.GetPathRoot(current)) break;
        }
    }

    private void TryShortcut(string target, string folder, InstallResult result)
    {
        object shell = null; object shortcut = null;
        try
        {
            Directory.CreateDirectory(folder);
            Type shellType = Type.GetTypeFromProgID("WScript.Shell"); shell = Activator.CreateInstance(shellType);
            shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { Path.Combine(folder, ShortcutName + ".lnk") });
            Type type = shortcut.GetType();
            type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { Path.Combine(target, Launcher) });
            type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { target });
            type.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { Label + " v" + Version });
            type.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        catch (Exception ex) { string warning = "应用已安装，但快捷方式创建失败（" + folder + "）：" + ex.Message; result.Warnings.Add(warning); Record(warning); }
        finally { if (shortcut != null) Marshal.FinalReleaseComObject(shortcut); if (shell != null) Marshal.FinalReleaseComObject(shell); }
    }

    internal bool CanLaunch(string target) { return File.Exists(Path.Combine(target, Launcher)); }
    internal void Launch(string target) { Process.Start(new ProcessStartInfo(Path.Combine(target, Launcher)) { WorkingDirectory = target, UseShellExecute = true }); }
}
