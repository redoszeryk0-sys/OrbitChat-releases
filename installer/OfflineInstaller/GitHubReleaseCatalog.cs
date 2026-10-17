using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OrbitChat.SetupPreview;

public sealed record OrbitRelease(string Tag, string Label, string Subtitle, string DownloadUrl, long Size, string? Sha256, bool IsNewest)
{
    public override string ToString() => Label;
}

public readonly record struct DownloadProgress(long ReceivedBytes, long? TotalBytes);

public static partial class GitHubReleaseCatalog
{
    private const string Repository = "redoszeryk0-sys/OrbitChat-releases";
    private const long MaximumDownloadBytes = 2L * 1024 * 1024 * 1024;
    private static readonly HttpClient Client = CreateClient();

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("OrbitChat-OnlineInstaller/1.0");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        client.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
        return client;
    }

    public static async Task<IReadOnlyList<OrbitRelease>> LoadAsync(CancellationToken cancellationToken = default)
    {
        var releases = new List<(OrbitRelease Release, SemanticVersion Version)>();
        for (var page = 1; page <= 5; page++)
        {
            var url = $"https://api.github.com/repos/{Repository}/releases?per_page=100&page={page}";
            using var response = await Client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (response.StatusCode == System.Net.HttpStatusCode.Forbidden && response.Headers.Contains("X-RateLimit-Remaining"))
                throw new InvalidOperationException("GitHub has temporarily limited release lookups. Please wait a minute and try again.");
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            var pageCount = 0;
            foreach (var item in document.RootElement.EnumerateArray())
            {
                pageCount++;
                if (item.TryGetProperty("draft", out var draft) && draft.GetBoolean()) continue;
                if (!item.TryGetProperty("tag_name", out var tagElement)) continue;
                var tag = tagElement.GetString()?.Trim();
                if (string.IsNullOrEmpty(tag) || !SemanticVersion.TryParse(tag, out var version)) continue;
                if (!item.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array) continue;

                var expectedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                {
                    $"Orbit-Chat-{tag}-win-x64.zip",
                    $"Orbit-Chat-{version.CoreVersion}-win-x64.zip",
                };
                var asset = assets.EnumerateArray().FirstOrDefault(candidate =>
                    candidate.TryGetProperty("name", out var name) &&
                    expectedNames.Contains(name.GetString() ?? string.Empty) &&
                    candidate.TryGetProperty("browser_download_url", out var download) &&
                    IsAllowedDownloadUrl(download.GetString()));
                if (asset.ValueKind == JsonValueKind.Undefined) continue;

                var nameValue = asset.GetProperty("name").GetString()!;
                var downloadUrl = asset.GetProperty("browser_download_url").GetString()!;
                var size = asset.TryGetProperty("size", out var sizeElement) ? sizeElement.GetInt64() : 0;
                var digest = asset.TryGetProperty("digest", out var digestElement) ? digestElement.GetString() : null;
                var sha256 = digest?.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) == true ? digest[7..] : null;
                var label = $"{tag} · {nameValue}";
                var subtitle = item.TryGetProperty("prerelease", out var prerelease) && prerelease.GetBoolean()
                    ? "Pre-release · GitHub release"
                    : "Stable release · GitHub release";
                releases.Add((new OrbitRelease(tag, label, subtitle, downloadUrl, size, sha256, false), version));
            }

            if (pageCount < 100) break;
        }

        if (releases.Count == 0)
            throw new InvalidOperationException("No compatible Orbit Chat Windows ZIP releases were found. Releases must include Orbit-Chat-{tag}-win-x64.zip.");

        releases.Sort((left, right) => right.Version.CompareTo(left.Version));
        return releases.Select((item, index) => item.Release with
        {
            IsNewest = index == 0,
            Label = index == 0 ? $"{item.Release.Tag} · latest" : item.Release.Tag,
            Subtitle = $"{item.Release.Subtitle} · {FormatSize(item.Release.Size)}",
        }).ToArray();
    }

    public static async Task DownloadAsync(
        OrbitRelease release,
        string destination,
        IProgress<DownloadProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        if (!IsAllowedDownloadUrl(release.DownloadUrl))
            throw new InvalidOperationException("The GitHub release contains an unsupported download URL.");

        using var response = await Client.GetAsync(release.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var total = response.Content.Headers.ContentLength ?? (release.Size > 0 ? release.Size : null);
        if (total > MaximumDownloadBytes || (release.Size > MaximumDownloadBytes))
            throw new InvalidOperationException("The selected app archive is larger than the installer allows.");

        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using (var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None,
            131072, FileOptions.Asynchronous | FileOptions.SequentialScan))
        {
            var buffer = new byte[131072];
            long received = 0;
            int read;
            while ((read = await input.ReadAsync(buffer, cancellationToken)) != 0)
            {
                received += read;
                if (received > MaximumDownloadBytes)
                    throw new InvalidOperationException("The downloaded archive exceeded the installer size limit.");
                await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                progress?.Report(new DownloadProgress(received, total));
            }
            if (release.Size > 0 && received != release.Size)
                throw new InvalidDataException("The downloaded file size does not match the GitHub release metadata.");
        }

        if (!string.IsNullOrWhiteSpace(release.Sha256))
        {
            await using var file = File.OpenRead(destination);
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(file, cancellationToken));
            if (!StringComparer.OrdinalIgnoreCase.Equals(actual, release.Sha256))
                throw new InvalidDataException("The downloaded ZIP failed GitHub's SHA-256 integrity check.");
        }
    }

    public static string FormatSize(long bytes) => bytes <= 0 ? "Size unknown" : bytes >= 1024L * 1024 * 1024
        ? $"{bytes / (1024d * 1024 * 1024):0.#} GiB"
        : $"{bytes / (1024d * 1024):0} MiB";

    private static bool IsAllowedDownloadUrl(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
            (uri.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) ||
             uri.Host.Equals("release-assets.githubusercontent.com", StringComparison.OrdinalIgnoreCase));
    }

    private readonly record struct SemanticVersion(int Major, int Minor, int Patch, string? Prerelease) : IComparable<SemanticVersion>
    {
        public string CoreVersion => $"{Major}.{Minor}.{Patch}";

        public static bool TryParse(string tag, out SemanticVersion version)
        {
            version = default;
            var match = VersionRegex().Match(tag);
            if (!match.Success || !int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var major) ||
                !int.TryParse(match.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var minor) ||
                !int.TryParse(match.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var patch)) return false;
            version = new SemanticVersion(major, minor, patch, match.Groups[4].Success ? match.Groups[4].Value : null);
            return true;
        }

        public int CompareTo(SemanticVersion other)
        {
            var compare = Major.CompareTo(other.Major);
            if (compare != 0) return compare;
            compare = Minor.CompareTo(other.Minor);
            if (compare != 0) return compare;
            compare = Patch.CompareTo(other.Patch);
            if (compare != 0) return compare;
            if (Prerelease is null) return other.Prerelease is null ? 0 : 1;
            if (other.Prerelease is null) return -1;

            var left = Prerelease.Split('.');
            var right = other.Prerelease.Split('.');
            for (var index = 0; index < Math.Min(left.Length, right.Length); index++)
            {
                var leftNumeric = long.TryParse(left[index], NumberStyles.None, CultureInfo.InvariantCulture, out var leftNumber);
                var rightNumeric = long.TryParse(right[index], NumberStyles.None, CultureInfo.InvariantCulture, out var rightNumber);
                compare = leftNumeric && rightNumeric ? leftNumber.CompareTo(rightNumber)
                    : leftNumeric ? -1 : rightNumeric ? 1 : StringComparer.OrdinalIgnoreCase.Compare(left[index], right[index]);
                if (compare != 0) return compare;
            }
            return left.Length.CompareTo(right.Length);
        }
    }

    [GeneratedRegex("^v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionRegex();
}
