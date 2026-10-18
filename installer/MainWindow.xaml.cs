using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using MediaBrushes = System.Windows.Media.Brushes;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using Forms = System.Windows.Forms;
using MediaColor = System.Windows.Media.Color;

namespace OrbitChat.SetupPreview;

public partial class MainWindow : Window
{
    private static readonly PreviewVersion[] PreviewVersions =
    [
        new("1.2.0", "1.2.0", "Latest stable release · preview sample", true),
        new("1.1.0", "1.1.0", "Previous stable release · preview sample"),
        new("1.0.5", "1.0.5", "Archived release · preview sample"),
    ];

    private static readonly string[] ProgressStatuses =
    [
        "Preparing the simulated installation…",
        "Extracting OrbitChat files…",
        "Creating shortcuts…",
        "Finishing setup…",
        "Preview complete.",
    ];

    private static readonly string[] ProgressDetails =
    [
        "Preparing the preview",
        "Extracting application files (simulated)",
        "Creating shortcuts (simulated)",
        "Finishing up (simulated)",
        "All steps shown here were simulated",
    ];

    private readonly DispatcherTimer _progressTimer = new() { Interval = TimeSpan.FromMilliseconds(760) };
    private bool _isInitializing = true;
    private int _step;
    private int _progressTick;
    private string _completedAction = "Install";
    private string _completedVersion = "1.2.0";

    private readonly record struct PreviewVersion(string Label, string? Value, string Subtitle, bool IsNewest = false)
    {
        public override string ToString() => Label;
    }

    public MainWindow()
    {
        InitializeComponent();

        InstallPathBox.Text = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs",
            "Orbit Chat");

        var installChoices = new ObservableCollection<PreviewVersion>(PreviewVersions);
        VersionSelector.ItemsSource = installChoices;
        VersionSelector.SelectedIndex = 0;

        _isInitializing = false;
        _progressTimer.Tick += ProgressTimer_Tick;

        UpdateActionPreview();
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
            InstallPathBox.Text = dialog.SelectedPath;
    }

    private void VersionSelector_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_isInitializing)
            return;

        UpdateActionPreview();
        UpdateReviewSummary();
    }

    private void NoticeAcknowledgement_Changed(object sender, RoutedEventArgs e)
    {
        if (!_isInitializing)
            UpdateNavigation();
    }

    private void BackButton_Click(object sender, RoutedEventArgs e)
    {
        if (_step == 0 || _step >= 4)
            return;

        ShowStep(_step - 1);
    }

    private void NextButton_Click(object sender, RoutedEventArgs e)
    {
        switch (_step)
        {
            case 0:
                ShowStep(1);
                break;
            case 1 when NoticeAcknowledgement.IsChecked == true:
                ShowStep(2);
                break;
            case 2:
                UpdateReviewSummary();
                ShowStep(3);
                break;
            case 3:
                StartSimulatedInstall();
                break;
            case 5:
                Close();
                break;
        }
    }

    private void ShowStep(int nextStep)
    {
        if (nextStep < 0 || nextStep > 5 || nextStep == _step)
            return;

        var previousStep = _step;
        _step = nextStep;

        foreach (var page in StepPages())
            page.Visibility = Visibility.Collapsed;

        StepPages()[_step].Visibility = Visibility.Visible;
        StepPanel.Opacity = 0;
        StepSlide.X = nextStep >= previousStep ? 28 : -28;
        UpdateStepTracker();
        UpdateNavigation();

        if (SystemParameters.ClientAreaAnimation)
        {
            var storyboard = (Storyboard)FindResource(nextStep >= previousStep ? "SlideForward" : "SlideBackward");
            storyboard.Begin(this, true);
        }
        else
        {
            StepPanel.Opacity = 1;
            StepSlide.X = 0;
        }

        if (_step == 5)
            _progressTimer.Stop();
    }

    private StackPanel[] StepPages() =>
    [WelcomeStep, NoticeStep, OptionsStep, ReviewStep, ProgressStep, CompleteStep];

    private void UpdateNavigation()
    {
        BackButton.Visibility = _step is 0 or 4 or 5 ? Visibility.Hidden : Visibility.Visible;
        NextButton.IsEnabled = _step != 1 || NoticeAcknowledgement.IsChecked == true;

        NextButton.Content = _step switch
        {
            3 => "Start preview  →",
            4 => "Previewing…",
            5 => "Close preview",
            _ => "Next  →",
        };

        NextButton.IsEnabled &= _step != 4;
    }

    private void UpdateStepTracker()
    {
        StepTracker.Children.Clear();
        var stepLabels = new[] { StepLabel0, StepLabel1, StepLabel2, StepLabel3, StepLabel4, StepLabel5 };

        for (var index = 0; index < 6; index++)
        {
            var completed = index < _step;
            var current = index == _step;
            stepLabels[index].Foreground = current
                ? new SolidColorBrush(MediaColor.FromRgb(209, 201, 242))
                : completed
                    ? new SolidColorBrush(MediaColor.FromRgb(144, 139, 157))
                    : new SolidColorBrush(MediaColor.FromRgb(119, 114, 130));
            stepLabels[index].FontWeight = current ? FontWeights.SemiBold : FontWeights.Normal;
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
        var selected = (VersionSelector.SelectedItem as PreviewVersion?)?.Value;
        var installed = DetectInstalledVersion();

        var (heading, description, indicator) = DescribeAction(selected, installed);
        ActionHeading.Text = heading;
        ActionDescription.Text = description;
        ActionIndicator.Background = new SolidColorBrush(indicator);
    }

    private void UpdateReviewSummary()
    {
        var selected = (VersionSelector.SelectedItem as PreviewVersion?)?.Value;
        var installed = DetectInstalledVersion();
        var (heading, _, _) = DescribeAction(selected, installed);

        ReviewAction.Text = heading;
        ReviewVersion.Text = selected is null ? "No version selected" : $"Orbit Chat {selected}";
        ReviewPath.Text = InstallPathBox.Text;
    }

    private static string? DetectInstalledVersion()
    {
        // This isolated design preview intentionally simulates a clean machine.
        // A functioning Burn BA will read the installed bundle's registered version.
        return null;
    }

    private static (string Heading, string Description, MediaColor Color) DescribeAction(string? selected, string? installed)
    {
        if (selected is null)
            return ("Choose a version", "No preview version is selected.", MediaColor.FromRgb(237, 105, 116));

        if (installed is null)
            return ("Install", "No existing installation detected. The newest release is selected by default.", MediaColor.FromRgb(136, 123, 207));

        if (StringComparer.Ordinal.Equals(selected, installed))
            return ("Fix", $"Installed version {installed} matches the selected version.", MediaColor.FromRgb(81, 199, 139));

        if (System.Version.TryParse(selected, out var target) && System.Version.TryParse(installed, out var current))
        {
            return target > current
                ? ("Upgrade", $"Preview would move from {installed} to {selected}.", MediaColor.FromRgb(108, 168, 245))
                : ("Downgrade", $"Preview would move from {installed} back to {selected}.", MediaColor.FromRgb(229, 196, 142));
        }

        return ("Review version", "The preview cannot compare these sample version numbers.", MediaColor.FromRgb(136, 123, 207));
    }

    private void StartSimulatedInstall()
    {
        UpdateReviewSummary();
        _completedAction = ReviewAction.Text;
        _completedVersion = (VersionSelector.SelectedItem as PreviewVersion?)?.Value ?? "unknown";
        _progressTick = 0;

        ProgressGlow.Width = 16;
        ProgressPercent.Text = "8%";
        ProgressCaption.Text = ProgressStatuses[0];
        ProgressDetail.Text = ProgressDetails[0];
        UpdateProgressSteps();

        if (SystemParameters.ClientAreaAnimation)
        {
            var pulse = (Storyboard)FindResource("ProgressPulse");
            pulse.Begin(this, true);
        }

        ShowStep(4);
        _progressTimer.Start();
    }

    private void ProgressTimer_Tick(object? sender, EventArgs e)
    {
        _progressTick = Math.Min(_progressTick + 1, ProgressStatuses.Length - 1);
        ProgressCaption.Text = ProgressStatuses[_progressTick];
        ProgressDetail.Text = ProgressDetails[_progressTick];
        ProgressPercent.Text = $"{new[] { 8, 34, 59, 82, 100 }[_progressTick]}%";

        var progressTrack = ProgressGlow.Parent as FrameworkElement;
        if (progressTrack is not null)
            ProgressGlow.Width = Math.Max(16, progressTrack.ActualWidth * new[] { .08, .34, .59, .82, 1.0 }[_progressTick]);

        UpdateProgressSteps();

        if (_progressTick != ProgressStatuses.Length - 1)
            return;

        _progressTimer.Stop();
        if (SystemParameters.ClientAreaAnimation)
            ((Storyboard)FindResource("ProgressPulse")).Stop(this);

        CompleteAction.Text = $"{_completedAction} preview";
        CompleteVersion.Text = $"Orbit Chat {_completedVersion} · no files were changed";
        ShowStep(5);
    }

    private void UpdateProgressSteps()
    {
        var rows = new[] { ProgressLineOne, ProgressLineTwo, ProgressLineThree, ProgressLineFour };
        for (var index = 0; index < rows.Length; index++)
        {
            var completed = index < _progressTick;
            var active = index == _progressTick && _progressTick < rows.Length;
            rows[index].Text = $"{(completed ? "✓" : active ? "◌" : "○")}   {new[] { "Prepare installer", "Extract application files", "Create shortcuts", "Finish setup" }[index]}";
            rows[index].Foreground = completed
                ? new SolidColorBrush(MediaColor.FromRgb(126, 213, 166))
                : active ? new SolidColorBrush(MediaColor.FromRgb(209, 201, 242))
                : new SolidColorBrush(MediaColor.FromRgb(119, 114, 130));
        }
    }
}
