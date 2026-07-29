namespace Dokladovka.Agent;

public sealed record AgentConfigurationRequest
{
    public required string CloudBaseUrl { get; init; }
    public required string PairingCode { get; init; }
    public string? MServerUrl { get; init; }
    /// <summary>Povinné pre mserver a manuálny cli režim; voliteľné pri automatickom vyhľadaní firiem.</summary>
    public string? CompanyIco { get; init; }
    public required string UserName { get; init; }
    public required string Password { get; init; }
    public string EndpointId { get; init; } = "mserver-1";
    public string? InstanceName { get; init; }
    public string? PohodaExePath { get; init; }
    public string Mode { get; init; } = "mserver";
    public string? Database { get; init; }
    /// <summary>Dátový priečinok POHODA – zapína automatický cli režim pre všetky firmy (MDB variant).</summary>
    public string? DataDirectory { get; init; }
    /// <summary>Adresa SQL Servera POHODY – zapína automatický cli režim pre všetky firmy (SQL/E1 variant).</summary>
    public string? SqlHost { get; init; }
    public int? SqlPort { get; init; }
    public string? SqlUserName { get; init; }
    public string? SqlPassword { get; init; }
    public string? AllowedPublisherThumbprint { get; init; }
    public string? InstallationName { get; init; }
}

public sealed record AgentConfigurationResult(
    MServerCompany Company,
    PairResponse Pairing,
    IReadOnlyList<DiscoveredCompany> Discovered);

public static class AgentConfiguration
{
    public static async Task<AgentConfigurationResult> ConfigureAsync(
        AgentConfigurationRequest request,
        IAgentLog log,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.PairingCode))
            throw new InvalidOperationException("Párovací kód je povinný.");
        if (string.IsNullOrWhiteSpace(request.UserName))
            throw new InvalidOperationException("Používateľ POHODA je povinný.");
        if (string.IsNullOrEmpty(request.Password))
            throw new InvalidOperationException("Heslo POHODA je povinné.");

        var isAuto = request.Mode.Equals("cli", StringComparison.OrdinalIgnoreCase)
            && (!string.IsNullOrWhiteSpace(request.DataDirectory) || !string.IsNullOrWhiteSpace(request.SqlHost));
        return isAuto
            ? await ConfigureAutoAsync(request, log, cancellationToken)
            : await ConfigureSingleAsync(request, log, cancellationToken);
    }

    /// <summary>Doklado-štýl: jeden agent pre všetky firmy nájdené v dátovom priečinku POHODA.</summary>
    private static async Task<AgentConfigurationResult> ConfigureAutoAsync(
        AgentConfigurationRequest request,
        IAgentLog log,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.PohodaExePath))
            throw new InvalidOperationException("Pre priamy import je povinná cesta k pohoda.exe.");
        var usesSql = !string.IsNullOrWhiteSpace(request.SqlHost);
        if (usesSql && (string.IsNullOrWhiteSpace(request.SqlUserName) || string.IsNullOrEmpty(request.SqlPassword)))
            throw new InvalidOperationException("Pre MS SQL POHODU je povinné prihlásenie na SQL Server (napr. sa).");
        var discovered = usesSql
            ? await PohodaDataDiscovery.ScanSqlAsync(
                request.SqlHost!.Trim(), request.SqlPort ?? 1433, request.SqlUserName!.Trim(), request.SqlPassword!, cancellationToken)
            : PohodaDataDiscovery.Scan(request.DataDirectory!);
        if (discovered.Count == 0)
            throw new InvalidOperationException(usesSql
                ? $"Na SQL Serveri '{request.SqlHost}' sa nenašla žiadna databáza firmy (StwPh_ICO_ROK). Skontrolujte adresu a prihlásenie."
                : $"V priečinku '{request.DataDirectory}' sa nenašla žiadna databáza firmy (StwPh_ICO_ROK.mdb). Skontrolujte dátový priečinok POHODA.");
        var probeCompany = string.IsNullOrWhiteSpace(request.CompanyIco)
            ? discovered.OrderByDescending(company => company.Year, StringComparer.Ordinal).First()
            : discovered.FirstOrDefault(company => company.Ico == request.CompanyIco.Trim())
                ?? throw new InvalidOperationException($"Firma s IČO {request.CompanyIco} sa v dátovom priečinku nenašla.");

        var settings = new AgentSettings
        {
            CloudBaseUrl = request.CloudBaseUrl,
            InstallationName = request.InstallationName ?? Environment.MachineName,
            MServers = [],
            PohodaAuto = new PohodaAutoSettings
            {
                PohodaExePath = request.PohodaExePath!,
                DataDirectory = NullIfBlank(request.DataDirectory),
                SqlHost = NullIfBlank(request.SqlHost),
                SqlPort = request.SqlPort ?? 1433,
            },
            AllowedPublisherThumbprint = NormalizeThumbprint(request.AllowedPublisherThumbprint),
        };
        AgentSettings.Validate(settings);
        AgentSettingsStore.VerifyWritable();
        SecretVault.VerifyAvailable();

        var secret = new MServerSecret
        {
            EndpointId = PohodaAutoSettings.SecretEndpointId,
            UserName = request.UserName,
            Password = request.Password,
        };
        var probeEndpoint = new MServerEndpointSettings
        {
            Id = PohodaAutoSettings.EndpointIdPrefix + probeCompany.Database,
            CompanyIco = probeCompany.Ico,
            Mode = "cli",
            Database = probeCompany.Database,
            PohodaExePath = request.PohodaExePath,
        };
        IPohodaClient client = new PohodaCliClient(probeEndpoint, secret, log);
        var company = await client.GetCompanyAsync(cancellationToken);
        var probeXml = PohodaXml.BuildCodeListRequest(probeCompany.Ico, $"konfiguracia-test-{Guid.NewGuid():N}");
        PohodaXml.ParseCodeLists(await client.PostXmlAsync(probeXml, "konfiguracia-test", false, cancellationToken));

        var paired = await BackendClient.PairAsync(
            request.CloudBaseUrl,
            request.PairingCode,
            Environment.MachineName,
            AgentVersion.Current,
            NullIfBlank(request.CompanyIco),
            cancellationToken);

        AgentSettingsStore.Save(settings);
        var storedSecrets = new List<MServerSecret> { secret };
        if (usesSql)
            storedSecrets.Add(new MServerSecret
            {
                EndpointId = PohodaAutoSettings.SqlSecretEndpointId,
                UserName = request.SqlUserName!.Trim(),
                Password = request.SqlPassword!,
            });
        SecretVault.Save(new AgentSecrets { AgentToken = paired.AgentToken, MServers = storedSecrets });
        var backend = new BackendClient(settings.CloudBaseUrl, paired.AgentToken, log);
        await backend.SendHeartbeatAsync(
            discovered.Select(item => new HeartbeatCompany(item.Ico, item.Database, item.Year)).ToArray(),
            cancellationToken);
        return new AgentConfigurationResult(company, paired, discovered);
    }

    private static async Task<AgentConfigurationResult> ConfigureSingleAsync(
        AgentConfigurationRequest request,
        IAgentLog log,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.CompanyIco))
            throw new InvalidOperationException("IČO firmy je povinné.");

        var endpoint = new MServerEndpointSettings
        {
            Id = request.EndpointId,
            BaseUrl = request.MServerUrl,
            CompanyIco = request.CompanyIco,
            InstanceName = request.InstanceName,
            PohodaExePath = request.PohodaExePath,
            Mode = request.Mode,
            Database = request.Database,
        };
        var settings = new AgentSettings
        {
            CloudBaseUrl = request.CloudBaseUrl,
            InstallationName = request.InstallationName ?? Environment.MachineName,
            MServers = [endpoint],
            AllowedPublisherThumbprint = NormalizeThumbprint(request.AllowedPublisherThumbprint),
        };
        AgentSettings.Validate(settings);
        AgentSettingsStore.VerifyWritable();
        SecretVault.VerifyAvailable();

        var mServerSecret = new MServerSecret
        {
            EndpointId = endpoint.Id,
            UserName = request.UserName,
            Password = request.Password,
        };
        IPohodaClient client = endpoint.IsCli
            ? new PohodaCliClient(endpoint, mServerSecret, log)
            : new MServerClient(endpoint, mServerSecret, log);
        var company = await client.GetCompanyAsync(cancellationToken);
        if (endpoint.IsCli)
        {
            var probeXml = PohodaXml.BuildCodeListRequest(request.CompanyIco, $"konfiguracia-test-{Guid.NewGuid():N}");
            PohodaXml.ParseCodeLists(await client.PostXmlAsync(probeXml, "konfiguracia-test", false, cancellationToken));
        }
        var paired = await BackendClient.PairAsync(
            request.CloudBaseUrl,
            request.PairingCode,
            Environment.MachineName,
            AgentVersion.Current,
            request.CompanyIco,
            cancellationToken);

        AgentSettingsStore.Save(settings);
        SecretVault.Save(new AgentSecrets { AgentToken = paired.AgentToken, MServers = [mServerSecret] });
        var backend = new BackendClient(settings.CloudBaseUrl, paired.AgentToken, log);
        await backend.SendHeartbeatAsync(
            [new HeartbeatCompany(request.CompanyIco, company.DatabaseName, company.Year)],
            cancellationToken);
        return new AgentConfigurationResult(company, paired, [new DiscoveredCompany(request.CompanyIco, company.DatabaseName, company.Year)]);
    }

    private static string? NullIfBlank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string? NormalizeThumbprint(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = value.Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
        if (normalized.Length is not (40 or 64) || normalized.Any(character => !Uri.IsHexDigit(character)))
            throw new InvalidOperationException("Odtlačok certifikátu vydavateľa nie je platný.");
        return normalized;
    }
}
