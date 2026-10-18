using System.Collections.ObjectModel;
using System.Globalization;
using System.IO.Compression;
using System.IO;
using System.Net.Http;
using System.Security;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Microsoft.Win32;
using Forms = System.Windows.Forms;
using MediaBrushes = System.Windows.Media.Brushes;
using MediaColor = System.Windows.Media.Color;

namespace OrbitChat.SetupPreview;

public partial class MainWindow : Window
{
    private const string UninstallKeyName = "OrbitChat.OnlineInstaller";
    private const string AppExecutableName = "Orbit Chat.exe";
    private const string UninstallerName = "uninstall_orbitchat.exe";
    private const string InstallMarkerName = ".orbitchat-install.json";
    private const string InstallMarkerId = "OrbitChat.OnlineInstaller.v1";
    private const long MaximumExpandedArchiveBytes = 3L * 1024 * 1024 * 1024;
    private readonly record struct ArchiveExtractionProgress(long ExtractedBytes, long TotalBytes, int CompletedEntries, int TotalEntries);

    private readonly ObservableCollection<OrbitRelease> _releases = [];
    private bool _isInitializing = true;
    private int _step;
    private int _progressTick;
    private string _completedAction = "Install";
    private string _completedVersion = "unknown";
    private string? _installedAppPath;

    public MainWindow()
    {
        InitializeComponent();
        InstallPathBox.Text = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Orbit Chat");
        VersionSelector.ItemsSource = _releases;
        VersionSelector.SelectedIndex = -1;
        _isInitializing = false;

        UpdateActionPreview();
        UpdateStepTracker();
        UpdateNavigation();
        _ = LoadReleaseCatalogAsync();
    }

    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ButtonState == MouseButtonState.Pressed) DragMove();
    }

    private void MinimizeButton_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    private async void RetryReleasesButton_Click(object sender, RoutedEventArgs e) => await LoadReleaseCatalogAsync();

    private async Task LoadReleaseCatalogAsync()
    {
        VersionSelector.IsEnabled = false;
        RetryReleasesButton.Visibility = Visibility.Collapsed;
        ReleaseCatalogStatus.Text = "Loading release tags from GitHub…";
        ReleaseCatalogStatus.Foreground = new SolidColorBrush(MediaColor.FromRgb(144, 139, 157));
        try
        {
            var releases = await GitHubReleaseCatalog.LoadAsync();
            _releases.Clear();
            foreach (var release in releases) _releases.Add(release);
            VersionSelector.SelectedIndex = 0;
            VersionSelector.IsEnabled = _releases.Count > 0;
            ReleaseCatalogStatus.Text = $"Found {_releases.Count} compatible Windows release{(_releases.Count == 1 ? string.Empty : "s")}.";
            UpdateActionPreview();
            UpdateReviewSummary();
        }
        catch (Exception ex)
        {
            ReleaseCatalogStatus.Text = ex is HttpRequestException
                ? "Could not reach GitHub. Check your Internet connection and retry."
                : ex.Message;
            ReleaseCatalogStatus.Foreground = new SolidColorBrush(MediaColor.FromRgb(240, 143, 153));
            RetryReleasesButton.Visibility = Visibility.Visible;
            _releases.Clear();
            VersionSelector.SelectedIndex = -1;
            UpdateActionPreview();
        }
        UpdateNavigation();
    }

    private void BrowseButton_Click(object sender, RoutedEventArgs e)
    {
        using var dialog = new Forms.FolderBrowserDialog
        {
            Description = "Choose where Orbit Chat should be installed.",
            UseDescriptionForTitle = true,
            SelectedPath = InstallPathBox.Text,
            ShowNewFolderButton = true,
        };
        if (dialog.ShowDialog() == Forms.DialogResult.OK)
        {
            var selectedPath = Path.GetFullPath(dialog.SelectedPath.Trim());
            var chosenFolderIsOrbitChat = string.Equals(
                Path.GetFileName(selectedPath.TrimEnd(Path.DirectorySeparatorChar)), "Orbit Chat", StringComparison.OrdinalIgnoreCase)
                || IsManagedInstall(selectedPath);
            InstallPathBox.Text = chosenFolderIsOrbitChat ? selectedPath : Path.Combine(selectedPath, "Orbit Chat");
            UpdateReviewSummary();
            UpdateActionPreview();
        }
    }

    private void VersionSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_isInitializing) return;
        UpdateActionPreview();
        UpdateReviewSummary();
        UpdateNavigation();
    }

    private void NoticeAcknowledgement_Changed(object sender, RoutedEventArgs e)
    {
        if (!_isInitializing) UpdateNavigation();
    }

    private void BackButton_Click(object sender, RoutedEventArgs e)
    {
        if (_step is 0 or >= 4) return;
        ShowStep(_step - 1);
    }

    private async void NextButton_Click(object sender, RoutedEventArgs e)
    {
        switch (_step)
        {
            case 0:
                ShowStep(1);
                break;
            case 1 when NoticeAcknowledgement.IsChecked == true:
                ShowStep(2);
                break;
            case 2 when VersionSelector.SelectedItem is OrbitRelease:
                UpdateReviewSummary();
                ShowStep(3);
                break;
            case 3 when VersionSelector.SelectedItem is OrbitRelease:
                await StartOnlineInstallAsync();
                break;
            case 5:
                Close();
                break;
        }
    }

    private void ShowStep(int nextStep)
    {
        if (nextStep is < 0 or > 5 || nextStep == _step) return;
        var previousStep = _step;
        _step = nextStep;
        foreach (var page in StepPages()) page.Visibility = Visibility.Collapsed;
        StepPages()[_step].Visibility = Visibility.Visible;
        StepPanel.Opacity = 0;
        StepSlide.X = nextStep >= previousStep ? 28 : -28;
        UpdateStepTracker();
        UpdateNavigation();
        if (SystemParameters.ClientAreaAnimation)
            ((Storyboard)FindResource(nextStep >= previousStep ? "SlideForward" : "SlideBackward")).Begin(this, true);
        else
        {
            StepPanel.Opacity = 1;
            StepSlide.X = 0;
        }
    }

    private StackPanel[] StepPages() => [WelcomeStep, NoticeStep, OptionsStep, ReviewStep, ProgressStep, CompleteStep];

    private void UpdateNavigation()
    {
        BackButton.Visibility = _step is 0 or 4 or 5 ? Visibility.Hidden : Visibility.Visible;
        NextButton.Content = _step switch
        {
            3 => $"{GetSelectedAction()} Orbit Chat  →",
            4 => "Installing…",
            5 => "Exit",
            _ => "Next  →",
        };
        NextButton.Visibility = _step == 5 ? Visibility.Collapsed : Visibility.Visible;
        NextButton.IsEnabled = _step switch
        {
            1 => NoticeAcknowledgement.IsChecked == true,
            2 or 3 => VersionSelector.SelectedItem is OrbitRelease,
            4 => false,
            _ => true,
        };
    }

    private void UpdateStepTracker()
    {
        StepTracker.Children.Clear();
        var labels = new[] { StepLabel0, StepLabel1, StepLabel2, StepLabel3, StepLabel4, StepLabel5 };
        for (var index = 0; index < labels.Length; index++)
        {
            var completed = index < _step;
            var current = index == _step;
            labels[index].Foreground = current
                ? new SolidColorBrush(MediaColor.FromRgb(209, 201, 242))
                : completed ? new SolidColorBrush(MediaColor.FromRgb(144, 139, 157))
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
    }

    private void UpdateActionPreview()
    {
        var release = VersionSelector.SelectedItem as OrbitRelease;
        var installed = DetectInstalledVersion();
        if (release is null)
        {
            ActionHeading.Text = "Choose a version";
            ActionDescription.Text = "Load a compatible GitHub release before continuing.";
            ActionIndicator.Background = new SolidColorBrush(MediaColor.FromRgb(237, 105, 116));
            return;
        }
        var heading = GetReleaseAction(release.Tag, installed);
        ActionHeading.Text = heading;
        ActionDescription.Text = heading switch
        {
            "Install" => $"Orbit Chat {release.Tag} will be downloaded from GitHub.",
            "Repair" => $"Orbit Chat {installed} will be repaired with version {release.Tag}.",
            "Downgrade" => $"Orbit Chat {installed} will be downgraded to version {release.Tag}.",
            _ => $"Orbit Chat {installed} will be updated to version {release.Tag}.",
        };
        ActionIndicator.Background = new SolidColorBrush(heading == "Downgrade"
            ? MediaColor.FromRgb(208, 153, 94)
            : release.IsNewest ? MediaColor.FromRgb(81, 199, 139) : MediaColor.FromRgb(136, 123, 207));
    }

    private void UpdateReviewSummary()
    {
        var release = VersionSelector.SelectedItem as OrbitRelease;
        ReviewAction.Text = release is null ? "No release selected" : GetReleaseAction(release.Tag, DetectInstalledVersion());
        ReviewVersion.Text = release is null ? "No version selected" : $"Orbit Chat {release.Tag}";
        ReviewPath.Text = InstallPathBox.Text;
    }

    private string GetSelectedAction() => VersionSelector.SelectedItem is OrbitRelease release
        ? GetReleaseAction(release.Tag, DetectInstalledVersion())
        : "Install";

    private static string GetReleaseAction(string selectedVersion, string? installedVersion)
    {
        if (installedVersion is null) return "Install";
        var comparison = CompareReleaseVersions(selectedVersion, installedVersion);
        return comparison == 0 ? "Repair" : comparison < 0 ? "Downgrade" : "Update";
    }

    private static int CompareReleaseVersions(string left, string right)
    {
        static (Version? Core, string? Prerelease) Parse(string value)
        {
            var normalized = value.Trim().TrimStart('v', 'V');
            var buildIndex = normalized.IndexOf('+');
            if (buildIndex >= 0) normalized = normalized[..buildIndex];
            string? prerelease = null;
            var prereleaseIndex = normalized.IndexOf('-');
            if (prereleaseIndex >= 0)
            {
                prerelease = normalized[(prereleaseIndex + 1)..];
                normalized = normalized[..prereleaseIndex];
            }
            if (normalized.Count(character => character == '.') == 2) normalized += ".0";
            return (Version.TryParse(normalized, out var version) ? version : null, prerelease);
        }

        var leftVersion = Parse(left);
        var rightVersion = Parse(right);
        if (leftVersion.Core is null || rightVersion.Core is null)
            return StringComparer.OrdinalIgnoreCase.Compare(left, right);

        var coreComparison = leftVersion.Core.CompareTo(rightVersion.Core);
        if (coreComparison != 0) return coreComparison;
        if (leftVersion.Prerelease is null) return rightVersion.Prerelease is null ? 0 : 1;
        if (rightVersion.Prerelease is null) return -1;

        var leftIdentifiers = leftVersion.Prerelease.Split('.');
        var rightIdentifiers = rightVersion.Prerelease.Split('.');
        for (var index = 0; index < Math.Min(leftIdentifiers.Length, rightIdentifiers.Length); index++)
        {
            var leftNumeric = long.TryParse(leftIdentifiers[index], NumberStyles.None, CultureInfo.InvariantCulture, out var leftNumber);
            var rightNumeric = long.TryParse(rightIdentifiers[index], NumberStyles.None, CultureInfo.InvariantCulture, out var rightNumber);
            var comparison = leftNumeric && rightNumeric ? leftNumber.CompareTo(rightNumber)
                : leftNumeric ? -1 : rightNumeric ? 1
                : StringComparer.Ordinal.Compare(leftIdentifiers[index], rightIdentifiers[index]);
            if (comparison != 0) return comparison;
        }
        return leftIdentifiers.Length.CompareTo(rightIdentifiers.Length);
    }

    private string? DetectInstalledVersion()
    {
        if (!Path.IsPathFullyQualified(InstallPathBox.Text)) return null;
        try
        {
            var marker = Path.Combine(Path.GetFullPath(InstallPathBox.Text.Trim()), InstallMarkerName);
            if (File.Exists(marker))
            {
                using var document = JsonDocument.Parse(File.ReadAllText(marker));
                if (document.RootElement.TryGetProperty("version", out var version)) return version.GetString();
            }
            var installDirectory = Path.GetFullPath(InstallPathBox.Text.Trim());
            return IsManagedInstall(installDirectory) ? ReadMarkerVersion(installDirectory) : null;
        }
        catch { return null; }
    }

    private async Task StartOnlineInstallAsync()
    {
        if (VersionSelector.SelectedItem is not OrbitRelease release) return;
        UpdateReviewSummary();
        _completedAction = ReviewAction.Text;
        _completedVersion = release.Tag;
        _progressTick = 0;
        BackButton.IsEnabled = false;
        CloseButton.IsEnabled = false;
        ProgressGlow.Width = 16;
        ProgressPercent.Text = "0%";
        ProgressCaption.Text = "Checking the release and installation folder…";
        ProgressDetail.Text = $"Preparing Orbit Chat {release.Tag} · {GitHubReleaseCatalog.FormatSize(release.Size)}.";
        UpdateProgressSteps();
        ShowStep(4);
        try
        {
            await InstallReleaseAsync(release);
            _installedAppPath = Path.Combine(Path.GetFullPath(InstallPathBox.Text.Trim()), AppExecutableName);
            _progressTick = 7;
            ProgressCaption.Text = "Installation complete.";
            ProgressDetail.Text = "Orbit Chat is installed. Your app data and settings were kept.";
            ProgressPercent.Text = "100%";
            UpdateProgressSteps();
            CompleteAction.Text = $"{_completedAction} complete";
            CompleteVersion.Text = $"Orbit Chat {_completedVersion} · installed successfully";
            ShowStep(5);
        }
        catch (Exception ex)
        {
            BackButton.IsEnabled = true;
            CloseButton.IsEnabled = true;
            ShowStep(3);
            System.Windows.MessageBox.Show(this, $"Orbit Chat could not be installed.\n\n{ex.Message}",
                "Online installation failed", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ExitButton_Click(object sender, RoutedEventArgs e) => Close();

    private void OpenAndExitButton_Click(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_installedAppPath) || !File.Exists(_installedAppPath))
        {
            System.Windows.MessageBox.Show(this, "Orbit Chat could not be found in the installed folder.",
                "Orbit Chat", MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }

        try
        {
            using var launchedProcess = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(_installedAppPath)
            {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(_installedAppPath)!,
            });
            if (launchedProcess is null) throw new InvalidOperationException("Windows did not start Orbit Chat.");
            Close();
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show(this, $"Orbit Chat could not be opened.\n\n{ex.Message}",
                "Orbit Chat", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task InstallReleaseAsync(OrbitRelease release)
    {
        if (string.IsNullOrWhiteSpace(InstallPathBox.Text))
            throw new InvalidOperationException("Choose an installation folder.");
        var target = Path.GetFullPath(InstallPathBox.Text.Trim()).TrimEnd(Path.DirectorySeparatorChar);
        var root = Path.GetPathRoot(target)?.TrimEnd(Path.DirectorySeparatorChar);
        if (target.Length > 220 || target.Length < 5 || string.Equals(target, root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Choose a valid installation folder that is not a drive root.");
        if (target.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Orbit Chat cannot be installed inside the temporary folder.");
        if (Directory.Exists(target) && Directory.EnumerateFileSystemEntries(target).Any() && !IsManagedInstall(target))
            throw new InvalidOperationException($"The selected folder contains files that are not a recognized Orbit Chat installation:\n{target}\n\nChoose an empty folder, or select the existing Orbit Chat install folder to update it.");
        var replacingInstall = IsManagedInstall(target);
        var previousVersion = replacingInstall ? ReadMarkerVersion(target) : null;
        var replacingLegacyRegistration = replacingInstall && IsLegacyRegisteredInstall(target);
        if (replacingInstall && IsAppRunning(target))
            throw new InvalidOperationException("Close Orbit Chat before updating it, then try again.");

        var runningInstaller = Environment.ProcessPath
            ?? throw new InvalidOperationException("The installer executable path could not be determined.");
        var downloadPath = Path.Combine(Path.GetTempPath(), $"OrbitChat-{Guid.NewGuid():N}.zip");
        var stage = target + ".installing-" + Guid.NewGuid().ToString("N");
        var backup = target + ".previous-" + Guid.NewGuid().ToString("N");
        var oldMoved = false;
        var newMoved = false;
        try
        {
            _progressTick = 1;
            UpdateProgressSteps();
            ProgressCaption.Text = "Downloading Orbit Chat…";
            ProgressDetail.Text = "Connecting securely to GitHub Releases.";
            var progress = new Progress<DownloadProgress>(value =>
            {
                if (value.IsVerifying)
                {
                    _progressTick = 2;
                    ProgressCaption.Text = "Verifying the downloaded ZIP…";
                    ProgressPercent.Text = "43%";
                    ProgressGlow.Width = 172;
                    ProgressDetail.Text = string.IsNullOrWhiteSpace(release.Sha256)
                        ? "Checking the advertised download size; GitHub did not provide a SHA-256 digest."
                        : "Checking the downloaded file against GitHub’s SHA-256 digest.";
                    UpdateProgressSteps();
                    return;
                }
                var fraction = value.TotalBytes is > 0 ? Math.Clamp(value.ReceivedBytes / (double)value.TotalBytes.Value, 0, 1) : 0;
                var percent = value.TotalBytes is > 0 ? (int)(fraction * 38) + 5 : 5;
                ProgressPercent.Text = value.TotalBytes is > 0 ? $"{percent}%" : "Downloading…";
                ProgressGlow.Width = Math.Max(16, 400 * percent / 100d);
                ProgressDetail.Text = value.TotalBytes is > 0
                    ? $"Downloaded {GitHubReleaseCatalog.FormatSize(value.ReceivedBytes)} of {GitHubReleaseCatalog.FormatSize(value.TotalBytes.Value)}."
                    : $"Downloaded {GitHubReleaseCatalog.FormatSize(value.ReceivedBytes)}.";
            });
            await GitHubReleaseCatalog.DownloadAsync(release, downloadPath, progress);

            Directory.CreateDirectory(stage);
            _progressTick = 3;
            ProgressCaption.Text = "Extracting the verified app files…";
            ProgressDetail.Text = "Safely extracting the release into a staging folder.";
            ProgressPercent.Text = "45%";
            ProgressGlow.Width = 180;
            UpdateProgressSteps();
            var extractionProgress = new Progress<ArchiveExtractionProgress>(value =>
            {
                var fraction = value.TotalBytes > 0 ? Math.Clamp(value.ExtractedBytes / (double)value.TotalBytes, 0, 1) : 1;
                var percent = 45 + (int)(fraction * 37);
                ProgressPercent.Text = $"{percent}%";
                ProgressGlow.Width = Math.Max(16, 400 * percent / 100d);
                ProgressDetail.Text = $"Extracted {GitHubReleaseCatalog.FormatSize(value.ExtractedBytes)} of {GitHubReleaseCatalog.FormatSize(value.TotalBytes)} · {value.CompletedEntries} of {value.TotalEntries} files.";
            });
            await ExtractReleaseArchiveAsync(downloadPath, stage, extractionProgress);

            _progressTick = 4;
            ProgressCaption.Text = "Validating the extracted app…";
            ProgressDetail.Text = "Confirming the executable and application archive are present.";
            ProgressPercent.Text = "84%";
            ProgressGlow.Width = 336;
            UpdateProgressSteps();
            var appExe = Path.Combine(stage, AppExecutableName);
            if (!File.Exists(appExe) || !File.Exists(Path.Combine(stage, "resources", "app.asar")))
                throw new InvalidDataException("The ZIP does not contain a valid Orbit Chat portable app.");

            ProgressCaption.Text = "Preparing uninstall support…";
            ProgressDetail.Text = "Copying the signed-off setup helper into the staged app.";
            ProgressPercent.Text = "85%";
            ProgressGlow.Width = 340;
            await Task.Run(() => File.Copy(runningInstaller, Path.Combine(stage, UninstallerName), overwrite: false));
            var marker = new
            {
                id = InstallMarkerId,
                product = "Orbit Chat",
                version = release.Tag,
                installDirectory = target,
                installedAt = DateTimeOffset.UtcNow,
            };
            await File.WriteAllTextAsync(Path.Combine(stage, InstallMarkerName), JsonSerializer.Serialize(marker));

            ProgressCaption.Text = "Replacing the installed app files…";
            ProgressDetail.Text = "The staged app is verified; your account data remains untouched.";
            _progressTick = 5;
            UpdateProgressSteps();
            ProgressPercent.Text = "87%";
            ProgressGlow.Width = 348;

            if (Directory.Exists(target))
            {
                Directory.Move(target, backup);
                oldMoved = true;
            }
            Directory.Move(stage, target);
            newMoved = true;
            ProgressCaption.Text = "Replacing the app and creating shortcuts…";
            ProgressDetail.Text = "Updating the app files, Desktop, Start menu, and Installed apps entry.";
            ProgressPercent.Text = "91%";
            ProgressGlow.Width = 364;
            CreateShortcuts(Path.Combine(target, AppExecutableName), release.Tag);
            RegisterUninstallEntry(target, release.Tag);

            _progressTick = 6;
            ProgressCaption.Text = "Cleaning up previous files…";
            ProgressDetail.Text = "Removing files from the previous app version.";
            ProgressPercent.Text = "Cleaning…";
            ProgressGlow.Width = 376;
            UpdateProgressSteps();
            if (oldMoved && Directory.Exists(backup))
                await Task.Run(() => Directory.Delete(backup, recursive: true));
            ProgressPercent.Text = "99%";
            ProgressGlow.Width = 396;
            if (replacingLegacyRegistration)
            {
                try
                {
                    Registry.CurrentUser.DeleteSubKeyTree(
                        @"Software\Microsoft\Windows\CurrentVersion\Uninstall\OrbitChat.OfflineInstaller",
                        throwOnMissingSubKey: false);
                }
                catch { /* The new registration is already committed; a stale legacy entry is harmless. */ }
            }
            _progressTick = 7;
            ProgressPercent.Text = "100%";
            ProgressGlow.Width = 400;
            UpdateProgressSteps();
        }
        catch
        {
            if (newMoved && Directory.Exists(target))
            {
                try { RemoveShortcuts(); } catch { }
                try { await Task.Run(() => Directory.Delete(target, recursive: true)); } catch { }
            }
            if (oldMoved && Directory.Exists(backup) && !Directory.Exists(target))
            {
                Directory.Move(backup, target);
                try
                {
                    if (previousVersion is not null)
                    {
                        CreateShortcuts(Path.Combine(target, AppExecutableName), previousVersion);
                        RegisterUninstallEntry(target, previousVersion);
                    }
                }
                catch { }
            }
            else if (!oldMoved)
            {
                Registry.CurrentUser.DeleteSubKeyTree($@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{UninstallKeyName}", throwOnMissingSubKey: false);
            }
            if (Directory.Exists(stage)) await Task.Run(() => Directory.Delete(stage, recursive: true));
            throw;
        }
        finally
        {
            try { File.Delete(downloadPath); } catch { }
        }
    }

    private async Task ExtractReleaseArchiveAsync(string archivePath, string destination, IProgress<ArchiveExtractionProgress> progress)
    {
        await Task.Run(async () =>
        {
            using var archive = ZipFile.OpenRead(archivePath);
            if (archive.Entries.Count is < 10 or > 10_000)
                throw new InvalidDataException("The selected ZIP has an unexpected number of files.");
            var totalBytes = archive.Entries.Sum(entry => entry.Length);
            if (totalBytes > MaximumExpandedArchiveBytes)
                throw new InvalidDataException("The expanded app exceeds the installer's size limit.");
            long extractedBytes = 0;
            long lastReportedBytes = 0;
            var buffer = new byte[131072];
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

                var outputPath = Path.GetFullPath(Path.Combine(destination, relative.Replace('/', Path.DirectorySeparatorChar)));
                if (!outputPath.StartsWith(destination + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    throw new SecurityException("A release ZIP entry would write outside the install folder.");
                if (relative.EndsWith('/')) Directory.CreateDirectory(outputPath);
                else
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
                    await using var input = entry.Open();
                    await using var output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                        buffer.Length, FileOptions.Asynchronous | FileOptions.SequentialScan);
                    int read;
                    while ((read = await input.ReadAsync(buffer.AsMemory())) > 0)
                    {
                        await output.WriteAsync(buffer.AsMemory(0, read));
                        extractedBytes = checked(extractedBytes + read);
                        if (extractedBytes - lastReportedBytes >= 8L * 1024 * 1024)
                        {
                            progress.Report(new ArchiveExtractionProgress(extractedBytes, totalBytes, index, archive.Entries.Count));
                            lastReportedBytes = extractedBytes;
                        }
                    }
                    await output.FlushAsync();
                }
                progress.Report(new ArchiveExtractionProgress(extractedBytes, totalBytes, index + 1, archive.Entries.Count));
            }
        });
    }

    private static bool IsManagedInstall(string directory)
    {
        try
        {
            var markerPath = Path.Combine(directory, InstallMarkerName);
            if (File.Exists(markerPath))
            {
                using var marker = JsonDocument.Parse(File.ReadAllText(markerPath));
                return marker.RootElement.TryGetProperty("id", out var id) && id.GetString() == InstallMarkerId &&
                    marker.RootElement.TryGetProperty("product", out var product) && product.GetString() == "Orbit Chat" &&
                    File.Exists(Path.Combine(directory, AppExecutableName)) && File.Exists(Path.Combine(directory, UninstallerName));
            }
        }
        catch { return false; }

        // Accept the former custom-installer registration and extracted portable folders,
        // identified by the Electron executable's product metadata plus its app archive.
        return IsLegacyRegisteredInstall(directory) || IsPortableOrbitChatDirectory(directory);
    }

    private static bool IsLegacyRegisteredInstall(string directory)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Uninstall\OrbitChat.OfflineInstaller", writable: false);
            return key?.GetValue("DisplayName") as string == "Orbit Chat"
                && string.Equals(key.GetValue("InstallLocation") as string, directory, StringComparison.OrdinalIgnoreCase)
                && File.Exists(Path.Combine(directory, AppExecutableName))
                && File.Exists(Path.Combine(directory, "resources", "app.asar"));
        }
        catch { return false; }
    }

    private static bool IsPortableOrbitChatDirectory(string directory)
    {
        try
        {
            var appExecutable = Path.Combine(directory, AppExecutableName);
            return File.Exists(appExecutable)
                && File.Exists(Path.Combine(directory, "resources", "app.asar"))
                && string.Equals(System.Diagnostics.FileVersionInfo.GetVersionInfo(appExecutable).ProductName,
                    "Orbit Chat", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static string? ReadMarkerVersion(string directory)
    {
        try
        {
            var markerPath = Path.Combine(directory, InstallMarkerName);
            if (File.Exists(markerPath))
            {
                using var marker = JsonDocument.Parse(File.ReadAllText(markerPath));
                return marker.RootElement.GetProperty("version").GetString();
            }
            using var legacyKey = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Uninstall\OrbitChat.OfflineInstaller", writable: false);
            var registeredVersion = legacyKey?.GetValue("DisplayVersion") as string;
            if (!string.IsNullOrWhiteSpace(registeredVersion)) return registeredVersion;
            return System.Diagnostics.FileVersionInfo.GetVersionInfo(Path.Combine(directory, AppExecutableName)).ProductVersion;
        }
        catch { return null; }
    }

    private static bool IsAppRunning(string installDirectory)
    {
        foreach (var process in System.Diagnostics.Process.GetProcessesByName(Path.GetFileNameWithoutExtension(AppExecutableName)))
        {
            using (process)
            {
                try
                {
                    if (string.Equals(Path.GetFullPath(process.MainModule?.FileName ?? string.Empty),
                        Path.Combine(installDirectory, AppExecutableName), StringComparison.OrdinalIgnoreCase)) return true;
                }
                catch { return true; }
            }
        }
        return false;
    }

    private static void RegisterUninstallEntry(string target, string version)
    {
        var executablePath = Path.Combine(target, AppExecutableName);
        var uninstallerPath = Path.Combine(target, UninstallerName);
        var command = $"\"{uninstallerPath}\" --uninstall --product-name \"Orbit Chat\" " +
            $"--install-directory \"{target}\" --install-folder \"{InstallMarkerId}\" " +
            $"--app-executable \"{AppExecutableName}\" --registry-key \"{UninstallKeyName}\" " +
            $"--start-menu-folder \"Orbit Chat\" --shortcut-name \"Orbit Chat.lnk\" --version \"{version}\"";
        using var key = Registry.CurrentUser.CreateSubKey($@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{UninstallKeyName}", writable: true)
            ?? throw new InvalidOperationException("Could not register Orbit Chat in Windows Installed apps.");
        key.SetValue("DisplayName", "Orbit Chat", RegistryValueKind.String);
        key.SetValue("DisplayVersion", version, RegistryValueKind.String);
        key.SetValue("Publisher", "Orbit Chat", RegistryValueKind.String);
        key.SetValue("InstallLocation", target, RegistryValueKind.String);
        key.SetValue("DisplayIcon", $"\"{executablePath}\",0", RegistryValueKind.String);
        key.SetValue("UninstallString", command, RegistryValueKind.String);
        key.SetValue("QuietUninstallString", command, RegistryValueKind.String);
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd", System.Globalization.CultureInfo.InvariantCulture), RegistryValueKind.String);
    }

    private static void CreateShortcuts(string executablePath, string version)
    {
        if (!File.Exists(executablePath)) throw new FileNotFoundException("The installed app executable is missing.", executablePath);
        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Orbit Chat");
        Directory.CreateDirectory(startMenu);
        CreateShortcut(Path.Combine(desktop, "Orbit Chat.lnk"), executablePath, version);
        CreateShortcut(Path.Combine(startMenu, "Orbit Chat.lnk"), executablePath, version);
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string version)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell", throwOnError: true)!;
        dynamic shell = Activator.CreateInstance(shellType)!;
        try
        {
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            try
            {
                shortcut.TargetPath = targetPath;
                shortcut.WorkingDirectory = Path.GetDirectoryName(targetPath);
                shortcut.Description = $"Orbit Chat {version}";
                shortcut.IconLocation = targetPath + ",0";
                shortcut.Save();
            }
            finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut); }
        }
        finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
    }

    private static void RemoveShortcuts()
    {
        File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Orbit Chat.lnk"));
        var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Orbit Chat");
        File.Delete(Path.Combine(startMenu, "Orbit Chat.lnk"));
        if (Directory.Exists(startMenu) && !Directory.EnumerateFileSystemEntries(startMenu).Any()) Directory.Delete(startMenu);
    }

    private void UpdateProgressSteps()
    {
        var rows = new[] { ProgressLineOne, ProgressLineTwo, ProgressLineThree, ProgressLineFour, ProgressLineFive, ProgressLineSix, ProgressLineSeven };
        var captions = new[]
        {
            "Check release and installation folder", "Download portable app", "Verify file size and SHA-256",
            "Extract and validate app files", "Validate app files and prepare install", "Replace app files and register app",
            "Clean up temporary files",
        };
        for (var index = 0; index < rows.Length; index++)
        {
            var completed = index < _progressTick;
            var active = index == _progressTick && _progressTick < rows.Length;
            rows[index].Text = $"{(completed ? "✓" : active ? "◌" : "○")}   {captions[index]}";
            rows[index].Foreground = completed ? new SolidColorBrush(MediaColor.FromRgb(126, 213, 166))
                : active ? new SolidColorBrush(MediaColor.FromRgb(209, 201, 242))
                : new SolidColorBrush(MediaColor.FromRgb(119, 114, 130));
        }
    }
}
