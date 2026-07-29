using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Microsoft.Win32;

namespace Dokladovka.Agent;

/// <summary>Firma nájdená podľa databázy POHODA: StwPh_{IČO}_{rok}.mdb (Access) alebo StwPh_{IČO}_{rok} (SQL/E1).</summary>
public sealed record DiscoveredCompany(string Ico, string Database, string Year);

public static partial class PohodaDataDiscovery
{
    // Systémové databázy (StwPh.mdb, StwPhProfile.mdb, zálohy…) vzor zámerne nematchne.
    [GeneratedRegex(@"^StwPh_(\d{8})_(\d{4})\.mdb$", RegexOptions.IgnoreCase)]
    private static partial Regex CompanyDatabasePattern();

    // SQL/E1 variant: databáza sa volá ako súbor, len bez prípony.
    [GeneratedRegex(@"^StwPh_(\d{8})_(\d{4})$", RegexOptions.IgnoreCase)]
    private static partial Regex SqlDatabasePattern();

    /// <summary>Nájde všetky firemné databázy v dátovom priečinku POHODA. Chýbajúci priečinok vráti prázdny zoznam.</summary>
    public static IReadOnlyList<DiscoveredCompany> Scan(string dataDirectory)
    {
        if (string.IsNullOrWhiteSpace(dataDirectory) || !Directory.Exists(dataDirectory)) return [];
        var result = new List<DiscoveredCompany>();
        foreach (var path in Directory.EnumerateFiles(dataDirectory, "StwPh_*.mdb"))
        {
            var fileName = Path.GetFileName(path);
            var match = CompanyDatabasePattern().Match(fileName);
            if (match.Success) result.Add(new DiscoveredCompany(match.Groups[1].Value, fileName, match.Groups[2].Value));
        }
        return result
            .OrderBy(company => company.Ico, StringComparer.Ordinal)
            .ThenByDescending(company => company.Year, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// Nájde všetky firemné databázy na SQL Serveri POHODY (varianty SQL/E1) — rovnako ako Doklado
    /// číta sys.databases namiesto súborov. INI parameter database= berie pri SQL variante názov databázy.
    /// </summary>
    public static async Task<IReadOnlyList<DiscoveredCompany>> ScanSqlAsync(
        string host, int port, string userName, string password, CancellationToken cancellationToken)
    {
        var builder = new SqlConnectionStringBuilder
        {
            DataSource = $"{host},{port}",
            UserID = userName,
            Password = password,
            InitialCatalog = "master",
            // POHODA SQL beží v LAN spravidla bez dôveryhodného certifikátu.
            TrustServerCertificate = true,
            ConnectTimeout = 15,
        };
        var result = new List<DiscoveredCompany>();
        await using var connection = new SqlConnection(builder.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = new SqlCommand("SELECT name FROM sys.databases WHERE name LIKE 'StwPh[_]%'", connection);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var company = ParseSqlDatabaseName(reader.GetString(0));
            if (company is not null) result.Add(company);
        }
        return result
            .OrderBy(company => company.Ico, StringComparer.Ordinal)
            .ThenByDescending(company => company.Year, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>StwPh_{IČO}_{rok} → firma; systémové databázy (StwPh, StwPhProfile…) vráti null.</summary>
    public static DiscoveredCompany? ParseSqlDatabaseName(string name)
    {
        var match = SqlDatabasePattern().Match(name.Trim());
        return match.Success ? new DiscoveredCompany(match.Groups[1].Value, name.Trim(), match.Groups[2].Value) : null;
    }

    /// <summary>Skúsi nájsť dátový priečinok POHODA – preferuje kandidáta, ktorý už obsahuje firemné databázy.</summary>
    public static string? FindDataDirectory(string? pohodaExePath)
    {
        var candidates = new List<string>();
        var exeDirectory = string.IsNullOrWhiteSpace(pohodaExePath) ? null : Path.GetDirectoryName(pohodaExePath);
        if (!string.IsNullOrEmpty(exeDirectory)) candidates.Add(Path.Combine(exeDirectory, "Data"));
        var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        candidates.Add(Path.Combine(programData, "STORMWARE", "POHODA", "Data"));
        candidates.Add(Path.Combine(programData, "STORMWARE", "POHODA SK", "Data"));
        return candidates.FirstOrDefault(candidate => Scan(candidate).Count > 0)
            ?? candidates.FirstOrDefault(Directory.Exists);
    }
}

public static class PohodaDiscovery
{
    public static string? FindExecutable()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "STORMWARE", "POHODA", "Pohoda.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "STORMWARE", "POHODA", "Pohoda.exe"),
        };
        var known = candidates.FirstOrDefault(File.Exists);
        if (known is not null) return known;
        if (!OperatingSystem.IsWindows()) return null;
        foreach (var registryPath in new[]
        {
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        })
        {
            using var root = Registry.LocalMachine.OpenSubKey(registryPath);
            if (root is null) continue;
            foreach (var name in root.GetSubKeyNames())
            {
                using var item = root.OpenSubKey(name);
                var displayName = item?.GetValue("DisplayName") as string;
                if (displayName?.Contains("POHODA", StringComparison.OrdinalIgnoreCase) != true) continue;
                var location = item?.GetValue("InstallLocation") as string;
                if (string.IsNullOrWhiteSpace(location)) continue;
                var path = Path.Combine(location, "Pohoda.exe");
                if (File.Exists(path)) return path;
            }
        }
        return null;
    }
}
