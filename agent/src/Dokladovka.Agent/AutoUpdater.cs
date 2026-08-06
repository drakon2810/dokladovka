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
        if (!release.Available) return;
        // Self-signed vydanie je legitímne, kým firma nemá kúpený certifikát —
        // dovtedy sa agent preinštalovával ručne, hoci autoaktualizácia existuje.
        // Dôvera nestojí na Windows Trusted Root, ale na odtlačku vydavateľa
        // z nastavení agenta: ten sa porovnáva s manifestom AJ s podpisom súboru,
        // takže cudzí inštalátor neprejde ani s platným certifikátom.
        var selfSigned = string.Equals(release.SignatureTrust, "self-signed", StringComparison.OrdinalIgnoreCase);
        if ((!release.Signed && !selfSigned) || string.IsNullOrWhiteSpace(release.Version) || string.IsNullOrWhiteSpace(release.DownloadUrl)
            || string.IsNullOrWhiteSpace(release.Sha256) || string.IsNullOrWhiteSpace(release.PublisherThumbprint))
            throw new InvalidOperationException("Release manifest aktualizácie nie je úplný alebo podpísaný.");
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
        if (!System.Text.RegularExpressions.Regex.IsMatch(release.Sha256, "^[a-fA-F0-9]{64}$")
            || !CryptographicOperations.FixedTimeEquals(Convert.FromHexString(actual), Convert.FromHexString(release.Sha256)))
        {
            File.Delete(temporary);
            throw new InvalidOperationException("SHA-256 aktualizácie nesúhlasí s release manifestom.");
        }
        File.Move(temporary, target, true);
        if (release.FileSize is > 0 && new FileInfo(target).Length != release.FileSize.Value)
        {
            File.Delete(target);
            throw new InvalidOperationException("Veľkosť aktualizácie nesúhlasí s release manifestom.");
        }

        if (string.IsNullOrWhiteSpace(settings.AllowedPublisherThumbprint))
        {
            log.Info("update_staged", new { release.Version, reason = "publisher_thumbprint_not_configured" });
            return;
        }
        var expectedPublisher = settings.AllowedPublisherThumbprint.Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
        var manifestPublisher = release.PublisherThumbprint.Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
        if (!manifestPublisher.Equals(expectedPublisher, StringComparison.Ordinal))
            throw new InvalidOperationException("Vydavateľ release manifestu sa nezhoduje s povoleným certifikátom.");
        if (!await HasValidSignatureAsync(target, settings.AllowedPublisherThumbprint, selfSigned, cancellationToken))
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

    /// <summary>
    /// Podpis inštalátora musí patriť povolenému vydavateľovi. Pri self-signed
    /// certifikáte Windows hlási „UnknownError" (koreň nie je v Trusted Root),
    /// čo ešte neznamená cudzí súbor — rozhoduje odtlačok podpisovateľa.
    /// Nepodpísaný súbor neprejde nikdy: bez odtlačku sa niet s čím porovnať.
    /// </summary>
    private static async Task<bool> HasValidSignatureAsync(string path, string expectedThumbprint, bool allowSelfSigned, CancellationToken cancellationToken)
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
        if (process.ExitCode != 0) return false;
        if (result.Equals($"Valid|{expected}", StringComparison.OrdinalIgnoreCase)) return true;
        if (!allowSelfSigned) return false;
        // Formát je "Status|Thumbprint"; prázdny odtlačok = súbor nie je podpísaný.
        var parts = result.Split('|', 2);
        return parts.Length == 2
            && !string.Equals(parts[0], "NotSigned", StringComparison.OrdinalIgnoreCase)
            && parts[1].Trim().Equals(expected, StringComparison.OrdinalIgnoreCase);
    }
}
