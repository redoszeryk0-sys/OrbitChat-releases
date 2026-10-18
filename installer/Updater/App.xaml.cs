using System;
using System.IO;
using System.Windows;

namespace OrbitChat.Updater;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // A legacy app launcher may start the updater with the install folder as its working directory.
        // Switch away before the updater tries to rename that folder on Windows.
        Environment.CurrentDirectory = Path.GetTempPath();
        base.OnStartup(e);
    }
}
