using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Diagnostics;
using System.IO.Compression;
using System.Security;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Threading.Tasks;
using Microsoft.Win32;
using OrbitChat.SetupPreview;

namespace OrbitChat.Updater;

public partial class MainWindow : Window
{
    private const string AppExecutableName = "Orbit Chat.exe";
    private const string UninstallerName = "uninstall_orbitchat.exe";
    private const string MarkerName = ".orbitchat-install.json";
    private const string InstallMarkerId = "OrbitChat.OnlineInstaller.v1";
    private const string UninstallKeyName = "OrbitChat.OnlineInstaller";
    private const long MaximumExpandedArchiveBytes = 3L * 1024 * 1024 * 1024;

    private readonly string _installDirectory;
    private readonly int _appProcessId;
    private readonly string _currentVersion;
    private OrbitRelease? _release;
    private string? _installedAppPath;
    private bool _isUpdating;

    public MainWindow()
    {
        InitializeComponent();
        try
        {
            (_installDirectory, _appProcessId) = ReadAndValidateArguments(Environment.GetCommandLineArgs().Skip(1).ToArray());
            var appExecutable = Path.Combine(_installDirectory, AppExecutableName);
            var fileVersion = FileVersionInfo.GetVersionInfo(appExecutable);
            if (!string.Equals(fileVersion.ProductName, "Orbit Chat", StringComparison.OrdinalIgnoreCase))
                throw new SecurityException("The selected folder does not contain Orbit Chat.");
            _currentVersion = fileVersion.ProductVersion ?? fileVersion.FileVersion ?? "unknown";
            CurrentVersionText.Text = _currentVersion;
            FooterVersionText.Text = $"INSTALLED VERSION {_currentVersion}";
            _installedAppPath = appExecutable;
        }
        catch (Exception ex)
        {
            _installDirectory = string.Empty;
            _appProcessId = 0;
            _currentVersion = "unknown";
            HeadingText.Text = "Updater could not start";
            StatusText.Text = ex.Message;
            StatusText.Foreground = (Brush)FindResource("RedBrush");
            RetryButton.Visibility = Visibility.Collapsed;
            InstallUpdateButton.Visibility = Visibility.Collapsed;
            CancelButton.Content = "Close";
        }
    }

    private static (string Directory, int ProcessId) ReadAndValidateArguments(string[] args)
    {
        string? installDirectory = null;
        var processId = 0;
        for (var index = 0; index < args.Length; index++)
        {
            if (args[index] == "--install-directory" && index + 1 < args.Length)
                installDirectory = args[++index];
            else if (args[index] == "--app-process-id" && index + 1 < args.Length && int.TryParse(args[++index], out var parsedId))
                processId = parsedId;
        }

        if (string.IsNullOrWhiteSpace(installDirectory) || !Path.IsPathFullyQualified(installDirectory))
            throw new ArgumentException("The Orbit Chat installation folder could not be determined.");
        if (processId <= 0) throw new ArgumentException("The running Orbit Chat process could not be verified.");
        var target = Path.GetFullPath(installDirectory).TrimEnd(Path.DirectorySeparatorChar);
        var root = Path.GetPathRoot(target)?.TrimEnd(Path.DirectorySeparatorChar);
        if (target.Length < 5 || target.Length > 220 || string.Equals(target, root, StringComparison.OrdinalIgnoreCase))
            throw new SecurityException("The Orbit Chat installation folder is not valid.");
        if (!Directory.Exists(target) || !File.Exists(Path.Combine(target, AppExecutableName)) ||
            !File.Exists(Path.Combine(target, "resources", "app.asar")))
            throw new FileNotFoundException("The current Orbit Chat app files could not be verified.");
        return (target, processId);
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e) => await LoadLatestUpdateAsync();

    private void Header_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed) DragMove();
    }

    private void MinimizeButton_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();
    private void ExitButton_Click(object sender, RoutedEventArgs e) => Close();

    private async void RetryButton_Click(object sender, RoutedEventArgs e)
    {
        if (_release is not null) await InstallUpdateAsync();
        else await LoadLatestUpdateAsync();
    }
    private async void InstallUpdateButton_Click(object sender, RoutedEventArgs e) => await InstallUpdateAsync();
    private void OpenCurrentAppButton_Click(object sender, RoutedEventArgs e) => OpenCurrentApp();

    private async Task LoadLatestUpdateAsync()
    {
        if (string.IsNullOrEmpty(_installDirectory)) return;
        HeadingText.Text = "Checking for updates…";
        StatusText.Text = "Connecting securely to Orbit Chat Releases.";
        StatusText.Foreground = (Brush)FindResource("MutedBrush");
        RetryButton.Visibility = Visibility.Collapsed;
        RetryButton.Content = "Check again";
        OpenCurrentAppButton.Visibility = Visibility.Collapsed;
        InstallUpdateButton.Visibility = Visibility.Collapsed;
        VersionCard.Visibility = Visibility.Collapsed;
        NotesHeading.Visibility = Visibility.Collapsed;
        NotesCard.Visibility = Visibility.Collapsed;
        KeepDataNotice.Visibility = Visibility.Collapsed;
        CancelButton.Content = "Cancel";

        try
        {
            var releases = await GitHubReleaseCatalog.LoadAsync();
            _release = releases.FirstOrDefault(release =>
                release.Subtitle.StartsWith("Stable release", StringComparison.OrdinalIgnoreCase) &&
                IsNewerVersion(release.Tag, _currentVersion));
            if (_release is null)
            {
                HeadingText.Text = "You’re up to date.";
                StatusText.Text = $"Orbit Chat {_currentVersion} is the latest compatible stable release.";
                VersionCard.Visibility = Visibility.Visible;
                UpdateVersionText.Text = _currentVersion;
                CancelButton.Content = "Close";
                return;
            }

            HeadingText.Text = "A new version is ready.";
            StatusText.Text = "Review the update, then choose when to install it.";
            UpdateVersionText.Text = _release.Tag;
            VersionCard.Visibility = Visibility.Visible;
            NotesHeading.Visibility = Visibility.Visible;
            NotesCard.Visibility = Visibility.Visible;
            ReleaseNotesText.Text = string.IsNullOrWhiteSpace(_release.ReleaseNotes)
                ? "No release notes were included with this version."
                : _release.ReleaseNotes;
            KeepDataNotice.Visibility = Visibility.Visible;
            InstallUpdateButton.Visibility = Visibility.Visible;
            InstallUpdateButton.IsEnabled = true;
        }
        catch (Exception ex)
        {
            HeadingText.Text = "Couldn’t check for updates.";
            StatusText.Text = ex is HttpRequestException
                ? "Could not reach GitHub. Check your Internet connection and try again."
                : ex.Message;
            StatusText.Foreground = (Brush)FindResource("RedBrush");
            RetryButton.Visibility = Visibility.Visible;
        }
    }

    private static bool IsNewerVersion(string releaseTag, string installedVersion)
    {
        if (!TryVersion(releaseTag, out var release) || !TryVersion(installedVersion, out var installed)) return false;
        return release > installed;
    }

    private static bool TryVersion(string value, out Version version)
    {
        var normalized = value.Trim().TrimStart('v', 'V');
        var parts = normalized.Split('.');
        if (parts.Length == 4 && parts[3] == "0") normalized = string.Join('.', parts.Take(3));
        if (Version.TryParse(normalized, out var parsed) && parsed is not null)
        {
            version = parsed;
            return true;
        }
        version = new Version(0, 0, 0);
        return false;
    }

    private async Task InstallUpdateAsync()
    {
        if (_release is null || _isUpdating) return;
        if (string.IsNullOrWhiteSpace(_release.Sha256))
        {
            StatusText.Text = "This release does not provide a SHA-256 digest, so the update cannot be verified.";
            StatusText.Foreground = (Brush)FindResource("RedBrush");
            return;
        }

        _isUpdating = true;
        InstallUpdateButton.IsEnabled = false;
        RetryButton.Visibility = Visibility.Collapsed;
        CancelButton.IsEnabled = false;
        CloseButton.IsEnabled = false;
        ReviewStep.Visibility = Visibility.Collapsed;
        ProgressStep.Visibility = Visibility.Visible;
            ProgressCaption.Text = "Closing Orbit Chat safely…";
            ProgressDetail.Text = "Waiting for Orbit Chat to exit and release its files.";
            UpdateProgress.Value = 3;
            UpdateProgressSteps(0);

        var downloadPath = Path.Combine(Path.GetTempPath(), $"OrbitChat-update-{Guid.NewGuid():N}.zip");
        var stage = _installDirectory + ".updating-" + Guid.NewGuid().ToString("N");
        var backup = _installDirectory + ".previous-" + Guid.NewGuid().ToString("N");
        var oldMoved = false;
        var newMoved = false;
        (string? DisplayVersion, string? UninstallString, string? QuietUninstallString)? oldRegistry = null;

        try
        {
            oldRegistry = ReadUninstallRegistryValues(_installDirectory);
            await WaitForAppToCloseAsync();
            ProgressCaption.Text = "Downloading Orbit Chat…";
            ProgressDetail.Text = $"Orbit Chat {_release.Tag} · {GitHubReleaseCatalog.FormatSize(_release.Size)}";
            UpdateProgressSteps(1);
            var downloadProgress = new Progress<DownloadProgress>(progress =>
            {
                if (progress.IsVerifying)
                {
                    ProgressCaption.Text = "Verifying the download…";
                    ProgressDetail.Text = "Checking the published SHA-256 digest.";
                    UpdateProgressSteps(2);
                    UpdateProgress.Value = 58;
                    return;
                }
                var fraction = progress.TotalBytes is > 0
                    ? Math.Clamp(progress.ReceivedBytes / (double)progress.TotalBytes.Value, 0, 1)
                    : 0;
                UpdateProgress.Value = 5 + fraction * 48;
                ProgressDetail.Text = progress.TotalBytes is > 0
                    ? $"Downloaded {GitHubReleaseCatalog.FormatSize(progress.ReceivedBytes)} of {GitHubReleaseCatalog.FormatSize(progress.TotalBytes.Value)}."
                    : $"Downloaded {GitHubReleaseCatalog.FormatSize(progress.ReceivedBytes)}.";
            });
            await GitHubReleaseCatalog.DownloadAsync(_release, downloadPath, downloadProgress);

            ProgressCaption.Text = "Safely extracting the update…";
            ProgressDetail.Text = "Checking archive paths and validating the Orbit Chat files.";
            UpdateProgressSteps(3);
            Directory.CreateDirectory(stage);
            var extractProgress = new Progress<int>(percent => UpdateProgress.Value = 60 + percent * 0.27);
            await ExtractReleaseArchiveAsync(downloadPath, stage, extractProgress);
            if (!File.Exists(Path.Combine(stage, AppExecutableName)) || !File.Exists(Path.Combine(stage, "resources", "app.asar")))
                throw new InvalidDataException("The downloaded ZIP does not contain a valid Orbit Chat app.");

            ProgressCaption.Text = "Preserving your installation…";
            ProgressDetail.Text = "Keeping the uninstaller, install marker, and shortcuts in place.";
            UpdateProgressSteps(4);
            PreserveInstallMetadata(stage, _release.Tag);
            ProgressCaption.Text = "Installing the update…";
            ProgressDetail.Text = "Replacing app files. Your account data remains in your Windows profile.";
            UpdateProgressSteps(5);
            UpdateProgress.Value = 89;
            await MoveDirectoryWithRetryAsync(_installDirectory, backup);
            oldMoved = true;
            await MoveDirectoryWithRetryAsync(stage, _installDirectory);
            newMoved = true;
            ProgressCaption.Text = "Finalizing the update…";
            ProgressDetail.Text = "Refreshing the installed version and cleaning up temporary files.";
            UpdateProgressSteps(6);
            UpdateUninstallRegistration(_installDirectory, _release.Tag);
            if (oldMoved && Directory.Exists(backup))
            {
                try { Directory.Delete(backup, recursive: true); }
                catch { /* The new install is valid; an old backup can be cleaned later. */ }
            }
            UpdateProgressSteps(7);
            UpdateProgress.Value = 100;
            ProgressCaption.Text = "Update complete.";
            ProgressDetail.Text = $"Orbit Chat {_release.Tag} is installed. Your data and settings were kept.";
            CompleteVersionText.Text = $"Orbit Chat {_release.Tag} was installed successfully.";
            ReviewStep.Visibility = Visibility.Collapsed;
            ProgressStep.Visibility = Visibility.Collapsed;
            CompleteStep.Visibility = Visibility.Visible;
            CancelButton.Visibility = Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            if (newMoved && Directory.Exists(_installDirectory))
            {
                try { Directory.Delete(_installDirectory, recursive: true); } catch { }
            }
            if (oldMoved && Directory.Exists(backup) && !Directory.Exists(_installDirectory))
            {
                try { Directory.Move(backup, _installDirectory); } catch { }
            }
            RestoreUninstallRegistry(oldRegistry);
            if (Directory.Exists(stage))
            {
                try { Directory.Delete(stage, recursive: true); } catch { }
            }
            ProgressStep.Visibility = Visibility.Collapsed;
            ReviewStep.Visibility = Visibility.Visible;
            HeadingText.Text = "The update could not be installed.";
            var isFileLock = ex is IOException &&
                (ex.Message.Contains("being used by another process", StringComparison.OrdinalIgnoreCase) ||
                 ex.Message.Contains("release an Orbit Chat file", StringComparison.OrdinalIgnoreCase));
            StatusText.Text = isFileLock
                ? $"Windows could not replace an app file because it is still in use. Close Orbit Chat or any window using its install folder, then try again.\n\nDetails: {ex.Message}\nYour previous app files were kept where possible."
                : $"{ex.Message}\n\nYour previous app files were kept where possible. You can try again or reopen Orbit Chat.";
            StatusText.Foreground = (Brush)FindResource("RedBrush");
            VersionCard.Visibility = Visibility.Collapsed;
            NotesHeading.Visibility = Visibility.Collapsed;
            NotesCard.Visibility = Visibility.Collapsed;
            KeepDataNotice.Visibility = Visibility.Collapsed;
            InstallUpdateButton.Visibility = Visibility.Collapsed;
            InstallUpdateButton.IsEnabled = true;
            RetryButton.Visibility = Visibility.Visible;
            RetryButton.Content = "Try again";
            OpenCurrentAppButton.Visibility = File.Exists(_installedAppPath) ? Visibility.Visible : Visibility.Collapsed;
            CancelButton.IsEnabled = true;
            CancelButton.Content = "Close";
            CloseButton.IsEnabled = true;
        }
        finally
        {
            _isUpdating = false;
            try { File.Delete(downloadPath); } catch { }
        }
    }

    private async Task WaitForAppToCloseAsync()
    {
        try
        {
            using var originalProcess = Process.GetProcessById(_appProcessId);
            var originalExecutable = Path.GetFullPath(originalProcess.MainModule?.FileName ?? string.Empty);
            if (!string.Equals(originalExecutable, Path.Combine(_installDirectory, AppExecutableName), StringComparison.OrdinalIgnoreCase))
                throw new SecurityException("The updater was not started by this Orbit Chat installation.");
        }
        catch (ArgumentException) { /* Orbit Chat may have exited before the updater opened. */ }
        catch (InvalidOperationException) { /* The original process has already exited. */ }

        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            var running = false;
            foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(AppExecutableName)))
            {
                using (process)
                {
                    try
                    {
                        var executable = Path.GetFullPath(process.MainModule?.FileName ?? string.Empty);
                        if (string.Equals(executable, Path.Combine(_installDirectory, AppExecutableName), StringComparison.OrdinalIgnoreCase))
                        {
                            running = true;
                            break;
                        }
                    }
                    catch { running = true; break; }
                }
            }
            if (!running) return;
            ProgressDetail.Text = "Waiting for Orbit Chat to close…";
            await Task.Delay(300);
        }
        throw new TimeoutException("Orbit Chat is still running. Close it and try the update again.");
    }

    private async Task MoveDirectoryWithRetryAsync(string source, string destination)
    {
        const int maximumAttempts = 10;
        IOException? lastError = null;
        for (var attempt = 1; attempt <= maximumAttempts; attempt++)
        {
            try
            {
                Directory.Move(source, destination);
                return;
            }
            catch (IOException ex) when (attempt < maximumAttempts && !Directory.Exists(destination))
            {
                lastError = ex;
                ProgressDetail.Text = $"Waiting for Windows to release an app file… ({attempt}/{maximumAttempts - 1})";
                await Task.Delay(500);
            }
        }
        throw new IOException("Windows could not release an Orbit Chat file. Close other Orbit Chat processes or windows using the install folder, then try again.", lastError);
    }

    private async Task ExtractReleaseArchiveAsync(string archivePath, string destination, IProgress<int> progress)
    {
        await Task.Run(() =>
        {
            using var archive = ZipFile.OpenRead(archivePath);
            if (archive.Entries.Count is < 10 or > 10_000)
                throw new InvalidDataException("The release ZIP has an unexpected number of files.");
            long expandedBytes = 0;
            for (var index = 0; index < archive.Entries.Count; index++)
            {
                var entry = archive.Entries[index];
                var relative = entry.FullName.Replace('\\', '/');
                if (relative.StartsWith('/') || Path.IsPathRooted(relative) ||
                    relative.Split('/').Any(part => part is ".." or ".") || relative.Contains(':'))
                    throw new SecurityException("The release ZIP contains an unsafe file path.");
                var unixFileType = (entry.ExternalAttributes >> 16) & 0xF000;
                if (unixFileType == 0xA000)
                    throw new SecurityException("The release ZIP contains an unsupported symbolic link.");

                expandedBytes = checked(expandedBytes + entry.Length);
                if (expandedBytes > MaximumExpandedArchiveBytes)
                    throw new InvalidDataException("The expanded app exceeds the updater's size limit.");
                var outputPath = Path.GetFullPath(Path.Combine(destination, relative.Replace('/', Path.DirectorySeparatorChar)));
                if (!outputPath.StartsWith(destination + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    throw new SecurityException("A release ZIP entry would write outside the update staging folder.");
                if (relative.EndsWith('/')) Directory.CreateDirectory(outputPath);
                else
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
                    using var input = entry.Open();
                    using var output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                        131072, FileOptions.SequentialScan);
                    input.CopyTo(output);
                }
                if (index % 4 == 0) progress.Report((int)((index + 1d) / archive.Entries.Count * 100));
            }
            progress.Report(100);
        });
    }

    private void PreserveInstallMetadata(string stage, string newVersion)
    {
        var oldUninstaller = Path.Combine(_installDirectory, UninstallerName);
        if (File.Exists(oldUninstaller)) File.Copy(oldUninstaller, Path.Combine(stage, UninstallerName), overwrite: false);

        var oldMarkerPath = Path.Combine(_installDirectory, MarkerName);
        if (!File.Exists(oldMarkerPath)) return;
        JsonObject marker;
        try { marker = JsonNode.Parse(File.ReadAllText(oldMarkerPath))?.AsObject() ?? throw new JsonException(); }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidOperationException)
        {
            throw new InvalidDataException("The existing Orbit Chat install marker could not be verified.", ex);
        }
        if (marker["id"]?.GetValue<string>() != InstallMarkerId || marker["product"]?.GetValue<string>() != "Orbit Chat" ||
            !string.Equals(marker["installDirectory"]?.GetValue<string>(), _installDirectory, StringComparison.OrdinalIgnoreCase))
            throw new SecurityException("The existing Orbit Chat install marker does not match this folder.");
        marker["version"] = newVersion;
        WriteMarker(stage, marker);
    }

    private static void WriteMarker(string stage, JsonObject marker)
    {
        File.WriteAllText(Path.Combine(stage, MarkerName), marker.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    private (string? DisplayVersion, string? UninstallString, string? QuietUninstallString)? ReadUninstallRegistryValues(string installDirectory)
    {
        using var key = Registry.CurrentUser.OpenSubKey($@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{UninstallKeyName}", writable: false);
        if (key is null) return null;
        if (key.GetValue("DisplayName") as string != "Orbit Chat" ||
            !string.Equals(key.GetValue("InstallLocation") as string, installDirectory, StringComparison.OrdinalIgnoreCase))
            throw new SecurityException("The Installed apps entry points to a different Orbit Chat folder.");
        return (key.GetValue("DisplayVersion") as string, key.GetValue("UninstallString") as string,
            key.GetValue("QuietUninstallString") as string);
    }

    private void UpdateUninstallRegistration(string installDirectory, string version)
    {
        using var key = Registry.CurrentUser.OpenSubKey($@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{UninstallKeyName}", writable: true);
        if (key is null) return;
        if (key.GetValue("DisplayName") as string != "Orbit Chat" ||
            !string.Equals(key.GetValue("InstallLocation") as string, installDirectory, StringComparison.OrdinalIgnoreCase))
            throw new SecurityException("The Installed apps entry changed during the update.");
        key.SetValue("DisplayVersion", version, RegistryValueKind.String);
        foreach (var valueName in new[] { "UninstallString", "QuietUninstallString" })
        {
            if (key.GetValue(valueName) is not string command) continue;
            var updated = Regex.Replace(command, "(--version\\s+\")[^\"]+(\")", $"$1{version}$2", RegexOptions.CultureInvariant);
            if (!string.Equals(updated, command, StringComparison.Ordinal)) key.SetValue(valueName, updated, RegistryValueKind.String);
        }
    }

    private void RestoreUninstallRegistry((string? DisplayVersion, string? UninstallString, string? QuietUninstallString)? values)
    {
        if (values is null) return;
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey($@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{UninstallKeyName}", writable: true);
            if (key is null) return;
            if (values.Value.DisplayVersion is not null) key.SetValue("DisplayVersion", values.Value.DisplayVersion, RegistryValueKind.String);
            if (values.Value.UninstallString is not null) key.SetValue("UninstallString", values.Value.UninstallString, RegistryValueKind.String);
            if (values.Value.QuietUninstallString is not null) key.SetValue("QuietUninstallString", values.Value.QuietUninstallString, RegistryValueKind.String);
        }
        catch { /* Keep rollback best-effort if Windows blocks registry restoration. */ }
    }

    private void UpdateProgressSteps(int completed)
    {
        var items = new[] { ProgressClose, ProgressDownload, ProgressVerify, ProgressExtract, ProgressPreserve, ProgressInstall, ProgressFinish };
        var labels = new[]
        {
            "Close Orbit Chat and release its files",
            "Download the selected release",
            "Verify the published SHA-256",
            "Safely extract and validate app files",
            "Preserve install settings and shortcuts",
            "Replace app files and update registration",
            "Finish and clean up temporary files",
        };
        for (var index = 0; index < items.Length; index++)
        {
            items[index].Text = $"{(index < completed ? "✓" : index == completed ? "◌" : "○")}   {labels[index]}";
            items[index].Foreground = index < completed ? (Brush)FindResource("GreenBrush")
                : index == completed ? new SolidColorBrush(Color.FromRgb(216, 208, 255))
                : (Brush)FindResource("MutedBrush");
        }
    }

    private void OpenCurrentApp()
    {
        var executablePath = _installedAppPath;
        if (string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath)) return;
        try
        {
            Process.Start(new ProcessStartInfo(executablePath)
            {
                UseShellExecute = true,
                WorkingDirectory = _installDirectory,
            });
            Close();
        }
        catch (Exception ex)
        {
            StatusText.Text = $"Orbit Chat could not be opened.\n\n{ex.Message}";
        }
    }

    private void OpenAndExitButton_Click(object sender, RoutedEventArgs e)
    {
        var executablePath = _installedAppPath;
        if (string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath))
        {
            StatusText.Text = "Orbit Chat could not be found in the updated folder.";
            return;
        }
        try
        {
            using var launched = Process.Start(new ProcessStartInfo(executablePath)
            {
                UseShellExecute = true,
                WorkingDirectory = _installDirectory,
            });
            if (launched is null) throw new InvalidOperationException("Windows did not start Orbit Chat.");
            Close();
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show(this, $"Orbit Chat could not be opened.\n\n{ex.Message}",
                "Orbit Chat Updater", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }
}
