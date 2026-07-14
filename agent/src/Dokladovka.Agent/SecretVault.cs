using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Dokladovka.Agent;

public static class SecretVault
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Dokladovka.Agent.Secrets.v1");

    public static void Save(AgentSecrets secrets)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("DPAPI je dostupné iba na Windows.");
        Directory.CreateDirectory(AgentPaths.Root);
        var clear = JsonSerializer.SerializeToUtf8Bytes(secrets, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        try
        {
            var encrypted = ProtectedData.Protect(clear, Entropy, DataProtectionScope.LocalMachine);
            var temporary = AgentPaths.Secrets + ".tmp";
            File.WriteAllBytes(temporary, encrypted);
            File.Move(temporary, AgentPaths.Secrets, true);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(clear);
        }
    }

    public static void VerifyAvailable()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("DPAPI je dostupné iba na Windows.");
        var clear = Encoding.UTF8.GetBytes("Dokladovka.Agent.DPAPI.Test");
        byte[]? encrypted = null;
        try
        {
            encrypted = ProtectedData.Protect(clear, Entropy, DataProtectionScope.LocalMachine);
            var roundTrip = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.LocalMachine);
            try
            {
                if (!CryptographicOperations.FixedTimeEquals(clear, roundTrip))
                    throw new CryptographicException("DPAPI kontrola zlyhala.");
            }
            finally { CryptographicOperations.ZeroMemory(roundTrip); }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(clear);
            if (encrypted is not null) CryptographicOperations.ZeroMemory(encrypted);
        }
    }

    public static AgentSecrets Load()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("DPAPI je dostupné iba na Windows.");
        if (!File.Exists(AgentPaths.Secrets)) throw new InvalidOperationException("Chýbajú bezpečne uložené prihlasovacie údaje agenta.");
        var encrypted = File.ReadAllBytes(AgentPaths.Secrets);
        var clear = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.LocalMachine);
        try
        {
            return JsonSerializer.Deserialize<AgentSecrets>(clear, new JsonSerializerOptions(JsonSerializerDefaults.Web))
                ?? throw new InvalidOperationException("Uložené prihlasovacie údaje sú poškodené.");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(clear);
        }
    }
}
