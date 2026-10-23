using System;
using System.Text;
using System.Windows.Forms;

// C# 5 / .NET Framework 4.5. Both native UI and --quiet use the same install engine.
internal static class Setup
{
    [STAThread]
    private static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch (Exception) { }
        Installer engine = new Installer();
        InstallOptions options = new InstallOptions();
        foreach (string arg in args)
        {
            if (arg.StartsWith("--target=", StringComparison.Ordinal)) options.Target = arg.Substring(9);
            else if (arg == "--quiet") options.Quiet = true;
            else if (arg == "--no-shortcut") { options.DesktopShortcut = false; options.StartMenuShortcut = false; }
            else if (arg == "--help")
            {
                Console.WriteLine("用法：Setup.exe [--target=<目录>] [--quiet] [--no-shortcut] [--version]");
                Console.WriteLine("不带 --quiet 时打开安装向导；--target 可预填安装目录。");
                return 0;
            }
            else if (arg == "--version") { Console.WriteLine(engine.Version); return 0; }
            else { Console.WriteLine("无法识别的参数：" + arg); return 64; }
        }
        if (options.Target == null) options.Target = Environment.GetEnvironmentVariable("RCC_TARGET");
        if (options.Target == null) options.Target = engine.DefaultTarget();
        if (engine.ShortcutName.Length == 0) { options.DesktopShortcut = false; options.StartMenuShortcut = false; }
        if (options.Quiet)
        {
            try
            {
                InstallResult result = engine.Install(options, delegate(InstallProgress p) { });
                Console.WriteLine(engine.Label + " v" + engine.Version);
                Console.WriteLine("安装完成：" + result.Files + " 个文件，" + (result.Bytes / 1048576) + " MiB。");
                Console.WriteLine("安装位置：" + result.Target);
                foreach (string warning in result.Warnings) Console.WriteLine(warning);
                Console.WriteLine("日志：" + engine.LogPath);
                return 0;
            }
            catch (Exception ex) { engine.Record("FAILED " + ex); Console.Error.WriteLine("安装未完成：" + ex.Message + "\n日志：" + engine.LogPath); return 1; }
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (InstallerWizard wizard = new InstallerWizard(engine, options))
        {
            Application.Run(wizard);
            return wizard.ExitCode;
        }
    }
}
