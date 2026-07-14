using System.Diagnostics;

namespace Dokladovka.Agent;

public static class PohodaProcessController
{
    private static readonly HashSet<string> AllowedActions = new(StringComparer.OrdinalIgnoreCase) { "start", "stop", "restart" };

    public static async Task<int> ExecuteAsync(MServerEndpointSettings endpoint, string action, CancellationToken cancellationToken)
    {
        if (!AllowedActions.Contains(action)) throw new ArgumentException("Povolené akcie sú start, stop a restart.", nameof(action));
        if (string.IsNullOrWhiteSpace(endpoint.PohodaExePath) || !File.Exists(endpoint.PohodaExePath))
            throw new InvalidOperationException($"Pre mServer {endpoint.Id} nie je nastavená platná cesta k pohoda.exe.");
        if (string.IsNullOrWhiteSpace(endpoint.InstanceName))
            throw new InvalidOperationException($"Pre mServer {endpoint.Id} nie je nastavený názov inštancie.");

        var start = new ProcessStartInfo(endpoint.PohodaExePath) { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("/http");
        start.ArgumentList.Add(action);
        start.ArgumentList.Add(endpoint.InstanceName);
        start.ArgumentList.Add("/f");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Nepodarilo sa spustiť pohoda.exe.");
        await process.WaitForExitAsync(cancellationToken);
        return process.ExitCode;
    }
}
