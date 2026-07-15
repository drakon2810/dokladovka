using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Dokladovka.Agent;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        try
        {
            if (args.FirstOrDefault()?.Equals("configure", StringComparison.OrdinalIgnoreCase) == true)
                return await ConfigureAsync(args.Skip(1).ToArray(), CancellationToken.None);
            if (args.FirstOrDefault()?.Equals("diagnose", StringComparison.OrdinalIgnoreCase) == true)
                return await DiagnoseAsync(CancellationToken.None);
            if (args.FirstOrDefault()?.Equals("run-once", StringComparison.OrdinalIgnoreCase) == true)
                return await RunOnceAsync(CancellationToken.None);
            if (args.FirstOrDefault()?.Equals("pohoda", StringComparison.OrdinalIgnoreCase) == true)
                return await ControlPohodaAsync(args.Skip(1).ToArray(), CancellationToken.None);
            if (args.FirstOrDefault() is "--help" or "-h" or "help")
            {
                PrintUsage();
                return 0;
            }

            var builder = Host.CreateApplicationBuilder(args);
            builder.Services.AddWindowsService(options => options.ServiceName = "DokladovkaService");
            builder.Services.AddSingleton<IAgentLog, RollingFileAgentLog>();
            builder.Services.AddHostedService<AgentWorker>();
            await builder.Build().RunAsync();
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Chyba: {error.Message}");
            return 1;
        }
    }

    private static async Task<int> ConfigureAsync(string[] args, CancellationToken cancellationToken)
    {
        var cloud = Option(args, "--cloud") ?? Prompt("URL cloudu", "https://app.example.sk");
        var pairingCode = Option(args, "--pairing-code") ?? Prompt("Párovací kód");
        var mServerUrl = Option(args, "--mserver-url") ?? Prompt("URL POHODA mServer", "http://localhost:444");
        var ico = Option(args, "--ico") ?? Prompt("IČO firmy v otvorenej databáze POHODA");
        var user = Option(args, "--mserver-user") ?? Prompt("Používateľ mServer");
        var password = Environment.GetEnvironmentVariable("DOKLADOVKA_MSERVER_PASSWORD") ?? ReadPassword("Heslo mServer");
        var endpointId = Option(args, "--endpoint-id") ?? "mserver-1";
        var endpoint = new MServerEndpointSettings
        {
            Id = endpointId,
            BaseUrl = mServerUrl,
            CompanyIco = ico,
            InstanceName = Option(args, "--instance"),
            PohodaExePath = Option(args, "--pohoda-exe"),
        };
        var settings = new AgentSettings
        {
            CloudBaseUrl = cloud,
            InstallationName = Option(args, "--name") ?? Environment.MachineName,
            MServers = [endpoint],
            AllowedPublisherThumbprint = Option(args, "--publisher-thumbprint"),
        };
        AgentSettings.Validate(settings);
        var mServerSecret = new MServerSecret { EndpointId = endpointId, UserName = user, Password = password };
        var log = new RollingFileAgentLog();
        var company = await new MServerClient(endpoint, mServerSecret, log).GetCompanyAsync(cancellationToken);
        Console.WriteLine($"mServer je dostupný: {company.Company}, databáza {company.DatabaseName}, rok {company.Year}.");
        var paired = await BackendClient.PairAsync(cloud, pairingCode, Environment.MachineName, AgentVersion.Current, cancellationToken);
        AgentSettingsStore.Save(settings);
        SecretVault.Save(new AgentSecrets { AgentToken = paired.AgentToken, MServers = [mServerSecret] });
        Console.WriteLine($"Agent bol úspešne nakonfigurovaný. Konfigurácia: {AgentPaths.Settings}");
        return 0;
    }

    private static async Task<int> DiagnoseAsync(CancellationToken cancellationToken)
    {
        var settings = AgentSettingsStore.Load();
        var secrets = SecretVault.Load();
        var runner = new AgentCycleRunner(settings, secrets, new RollingFileAgentLog());
        var companies = await runner.ReadCompaniesAsync(cancellationToken);
        foreach (var item in companies)
            Console.WriteLine($"{item.Endpoint.Id}: OK, {item.Company.DatabaseName}, rok {item.Company.Year}, obdobie {item.Company.Period}");
        Console.WriteLine($"Dostupných mServerov: {companies.Count}/{settings.MServers.Count}");
        return companies.Count == settings.MServers.Count ? 0 : 2;
    }

    private static async Task<int> RunOnceAsync(CancellationToken cancellationToken)
    {
        var settings = AgentSettingsStore.Load();
        await new AgentCycleRunner(settings, SecretVault.Load(), new RollingFileAgentLog()).RunOnceAsync(cancellationToken);
        return 0;
    }

    private static async Task<int> ControlPohodaAsync(string[] args, CancellationToken cancellationToken)
    {
        var action = args.FirstOrDefault() ?? throw new ArgumentException("Chýba akcia start, stop alebo restart.");
        var settings = AgentSettingsStore.Load();
        var endpointId = Option(args, "--endpoint") ?? settings.MServers[0].Id;
        var endpoint = settings.MServers.FirstOrDefault(item => item.Id.Equals(endpointId, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException($"mServer {endpointId} neexistuje v konfigurácii.");
        var exitCode = await PohodaProcessController.ExecuteAsync(endpoint, action, cancellationToken);
        Console.WriteLine($"POHODA /http {action} skončila s kódom {exitCode}.");
        return exitCode;
    }

    private static string? Option(string[] args, string name)
    {
        var index = Array.FindIndex(args, value => value.Equals(name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static string Prompt(string label, string? defaultValue = null)
    {
        Console.Write(defaultValue is null ? $"{label}: " : $"{label} [{defaultValue}]: ");
        var value = Console.ReadLine()?.Trim();
        return string.IsNullOrWhiteSpace(value) ? defaultValue ?? throw new InvalidOperationException($"{label} je povinné.") : value;
    }

    private static string ReadPassword(string label)
    {
        if (Console.IsInputRedirected) throw new InvalidOperationException("Heslo mServer nastavte interaktívne alebo cez DOKLADOVKA_MSERVER_PASSWORD.");
        Console.Write($"{label}: ");
        var result = new StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter) break;
            if (key.Key == ConsoleKey.Backspace && result.Length > 0) result.Length--;
            else if (!char.IsControl(key.KeyChar)) result.Append(key.KeyChar);
        }
        Console.WriteLine();
        if (result.Length == 0) throw new InvalidOperationException("Heslo mServer je povinné.");
        return result.ToString();
    }

    private static void PrintUsage() => Console.WriteLine("""
        Dokladovka.Agent
          configure [--cloud URL] [--pairing-code CODE] [--mserver-url URL] [--ico ICO]
                    [--mserver-user USER] [--instance NAME] [--pohoda-exe PATH]
          diagnose
          run-once
          pohoda start|stop|restart [--endpoint ID]
        """);
}
