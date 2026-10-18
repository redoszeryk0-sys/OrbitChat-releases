using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Microsoft.Win32;
using MediaBrushes = System.Windows.Media.Brushes;
using MediaColor = System.Windows.Media.Color;

namespace OrbitChat.SetupPreview;

public partial class UninstallWindow : Window
{
    private readonly UninstallOptions _options;
    private int _step;
    private string? _cleanupScript;
    private bool _cleanupStarted;

    public UninstallWindow(UninstallOptions options)
    {
        _options = options;
        InitializeComponent();

        Title = $"{_options.ProductName} Uninstaller";
        BrandName.Text = _options.ProductName;
        ProductNameText.Text = _options.ProductName;
        ReviewProduct.Text = _options.ProductName;
        DoneProduct.Text = _options.ProductName;
        ProductVersionText.Text = $"Version {_options.Version} · Windows 64-bit";
        WelcomeDescription.Text = $"Remove {_options.ProductName} from this PC. The app will be uninstalled without connecting to the internet or GitHub.";
        ProgressHeading.Text = $"Removing {_options.ProductName}.";
        ReviewPath.Text = _options.InstallDirectory;
        DoneDescription.Text = $"{_options.ProductName} and its shortcuts are being removed. Your account data and settings are kept.";

        UpdateStepTracker();
        UpdateNavigation();
    }

    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed)
            DragMove();
    }

    private void MinimizeButton_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    private void BackButton_Click(object sender, RoutedEventArgs e)
    {
        if (_step == 1)
            ShowStep(0);
    }

    private async void NextButton_Click(object sender, RoutedEventArgs e)
    {
        if (_step == 0)
        {
            ShowStep(1);
            return;
        }

        if (_step == 1)
        {
            if (ConfirmRemoval.IsChecked != true)
                return;
            await BeginUninstallAsync();
            return;
        }

        if (_step == 3)
            FinishUninstall();
    }

    private void ConfirmRemoval_Changed(object sender, RoutedEventArgs e) => UpdateNavigation();

    private void ShowStep(int nextStep)
    {
        if (nextStep is < 0 or > 3 || nextStep == _step)
            return;

        var previousStep = _step;
        _step = nextStep;
        foreach (var page in StepPages())
            page.Visibility = Visibility.Collapsed;
        StepPages()[_step].Visibility = Visibility.Visible;

        StepPanel.Opacity = 0;
        StepSlide.X = nextStep >= previousStep ? 24 : -24;
        UpdateStepTracker();
        UpdateNavigation();

        if (SystemParameters.ClientAreaAnimation)
            ((Storyboard)FindResource("SlideForward")).Begin(this, true);
        else
        {
            StepPanel.Opacity = 1;
            StepSlide.X = 0;
        }
    }

    private StackPanel[] StepPages() => [WelcomeStep, ReviewStep, ProgressStep, DoneStep];

    private void UpdateNavigation()
    {
        BackButton.Visibility = _step == 1 ? Visibility.Visible : Visibility.Hidden;
        BackButton.IsEnabled = _step == 1;
        CloseButton.IsEnabled = _step != 2;
        NextButton.IsEnabled = _step switch
        {
            0 => true,
            1 => ConfirmRemoval.IsChecked == true,
            2 => false,
            _ => true,
        };
        NextButton.Content = _step switch
        {
            1 => "Uninstall  →",
            2 => "Removing…",
            3 => "Finish",
            _ => "Next  →",
        };
    }

    private void UpdateStepTracker()
    {
        StepTracker.Children.Clear();
        var labels = new[] { StepLabel0, StepLabel1, StepLabel2, StepLabel3 };
        for (var index = 0; index < labels.Length; index++)
        {
            var completed = index < _step;
            var current = index == _step;
            labels[index].Foreground = current
                ? new SolidColorBrush(MediaColor.FromRgb(209, 201, 242))
                : completed
                    ? new SolidColorBrush(MediaColor.FromRgb(144, 139, 157))
                    : new SolidColorBrush(MediaColor.FromRgb(119, 114, 130));
            labels[index].FontWeight = current ? FontWeights.SemiBold : FontWeights.Normal;

            var dot = new Border
            {
                Width = current ? 25 : 21,
                Height = current ? 25 : 21,
                CornerRadius = new CornerRadius(20),
                Background = completed ? new SolidColorBrush(MediaColor.FromRgb(72, 111, 89))
                    : current ? new SolidColorBrush(MediaColor.FromRgb(101, 90, 157))
                    : new SolidColorBrush(MediaColor.FromRgb(41, 38, 50)),
                BorderBrush = completed ? new SolidColorBrush(MediaColor.FromRgb(91, 151, 115))
                    : current ? new SolidColorBrush(MediaColor.FromRgb(153, 141, 209))
                    : new SolidColorBrush(MediaColor.FromRgb(57, 53, 68)),
                BorderThickness = new Thickness(1),
                HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                VerticalAlignment = System.Windows.VerticalAlignment.Center,
                Child = new TextBlock
                {
                    Text = completed ? "✓" : (index + 1).ToString(),
                    FontSize = completed ? 11 : 9,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = current || completed ? MediaBrushes.White : new SolidColorBrush(MediaColor.FromRgb(132, 126, 145)),
                    HorizontalAlignment = System.Windows.HorizontalAlignment.Center,
                    VerticalAlignment = System.Windows.VerticalAlignment.Center,
                    TextAlignment = TextAlignment.Center,
                },
            };
            StepTracker.Children.Add(new Grid { Children = { dot } });
        }

        StepProgressLine.Width = StepLineCanvas.ActualWidth * (_step / 3d);
    }

    private async Task BeginUninstallAsync()
    {
        UninstallError.Text = string.Empty;
        UninstallError.Visibility = Visibility.Collapsed;

        try
        {
            var installDirectory = ValidateInstallTarget();
            if (IsAppRunning(installDirectory))
                throw new InvalidOperationException($"Close {_options.ProductName} before uninstalling it, then try again.");

            _cleanupScript = CreateCleanupScript(installDirectory);
            ShowStep(2);
            CloseButton.IsEnabled = false;
            BackButton.IsEnabled = false;

            ProgressCaption.Text = "Checking the app installation…";
            ProgressDetail.Text = "Verifying the app files and selected install location.";
            SetProgress(.15, 0);
            await Task.Delay(300);

            ProgressCaption.Text = "Removing shortcuts and Installed apps entry…";
            ProgressDetail.Text = "Your account data and settings are not being changed.";
            RemoveShortcuts();
            Registry.CurrentUser.DeleteSubKeyTree(
                $@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{_options.RegistryKeyName}",
                throwOnMissingSubKey: false);
            SetProgress(.68, 1);
            await Task.Delay(400);

            ProgressCaption.Text = "Preparing final cleanup…";
            ProgressDetail.Text = "The application folder will be deleted after this window closes.";
            SetProgress(1, 3);
            await Task.Delay(350);

            DoneDescription.Text = $"{_options.ProductName} and its shortcuts have been removed. Your account data and settings were kept.";
            ShowStep(3);
        }
        catch (Exception ex)
        {
            if (_cleanupScript is not null)
            {
                try { File.Delete(_cleanupScript); } catch { }
                _cleanupScript = null;
            }

            UninstallError.Text = ex.Message;
            UninstallError.Visibility = Visibility.Visible;
            ShowStep(1);
        }
    }

    private string ValidateInstallTarget()
    {
        var installDirectory = Path.GetFullPath(_options.InstallDirectory).TrimEnd(Path.DirectorySeparatorChar);
        var expectedProduct = _options.ProductName switch
        {
            "Orbit Chat" => (Folder: "", Executable: "Orbit Chat.exe", Key: "OrbitChat.OnlineInstaller", StartMenu: "Orbit Chat", Shortcut: "Orbit Chat.lnk"),
            "OrbitChat Dev" => (Folder: "OrbitChat-Dev", Executable: "OrbitChat Dev.exe", Key: "OrbitChatDev.LegacyInstall", StartMenu: "OrbitChat Dev", Shortcut: "OrbitChat Dev.lnk"),
            _ => throw new SecurityException("This uninstaller does not recognize the selected app."),
        };

        if (string.Equals(_options.ProductName, "Orbit Chat", StringComparison.Ordinal))
        {
            var root = Path.GetPathRoot(installDirectory)?.TrimEnd(Path.DirectorySeparatorChar);
            if (installDirectory.Length < 5 || string.Equals(installDirectory, root, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(_options.AllowedInstallFolder, "OrbitChat.OnlineInstaller.v1", StringComparison.Ordinal)
                || !string.Equals(_options.RegistryKeyName, expectedProduct.Key, StringComparison.Ordinal)
                || !string.Equals(_options.AppExecutableName, expectedProduct.Executable, StringComparison.Ordinal)
                || !string.Equals(_options.StartMenuFolder, expectedProduct.StartMenu, StringComparison.Ordinal)
                || !string.Equals(_options.ShortcutName, expectedProduct.Shortcut, StringComparison.Ordinal))
                throw new SecurityException("The selected folder is not a valid registered Orbit Chat installation.");

            using var uninstallKey = Registry.CurrentUser.OpenSubKey(
                $@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{expectedProduct.Key}", writable: false);
            if (uninstallKey?.GetValue("DisplayName") as string != "Orbit Chat"
                || !string.Equals(uninstallKey.GetValue("InstallLocation") as string, installDirectory, StringComparison.OrdinalIgnoreCase))
                throw new SecurityException("The Windows Installed apps entry does not match this Orbit Chat folder.");

            var markerPath = Path.Combine(installDirectory, ".orbitchat-install.json");
            try
            {
                using var marker = JsonDocument.Parse(File.ReadAllText(markerPath));
                var data = marker.RootElement;
                if (data.GetProperty("id").GetString() != "OrbitChat.OnlineInstaller.v1"
                    || data.GetProperty("product").GetString() != "Orbit Chat"
                    || !string.Equals(data.GetProperty("installDirectory").GetString(), installDirectory, StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(data.GetProperty("version").GetString(), _options.Version, StringComparison.Ordinal))
                    throw new SecurityException("The Orbit Chat install marker does not match this uninstall request.");
            }
            catch (Exception ex) when (ex is IOException or JsonException or KeyNotFoundException or InvalidOperationException)
            {
                throw new SecurityException("The Orbit Chat installation marker is missing or invalid.", ex);
            }

            if (!File.Exists(Path.Combine(installDirectory, _options.AppExecutableName))
                || !File.Exists(Path.Combine(installDirectory, "uninstall_orbitchat.exe")))
                throw new FileNotFoundException("A required Orbit Chat installation file could not be found. No files were removed.");
        }
        else
        {
            var programsDirectory = Path.GetFullPath(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"))
                .TrimEnd(Path.DirectorySeparatorChar);
            var parent = Directory.GetParent(installDirectory)?.FullName.TrimEnd(Path.DirectorySeparatorChar);
            if (!string.Equals(parent, programsDirectory, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(Path.GetFileName(installDirectory), expectedProduct.Folder, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(_options.AllowedInstallFolder, expectedProduct.Folder, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(_options.RegistryKeyName, expectedProduct.Key, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(_options.AppExecutableName, expectedProduct.Executable, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(_options.StartMenuFolder, expectedProduct.StartMenu, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(_options.ShortcutName, expectedProduct.Shortcut, StringComparison.OrdinalIgnoreCase))
                throw new SecurityException("For safety, this uninstaller only removes its registered app folder under your Windows Programs directory.");

            if (!File.Exists(Path.Combine(installDirectory, _options.AppExecutableName)))
                throw new FileNotFoundException("The app executable could not be found. No files were removed.");
        }

        if (!string.Equals(_options.AppExecutableName, expectedProduct.Executable, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(_options.StartMenuFolder, expectedProduct.StartMenu, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(_options.ShortcutName, expectedProduct.Shortcut, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(_options.RegistryKeyName, expectedProduct.Key, StringComparison.OrdinalIgnoreCase))
            throw new SecurityException("The uninstall options do not match a supported Orbit Chat product.");

        return installDirectory;
    }

    private bool IsAppRunning(string installDirectory)
    {
        var processName = Path.GetFileNameWithoutExtension(_options.AppExecutableName);
        foreach (var process in Process.GetProcessesByName(processName))
        {
            using (process)
            {
                try
                {
                    var processPath = process.MainModule?.FileName;
                    if (processPath is not null && string.Equals(
                        Path.GetFullPath(processPath), Path.Combine(installDirectory, _options.AppExecutableName),
                        StringComparison.OrdinalIgnoreCase))
                        return true;
                }
                catch
                {
                    return true;
                }
            }
        }

        return false;
    }

    private void RemoveShortcuts()
    {
        var desktopShortcut = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), _options.ShortcutName);
        var startMenuDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", _options.StartMenuFolder);
        var startMenuShortcut = Path.Combine(startMenuDirectory, _options.ShortcutName);

        File.Delete(desktopShortcut);
        File.Delete(startMenuShortcut);
        if (Directory.Exists(startMenuDirectory) && !Directory.EnumerateFileSystemEntries(startMenuDirectory).Any())
            Directory.Delete(startMenuDirectory);
    }

    private static string CreateCleanupScript(string installDirectory)
    {
        var cleanupPath = Path.Combine(Path.GetTempPath(), $"orbit-chat-uninstall-{Guid.NewGuid():N}.cmd");
        var temporaryExecutable = Environment.ProcessPath;
        if (temporaryExecutable is null || temporaryExecutable.Contains('"'))
            throw new InvalidOperationException("The uninstaller could not prepare its final cleanup step.");

        var contents = new StringBuilder()
            .AppendLine("@echo off")
            .AppendLine("timeout /t 3 /nobreak >nul")
            .AppendLine($"rmdir /s /q \"{installDirectory}\" >nul 2>&1")
            .AppendLine($"del /f /q \"{temporaryExecutable}\" >nul 2>&1")
            .AppendLine("del /f /q \"%~f0\" >nul 2>&1")
            .ToString();
        File.WriteAllText(cleanupPath, contents, Encoding.ASCII);
        return cleanupPath;
    }

    private void SetProgress(double fraction, int step)
    {
        ProgressPercent.Text = $"{(int)(fraction * 100)}%";
        ProgressFill.Width = Math.Max(12, ProgressTrack.ActualWidth * fraction);
        UpdateProgressSteps(step);
    }

    private void UpdateProgressSteps(int activeStep)
    {
        var labels = new[] { ProgressLineOne, ProgressLineTwo, ProgressLineThree };
        var captions = new[] { "Check app files", "Remove shortcuts and app entry", "Finish cleanup" };
        for (var index = 0; index < labels.Length; index++)
        {
            var completed = index < activeStep;
            var active = index == activeStep && activeStep < labels.Length;
            labels[index].Text = $"{(completed ? "✓" : active ? "◌" : "○")}   {captions[index]}";
            labels[index].Foreground = completed
                ? new SolidColorBrush(MediaColor.FromRgb(126, 213, 166))
                : active ? new SolidColorBrush(MediaColor.FromRgb(209, 201, 242))
                : new SolidColorBrush(MediaColor.FromRgb(119, 114, 130));
        }
    }

    private void FinishUninstall()
    {
        try
        {
            StartCleanupProcess();
            _cleanupStarted = true;
            Close();
        }
        catch (Exception ex)
        {
            UninstallError.Text = $"The uninstaller window could not start the final cleanup: {ex.Message}";
            UninstallError.Visibility = Visibility.Visible;
        }
    }

    private void StartCleanupProcess()
    {
        if (_cleanupScript is null)
            throw new InvalidOperationException("The cleanup command is not ready.");

        var commandProcessor = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
        var startInfo = new ProcessStartInfo(commandProcessor)
        {
            Arguments = $"/d /c \"\"{_cleanupScript}\"\"",
            CreateNoWindow = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetTempPath(),
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        _ = Process.Start(startInfo) ?? throw new InvalidOperationException("Windows could not start the cleanup command.");
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (_cleanupScript is not null && !_cleanupStarted)
        {
            try
            {
                StartCleanupProcess();
                _cleanupStarted = true;
            }
            catch
            {
                e.Cancel = true;
                UninstallError.Text = "The final cleanup could not start. Please choose Finish again.";
                UninstallError.Visibility = Visibility.Visible;
            }
        }
    }
}
