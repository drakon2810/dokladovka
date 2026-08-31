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
    private readonly MServerSecret? _autoSecret;
    private readonly MServerSecret? _sqlSecret;
    // ponytail: počítadlo pokusov v pamäti procesu (reset pri reštarte služby). Perzistovať sa nedá – pending .bin sa každý cyklus
    // prepíše z fronty. Pri reštarte sa pokusy vynulujú, čo je prijateľné. Slúži len na cli režim (mserver má vlastnú permanent chybu).
    private const int CliMaxAttempts = 5;
    private readonly Dictionary<string, int> _cliExportAttempts = new(StringComparer.Ordinal);
    // ponytail: rovnaký vzor pre tréningovú synchronizáciu — trvalá chyba POHODY by inak
    // spúšťala celý export agendy (a POHODU v cli režime) donekonečna každý cyklus.
    private const int TrainingMaxAttempts = 3;
    private readonly Dictionary<string, int> _trainingSyncAttempts = new(StringComparer.Ordinal);

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
        if (settings.PohodaAuto is not null)
        {
            _autoSecret = secretByEndpoint.TryGetValue(PohodaAutoSettings.SecretEndpointId, out var autoSecret)
                ? autoSecret
                : throw new InvalidOperationException("Chýbajú prihlasovacie údaje POHODA pre automatický režim.");
            if (settings.PohodaAuto.UsesSql)
            {
                _sqlSecret = secretByEndpoint.TryGetValue(PohodaAutoSettings.SqlSecretEndpointId, out var sqlSecret)
                    ? sqlSecret
                    : throw new InvalidOperationException("Chýbajú prihlasovacie údaje SQL Servera POHODY.");
            }
        }
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
        // Organizácie sa čítajú PRED heartbeatom: do cloudu sa hlásia len firmy,
        // ktoré v projekte existujú. Účtovník tak nikdy nesynchronizuje databázy
        // firiem, s ktorými v Dokladovke nepracuje.
        var organizations = await _backend.GetOrganizationsAsync(cancellationToken);
        var live = FilterToKnownOrganizations(await ReadCompaniesAsync(cancellationToken), organizations);
        // Heartbeat oddelený od zvyšku cyklu: jeho zlyhanie (napr. odmietnutá dávka) nesmie zablokovať spracovanie exportov.
        try
        {
            await _backend.SendHeartbeatAsync(live.Select(item => new HeartbeatCompany(item.Endpoint.CompanyIco, item.Company.DatabaseName, item.Company.Year)).ToArray(), cancellationToken);
        }
        catch (Exception error)
        {
            _log.Error("heartbeat_failed", error);
        }

        foreach (var pending in _pendingJobs.LoadAll())
            await TryProcessPendingAsync(pending, cancellationToken);

        foreach (var organization in organizations)
        {
            var endpoint = MatchEndpoint(organization, live);
            if (endpoint is null)
            {
                _log.Info("organization_unmatched", new { organization.OrganizationId, organization.Ico, organization.PreferredYear });
                // Žiadosť o tréning pre nespárovanú firmu by inak visela naveky bez stopy
                // v telemetrii — po opakovaných cykloch sa vzdá a žiadosť sa zmaže.
                if (organization.TrainingSyncRequested)
                    await HandleTrainingSyncFailureAsync(organization.OrganizationId, "organization_unmatched", 0, cancellationToken);
                continue;
            }
            await TrySyncCodeListsAsync(organization, endpoint.Value, cancellationToken);
            if (organization.TrainingSyncRequested) await TrySyncTrainingAsync(organization, endpoint.Value, cancellationToken);
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

    public int EndpointCount => _endpoints.Count;

    public async Task<IReadOnlyList<(MServerEndpointSettings Endpoint, MServerCompany Company)>> ReadCompaniesAsync(CancellationToken cancellationToken)
    {
        await RefreshAutoEndpointsAsync(cancellationToken);
        var result = new List<(MServerEndpointSettings, MServerCompany)>();
        foreach (var endpoint in _endpoints.Values.ToArray())
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

    // Dynamické endpointy: každá firemná databáza POHODY (StwPh_{ICO}_{rok}) = jeden endpoint.
    // Beží pri každom cykle, takže nová firma pridaná do POHODY (alebo Dokladovky) sa objaví bez rekonfigurácie.
    private async Task RefreshAutoEndpointsAsync(CancellationToken cancellationToken)
    {
        if (_settings.PohodaAuto is null || _autoSecret is null) return;
        IReadOnlyList<DiscoveredCompany> discovered;
        if (_settings.PohodaAuto.UsesSql)
        {
            try
            {
                discovered = await PohodaDataDiscovery.ScanSqlAsync(
                    _settings.PohodaAuto.SqlHost!, _settings.PohodaAuto.SqlPort,
                    _sqlSecret!.UserName, _sqlSecret.Password, cancellationToken);
            }
            catch (Exception error)
            {
                // Výpadok SQL Servera nesmie zhodiť už známe endpointy — heartbeat pobeží so starým zoznamom.
                _log.Error("sql_discovery_failed", error, new { _settings.PohodaAuto.SqlHost, _settings.PohodaAuto.SqlPort });
                return;
            }
        }
        else
        {
            discovered = PohodaDataDiscovery.Scan(_settings.PohodaAuto.DataDirectory!);
        }
        var expected = new HashSet<string>(
            discovered.Select(company => PohodaAutoSettings.EndpointIdPrefix + company.Database),
            StringComparer.OrdinalIgnoreCase);
        foreach (var id in _endpoints.Keys
            .Where(id => id.StartsWith(PohodaAutoSettings.EndpointIdPrefix, StringComparison.OrdinalIgnoreCase) && !expected.Contains(id))
            .ToArray())
        {
            _endpoints.Remove(id);
            _mServers.Remove(id);
        }
        var staticDatabases = new HashSet<string>(
            _settings.MServers.Where(endpoint => endpoint.Database is not null).Select(endpoint => endpoint.Database!),
            StringComparer.OrdinalIgnoreCase);
        foreach (var company in discovered)
        {
            var id = PohodaAutoSettings.EndpointIdPrefix + company.Database;
            if (_endpoints.ContainsKey(id) || staticDatabases.Contains(company.Database)) continue;
            var endpoint = new MServerEndpointSettings
            {
                Id = id,
                CompanyIco = company.Ico,
                Mode = "cli",
                Database = company.Database,
                PohodaExePath = _settings.PohodaAuto.PohodaExePath,
            };
            _endpoints[id] = endpoint;
            _mServers[id] = new PohodaCliClient(endpoint, _autoSecret, _log);
            _log.Info("auto_endpoint_added", new { id, company.Ico, company.Year });
        }
    }

    /// <summary>Len firmy existujúce v projekte — cudzie databázy POHODY sa do cloudu nehlásia.</summary>
    public static IReadOnlyList<(MServerEndpointSettings Endpoint, MServerCompany Company)> FilterToKnownOrganizations(
        IReadOnlyList<(MServerEndpointSettings Endpoint, MServerCompany Company)> live,
        IReadOnlyList<AgentOrganization> organizations)
    {
        var knownIcos = new HashSet<string>(organizations.Select(organization => organization.Ico), StringComparer.Ordinal);
        return live.Where(item => knownIcos.Contains(item.Endpoint.CompanyIco)).ToList();
    }

    public static (MServerEndpointSettings Endpoint, MServerCompany Company)? MatchEndpoint(
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
        // „Synchronizovať mostíkom" z webu obchádza hodinový interval — žiadosť
        // zmaže server pri nahratí číselníkov, takže sa nevykoná dvakrát.
        if (!organization.SyncRequested
            && _state.LastCodeListSync.TryGetValue(stateKey, out var last)
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

    // Tréning AI cez mostík: beží len na žiadosť z webu (žiadny interval).
    // Agent stiahne prijaté faktúry oficiálnym XML exportom (iba čítanie)
    // a nahrá rozhodnutia do cloudu; server žiadosť zmaže pri nahratí —
    // aj prázdny výsledok sa nahráva, inak by sa sync opakoval každý cyklus.
    private async Task TrySyncTrainingAsync(
        AgentOrganization organization,
        (MServerEndpointSettings Endpoint, MServerCompany Company) target,
        CancellationToken cancellationToken)
    {
        // Strop pokusov už dosiahnutý — export POHODY sa nespúšťa, skúša sa len
        // lacné zmazanie žiadosti (HandleTrainingSyncFailureAsync pri strope).
        if (_trainingSyncAttempts.GetValueOrDefault(organization.OrganizationId) >= TrainingMaxAttempts)
        {
            await HandleTrainingSyncFailureAsync(organization.OrganizationId, "max_attempts", 0, cancellationToken);
            return;
        }
        var stopwatch = Stopwatch.StartNew();
        try
        {
            var requestXml = PohodaXml.BuildInvoiceListRequest(organization.Ico, $"trening-{organization.OrganizationId}-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}");
            var errors = _validator.ValidateDataPack(requestXml);
            if (errors.Count > 0) throw new InvalidOperationException("XSD validácia požiadavky tréningu zlyhala: " + string.Join("; ", errors.Take(5)));
            var response = await _mServers[target.Endpoint.Id].PostXmlAsync(requestXml, $"trening-{organization.OrganizationId}", false, cancellationToken);
            var parsed = PohodaXml.ParseTrainingDecisions(response);
            var imported = 0;
            var duplicates = 0;
            var rejected = 0;
            // Dávky po 2 000 riadkov: bezpečne pod limitom API (10 000) aj bodyLimit.
            // done=true iba pri poslednej — server až vtedy zmaže žiadosť, takže
            // výpadok uprostred nechá žiadosť aktívnu a ďalší cyklus sync zopakuje.
            var batches = parsed.Items.Count == 0
                ? new List<TrainingDecision[]> { Array.Empty<TrainingDecision>() }
                : parsed.Items.Chunk(2000).ToList();
            for (var index = 0; index < batches.Count; index++)
            {
                // Prvá dávka nesie reset: hromadne načítaná pamäť sa postaví z tohto
                // prenosu. Rozhodnutia schválené účtovníkom v appke ostávajú.
                var result = await _backend.UploadTrainingDecisionsAsync(
                    organization.OrganizationId, batches[index], index == batches.Count - 1, index == 0, cancellationToken);
                imported += result.Imported;
                duplicates += result.Duplicates;
                rejected += result.Rejected;
            }
            // Korpus histórie pre účtovný profil ide tou istou žiadosťou o sync —
            // účtovník tak nemusí nosiť .mdb ručne, hoci agent databázu firmy vidí.
            // Zlyhanie tu nesmie zhodiť tréning vyššie: pamäť dodávateľov je
            // dôležitejšia a už je nahratá.
            try { await SyncUctoHistoryAsync(organization, target, cancellationToken); }
            catch (Exception error) { _log.Error("ucto_history_sync_failed", error, new { organization.OrganizationId }); }

            _trainingSyncAttempts.Remove(organization.OrganizationId);
            // Nič neprešlo a všetko odmietnuté = pravdepodobne chýbajú číselníky —
            // do telemetrie ide error, nech to nevyzerá ako úspešná synchronizácia.
            var allRejected = rejected > 0 && imported == 0 && duplicates == 0;
            await TrySendSyncResultAsync(new AgentSyncResult(
                organization.OrganizationId, "treningAi", allRejected ? "error" : "ok",
                Math.Min(parsed.Items.Count, 20_000), (int)stopwatch.ElapsedMilliseconds,
                allRejected ? "rows_rejected" : null), cancellationToken);
            _log.Info("training_synced", new { organization.OrganizationId, rows = parsed.Items.Count, imported, duplicates, rejected, durationMs = stopwatch.ElapsedMilliseconds, warnings = parsed.Warnings.Count });
        }
        catch (Exception error)
        {
            _log.Error("training_sync_failed", error, new { organization.OrganizationId, target.Endpoint.Id, durationMs = stopwatch.ElapsedMilliseconds });
            await HandleTrainingSyncFailureAsync(organization.OrganizationId, error.GetType().Name, (int)stopwatch.ElapsedMilliseconds, cancellationToken);
        }
    }

    /// <summary>
    /// Korpus histórie pre účtovný profil: všetky dokladové agendy (prijaté aj
    /// vydané faktúry, ostatné záväzky, pokladňa so smerom, interné doklady),
    /// banka zatiaľ nie. Beží spolu s tréningom, lebo obe vychádzajú z tej istej
    /// žiadosti účtovníka a z tej istej databázy firmy.
    /// </summary>
    private async Task SyncUctoHistoryAsync(
        AgentOrganization organization,
        (MServerEndpointSettings Endpoint, MServerCompany Company) target,
        CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var requestXml = PohodaXml.BuildHistoryListRequest(
            organization.Ico, $"historia-{organization.OrganizationId}-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}");
        var errors = _validator.ValidateDataPack(requestXml);
        if (errors.Count > 0) throw new InvalidOperationException("XSD validácia požiadavky histórie zlyhala: " + string.Join("; ", errors.Take(5)));
        var response = await _mServers[target.Endpoint.Id].PostXmlAsync(
            requestXml, $"historia-{organization.OrganizationId}", false, cancellationToken);
        var parsed = PohodaXml.ParseHistoryRows(response);
        if (parsed.Rows.Count == 0)
        {
            _log.Info("ucto_history_empty", new { organization.OrganizationId, warnings = parsed.Warnings.Count });
            return;
        }
        var imported = 0;
        var duplicates = 0;
        // Dávky po 2 000 riadkov — server berie najviac 20 000 na požiadavku
        // a bodyLimit je 30 MB; história býva rádovo väčšia než pamäť.
        var prvaDavka = true;
        foreach (var batch in parsed.Rows.Chunk(2000))
        {
            // Prvá dávka nesie reset — server korpus zahodí a postaví z tohto
            // prenosu. Až potom sa dávky pripájajú.
            var result = await _backend.UploadUctoHistoryAsync(
                organization.OrganizationId, batch, prvaDavka, cancellationToken);
            prvaDavka = false;
            imported += result.Imported;
            duplicates += result.Duplicates;
        }
        await TrySendSyncResultAsync(new AgentSyncResult(
            organization.OrganizationId, "uctovnyProfil", "ok",
            parsed.Rows.Count, (int)stopwatch.ElapsedMilliseconds, null), cancellationToken);
        _log.Info("ucto_history_synced", new
        {
            organization.OrganizationId, rows = parsed.Rows.Count, imported, duplicates,
            durationMs = stopwatch.ElapsedMilliseconds, warnings = parsed.Warnings.Count,
        });
    }

    // Zlyhanie tréningovej synchronizácie: telemetria + počítadlo pokusov. Po
    // TrainingMaxAttempts sa žiadosť vzdá (prázdny upload s done=true ju zmaže),
    // aby trvalá chyba nespúšťala celý export agendy donekonečna.
    private async Task HandleTrainingSyncFailureAsync(string organizationId, string errorCode, int durationMs, CancellationToken cancellationToken)
    {
        await TrySendSyncResultAsync(new AgentSyncResult(organizationId, "treningAi", "error", 0, durationMs, errorCode), cancellationToken);
        var attempts = _trainingSyncAttempts.GetValueOrDefault(organizationId) + 1;
        if (attempts < TrainingMaxAttempts)
        {
            _trainingSyncAttempts[organizationId] = attempts;
            return;
        }
        try
        {
            // Prázdny prenos iba uzatvára žiadosť — pamäť sa nemaže.
            await _backend.UploadTrainingDecisionsAsync(organizationId, Array.Empty<TrainingDecision>(), true, false, cancellationToken);
            _trainingSyncAttempts.Remove(organizationId);
            _log.Info("training_sync_abandoned", new { organizationId, attempts, errorCode });
        }
        catch (Exception error)
        {
            // Zmazanie žiadosti sa nepodarilo — počítadlo ostáva na strope, ďalší
            // cyklus skúsi iba lacné zmazanie, export POHODY sa už nespúšťa.
            _trainingSyncAttempts[organizationId] = attempts;
            _log.Error("training_sync_abandon_failed", error, new { organizationId });
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
            // Ochrana dát POHODY: agent doklady výhradne vytvára. DataPack s akciou
            // update/delete sa odmietne ešte pred odoslaním — nech príde odkiaľkoľvek.
            var destructive = PohodaXml.FindDestructiveActions(pending.Job.DataPackXml);
            if (destructive.Count > 0)
            {
                await SendPermanentFailureAsync(pending, documentIds, $"Agent povoľuje iba vytváranie dokladov — dataPack obsahuje akciu {string.Join(", ", destructive)}.", stopwatch, cancellationToken);
                return;
            }
            var response = await mServer.PostXmlAsync(pending.Job.DataPackXml, pending.Job.IdempotencyKey, pending.Job.CheckDuplicity, cancellationToken);
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
            // Sken sa ukladá až po potvrdení prenosu — zlyhanie kopírovania nesmie
            // zdržať cloud ani spôsobiť opakovaný import už zaúčtovaného dokladu.
            try { await TryAttachScansAsync(pending, mServer, parsed.Results, cancellationToken); }
            catch (Exception error) { _log.Error("scan_attach_failed", error, new { pending.Job.ExportJobId }); }
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

    /// <summary>
    /// Uloží originálny sken k prenesenému dokladu do priečinka dokumentov POHODY
    /// (záložka „Dokumenty"). Cestu pýtame od POHODY — pozná lokalizovaný segment
    /// aj priečinok číselného radu. Beží až PO potvrdení prenosu a je best-effort:
    /// zlyhanie kopírovania nesmie zhodiť ani zopakovať už zaúčtovaný doklad.
    /// </summary>
    private async Task TryAttachScansAsync(
        PendingExport pending,
        IPohodaClient pohoda,
        IReadOnlyList<ExportDocumentResult> results,
        CancellationToken cancellationToken)
    {
        // Len doklady, ktoré POHODA naozaj založila (varovanie = nezaložený doklad).
        var prenesene = results.Where(result => result.State == "ok" && !string.IsNullOrWhiteSpace(result.PohodaNumber)).ToArray();
        if (prenesene.Length == 0) return;
        var typy = PohodaXml.ReadDataPackItemTypes(pending.Job.DataPackXml);
        foreach (var skupina in prenesene.GroupBy(result => typy.GetValueOrDefault(result.DocumentId)))
        {
            if (skupina.Key is null) continue;
            var cisla = skupina.Select(result => result.PohodaNumber!).Distinct(StringComparer.Ordinal).ToArray();
            var requestXml = PohodaXml.BuildDocumentFolderRequest(
                PohodaXml.ReadDataPackIco(pending.Job.DataPackXml) ?? string.Empty, skupina.Key, cisla, $"priecinky-{pending.Job.ExportJobId}");
            if (requestXml is null) continue;
            var response = await pohoda.PostXmlAsync(requestXml, $"priecinky-{pending.Job.ExportJobId}", false, cancellationToken);
            var priecinky = PohodaXml.ParseDocumentFolders(response)
                .ToDictionary(folder => folder.Cislo, StringComparer.OrdinalIgnoreCase);
            foreach (var result in skupina)
            {
                if (!priecinky.TryGetValue(result.PohodaNumber!, out var folder) || string.IsNullOrWhiteSpace(folder.CompanyFolder))
                {
                    _log.Info("scan_folder_unknown", new { result.DocumentId, result.PohodaNumber });
                    continue;
                }
                try
                {
                    await SaveScanAsync(result, folder, cancellationToken);
                }
                catch (Exception error)
                {
                    _log.Error("scan_save_failed", error, new { result.DocumentId, result.PohodaNumber });
                }
            }
        }
    }

    private async Task SaveScanAsync(ExportDocumentResult result, PohodaXml.DocumentFolder folder, CancellationToken cancellationToken)
    {
        // subFolder je relatívny k priečinku firmy; absolútna hodnota by pri
        // Path.Combine ticho zahodila koreň a zapísala mimo stromu Dokumenty.
        var sub = folder.SubFolder?.Trim() ?? string.Empty;
        var target = string.IsNullOrEmpty(sub) || Path.IsPathRooted(sub)
            ? folder.CompanyFolder!
            : Path.Combine(folder.CompanyFolder!, sub);
        var (bytes, headerName) = await _backend.DownloadScanAsync(result.DocumentId, cancellationToken);
        var fileName = SafeFileName(headerName, result.PohodaNumber!);
        Directory.CreateDirectory(target);
        var path = Path.Combine(target, fileName);
        // Rovnaký sken sa druhýkrát neprepisuje (zopakovaný prenos, duplicita).
        if (File.Exists(path))
        {
            _log.Info("scan_already_present", new { result.DocumentId, path });
            return;
        }
        await File.WriteAllBytesAsync(path, bytes, cancellationToken);
        _log.Info("scan_saved", new { result.DocumentId, result.PohodaNumber, bytes = bytes.Length });
    }

    /// <summary>Meno súboru z HTTP hlavičky je cudzí vstup — z cesty sa berie len
    /// samotné meno, zakázané znaky padajú a dĺžka sa stráži kvôli limitu Windows.</summary>
    public static string SafeFileName(string? headerName, string fallback)
    {
        var raw = Path.GetFileName(headerName?.Trim() ?? string.Empty);
        var cleaned = new string(raw.Where(character => !Path.GetInvalidFileNameChars().Contains(character)).ToArray()).Trim();
        // "." / ".." prežijú filter znakov, ale ako cesta ukazujú na priečinok.
        if (cleaned.Length == 0 || cleaned.All(character => character == '.')) cleaned = $"{fallback}.pdf";
        if (cleaned.Length <= 90) return cleaned;
        var extension = Path.GetExtension(cleaned);
        return string.Concat(Path.GetFileNameWithoutExtension(cleaned).AsSpan(0, Math.Max(1, 90 - extension.Length)), extension);
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
