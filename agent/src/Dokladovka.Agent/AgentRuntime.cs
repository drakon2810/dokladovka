using System.Diagnostics;
using Microsoft.Extensions.Hosting;

namespace Dokladovka.Agent;

public sealed class AgentCycleRunner
{
    private readonly AgentSettings _settings;
    private readonly BackendClient _backend;
    private readonly IAgentLog _log;
    private readonly PohodaSchemaValidator _validator;
    private readonly PendingJobStore _pendingJobs;
    private readonly RuntimeStateStore _stateStore;
    private readonly RuntimeState _state;
    private readonly Dictionary<string, IPohodaClient> _mServers;
    private readonly Dictionary<string, MServerEndpointSettings> _endpoints;
    // ponytail: počítadlo pokusov v pamäti procesu (reset pri reštarte služby). Perzistovať sa nedá – pending .bin sa každý cyklus
    // prepíše z fronty. Pri reštarte sa pokusy vynulujú, čo je prijateľné. Slúži len na cli režim (mserver má vlastnú permanent chybu).
    private const int CliMaxAttempts = 5;
    private readonly Dictionary<string, int> _cliExportAttempts = new(StringComparer.Ordinal);

    public AgentCycleRunner(AgentSettings settings, AgentSecrets secrets, IAgentLog log)
    {
        _settings = settings;
        _log = log;
        _backend = new BackendClient(settings.CloudBaseUrl, secrets.AgentToken, log);
        _validator = new PohodaSchemaValidator(settings.SchemaDirectory);
        _pendingJobs = new PendingJobStore();
        _stateStore = new RuntimeStateStore();
        _state = _stateStore.Load();
        _endpoints = settings.MServers.ToDictionary(item => item.Id, StringComparer.OrdinalIgnoreCase);
        var secretByEndpoint = secrets.MServers.ToDictionary(item => item.EndpointId, StringComparer.OrdinalIgnoreCase);
        _mServers = settings.MServers.ToDictionary(
            endpoint => endpoint.Id,
            IPohodaClient (endpoint) =>
            {
                var secret = secretByEndpoint.TryGetValue(endpoint.Id, out var value)
                    ? value
                    : throw new InvalidOperationException($"Chýbajú prihlasovacie údaje pre mServer {endpoint.Id}.");
                return endpoint.IsCli ? new PohodaCliClient(endpoint, secret, log) : new MServerClient(endpoint, secret, log);
            },
            StringComparer.OrdinalIgnoreCase);
    }

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        var live = await ReadCompaniesAsync(cancellationToken);
        // Heartbeat oddelený od zvyšku cyklu: jeho zlyhanie (napr. odmietnutá dávka) nesmie zablokovať spracovanie exportov.
        try
        {
            await _backend.SendHeartbeatAsync(live.Select(item => new HeartbeatCompany(item.Endpoint.CompanyIco, item.Company.DatabaseName, item.Company.Year)).ToArray(), cancellationToken);
        }
        catch (Exception error)
        {
            _log.Error("heartbeat_failed", error);
        }
        var organizations = await _backend.GetOrganizationsAsync(cancellationToken);

        foreach (var pending in _pendingJobs.LoadAll())
            await TryProcessPendingAsync(pending, cancellationToken);

        foreach (var organization in organizations)
        {
            var endpoint = MatchEndpoint(organization, live);
            if (endpoint is null)
            {
                _log.Info("organization_unmatched", new { organization.OrganizationId, organization.Ico, organization.PreferredYear });
                continue;
            }
            await TrySyncCodeListsAsync(organization, endpoint.Value, cancellationToken);
            IReadOnlyList<AgentExportJob> jobs;
            try
            {
                jobs = await _backend.GetExportQueueAsync(organization.OrganizationId, cancellationToken);
            }
            catch (Exception error)
            {
                _log.Error("export_queue_failed", error, new { organization.OrganizationId });
                continue;
            }
            foreach (var job in jobs)
            {
                var pending = new PendingExport(organization.OrganizationId, endpoint.Value.Endpoint.Id, job, DateTimeOffset.UtcNow);
                _pendingJobs.Save(pending);
                await TryProcessPendingAsync(pending, cancellationToken);
            }
        }

        if (_state.LastUpdateCheck is null || DateTimeOffset.UtcNow - _state.LastUpdateCheck >= TimeSpan.FromHours(_settings.UpdateCheckHours))
        {
            try
            {
                await new AutoUpdater(_backend, _settings, _log).CheckAsync(cancellationToken);
                _state.LastUpdateCheck = DateTimeOffset.UtcNow;
            }
            catch (Exception error)
            {
                _log.Error("update_check_failed", error);
            }
        }
        _stateStore.Save(_state);
    }

    public async Task<IReadOnlyList<(MServerEndpointSettings Endpoint, MServerCompany Company)>> ReadCompaniesAsync(CancellationToken cancellationToken)
    {
        var result = new List<(MServerEndpointSettings, MServerCompany)>();
        foreach (var endpoint in _settings.MServers)
        {
            try
            {
                var company = await _mServers[endpoint.Id].GetCompanyAsync(cancellationToken);
                result.Add((endpoint, company));
            }
            catch (Exception error)
            {
                _log.Error("mserver_status_failed", error, new { endpoint.Id, endpoint.BaseUrl });
            }
        }
        return result;
    }

    private (MServerEndpointSettings Endpoint, MServerCompany Company)? MatchEndpoint(
        AgentOrganization organization,
        IReadOnlyList<(MServerEndpointSettings Endpoint, MServerCompany Company)> live)
    {
        var matches = live.Where(item => item.Endpoint.CompanyIco == organization.Ico).ToArray();
        if (!string.IsNullOrWhiteSpace(organization.DbName))
        {
            var exact = matches.FirstOrDefault(item => item.Company.DatabaseName.Equals(organization.DbName, StringComparison.OrdinalIgnoreCase));
            if (exact.Endpoint is not null) return exact;
        }
        if (!organization.PreferredYear.Equals("latest", StringComparison.OrdinalIgnoreCase))
        {
            var preferred = matches.FirstOrDefault(item => item.Company.Year.Equals(organization.PreferredYear, StringComparison.OrdinalIgnoreCase));
            if (preferred.Endpoint is not null) return preferred;
        }
        return matches.Length == 0
            ? null
            : matches.OrderByDescending(item => item.Company.Year, StringComparer.OrdinalIgnoreCase).First();
    }

    private async Task TrySyncCodeListsAsync(
        AgentOrganization organization,
        (MServerEndpointSettings Endpoint, MServerCompany Company) target,
        CancellationToken cancellationToken)
    {
        var stateKey = $"{organization.OrganizationId}:{target.Company.DatabaseName}:{target.Company.Year}";
        if (_state.LastCodeListSync.TryGetValue(stateKey, out var last)
            && DateTimeOffset.UtcNow - last < TimeSpan.FromMinutes(_settings.CodeListSyncMinutes)) return;
        var stopwatch = Stopwatch.StartNew();
        try
        {
            var requestXml = PohodaXml.BuildCodeListRequest(organization.Ico, $"ciselniky-{organization.OrganizationId}-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}");
            var errors = _validator.ValidateDataPack(requestXml);
            if (errors.Count > 0) throw new InvalidOperationException("XSD validácia požiadavky číselníkov zlyhala: " + string.Join("; ", errors.Take(5)));
            var response = await _mServers[target.Endpoint.Id].PostXmlAsync(requestXml, $"ciselniky-{organization.OrganizationId}", false, cancellationToken);
            var parsed = PohodaXml.ParseCodeLists(response);
            foreach (var (kind, items) in parsed.Items)
            {
                var itemStopwatch = Stopwatch.StartNew();
                try
                {
                    await _backend.SyncCodeListAsync(organization.OrganizationId, kind, items, cancellationToken);
                    await TrySendSyncResultAsync(new AgentSyncResult(organization.OrganizationId, kind, "ok", items.Count, (int)itemStopwatch.ElapsedMilliseconds), cancellationToken);
                }
                catch (Exception error)
                {
                    await TrySendSyncResultAsync(new AgentSyncResult(organization.OrganizationId, kind, "error", items.Count, (int)itemStopwatch.ElapsedMilliseconds, error.GetType().Name), cancellationToken);
                    throw;
                }
            }
            _state.LastCodeListSync[stateKey] = DateTimeOffset.UtcNow;
            _stateStore.Save(_state);
            _log.Info("code_lists_synced", new { organization.OrganizationId, durationMs = stopwatch.ElapsedMilliseconds, warnings = parsed.Warnings.Count });
        }
        catch (Exception error)
        {
            _log.Error("code_lists_sync_failed", error, new { organization.OrganizationId, target.Endpoint.Id, durationMs = stopwatch.ElapsedMilliseconds });
        }
    }

    private async Task TryProcessPendingAsync(PendingExport pending, CancellationToken cancellationToken)
    {
        if (!_endpoints.TryGetValue(pending.EndpointId, out var endpoint) || !_mServers.TryGetValue(pending.EndpointId, out var mServer))
        {
            _log.Info("pending_endpoint_missing", new { pending.Job.ExportJobId, pending.EndpointId });
            return;
        }
        var documentIds = PohodaXml.ReadDataPackItemIds(pending.Job.DataPackXml);
        if (documentIds.Count == 0)
        {
            _log.Error("export_invalid_empty", new InvalidOperationException("DataPack neobsahuje žiadne doklady."), new { pending.Job.ExportJobId });
            return;
        }
        var stopwatch = Stopwatch.StartNew();
        try
        {
            var errors = _validator.ValidateDataPack(pending.Job.DataPackXml);
            if (errors.Count > 0)
            {
                await SendPermanentFailureAsync(pending, documentIds, "XSD validácia zlyhala: " + string.Join("; ", errors.Take(5)), stopwatch, cancellationToken);
                return;
            }
            var response = await mServer.PostXmlAsync(pending.Job.DataPackXml, pending.Job.IdempotencyKey, true, cancellationToken);
            var parsed = PohodaXml.ParseExportResponse(response, documentIds);
            await _backend.SendExportResultsAsync(pending.Job.ExportJobId, parsed.Results, new
            {
                responsePackState = parsed.PackState,
                note = parsed.Note,
                responseSha256 = PohodaXml.Sha256(response),
                durationMs = stopwatch.ElapsedMilliseconds,
                endpoint = endpoint.Id,
            }, cancellationToken);
            _pendingJobs.Delete(pending.Job.ExportJobId);
            _cliExportAttempts.Remove(pending.Job.ExportJobId);
            _log.Info("export_completed", new { pending.Job.ExportJobId, durationMs = stopwatch.ElapsedMilliseconds, parsed.PackState });
        }
        catch (MServerException error) when (!error.IsTransient)
        {
            await SendPermanentFailureAsync(pending, documentIds, error.Message, stopwatch, cancellationToken);
        }
        catch (Exception error)
        {
            // Cli režim nemá netransientnú MServerException, takže trvalá chyba (zlá cesta k exe, zlé prihlásenie, chýbajúce právo,
            // zlý názov databázy) by inak donekonečna spúšťala POHODU a cloud by sa chybu nikdy nedozvedel. Po CliMaxAttempts to nahlásime.
            if (endpoint.IsCli)
            {
                var attempts = _cliExportAttempts.GetValueOrDefault(pending.Job.ExportJobId) + 1;
                if (attempts >= CliMaxAttempts)
                {
                    await SendPermanentFailureAsync(pending, documentIds, $"POHODA /XML export zlyhal {attempts}× po sebe; posledná chyba: {error.Message}", stopwatch, cancellationToken);
                    return;
                }
                _cliExportAttempts[pending.Job.ExportJobId] = attempts;
                _log.Error("export_deferred", error, new { pending.Job.ExportJobId, attempts, durationMs = stopwatch.ElapsedMilliseconds });
                return;
            }
            _log.Error("export_deferred", error, new { pending.Job.ExportJobId, durationMs = stopwatch.ElapsedMilliseconds });
        }
    }

    private async Task SendPermanentFailureAsync(PendingExport pending, IReadOnlyList<string> documentIds, string message, Stopwatch stopwatch, CancellationToken cancellationToken)
    {
        var results = documentIds.Select(id => new ExportDocumentResult(id, "error", Message: message[..Math.Min(message.Length, 1000)])).ToArray();
        await _backend.SendExportResultsAsync(pending.Job.ExportJobId, results, new
        {
            responsePackState = "error",
            validationOrTransportError = true,
            durationMs = stopwatch.ElapsedMilliseconds,
        }, cancellationToken);
        _pendingJobs.Delete(pending.Job.ExportJobId);
        _cliExportAttempts.Remove(pending.Job.ExportJobId);
        _log.Info("export_rejected", new { pending.Job.ExportJobId, durationMs = stopwatch.ElapsedMilliseconds });
    }

    private async Task TrySendSyncResultAsync(AgentSyncResult result, CancellationToken cancellationToken)
    {
        try { await _backend.SendSyncResultAsync(result, cancellationToken); }
        catch (Exception error) { _log.Error("sync_metric_failed", error, new { result.OrganizationId, result.Kind }); }
    }
}

public sealed class AgentWorker(IAgentLog log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        AgentSettings settings;
        AgentCycleRunner runner;
        try
        {
            settings = AgentSettingsStore.Load();
            runner = new AgentCycleRunner(settings, SecretVault.Load(), log);
        }
        catch (Exception error)
        {
            log.Error("agent_start_failed", error);
            return;
        }

        log.Info("agent_started", new { version = AgentVersion.Current, settings.InstallationName });
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await runner.RunOnceAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { log.Error("agent_cycle_failed", error); }
            try { await Task.Delay(TimeSpan.FromSeconds(settings.PollSeconds), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
        log.Info("agent_stopped");
    }
}
