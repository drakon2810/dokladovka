using Dokladovka.Agent;

namespace Dokladovka.Agent.Configurator;

/// <summary>
/// Hlavné okno agenta: zoznam firiem z Dokladovky spárovaných s databázami POHODA.
/// Obnoviť znova prehľadá dátový priečinok, odošle heartbeat (backend spáruje firmy podľa IČO)
/// a načíta aktuálny zoznam organizácií – nová firma pridaná vo webe sa objaví hneď.
/// </summary>
public sealed class StatusForm : Form
{
    private readonly AgentDefaults _defaults;
    private readonly ListView _firms = new()
    {
        Dock = DockStyle.Fill,
        View = View.Details,
        FullRowSelect = true,
        HeaderStyle = ColumnHeaderStyle.Nonclickable,
    };
    private readonly Label _summary = new() { AutoSize = true, ForeColor = Color.DimGray, Padding = new Padding(0, 6, 0, 0) };
    private readonly Button _refresh = new() { Text = "Obnoviť", AutoSize = true };
    private readonly Button _settings = new() { Text = "Nastavenie…", AutoSize = true };
    private readonly Button _diagnostics = new() { Text = "Diagnostika", AutoSize = true };

    public StatusForm(AgentDefaults defaults)
    {
        _defaults = defaults;
        Text = "Dokladovka Agent";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(760, 480);
        ClientSize = new Size(820, 520);
        Font = new Font("Segoe UI", 9F);

        _firms.Columns.Add("Firma", 240);
        _firms.Columns.Add("IČO", 90);
        _firms.Columns.Add("Databáza POHODA", 220);
        _firms.Columns.Add("Rok", 60);
        _firms.Columns.Add("Stav", 170);

        var header = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(16, 12, 16, 0) };
        header.Controls.Add(new Label { Text = "Prepojené firmy", Font = new Font("Segoe UI", 12F, FontStyle.Bold), AutoSize = true });
        header.Controls.Add(_summary);

        var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(16, 8, 16, 8) };
        footer.Controls.Add(_refresh);
        footer.Controls.Add(_settings);
        footer.Controls.Add(_diagnostics);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 74));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        root.Controls.Add(header, 0, 0);
        root.Controls.Add(new Panel { Dock = DockStyle.Fill, Padding = new Padding(16, 4, 16, 4), Controls = { _firms } }, 0, 1);
        root.Controls.Add(footer, 0, 2);
        Controls.Add(root);

        _refresh.Click += async (_, _) => await RefreshAsync();
        _settings.Click += (_, _) => OpenWizard();
        _diagnostics.Click += (_, _) => Program.ShowDiagnostics();
        Shown += async (_, _) => await RefreshAsync();
    }

    private async Task RefreshAsync()
    {
        _refresh.Enabled = false;
        _summary.ForeColor = Color.DimGray;
        _summary.Text = "Načítavam firmy…";
        try
        {
            var settings = AgentSettingsStore.Load();
            var secrets = SecretVault.Load();
            var log = new RollingFileAgentLog();
            var runner = new AgentCycleRunner(settings, secrets, log);
            var backend = new BackendClient(settings.CloudBaseUrl, secrets.AgentToken, log);
            // Organizácie ako prvé: okno aj heartbeat pracujú len s firmami,
            // ktoré účtovník vedie v Dokladovke — cudzie databázy POHODY sa nehlásia.
            var organizations = await backend.GetOrganizationsAsync(CancellationToken.None);
            var live = AgentCycleRunner.FilterToKnownOrganizations(
                await runner.ReadCompaniesAsync(CancellationToken.None), organizations);
            // Heartbeat pred vykreslením: backend hneď spáruje nové firmy podľa IČO.
            await backend.SendHeartbeatAsync(
                live.Select(item => new HeartbeatCompany(item.Endpoint.CompanyIco, item.Company.DatabaseName, item.Company.Year)).ToArray(),
                CancellationToken.None);

            _firms.BeginUpdate();
            _firms.Items.Clear();
            foreach (var organization in organizations)
            {
                var match = AgentCycleRunner.MatchEndpoint(organization, live);
                var item = new ListViewItem([
                    organization.Nazov,
                    organization.Ico,
                    match?.Company.DatabaseName ?? "—",
                    match?.Company.Year ?? "—",
                    match is not null ? "Spárované" : "Databáza sa nenašla",
                ]);
                item.ForeColor = match is not null ? Color.DarkGreen : Color.DarkOrange;
                _firms.Items.Add(item);
            }
            // Databázy bez firmy v Dokladovke sa zámerne nezobrazujú — okno ukazuje
            // len firmy, ktoré účtovník v projekte vedie.
            _firms.EndUpdate();
            var paired = organizations.Count(organization => AgentCycleRunner.MatchEndpoint(organization, live) is not null);
            _summary.Text = $"Firmy v Dokladovke: {organizations.Count} · spárované: {paired} · databázy POHODA: {live.Count}"
                + $" · agent {AgentVersion.Current}";
        }
        catch (Exception error)
        {
            _firms.Items.Clear();
            _summary.ForeColor = Color.DarkRed;
            _summary.Text = error is InvalidOperationException ? error.Message : $"Obnovenie zlyhalo: {error.Message}";
        }
        finally
        {
            _refresh.Enabled = true;
        }
    }

    private void OpenWizard()
    {
        using var wizard = new WizardForm(_defaults);
        if (wizard.ShowDialog(this) == DialogResult.OK) _ = RefreshAsync();
    }
}
