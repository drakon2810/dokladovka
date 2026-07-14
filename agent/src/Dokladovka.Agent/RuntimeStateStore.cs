using System.Text.Json;

namespace Dokladovka.Agent;

public sealed record RuntimeState
{
    public Dictionary<string, DateTimeOffset> LastCodeListSync { get; init; } = new(StringComparer.Ordinal);
    public DateTimeOffset? LastUpdateCheck { get; set; }
}

public sealed class RuntimeStateStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public RuntimeState Load()
    {
        if (!File.Exists(AgentPaths.RuntimeState)) return new RuntimeState();
        try
        {
            return JsonSerializer.Deserialize<RuntimeState>(File.ReadAllText(AgentPaths.RuntimeState), JsonOptions) ?? new RuntimeState();
        }
        catch (JsonException)
        {
            return new RuntimeState();
        }
    }

    public void Save(RuntimeState state)
    {
        Directory.CreateDirectory(AgentPaths.Root);
        var temporary = AgentPaths.RuntimeState + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(state, JsonOptions));
        File.Move(temporary, AgentPaths.RuntimeState, true);
    }
}
