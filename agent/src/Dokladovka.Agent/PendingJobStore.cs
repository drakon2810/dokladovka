using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Dokladovka.Agent;

public sealed record PendingExport(string OrganizationId, string EndpointId, AgentExportJob Job, DateTimeOffset ClaimedAt);

public sealed class PendingJobStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Dokladovka.Agent.Pending.v1");

    public PendingJobStore() => Directory.CreateDirectory(AgentPaths.Pending);

    public IReadOnlyList<PendingExport> LoadAll()
    {
        var result = new List<PendingExport>();
        foreach (var path in Directory.EnumerateFiles(AgentPaths.Pending, "*.bin"))
        {
            byte[]? clear = null;
            try
            {
                clear = ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.LocalMachine);
                var pending = JsonSerializer.Deserialize<PendingExport>(clear, JsonOptions);
                if (pending is not null) result.Add(pending);
            }
            catch (Exception error) when (error is JsonException or CryptographicException)
            {
                File.Move(path, path + ".invalid", true);
            }
            finally
            {
                if (clear is not null) CryptographicOperations.ZeroMemory(clear);
            }
        }
        return result.OrderBy(item => item.ClaimedAt).ToArray();
    }

    public void Save(PendingExport pending)
    {
        var destination = PathFor(pending.Job.ExportJobId);
        var temporary = destination + ".tmp";
        var clear = JsonSerializer.SerializeToUtf8Bytes(pending, JsonOptions);
        try
        {
            File.WriteAllBytes(temporary, ProtectedData.Protect(clear, Entropy, DataProtectionScope.LocalMachine));
            File.Move(temporary, destination, true);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(clear);
        }
    }

    public void Delete(string exportJobId)
    {
        var path = PathFor(exportJobId);
        if (File.Exists(path)) File.Delete(path);
    }

    private static string PathFor(string exportJobId) => Path.Combine(AgentPaths.Pending, $"{exportJobId}.bin");
}
