using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

// Test runner only. Not compiled into production installers. Exercises the actual generated EXE's
// controls/engine via reflection, with an explicit isolated target and a unique shortcut identity.
public static class WizardRegression
{
    private static Assembly assembly;
    private static string work;
    private static string version;
    private const BindingFlags Members = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
    private static readonly List<string> checks = new List<string>();

    private static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static object Create(string name, params object[] args) { return Activator.CreateInstance(assembly.GetType(name, true), Members, null, args, null); }
    private static T Control<T>(Form form, string name) where T : System.Windows.Forms.Control
    {
        System.Windows.Forms.Control[] values = form.Controls.Find(name, true);
        Assert(values.Length == 1, "Missing wizard control: " + name); return (T)values[0];
    }
    private static string Heading(Form form) { return Control<Label>(form, "PageHeading").Text; }
    private static void Click(Form form, string name) { Control<Button>(form, name).PerformClick(); }
    private static void Pump() { Application.DoEvents(); Thread.Sleep(10); }
    private static void Wait(Func<bool> condition, string message, int timeoutMs = 15000)
    {
        Stopwatch timer = Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < timeoutMs) { Pump(); if (condition()) return; }
        throw new Exception(message);
    }
    private static void Snapshot(Form form, string name)
    {
        Pump(); using (Bitmap bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, new Rectangle(0, 0, form.Width, form.Height)); bitmap.Save(Path.Combine(work, name + ".png"), ImageFormat.Png); }
    }
    private static Form Wizard(string target, bool links)
    {
        object options = Create("InstallOptions");
        options.GetType().GetField("Target", Members).SetValue(options, target);
        options.GetType().GetField("DesktopShortcut", Members).SetValue(options, links);
        options.GetType().GetField("StartMenuShortcut", Members).SetValue(options, links);
        Form form = (Form)Create("InstallerWizard", Create("Installer"), options); form.Show(); Pump(); return form;
    }
    private static int ExitCode(Form form) { return (int)form.GetType().GetProperty("ExitCode", Members).GetValue(form, null); }
    private static void GoToReady(Form form, string target)
    {
        Assert(Heading(form) == "欢迎使用安装向导", "Welcome page missing"); Click(form, "NextButton");
        Assert(Heading(form) == "选择安装位置", "Location page missing"); Control<TextBox>(form, "InstallPath").Text = target;
        Click(form, "NextButton"); Assert(Heading(form) == "选择快捷方式", "Shortcut page missing");
        Click(form, "NextButton"); Assert(Heading(form) == "准备安装", "Review page missing");
    }
    private static void Finish(Form form, bool run)
    {
        Assert(Heading(form) == "安装完成", "Installation did not complete: " + Control<Label>(form, "PageDetail").Text);
        Control<CheckBox>(form, "LaunchAfterInstall").Checked = run; Click(form, "NextButton"); Pump(); Assert(ExitCode(form) == 0, "Wrong successful exit code");
    }

    public static string[] Run(string installer, string directory, string expectedVersion, string shortcutName)
    {
        // Match production's Application.Run, rather than pumping modeless forms from a console
        // without a stable WindowsFormsSynchronizationContext for BackgroundWorker completion.
        Exception failure = null;
        string[] result = null;
        using (Form host = new Form { ShowInTaskbar = false, Opacity = 0, WindowState = FormWindowState.Minimized })
        {
            host.Shown += delegate { host.BeginInvoke(new Action(delegate
            {
                try { result = RunCases(installer, directory, expectedVersion, shortcutName); }
                catch (Exception error) { failure = error; }
                finally { host.Close(); }
            })); };
            Application.Run(host);
        }
        if (failure != null) throw new Exception("Wizard regression failed", failure);
        return result;
    }

    private static string[] RunCases(string installer, string directory, string expectedVersion, string shortcutName)
    {
        work = directory; version = expectedVersion; checks.Clear();
        assembly = Assembly.LoadFile(Path.GetFullPath(installer));
        Assert(FileVersionInfo.GetVersionInfo(installer).ProductVersion == version, "Installer product version mismatch");
        checks.Add("installer-file-version-metadata");
        string cancelled = Path.Combine(work, "取消 中文 space");
        using (Form form = Wizard(cancelled, false))
        {
            Assert(form.Text.Contains(version), "Version missing from wizard title"); Snapshot(form, "01-welcome");
            Click(form, "NextButton"); Click(form, "CancelButton"); Assert(ExitCode(form) == 2, "Cancel should report cancelled");
            Assert(!Directory.Exists(cancelled), "Cancel wrote installation files");
        }
        checks.Add("welcome-version-and-cancel-without-target-writes");
        MethodInfo normalize = assembly.GetType("Installer").GetMethod("NormalizeTarget", BindingFlags.Static | BindingFlags.NonPublic);
        foreach (string invalid in new string[] { "", "relative", "D:relative", "D:\\", "\\\\server\\share" })
        {
            bool refused = false; try { normalize.Invoke(null, new object[] { invalid }); } catch (TargetInvocationException) { refused = true; }
            Assert(refused, "Invalid location accepted: " + invalid);
        }
        checks.Add("absolute-local-dedicated-folder-validation");
        string target = Path.Combine(work, "向导安装 app 中文 spaces");
        using (Form form = Wizard(target, false))
        {
            Click(form, "NextButton");
            Exception pickerError = null;
            using (System.Windows.Forms.Timer picker = new System.Windows.Forms.Timer())
            {
                picker.Interval = 30; picker.Tick += delegate
                {
                    try
                    {
                        foreach (Form dialog in Application.OpenForms)
                        {
                            if (dialog.GetType().Name != "FolderPicker") continue;
                            picker.Stop(); Assert(Control<TreeView>(dialog, "FolderTree").Nodes.Count > 0, "No local drives in folder picker");
                            Control<TextBox>(dialog, "FolderPath").Text = target; Click(dialog, "FolderChoose"); break;
                        }
                    }
                    catch (Exception error) { pickerError = error; picker.Stop(); }
                };
                picker.Start(); Click(form, "BrowseButton");
            }
            if (pickerError != null) throw pickerError;
            Assert(Control<TextBox>(form, "InstallPath").Text == target, "Folder selection was not applied"); Snapshot(form, "02-location");
            Click(form, "NextButton"); Assert(!Control<CheckBox>(form, "DesktopShortcut").Checked && !Control<CheckBox>(form, "StartMenuShortcut").Checked, "Shortcut options lost");
            Snapshot(form, "03-shortcuts"); Click(form, "NextButton"); Click(form, "BackButton"); Click(form, "BackButton");
            Assert(Control<TextBox>(form, "InstallPath").Text == target, "Back lost selected path");
            Click(form, "NextButton"); Click(form, "NextButton"); Snapshot(form, "04-review");
            Assert(Control<Label>(form, "PageDetail").Text.Contains(version), "Version missing from review page");
            Click(form, "NextButton"); Assert(Heading(form) == "正在安装", "Progress page missing");
            Assert(!Control<Button>(form, "NextButton").Enabled && !Control<Button>(form, "CancelButton").Enabled, "Install can be interrupted halfway by controls");
            form.Close(); Assert(!form.IsDisposed, "Closing interrupted an in-progress install");
            Wait(delegate { return Heading(form) != "正在安装"; }, "GUI install timed out"); Snapshot(form, "05-complete");
            Assert(File.ReadAllText(Path.Combine(target, "installed-version.txt")).Trim() == version, "Installed receipt version missing");
            Finish(form, true);
        }
        Wait(delegate { return File.Exists(Path.Combine(target, "launched.txt")); }, "Finish did not launch fixture app");
        checks.Add("native-path-browser-and-back-navigation"); checks.Add("shortcut-options-and-review"); checks.Add("async-progress-and-blocked-mid-install-close"); checks.Add("finish-launches-installed-fixture-app");
        string desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), shortcutName + ".lnk");
        string menuFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), shortcutName);
        Assert(!File.Exists(desktopLink) && !Directory.Exists(menuFolder), "Unchecked shortcut option created links");
        checks.Add("unchecked-shortcuts-create-no-links");
        string linked = Path.Combine(work, "快捷方式 install");
        Assert(shortcutName.StartsWith("RCC-Wizard-Test-", StringComparison.Ordinal), "Refusing non-test shortcut identity");
        try
        {
            using (Form form = Wizard(linked, true))
            {
                GoToReady(form, linked); Click(form, "NextButton"); Wait(delegate { return Heading(form) != "正在安装"; }, "Shortcut install timed out"); Finish(form, false);
            }
            Assert(File.Exists(desktopLink), "Desktop shortcut missing"); Assert(File.Exists(Path.Combine(menuFolder, shortcutName + ".lnk")), "Start Menu shortcut missing");
            checks.Add("selected-desktop-and-start-menu-shortcuts");
        }
        finally
        {
            // Exact, newly created test identity only. No recursive deletion or existing app links.
            if (File.Exists(desktopLink)) File.Delete(desktopLink);
            string menuLink = Path.Combine(menuFolder, shortcutName + ".lnk"); if (File.Exists(menuLink)) File.Delete(menuLink);
            if (Directory.Exists(menuFolder)) Directory.Delete(menuFolder, false);
        }
        File.WriteAllText(Path.Combine(target, ".env"), "CUSTOM_KEEP=中文设置");
        File.WriteAllText(Path.Combine(target, "var", "rcc.sqlite"), "USER DATABASE MARKER");
        File.WriteAllText(Path.Combine(target, "data", "keep.bin"), "USER DATA MARKER");
        File.WriteAllText(Path.Combine(target, "models", "keep.bin"), "USER MODEL MARKER");
        File.WriteAllText(Path.Combine(target, "program-marker.txt"), "OLD APP FILE");
        using (Form form = Wizard(target, false))
        {
            GoToReady(form, target); Click(form, "NextButton"); Wait(delegate { return Heading(form) != "正在安装"; }, "Reinstall timed out"); Finish(form, false);
        }
        Assert(File.ReadAllText(Path.Combine(target, ".env")) == "CUSTOM_KEEP=中文设置", "Reinstall changed config");
        Assert(File.ReadAllText(Path.Combine(target, "var", "rcc.sqlite")) == "USER DATABASE MARKER", "Reinstall changed DB");
        Assert(File.ReadAllText(Path.Combine(target, "data", "keep.bin")) == "USER DATA MARKER", "Reinstall changed user data");
        Assert(File.ReadAllText(Path.Combine(target, "models", "keep.bin")) == "USER MODEL MARKER", "Reinstall changed model");
        Assert(File.ReadAllText(Path.Combine(target, "program-marker.txt")) == "NEW APP FILE", "Reinstall did not update application files");
        checks.Add("wizard-reinstall-updates-program-and-preserves-user-files");
        string blocked = Path.Combine(work, "文件占用"); Directory.CreateDirectory(blocked);
        string locked = Path.Combine(blocked, "guard.bin"); File.WriteAllText(locked, "LOCKED ORIGINAL"); File.WriteAllText(Path.Combine(blocked, "program-marker.txt"), "ORIGINAL APP");
        using (Form form = Wizard(blocked, false))
        {
            GoToReady(form, blocked);
            using (FileStream file = new FileStream(locked, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                Click(form, "NextButton"); Wait(delegate { return Heading(form) != "正在安装"; }, "Locked-file failure not shown");
                Assert(Heading(form) == "安装未完成", "Locked-file install incorrectly succeeded");
                Assert(Control<Label>(form, "PageDetail").Text.Contains("日志："), "Failure omitted log location");
                Assert(File.ReadAllText(Path.Combine(blocked, "program-marker.txt")) == "ORIGINAL APP", "Lock check modified earlier files"); Snapshot(form, "06-file-in-use");
            }
            Assert(File.ReadAllText(locked) == "LOCKED ORIGINAL", "Failure changed locked original");
            Click(form, "NextButton"); Wait(delegate { return Heading(form) != "正在安装"; }, "Retry timed out"); Finish(form, false);
        }
        checks.Add("locked-file-error-before-overwrite-and-visible-log"); checks.Add("retry-after-file-is-released");
        NativeEntry(installer);
        checks.Add("actual-exe-opens-wizard-and-cancels-cleanly");
        return checks.ToArray();
    }

    public static string[] InstallReal(string installer, string directory, string target, string expectedVersion, bool shortcuts)
    {
        Exception failure = null;
        using (Form host = new Form { ShowInTaskbar = false, Opacity = 0, WindowState = FormWindowState.Minimized })
        {
            host.Shown += delegate { host.BeginInvoke(new Action(delegate
            {
                try
                {
                    work = directory; version = expectedVersion; assembly = Assembly.LoadFile(Path.GetFullPath(installer));
                    using (Form form = Wizard(target, shortcuts))
                    {
                        Assert(form.Text.Contains(version), "Full installer version missing"); Snapshot(form, "installer-welcome");
                        GoToReady(form, target); Snapshot(form, "installer-review"); Click(form, "NextButton");
                        // Full payload is ~500 MB / 4700 files. Reinstall adds lock preflight and
                        // File.Replace on each existing file; keep fixture waits at 15s while this
                        // bounded budget fits inside the outer runner's 120s process timeout.
                        Wait(delegate { return Heading(form) != "正在安装"; }, "Full native installation timed out", 90000);
                        Assert(Heading(form) == "安装完成", "Full native installation failed: " + Control<Label>(form, "PageDetail").Text);
                        Assert(File.Exists(Path.Combine(target, "实时会议助手.exe")), "Desktop executable missing");
                        Assert(File.Exists(Path.Combine(target, "resources", "backend", "runtime", "node.exe")), "Bundled backend Node missing");
                        Assert(File.ReadAllText(Path.Combine(target, "installed-version.txt")).Trim() == version, "Full installation version differs");
                        Snapshot(form, "installer-complete"); Finish(form, false);
                    }
                }
                catch (Exception error) { failure = error; }
                finally { host.Close(); }
            })); };
            Application.Run(host);
        }
        if (failure != null) throw new Exception("Full installation wizard failed", failure);
        return new string[] { "native-welcome-location-shortcuts-review-progress-completion", "installed-version-receipt", "bundled-desktop-and-backend-files" };
    }

    private static void NativeEntry(string installer)
    {
        string target = Path.Combine(work, "真实入口取消");
        ProcessStartInfo start = new ProcessStartInfo(installer) { UseShellExecute = false, WorkingDirectory = work };
        start.EnvironmentVariables["RCC_TARGET"] = target; start.EnvironmentVariables["RCC_INSTALLER_LOG_DIR"] = Path.Combine(work, "logs");
        using (Process process = Process.Start(start))
        {
            try
            {
                Wait(delegate { process.Refresh(); return process.MainWindowHandle != IntPtr.Zero || process.HasExited; }, "Actual installer did not show its wizard");
                Assert(!process.HasExited && process.MainWindowTitle.Contains(version), "Actual installer showed no versioned native window");
                Assert(process.CloseMainWindow(), "Could not cancel actual wizard");
                Assert(process.WaitForExit(5000), "Actual installer did not exit after cancel"); Assert(process.ExitCode == 2, "Actual cancel exit code mismatch");
                Assert(!Directory.Exists(target), "Actual cancel wrote target files");
            }
            finally { if (!process.HasExited) { process.Kill(); process.WaitForExit(); } }
        }
    }
}
