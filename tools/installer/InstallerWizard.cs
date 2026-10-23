using System;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

internal sealed class InstallerWizard : Form
{
    private readonly Installer engine;
    private readonly InstallOptions options;
    private readonly Panel content = new Panel();
    private readonly Label heading = new Label();
    private readonly Label detail = new Label();
    private readonly TextBox path = new TextBox();
    private readonly CheckBox desktopShortcut = new CheckBox();
    private readonly CheckBox startMenuShortcut = new CheckBox();
    private readonly CheckBox launch = new CheckBox();
    private readonly Button back = new Button();
    private readonly Button next = new Button();
    private readonly Button cancel = new Button();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly BackgroundWorker worker = new BackgroundWorker();
    private int page;
    private bool installing;
    private InstallResult result;
    internal int ExitCode { get; private set; }

    internal InstallerWizard(Installer engine, InstallOptions options)
    {
        this.engine = engine; this.options = options; ExitCode = 2;
        Name = "InstallerWizard"; Text = "实时会议助手 v" + engine.Version + " 安装向导";
        ClientSize = new Size(640, 440); Font = new Font("Microsoft YaHei UI", 9F); BackColor = Color.White;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.Dpi;
        Label brand = new Label { Text = "实时会议助手", Font = new Font(Font.FontFamily, 17F, FontStyle.Bold), ForeColor = Color.FromArgb(30, 75, 130) };
        brand.SetBounds(28, 22, 560, 36);
        Label steps = new Label { Text = "欢迎  >  安装位置  >  快捷方式  >  确认安装  >  安装进度  >  完成", ForeColor = Color.DimGray }; steps.Name = "StepLabel"; steps.SetBounds(30, 65, 570, 24);
        content.SetBounds(28, 102, 584, 257);
        heading.Name = "PageHeading"; heading.Font = new Font(Font.FontFamily, 13F, FontStyle.Bold); heading.SetBounds(0, 0, 580, 34);
        detail.Name = "PageDetail"; detail.SetBounds(0, 44, 580, 190);
        Label footer = new Label { Text = "版本 " + engine.Version, ForeColor = Color.DimGray }; footer.SetBounds(28, 393, 290, 26);
        back.Name = "BackButton"; back.Text = "< 上一步"; back.SetBounds(330, 385, 90, 34); back.Click += delegate { ShowPage(page - 1); };
        next.Name = "NextButton"; next.SetBounds(430, 385, 90, 34); next.Click += delegate { Next(); };
        cancel.Name = "CancelButton"; cancel.Text = "取消"; cancel.SetBounds(530, 385, 82, 34); cancel.Click += delegate { Close(); };
        Controls.AddRange(new Control[] { brand, steps, content, footer, back, next, cancel }); AcceptButton = next; CancelButton = cancel;
        path.Name = "InstallPath"; path.Text = options.Target;
        desktopShortcut.Name = "DesktopShortcut"; desktopShortcut.Text = "创建桌面快捷方式"; desktopShortcut.Checked = options.DesktopShortcut;
        startMenuShortcut.Name = "StartMenuShortcut"; startMenuShortcut.Text = "在开始菜单中添加快捷方式"; startMenuShortcut.Checked = options.StartMenuShortcut;
        launch.Name = "LaunchAfterInstall"; launch.Text = "完成后启动实时会议助手"; launch.Checked = true;
        progress.Name = "InstallProgress"; worker.WorkerReportsProgress = true;
        worker.DoWork += delegate(object sender, DoWorkEventArgs e) { e.Result = engine.Install(options, delegate(InstallProgress p) { worker.ReportProgress(p.Percent, p.Message); }); };
        worker.ProgressChanged += delegate(object sender, ProgressChangedEventArgs e) { progress.Value = e.ProgressPercentage; detail.Text = (string)e.UserState; };
        worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs e)
        {
            installing = false;
            if (e.Error != null) { engine.Record("FAILED " + e.Error); ShowError(e.Error.Message); }
            else { result = (InstallResult)e.Result; ExitCode = 0; ShowPage(5); }
        };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (installing) e.Cancel = true; };
        ShowPage(0);
    }

    private void ShowPage(int value)
    {
        page = value;
        foreach (Control control in new System.Collections.Generic.List<Control>(ControlsOf(content))) if (object.Equals(control.Tag, "transient")) control.Dispose();
        content.Controls.Clear(); content.Controls.AddRange(new Control[] { heading, detail }); detail.Height = 190;
        back.Enabled = page > 0 && page < 4; back.Visible = page < 5;
        cancel.Enabled = page != 4; cancel.Visible = page < 5; next.Enabled = page != 4;
        next.Text = page == 3 ? "安装" : page == 5 ? "完成" : "下一步 >";
        if (page == 0)
        {
            heading.Text = "欢迎使用安装向导";
            detail.Text = "此向导将在你的电脑上安装" + engine.Label + "。\n\n你可以选择安装位置和快捷方式，安装完成后直接打开应用。\n\n升级会保留已有配置、会议数据库和模型。请先正常退出要更新的应用。";
        }
        else if (page == 1)
        {
            heading.Text = "选择安装位置"; detail.Height = 50;
            detail.Text = "程序文件将安装到下面的文件夹。可以直接修改路径，或点击“浏览”。";
            path.SetBounds(0, 108, 478, 28);
            Button browse = new Button { Name = "BrowseButton", Text = "浏览…", Tag = "transient" }; browse.SetBounds(490, 105, 90, 32);
            browse.Click += delegate { using (FolderPicker picker = new FolderPicker(path.Text)) { if (picker.ShowDialog(this) == DialogResult.OK) path.Text = picker.SelectedPath; } };
            Label note = new Label { Text = "会议和配置单独保存在用户数据目录，重新安装不会清空它们。", ForeColor = Color.DimGray, Tag = "transient" }; note.SetBounds(0, 158, 580, 50);
            content.Controls.AddRange(new Control[] { path, browse, note });
        }
        else if (page == 2)
        {
            heading.Text = "选择快捷方式"; detail.Height = 45; detail.Text = "选择安装完成后从哪里打开应用。";
            desktopShortcut.SetBounds(0, 99, 500, 30); startMenuShortcut.SetBounds(0, 140, 500, 30);
            desktopShortcut.Enabled = startMenuShortcut.Enabled = engine.ShortcutName.Length > 0;
            content.Controls.AddRange(new Control[] { desktopShortcut, startMenuShortcut });
        }
        else if (page == 3)
        {
            heading.Text = "准备安装";
            detail.Text = "版本：" + engine.Version + "\n\n安装位置：" + options.Target + "\n\n桌面快捷方式：" + (desktopShortcut.Checked ? "创建" : "不创建") + "\n开始菜单快捷方式：" + (startMenuShortcut.Checked ? "创建" : "不创建") + "\n\n点击“安装”开始。安装期间请等待文件写入完成。";
        }
        else if (page == 4)
        {
            heading.Text = "正在安装"; detail.Height = 85; detail.Text = "正在准备安装文件，请稍候…";
            progress.Value = 0; progress.SetBounds(0, 141, 580, 25); content.Controls.Add(progress);
        }
        else if (page == 5)
        {
            heading.Text = "安装完成"; detail.Height = 150;
            detail.Text = "已安装 " + engine.Label + " v" + engine.Version + "。\n\n安装位置：" + result.Target + "\n\n" + (result.Warnings.Count > 0 ? string.Join("\n", result.Warnings.ToArray()) : "点击“完成”关闭安装向导。") + "\n日志：" + engine.LogPath;
            launch.SetBounds(0, 203, 580, 30); launch.Enabled = engine.CanLaunch(result.Target); if (!launch.Enabled) launch.Checked = false;
            content.Controls.Add(launch);
        }
    }

    private static System.Collections.Generic.IEnumerable<Control> ControlsOf(Control parent)
    {
        foreach (Control child in parent.Controls) yield return child;
    }

    private void Next()
    {
        if (page == 5)
        {
            if (launch.Checked) try { engine.Launch(result.Target); } catch (Exception ex) { engine.Record("LAUNCH FAILED " + ex); MessageBox.Show(this, "应用已安装成功，但自动启动未完成。请从安装目录打开应用。\n\n" + ex.Message, "启动提示", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            Close(); return;
        }
        if (page == 1)
        {
            try { options.Target = Installer.NormalizeTarget(path.Text); path.Text = options.Target; }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "请检查安装位置", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
        }
        if (page == 3)
        {
            options.DesktopShortcut = desktopShortcut.Checked; options.StartMenuShortcut = startMenuShortcut.Checked;
            ShowPage(4); installing = true; worker.RunWorkerAsync(); return;
        }
        ShowPage(page + 1);
    }

    private void ShowError(string message)
    {
        page = 3; content.Controls.Clear(); content.Controls.AddRange(new Control[] { heading, detail });
        heading.Text = "安装未完成"; detail.Height = 205;
        detail.Text = message + "\n\n请修正问题后重试，或返回修改安装位置。\n日志：" + engine.LogPath;
        back.Visible = true; back.Enabled = true; next.Enabled = true; next.Text = "重试"; cancel.Enabled = true; ExitCode = 1;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            worker.Dispose(); path.Dispose(); desktopShortcut.Dispose(); startMenuShortcut.Dispose(); launch.Dispose(); progress.Dispose();
        }
        base.Dispose(disposing);
    }
}

// Lazy local enumeration avoids the shell extension stall observed in the original folder picker.
internal sealed class FolderPicker : Form
{
    private readonly TextBox selected = new TextBox();
    internal string SelectedPath { get { return selected.Text; } }
    internal FolderPicker(string initial)
    {
        Text = "选择安装文件夹"; ClientSize = new Size(520, 420); StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false; MaximizeBox = false; FormBorderStyle = FormBorderStyle.FixedDialog;
        TreeView tree = new TreeView(); tree.Name = "FolderTree"; tree.SetBounds(16, 16, 488, 290);
        foreach (DriveInfo drive in DriveInfo.GetDrives())
        {
            if (!drive.IsReady || (drive.DriveType != DriveType.Fixed && drive.DriveType != DriveType.Removable)) continue;
            TreeNode node = new TreeNode(drive.Name); node.Tag = drive.RootDirectory.FullName; node.Nodes.Add("…"); tree.Nodes.Add(node);
        }
        tree.BeforeExpand += delegate(object sender, TreeViewCancelEventArgs e)
        {
            if (e.Node.Nodes.Count != 1 || e.Node.Nodes[0].Text != "…") return;
            e.Node.Nodes.Clear();
            try
            {
                foreach (string directory in Directory.GetDirectories((string)e.Node.Tag))
                {
                    if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) continue;
                    TreeNode node = new TreeNode(Path.GetFileName(directory)); node.Tag = directory; node.Nodes.Add("…"); e.Node.Nodes.Add(node);
                }
            }
            catch (Exception) { /* An unreadable directory has no selectable children. */ }
        };
        tree.AfterSelect += delegate(object sender, TreeViewEventArgs e) { selected.Text = (string)e.Node.Tag; };
        selected.Name = "FolderPath"; selected.Text = initial; selected.SetBounds(16, 318, 488, 26);
        Button ok = new Button { Name = "FolderChoose", Text = "选择", DialogResult = DialogResult.OK }; ok.SetBounds(322, 367, 86, 32);
        Button cancel = new Button { Name = "FolderCancel", Text = "取消", DialogResult = DialogResult.Cancel }; cancel.SetBounds(418, 367, 86, 32);
        Controls.AddRange(new Control[] { tree, selected, ok, cancel }); AcceptButton = ok; CancelButton = cancel;
    }
}
