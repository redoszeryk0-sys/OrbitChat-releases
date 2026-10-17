namespace OrbitChat.SetupPreview;

public sealed record UninstallOptions(
    string ProductName,
    string InstallDirectory,
    string AllowedInstallFolder,
    string AppExecutableName,
    string RegistryKeyName,
    string StartMenuFolder,
    string ShortcutName,
    string Version)
{
    public static bool TryParse(string[] args, out UninstallOptions? options)
    {
        options = null;
        if (!args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase))
            return false;

        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index++)
        {
            if (StringComparer.OrdinalIgnoreCase.Equals(args[index], "--uninstall"))
                continue;
            if (StringComparer.OrdinalIgnoreCase.Equals(args[index], "--temporary-run"))
                continue;
            if (args[index].StartsWith("--", StringComparison.Ordinal))
            {
                if (index + 1 >= args.Length || args[index + 1].StartsWith("--", StringComparison.Ordinal))
                    throw new ArgumentException($"The uninstall command is missing a value for {args[index]}.");
                values[args[index]] = args[++index];
            }
        }

        string Required(string key) => values.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new ArgumentException($"The uninstall command is missing {key}.");

        options = new UninstallOptions(
            Required("--product-name"),
            Required("--install-directory"),
            Required("--install-folder"),
            Required("--app-executable"),
            Required("--registry-key"),
            Required("--start-menu-folder"),
            Required("--shortcut-name"),
            Required("--version"));
        return true;
    }
}
