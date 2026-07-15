using System.Diagnostics;
using System.Security.Cryptography;

namespace Dokladovka.Agent;

public sealed class AutoUpdater(BackendClient backend, AgentSettings settings, IAgentLog log)
{
    public async Task CheckAsync(CancellationToken cancellationToken)
    {
        AgentRelease release;
        try
        {
            release = await backend.GetLatestReleaseAsync(cancellationToken);
        }
        catch (BackendApiException error) when ((int)error.StatusCode == 404)
        {
            return;
        }
        if (!IsNewer(release.Version, AgentVersion.Current)) return;
        if (!Uri.TryCreate(release.DownloadUrl, UriKind.Absolute, out var url) || url.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("Aktualizácia agenta nemá HTTPS URL.");

        Directory.CreateDirectory(AgentPaths.Updates);
        var target = Path.Combine(AgentPaths.Updates, $"Dokladovka-Agent-{SafeVersion(release.Version)}.exe");
        var temporary = target + ".download";
        using (var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) })
        using (var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken))
        {
            response.EnsureSuccessStatusCode();
            await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
            await using var output = File.Create(temporary);
            await input.CopyToAsync(output, cancellationToken);
        }
        await using var downloaded = File.OpenRead(temporary);
        var actual = Convert.ToHexString(await SHA256.HashDataAsync(downloaded, cancellationToken)).ToLowerInvariant();
        if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(actual), Convert.FromHexString(release.Sha256)))
        {
            File.Delete(temporary);
            throw new InvalidOperationException("SHA-256 aktualizácie nesúhlasí s release manifestom.");
        }
        File.Move(temporary, target, true);

        if (string.IsNullOrWhiteSpace(settings.AllowedPublisherThumbprint))
        {
            log.Info("update_staged", new { release.Version, reason = "publisher_thumbprint_not_configured" });
            return;
        }
        if (!await HasValidSignatureAsync(target, settings.AllowedPublisherThumbprint, cancellationToken))
            throw new InvalidOperationException("Digitálny podpis aktualizácie nie je platný alebo vydavateľ nesúhlasí.");

        var installer = new ProcessStartInfo(target) { UseShellExecute = false, CreateNoWindow = true };
        installer.ArgumentList.Add("/VERYSILENT");
        installer.ArgumentList.Add("/SUPPRESSMSGBOXES");
        installer.ArgumentList.Add("/NORESTART");
        installer.ArgumentList.Add("/CLOSEAPPLICATIONS");
        Process.Start(installer);
        log.Info("update_started", new { release.Version });
    }

    private static bool IsNewer(string candidate, string current) =>
        Version.TryParse(candidate.Split('-', 2)[0], out var candidateVersion)
        && Version.TryParse(current.Split('-', 2)[0], out var currentVersion)
        && candidateVersion > currentVersion;

    private static string SafeVersion(string value) => string.Concat(value.Where(character => char.IsLetterOrDigit(character) || character is '.' or '-' or '_'));

    private static async Task<bool> HasValidSignatureAsync(string path, string expectedThumbprint, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-Command");
        start.ArgumentList.Add("$s=Get-AuthenticodeSignature -LiteralPath $args[0]; Write-Output ($s.Status.ToString()+'|'+$s.SignerCertificate.Thumbprint)");
        start.ArgumentList.Add(path);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Kontrolu digitálneho podpisu nebolo možné spustiť.");
        var result = (await process.StandardOutput.ReadToEndAsync(cancellationToken)).Trim();
        await process.WaitForExitAsync(cancellationToken);
        var expected = expectedThumbprint.Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
        return process.ExitCode == 0 && result.Equals($"Valid|{expected}", StringComparison.OrdinalIgnoreCase);
    }
}
