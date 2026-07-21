using System.Diagnostics;
using System.Text;

namespace Dokladovka.Agent;

public interface IPohodaClient
{
    Task<MServerCompany> GetCompanyAsync(CancellationToken cancellationToken);
    Task<string> PostXmlAsync(string xml, string instanceId, bool checkDuplicity, CancellationToken cancellationToken);
}

public sealed class PohodaCliClient : IPohodaClient
{
    // ponytail: medziprocesový zámok cez súbor v %ProgramData% – POHODA CLI beh drží licenciu a zamyká databázu, takže
    // sa musia serializovať aj behy z inej inštancie (služba vs. configure/run-once). SemaphoreSlim by zamkol len tento proces.
    private static readonly TimeSpan RunTimeout = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan LockAcquireTimeout = TimeSpan.FromMinutes(15);

    private readonly MServerEndpointSettings _endpoint;
    private readonly MServerSecret _secret;
    private readonly IAgentLog _log;
    private readonly Func<ProcessStartInfo, CancellationToken, Task<int>> _runProcess;

    static PohodaCliClient() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

    public PohodaCliClient(MServerEndpointSettings endpoint, MServerSecret secret, IAgentLog log,
        Func<ProcessStartInfo, CancellationToken, Task<int>>? runProcess = null)
    {
        _endpoint = endpoint;
        _secret = secret;
        _log = log;
        _runProcess = runProcess ?? RunPohodaAsync;
    }

    public Task<MServerCompany> GetCompanyAsync(CancellationToken cancellationToken)
    {
        // ponytail: lacná kontrola dostupnosti – overí len existenciu pohoda.exe, nespúšťa POHODU (tá by inak držala licenciu
        // každý heartbeat cyklus). Nesprávne prihlásenie, zamknutú alebo neexistujúcu databázu odhalí až samotný export.
        if (!File.Exists(_endpoint.PohodaExePath))
            throw new FileNotFoundException($"pohoda.exe sa nenašla na ceste '{_endpoint.PohodaExePath}'. Skontrolujte konfiguráciu endpointu.");
        return Task.FromResult(new MServerCompany(_endpoint.CompanyIco, _endpoint.Database!, YearFromDatabase(_endpoint.Database!), string.Empty));
    }

    public async Task<string> PostXmlAsync(string xml, string instanceId, bool checkDuplicity, CancellationToken cancellationToken)
    {
        var encoding = Encoding.GetEncoding(1250);
        var workDirectory = Path.Combine(AgentPaths.Root, "xml");
        Directory.CreateDirectory(workDirectory);
        var id = Sanitize(instanceId);
        var inputPath = Path.Combine(workDirectory, $"{id}-in.xml");
        var responsePath = Path.Combine(workDirectory, $"{id}-out.xml");
        var iniPath = Path.Combine(workDirectory, $"{id}.ini");

        using var machineLock = await AcquireMachineLockAsync(cancellationToken);
        try
        {
            if (File.Exists(responsePath)) File.Delete(responsePath);
            File.WriteAllBytes(inputPath, encoding.GetBytes(xml));
            File.WriteAllText(iniPath, BuildIni(inputPath, responsePath, checkDuplicity), encoding);

            var start = new ProcessStartInfo(_endpoint.PohodaExePath!)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(_endpoint.PohodaExePath!) ?? string.Empty,
            };
            start.ArgumentList.Add("/XML");
            start.ArgumentList.Add(_secret.UserName);
            start.ArgumentList.Add(_secret.Password);
            start.ArgumentList.Add(iniPath);

            var stopwatch = Stopwatch.StartNew();
            var exitCode = await _runProcess(start, cancellationToken);
            _log.Info("pohoda_cli_finished", new { instanceId, exitCode, durationMs = stopwatch.ElapsedMilliseconds });

            if (!File.Exists(responsePath))
                throw new InvalidOperationException(
                    $"POHODA /XML skončila s kódom {exitCode} bez súboru odpovede. Skontrolujte prihlásenie, právo Dátová komunikácia, názov databázy a či nie je databáza zamknutá alebo obsadená licencia.");
            return ReadXmlFile(responsePath);
        }
        finally
        {
            // Aj úspešnú odpoveď mažeme až v finally – zlyhaný File.Delete nesmie zahodiť už načítaný import (a spôsobiť opakovanie).
            TryDelete(inputPath);
            TryDelete(iniPath);
            TryDelete(responsePath);
        }
    }

    // Medziprocesový zámok: FileShare.None handle vo fixnej ceste v %ProgramData% serializuje behy naprieč procesmi aj reláciami.
    // Uviaznutý držiteľ sa sám uvoľní po svojom RunTimeout; čakateľ preto stráži strop LockAcquireTimeout a inak odloží export.
    private static async Task<FileStream> AcquireMachineLockAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(AgentPaths.Root);
        var lockPath = Path.Combine(AgentPaths.Root, "pohoda-xml.lock");
        var deadline = DateTime.UtcNow + LockAcquireTimeout;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException)
            {
                if (DateTime.UtcNow >= deadline)
                    throw new InvalidOperationException("Iný POHODA /XML import beží príliš dlho; export sa odloží na ďalší cyklus.");
                await Task.Delay(TimeSpan.FromMilliseconds(500), cancellationToken);
            }
        }
    }

    public string BuildIni(string inputPath, string responsePath, bool checkDuplicity) =>
        $"[XML]\r\ninput_xml={inputPath}\r\nresponse_xml={responsePath}\r\ndatabase={_endpoint.Database}\r\ncheck_duplicity={(checkDuplicity ? 1 : 0)}\r\nformat_output=1\r\n";

    public static string YearFromDatabase(string database)
    {
        var name = Path.GetFileNameWithoutExtension(database.Trim());
        var separator = name.LastIndexOf('_');
        var tail = separator >= 0 ? name[(separator + 1)..] : name;
        return tail.Length == 4 && tail.All(char.IsAsciiDigit) ? tail : string.Empty;
    }

    private static async Task<int> RunPohodaAsync(ProcessStartInfo start, CancellationToken cancellationToken)
    {
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Nepodarilo sa spustiť pohoda.exe.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(RunTimeout);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* proces mohol medzitým skončiť */ }
            // Kill len požiada o ukončenie; počkáme, kým proces reálne skončí a uvoľní licenciu/zámok databázy, než pustíme ďalší beh.
            try { using var grace = new CancellationTokenSource(TimeSpan.FromSeconds(30)); await process.WaitForExitAsync(grace.Token); } catch { /* grace uplynula */ }
            if (cancellationToken.IsCancellationRequested) throw;
            throw new InvalidOperationException($"POHODA /XML neskončila do {RunTimeout.TotalMinutes} minút a bola ukončená. Skontrolujte, či POHODA nečaká na dialóg (aktualizácia, údržba databázy).");
        }
        return process.ExitCode;
    }

    private static string ReadXmlFile(string path)
    {
        var bytes = File.ReadAllBytes(path);
        var prefix = Encoding.ASCII.GetString(bytes, 0, Math.Min(bytes.Length, 200));
        var encoding = prefix.Contains("utf-8", StringComparison.OrdinalIgnoreCase) ? Encoding.UTF8 : Encoding.GetEncoding(1250);
        return encoding.GetString(bytes).TrimStart('﻿');
    }

    private static string Sanitize(string value)
    {
        var safe = string.Concat(value.Select(character => char.IsLetterOrDigit(character) || character is '-' or '_' ? character : '-'));
        return safe.Length > 60 ? safe[..60] : safe;
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* upratovanie nesmie zhodiť export */ }
    }
}
