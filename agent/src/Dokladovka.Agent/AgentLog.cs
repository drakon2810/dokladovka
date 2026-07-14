using System.Text.Json;

namespace Dokladovka.Agent;

public interface IAgentLog
{
    void Info(string eventName, object? data = null);
    void Error(string eventName, Exception error, object? data = null);
}

public sealed class RollingFileAgentLog : IAgentLog
{
    private const long MaximumBytes = 10 * 1024 * 1024;
    private const int RetainedFiles = 10;
    private readonly object _gate = new();
    private readonly string _path;

    public RollingFileAgentLog()
    {
        Directory.CreateDirectory(AgentPaths.Logs);
        _path = Path.Combine(AgentPaths.Logs, "agent.log");
    }

    public void Info(string eventName, object? data = null) => Write("info", eventName, null, data);
    public void Error(string eventName, Exception error, object? data = null) => Write("error", eventName, error, data);

    private void Write(string level, string eventName, Exception? error, object? data)
    {
        var entry = new
        {
            timestamp = DateTimeOffset.UtcNow,
            level,
            eventName,
            data,
            error = error is null ? null : new { type = error.GetType().Name, error.Message },
        };
        lock (_gate)
        {
            RollIfNeeded();
            File.AppendAllText(_path, JsonSerializer.Serialize(entry) + Environment.NewLine);
        }
    }

    private void RollIfNeeded()
    {
        if (!File.Exists(_path) || new FileInfo(_path).Length < MaximumBytes) return;
        var oldest = $"{_path}.{RetainedFiles}";
        if (File.Exists(oldest)) File.Delete(oldest);
        for (var index = RetainedFiles - 1; index >= 1; index--)
        {
            var source = $"{_path}.{index}";
            if (File.Exists(source)) File.Move(source, $"{_path}.{index + 1}", true);
        }
        File.Move(_path, $"{_path}.1", true);
    }
}
