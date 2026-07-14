using Dokladovka.Agent;

namespace Dokladovka.Agent.Configurator;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        if (args.Any(value => value.Equals("--diagnostics", StringComparison.OrdinalIgnoreCase)))
        {
            ShowDiagnostics();
            return;
        }
        Application.Run(new WizardForm(AgentDefaults.Load()));
    }

    private static void ShowDiagnostics()
    {
        try
        {
            var settings = AgentSettingsStore.Load();
            var secrets = SecretVault.Load();
            var companies = new AgentCycleRunner(settings, secrets, new RollingFileAgentLog())
                .ReadCompaniesAsync(CancellationToken.None).GetAwaiter().GetResult();
            var schemas = Directory.Exists(settings.SchemaDirectory)
                ? Directory.EnumerateFiles(settings.SchemaDirectory, "*.xsd").Count()
                : 0;
            MessageBox.Show(
                $"Konfigurácia: OK\nPOHODA mServer: {companies.Count}/{settings.MServers.Count}\nXSD schémy: {schemas}\nAgent: {AgentVersion.Current}",
                "Dokladovka Agent – Diagnostika",
                MessageBoxButtons.OK,
                companies.Count == settings.MServers.Count && schemas > 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"Diagnostika zlyhala.\nKód: DIAG-001\n{error.GetType().Name}: {error.Message}",
                "Dokladovka Agent – Diagnostika",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
