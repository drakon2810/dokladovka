using System.Text.Json;

namespace Dokladovka.Agent.Configurator;

public sealed record AgentDefaults
{
    public string CloudBaseUrl { get; init; } = "https://app.dokladorpro.sk";
    public string MServerUrl { get; init; } = "http://localhost:444";
    public string? PublisherThumbprint { get; init; }

    public static AgentDefaults Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "agent-defaults.json");
        if (!File.Exists(path)) return new AgentDefaults();
        try
        {
            return JsonSerializer.Deserialize<AgentDefaults>(File.ReadAllText(path), new JsonSerializerOptions(JsonSerializerDefaults.Web))
                ?? new AgentDefaults();
        }
        catch (JsonException)
        {
            return new AgentDefaults();
        }
    }
}
