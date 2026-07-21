namespace Dokladovka.Agent;

public sealed record AgentConfigurationRequest
{
    public required string CloudBaseUrl { get; init; }
    public required string PairingCode { get; init; }
    public string? MServerUrl { get; init; }
    public required string CompanyIco { get; init; }
    public required string UserName { get; init; }
    public required string Password { get; init; }
    public string EndpointId { get; init; } = "mserver-1";
    public string? InstanceName { get; init; }
    public string? PohodaExePath { get; init; }
    public string Mode { get; init; } = "mserver";
    public string? Database { get; init; }
    public string? AllowedPublisherThumbprint { get; init; }
    public string? InstallationName { get; init; }
}

public sealed record AgentConfigurationResult(MServerCompany Company, PairResponse Pairing);

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
            throw new InvalidOperationException("Používateľ mServer je povinný.");
        if (string.IsNullOrEmpty(request.Password))
            throw new InvalidOperationException("Heslo mServer je povinné.");

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
        return new AgentConfigurationResult(company, paired);
    }

    private static string? NormalizeThumbprint(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = value.Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant();
        if (normalized.Length is not (40 or 64) || normalized.Any(character => !Uri.IsHexDigit(character)))
            throw new InvalidOperationException("Odtlačok certifikátu vydavateľa nie je platný.");
        return normalized;
    }
}
