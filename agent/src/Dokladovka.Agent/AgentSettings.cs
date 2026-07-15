using System.Text.Json;

namespace Dokladovka.Agent;

public sealed record MServerEndpointSettings
{
    public required string Id { get; init; }
    public required string BaseUrl { get; init; }
    public required string CompanyIco { get; init; }
    public string? InstanceName { get; init; }
    public string? PohodaExePath { get; init; }
}

public sealed record AgentSettings
{
    public required string CloudBaseUrl { get; init; }
    public required string InstallationName { get; init; }
    public required List<MServerEndpointSettings> MServers { get; init; }
    public int PollSeconds { get; init; } = 30;
    public int HeartbeatSeconds { get; init; } = 120;
    public int CodeListSyncMinutes { get; init; } = 60;
    public int UpdateCheckHours { get; init; } = 24;
    public string? AllowedPublisherThumbprint { get; init; }
    public string SchemaDirectory { get; init; } = Path.Combine(AppContext.BaseDirectory, "Schemas");

    public static void Validate(AgentSettings settings)
    {
        ValidateNetworkUrl(settings.CloudBaseUrl, allowLocalHttp: true, "URL cloudu");
        if (string.IsNullOrWhiteSpace(settings.InstallationName)) throw new InvalidOperationException("Názov inštalácie je povinný.");
        if (settings.MServers.Count == 0) throw new InvalidOperationException("Je potrebná aspoň jedna inštancia POHODA mServer.");
        if (settings.MServers.Select(item => item.Id).Distinct(StringComparer.OrdinalIgnoreCase).Count() != settings.MServers.Count)
            throw new InvalidOperationException("Identifikátory mServerov musia byť jedinečné.");
        foreach (var endpoint in settings.MServers)
        {
            ValidateNetworkUrl(endpoint.BaseUrl, allowLocalHttp: true, "URL mServera");
            if (!System.Text.RegularExpressions.Regex.IsMatch(endpoint.CompanyIco, "^[0-9]{8}$"))
                throw new InvalidOperationException("IČO mServera musí mať presne 8 číslic.");
        }
        if (settings.PollSeconds is < 10 or > 3600) throw new InvalidOperationException("Interval pollingu musí byť 10–3600 sekúnd.");
        if (settings.HeartbeatSeconds is < 30 or > 3600) throw new InvalidOperationException("Interval heartbeat musí byť 30–3600 sekúnd.");
    }

    public static bool IsLocalHost(string host) => host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
        || host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)
        || host.Equals("::1", StringComparison.OrdinalIgnoreCase);

    private static void ValidateNetworkUrl(string value, bool allowLocalHttp, string label)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
            throw new InvalidOperationException($"{label} nie je platná HTTP(S) adresa.");
        if (uri.Scheme != Uri.UriSchemeHttps && !(allowLocalHttp && IsLocalHost(uri.Host)))
            throw new InvalidOperationException($"{label} musí používať HTTPS; HTTP je povolené iba pre localhost.");
    }
}

public sealed record MServerSecret
{
    public required string EndpointId { get; init; }
    public required string UserName { get; init; }
    public required string Password { get; init; }
}

public sealed record AgentSecrets
{
    public required string AgentToken { get; init; }
    public required List<MServerSecret> MServers { get; init; }
}

public static class AgentPaths
{
    public static string Root => Environment.GetEnvironmentVariable("DOKLADOVKA_AGENT_DATA_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Dokladovka");
    public static string Settings => Path.Combine(Root, "agent.json");
    public static string Secrets => Path.Combine(Root, "secrets.bin");
    public static string Logs => Path.Combine(Root, "logs");
    public static string Pending => Path.Combine(Root, "pending");
    public static string RuntimeState => Path.Combine(Root, "runtime-state.json");
    public static string Updates => Path.Combine(Root, "updates");
}

public static class AgentSettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static AgentSettings Load()
    {
        if (!File.Exists(AgentPaths.Settings)) throw new InvalidOperationException("Agent nie je nakonfigurovaný. Spustite Dokladovka.Agent.exe configure.");
        var settings = JsonSerializer.Deserialize<AgentSettings>(File.ReadAllText(AgentPaths.Settings), JsonOptions)
            ?? throw new InvalidOperationException("Konfigurácia agenta je poškodená.");
        AgentSettings.Validate(settings);
        return settings;
    }

    public static void Save(AgentSettings settings)
    {
        AgentSettings.Validate(settings);
        Directory.CreateDirectory(AgentPaths.Root);
        var temporary = AgentPaths.Settings + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(settings, JsonOptions));
        File.Move(temporary, AgentPaths.Settings, true);
    }
}
