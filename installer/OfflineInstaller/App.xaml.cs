using System.Diagnostics;
using System.IO;
using System.Windows;

namespace OrbitChat.SetupPreview;

public partial class App : System.Windows.Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        try
        {
            Window window;
            if (UninstallOptions.TryParse(e.Args, out var options))
            {
                if (!e.Args.Contains("--temporary-run", StringComparer.OrdinalIgnoreCase))
                {
                    RelaunchUninstallerFromTemporaryFolder(e.Args);
                    Shutdown();
                    return;
                }

                window = new UninstallWindow(options!);
            }
            else
            {
                window = new MainWindow();
            }

            MainWindow = window;
            window.Show();
        }
        catch (Exception ex)
        {
            System.Windows.MessageBox.Show($"The setup command could not be opened.\n\n{ex.Message}",
                "Orbit Chat Setup", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
        }
    }

    private static void RelaunchUninstallerFromTemporaryFolder(string[] args)
    {
        var executablePath = Environment.ProcessPath
            ?? throw new InvalidOperationException("The uninstaller executable path could not be determined.");
        var temporaryExecutable = Path.Combine(Path.GetTempPath(), $"OrbitChat-Uninstaller-{Guid.NewGuid():N}.exe");
        File.Copy(executablePath, temporaryExecutable);

        var startInfo = new ProcessStartInfo(temporaryExecutable)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetTempPath(),
        };
        foreach (var argument in args)
            startInfo.ArgumentList.Add(argument);
        startInfo.ArgumentList.Add("--temporary-run");
        _ = Process.Start(startInfo) ?? throw new InvalidOperationException("The uninstaller window could not be started.");
    }
}
