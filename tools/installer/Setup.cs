using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

// Installer stub for the packaged app. Compiled by tools/make-installer.mjs with the csc.exe that ships inside
// .NET Framework, so the produced Setup.exe carries the payload as a managed resource and needs no third-party
// packaging tool. Written against C# 5 / .NET 4.0 syntax on purpose: csc.exe in the Framework directory is the
// pre-Roslyn compiler and rejects the newer surface.
internal static class Setup
{
    private const string PayloadResource = "payload.zip";
    private const string ManifestResource = "rcc-manifest.txt";
    private const string TargetPrefix = "--target=";

    private static int Main(string[] args)
    {
        // The box's console codepage is 936 while this file is UTF-8, so without this every Chinese message the
        // user is meant to read arrives as mojibake.
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch (Exception) { }

        string target = null;
        bool quiet = false;
        foreach (string arg in args)
        {
            if (arg.StartsWith(TargetPrefix, StringComparison.Ordinal)) target = arg.Substring(TargetPrefix.Length);
            else if (string.Equals(arg, "--quiet", StringComparison.OrdinalIgnoreCase)) quiet = true;
            else if (string.Equals(arg, "--help", StringComparison.OrdinalIgnoreCase)) { Usage(); return 0; }
            else
            {
                Console.WriteLine("无法识别的参数：" + arg);
                Usage();
                return 64;
            }
        }

        Dictionary<string, string> manifest = ReadManifest();
        string label = Value(manifest, "label", "Real-time Cognitive Companion");
        string required = Value(manifest, "required", "");
        string launcher = Value(manifest, "launcher", "RCC.bat");

        if (target == null) target = Environment.GetEnvironmentVariable("RCC_TARGET");
        if (target == null && !quiet) target = AskForFolder(DefaultTarget());
        if (target == null) target = DefaultTarget();
        if (target.Length == 0)
        {
            Console.WriteLine("安装目录是空的。");
            return 64;
        }

        Console.WriteLine(label);
        Console.WriteLine("安装到：" + target);

        try { Directory.CreateDirectory(target); }
        catch (Exception ex)
        {
            Console.WriteLine("创建目录失败：" + ex.Message);
            Console.WriteLine("如果这个目录已经存在并且里面有正在运行的程序，先结束它们再重装。");
            return 1;
        }

        int files;
        long bytes;
        try { Extract(target, out files, out bytes); }
        catch (Exception ex)
        {
            Console.WriteLine("解压失败：" + ex.Message);
            Console.WriteLine("如果失败的文件属于正在运行的后端，先跑 RCC-stop.bat，或从命令行带 --target 装到别的目录。");
            return 1;
        }

        if (required.Length > 0)
        {
            string probe = Path.Combine(Path.GetFullPath(target), required);
            if (!File.Exists(probe))
            {
                Console.WriteLine("装完了，但 " + required + " 不在——这次安装不算成功。");
                return 1;
            }
        }

        Console.WriteLine("完成：" + files + " 个文件，" + (bytes / 1048576) + " MiB。");
        Console.WriteLine("下一步：运行 " + Path.Combine(target, launcher));
        Pause(quiet);
        return 0;
    }

    private static string DefaultTarget()
    {
        string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
        if (string.IsNullOrEmpty(local)) local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(local)) local = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        return Path.Combine(local, "Programs", "RCC");
    }

    private static string AskForFolder(string initial)
    {
        using (FolderBrowserDialog dialog = new FolderBrowserDialog())
        {
            dialog.Description = "选择安装位置";
            dialog.RootFolder = Environment.SpecialFolder.MyComputer;
            try { dialog.SelectedPath = initial; } catch (Exception) { }
            if (dialog.ShowDialog() != DialogResult.OK) { Console.WriteLine("已取消，没有安装任何文件。"); Environment.Exit(2); }
            return dialog.SelectedPath;
        }
    }

    private static Dictionary<string, string> ReadManifest()
    {
        Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ManifestResource);
        if (stream == null) return values;
        using (stream)
        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
        {
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                int equals = line.IndexOf('=');
                if (equals <= 0) continue;
                values[line.Substring(0, equals).Trim()] = line.Substring(equals + 1).Trim();
            }
        }
        return values;
    }

    private static string Value(Dictionary<string, string> values, string key, string fallback)
    {
        string found;
        return values.TryGetValue(key, out found) && found.Length > 0 ? found : fallback;
    }

    private static void Extract(string target, out int fileCount, out long byteCount)
    {
        fileCount = 0;
        byteCount = 0;
        string root = Path.GetFullPath(target) + Path.DirectorySeparatorChar;
        string temp = Path.Combine(Path.GetTempPath(), "rcc-payload-" + Guid.NewGuid().ToString("N") + ".zip");
        try
        {
            Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource);
            if (payload == null) throw new InvalidOperationException("这个安装包里没有 " + PayloadResource + "。");
            using (payload)
            using (FileStream file = File.Create(temp)) payload.CopyTo(file);

            using (ZipArchive zip = ZipFile.OpenRead(temp))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string name = entry.FullName.Replace('/', Path.DirectorySeparatorChar)
                        .Replace('\\', Path.DirectorySeparatorChar);
                    if (name.StartsWith("." + Path.DirectorySeparatorChar)) name = name.Substring(2);
                    if (name.Length == 0 || name == "." || name.EndsWith(Path.DirectorySeparatorChar.ToString())) continue;

                    string destination = Path.GetFullPath(Path.Combine(root, name));
                    // Our own payload never contains these, and a self-extractor that writes outside the directory
                    // it was told to use would be a bug worth refusing rather than trusting.
                    if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidOperationException("压缩包里有条目想写到安装目录外面：" + entry.FullName);
                    }

                    // A reinstall updates application files but must preserve the user's API key and settings.
                    if (string.Equals(name, ".env", StringComparison.OrdinalIgnoreCase) && File.Exists(destination)) continue;

                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (Stream source = entry.Open())
                    using (FileStream sink = File.Create(destination))
                    {
                        source.CopyTo(sink);
                        byteCount += sink.Length;
                    }
                    fileCount++;
                }
            }
        }
        finally
        {
            try { File.Delete(temp); } catch (Exception) { }
        }
    }

    private static void Pause(bool quiet)
    {
        if (quiet || !Environment.UserInteractive) return;
        Console.Write("按回车键结束…");
        try { Console.ReadLine(); } catch (Exception) { }
    }

    private static void Usage()
    {
        Console.WriteLine("用法：Setup.exe [--target=<目录>] [--quiet]");
        Console.WriteLine("  不带参数：选目录后安装（默认 " + DefaultTarget() + "）。");
        Console.WriteLine("  --quiet：不弹选择框、不等回车，用默认目录或 RCC_TARGET。");
    }
}
