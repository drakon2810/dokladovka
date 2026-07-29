using System.Diagnostics;
using System.Net;
using Dokladovka.Agent;

namespace Dokladovka.Agent.Configurator;

public sealed class WizardForm : Form
{
    private readonly AgentDefaults _defaults;
    private readonly TabControl _pages = new() { Dock = DockStyle.Fill, Appearance = TabAppearance.FlatButtons, ItemSize = new Size(0, 1), SizeMode = TabSizeMode.Fixed };
    private readonly Button _back = new() { Text = "Späť", AutoSize = true };
    private readonly Button _next = new() { Text = "Pokračovať", AutoSize = true };
    private readonly TextBox _cloud = new() { Dock = DockStyle.Top };
    private readonly TextBox _pairing = new() { Dock = DockStyle.Top, CharacterCasing = CharacterCasing.Upper };
    private readonly RadioButton _modeMServer = new() { Text = "POHODA mServer (HTTP, beží trvalo)", AutoSize = true };
    private readonly RadioButton _modeCli = new() { Text = "Priamy XML import (pohoda.exe /XML, bez mServera) – všetky firmy automaticky", AutoSize = true, Checked = true };
    private readonly TextBox _mServer = new() { Dock = DockStyle.Top };
    private readonly RadioButton _typeMdb = new() { Text = "POHODA MDB (databázy sú súbory StwPh_*.mdb v dátovom priečinku)", AutoSize = true, Checked = true };
    private readonly RadioButton _typeSql = new() { Text = "POHODA SQL / E1 (databázy sú na Microsoft SQL Serveri)", AutoSize = true };
    private readonly TextBox _dataDirectory = new() { Dock = DockStyle.Top };
    private readonly TextBox _sqlHost = new() { Dock = DockStyle.Top };
    private readonly TextBox _sqlPort = new() { Dock = DockStyle.Top, Text = "1433" };
    private readonly TextBox _sqlUser = new() { Dock = DockStyle.Top, Text = "sa" };
    private readonly TextBox _sqlPassword = new() { Dock = DockStyle.Top, UseSystemPasswordChar = true };
    private readonly TextBox _pohodaExe = new() { Dock = DockStyle.Top };
    private readonly TextBox _user = new() { Dock = DockStyle.Top };
    private readonly TextBox _password = new() { Dock = DockStyle.Top, UseSystemPasswordChar = true };
    private readonly TextBox _ico = new() { Dock = DockStyle.Top, MaxLength = 8 };
    private readonly TextBox _instance = new() { Dock = DockStyle.Top };
    private readonly Label _discovery = new() { AutoSize = true, MaximumSize = new Size(660, 0), ForeColor = Color.DimGray };
    private readonly Label _companySummary = new() { AutoSize = true, MaximumSize = new Size(660, 0) };
    private readonly Label _testResult = new() { AutoSize = true, MaximumSize = new Size(660, 0), ForeColor = Color.DimGray };
    private readonly Button _test = new() { Text = "Skontrolovať a pripojiť", AutoSize = true };
    private readonly Button _copyDiagnostics = new() { Text = "Kopírovať diagnostiku", AutoSize = true, Enabled = false };
    private bool _configured;
    private string _diagnostics = string.Empty;

    public WizardForm(AgentDefaults defaults)
    {
        _defaults = defaults;
        Text = "Dokladovka Agent – Nastavenie";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(760, 600);
        ClientSize = new Size(760, 600);
        Font = new Font("Segoe UI", 9F);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        _cloud.Text = defaults.CloudBaseUrl;
        _mServer.Text = defaults.MServerUrl;
        _pages.TabPages.Add(BuildWelcomePage());
        _pages.TabPages.Add(BuildCloudPage());
        _pages.TabPages.Add(BuildDiscoveryPage());
        _pages.TabPages.Add(BuildCredentialsPage());
        _pages.TabPages.Add(BuildCompanyPage());
        _pages.TabPages.Add(BuildTestPage());
        _pages.TabPages.Add(BuildFinishPage());

        var footer = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Padding = new Padding(16, 10, 16, 10) };
        footer.Controls.Add(_next);
        footer.Controls.Add(_back);
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 68));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        root.Controls.Add(new Label { Text = "Dokladovka Mostík", Font = new Font(Font, FontStyle.Bold), AutoSize = true, Padding = new Padding(20, 22, 0, 0) }, 0, 0);
        root.Controls.Add(_pages, 0, 1);
        root.Controls.Add(footer, 0, 2);
        Controls.Add(root);

        _back.Click += (_, _) => MoveStep(-1);
        _next.Click += (_, _) => MoveStep(1);
        _pages.SelectedIndexChanged += (_, _) => UpdateNavigation();
        _test.Click += async (_, _) => await ConfigureAsync();
        _copyDiagnostics.Click += (_, _) => Clipboard.SetText(_diagnostics);
        UpdateNavigation();
    }

    private TabPage BuildWelcomePage() => Page(
        "Vitajte",
        "Dokladovka Agent bezpečne prepája cloudovú Dokladovku s POHODA mServer na tomto počítači. Agent používa iba odchádzajúce spojenie cez HTTPS. POHODA ani mServer nie sú súčasťou inštalátora.");

    private TabPage BuildCloudPage()
    {
        var page = Page("Pripojenie ku cloudu", "URL je v produkčnom inštalátore predvyplnená. Párovací kód získate v Dokladovke v Nastavenia → Mostík.");
        AddField(page, "URL Dokladovka", _cloud);
        AddField(page, "Párovací kód", _pairing);
        return page;
    }

    private TabPage BuildDiscoveryPage()
    {
        var page = Page("Vyhľadanie POHODA", "Sprievodca skúsi nájsť nainštalovanú POHODU. Vyberte spôsob prepojenia: mServer beží trvalo ako služba, priamy XML import spúšťa POHODU iba počas prenosu.");
        var panel = (FlowLayoutPanel)page.Controls[0];
        panel.Controls.Add(_modeMServer);
        panel.Controls.Add(_modeCli);
        var detect = new Button { Text = "Vyhľadať POHODU", AutoSize = true, Margin = new Padding(3, 12, 3, 3) };
        detect.Click += (_, _) => DiscoverPohoda();
        panel.Controls.Add(detect);
        panel.Controls.Add(_discovery);
        AddField(page, "Adresa POHODA mServer (iba pre režim mServer)", _mServer);
        AddField(page, "Cesta k pohoda.exe (povinná pre priamy import)", _pohodaExe);
        panel.Controls.Add(new Label { Text = "Typ POHODY (pre priamy import)", AutoSize = true, Margin = new Padding(3, 14, 3, 3), Font = new Font(Font, FontStyle.Bold) });
        panel.Controls.Add(_typeMdb);
        panel.Controls.Add(_typeSql);
        AddField(page, "Dátový priečinok POHODA s StwPh_*.mdb (typ MDB)", _dataDirectory);
        var browse = new Button { Text = "Prehľadávať…", AutoSize = true };
        browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { Description = "Vyberte dátový priečinok POHODA (obsahuje StwPh_*.mdb)" };
            if (Directory.Exists(_dataDirectory.Text)) dialog.SelectedPath = _dataDirectory.Text;
            if (dialog.ShowDialog(this) == DialogResult.OK) _dataDirectory.Text = dialog.SelectedPath;
        };
        panel.Controls.Add(browse);
        AddField(page, "SQL Server – adresa alebo IP (typ SQL/E1)", _sqlHost);
        AddField(page, "SQL Server – port", _sqlPort);
        AddField(page, "SQL Server – používateľ (sysadmin, napr. sa)", _sqlUser);
        AddField(page, "SQL Server – heslo", _sqlPassword);
        return page;
    }

    private TabPage BuildCredentialsPage()
    {
        var page = Page("Prihlásenie do POHODY", "Údaje zostanú iba na tomto počítači a heslo sa uloží cez Windows DPAPI LocalMachine. Pri priamom importe zadajte používateľa POHODA s právom Dátová komunikácia pre všetky firmy.");
        AddField(page, "Používateľ POHODA", _user);
        AddField(page, "Heslo POHODA", _password);
        AddField(page, "IČO firmy (pri priamom importe voliteľné – firmy sa nájdu automaticky)", _ico);
        AddField(page, "Názov inštancie (voliteľné)", _instance);
        return page;
    }

    private TabPage BuildCompanyPage()
    {
        var page = Page("Výber firmy", "Pri priamom importe sa všetky firmy z dátového priečinka spárujú s Dokladovkou automaticky podľa IČO. Pri režime mServer sa IČO musí zhodovať s vybranou organizáciou.");
        page.Controls.Add(_companySummary);
        return page;
    }

    private TabPage BuildTestPage()
    {
        var page = Page("Test spojenia", "Overí sa POHODA, prihlásenie, firma, účtovný rok, cloud, párovanie a dostupnosť XSD schém. Pri priamom XML importe sa POHODA spustí na pozadí a test môže trvať aj minútu.");
        page.Controls.Add(_test);
        page.Controls.Add(_testResult);
        page.Controls.Add(_copyDiagnostics);
        return page;
    }

    private TabPage BuildFinishPage() => Page(
        "Dokončenie",
        "Mostík bol úspešne nakonfigurovaný. Inštalátor teraz zaregistruje a spustí službu DokladovkaService. Stav sa do niekoľkých sekúnd zobrazí vo webovej aplikácii.");

    private static TabPage Page(string title, string description)
    {
        var page = new TabPage { Padding = new Padding(28), AutoScroll = true };
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true };
        panel.Controls.Add(new Label { Text = title, Font = new Font("Segoe UI", 14F, FontStyle.Bold), AutoSize = true });
        panel.Controls.Add(new Label { Text = description, AutoSize = true, MaximumSize = new Size(660, 0), ForeColor = Color.DimGray, Margin = new Padding(3, 8, 3, 18) });
        page.Controls.Add(panel);
        return page;
    }

    private static void AddField(TabPage page, string label, TextBox input)
    {
        var panel = (FlowLayoutPanel)page.Controls[0];
        panel.Controls.Add(new Label { Text = label, AutoSize = true, Margin = new Padding(3, 8, 3, 3) });
        input.Width = 640;
        panel.Controls.Add(input);
    }

    private void MoveStep(int direction)
    {
        if (direction > 0 && !ValidateCurrentPage()) return;
        if (_pages.SelectedIndex == _pages.TabCount - 1 && direction > 0)
        {
            TryStartExistingService();
            DialogResult = DialogResult.OK;
            Close();
            return;
        }
        _pages.SelectedIndex = Math.Clamp(_pages.SelectedIndex + direction, 0, _pages.TabCount - 1);
    }

    private bool ValidateCurrentPage()
    {
        string? error = _pages.SelectedIndex switch
        {
            1 when !Uri.TryCreate(_cloud.Text.Trim(), UriKind.Absolute, out _) => "Zadajte platnú URL Dokladovka.",
            1 when string.IsNullOrWhiteSpace(_pairing.Text) => "Zadajte párovací kód.",
            2 when !_modeCli.Checked && !Uri.TryCreate(_mServer.Text.Trim(), UriKind.Absolute, out _) => "Zadajte platnú adresu mServera.",
            2 when _modeCli.Checked && string.IsNullOrWhiteSpace(_pohodaExe.Text) => "Zadajte cestu k pohoda.exe.",
            2 when _modeCli.Checked && _typeMdb.Checked && string.IsNullOrWhiteSpace(_dataDirectory.Text) => "Zadajte dátový priečinok POHODA (obsahuje StwPh_*.mdb).",
            2 when _modeCli.Checked && _typeMdb.Checked && PohodaDataDiscovery.Scan(_dataDirectory.Text.Trim()).Count == 0 =>
                "V zadanom priečinku sa nenašla žiadna databáza firmy StwPh_ICO_ROK.mdb.",
            2 when _modeCli.Checked && _typeSql.Checked && string.IsNullOrWhiteSpace(_sqlHost.Text) => "Zadajte adresu SQL Servera POHODY.",
            2 when _modeCli.Checked && _typeSql.Checked && !SqlPortValid() => "Port SQL Servera musí byť číslo 1–65535.",
            2 when _modeCli.Checked && _typeSql.Checked && string.IsNullOrWhiteSpace(_sqlUser.Text) => "Zadajte SQL používateľa (napr. sa).",
            2 when _modeCli.Checked && _typeSql.Checked && string.IsNullOrEmpty(_sqlPassword.Text) => "Zadajte heslo SQL používateľa.",
            3 when string.IsNullOrWhiteSpace(_user.Text) => "Zadajte používateľa POHODA.",
            3 when string.IsNullOrEmpty(_password.Text) => "Zadajte heslo POHODA.",
            3 when !IcoValid() => "IČO musí mať presne 8 číslic.",
            5 when !_configured => "Najprv úspešne vykonajte kontrolu spojenia.",
            _ => null,
        };
        if (error is null)
        {
            if (_pages.SelectedIndex == 3)
            {
                if (_modeCli.Checked && _typeSql.Checked)
                {
                    _companySummary.Text = $"SQL Server: {_sqlHost.Text.Trim()}:{_sqlPort.Text.Trim()}\n"
                        + "Firmy sa načítajú zo sys.databases pri teste spojenia a spárujú sa s Dokladovkou automaticky podľa IČO.";
                }
                else if (_modeCli.Checked)
                {
                    var companies = PohodaDataDiscovery.Scan(_dataDirectory.Text.Trim());
                    _companySummary.Text = $"Nájdené firmy ({companies.Count}):\n" + string.Join(
                        "\n",
                        companies.Take(20).Select(company => $"• IČO {company.Ico}, rok {company.Year} ({company.Database})"))
                        + (companies.Count > 20 ? $"\n… a ďalších {companies.Count - 20}" : string.Empty);
                }
                else
                {
                    _companySummary.Text = $"Firma s IČO: {_ico.Text.Trim()}\nAdresa mServera: {_mServer.Text.Trim()}";
                }
            }
            return true;
        }
        MessageBox.Show(error, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return false;
    }

    private async Task ConfigureAsync()
    {
        _test.Enabled = false;
        _testResult.ForeColor = Color.DimGray;
        _testResult.Text = "Prebieha kontrola spojenia…";
        _copyDiagnostics.Enabled = false;
        try
        {
            var result = await AgentConfiguration.ConfigureAsync(new AgentConfigurationRequest
            {
                CloudBaseUrl = _cloud.Text.Trim(),
                PairingCode = _pairing.Text.Trim(),
                MServerUrl = NullIfBlank(_mServer.Text),
                CompanyIco = NullIfBlank(_ico.Text),
                UserName = _user.Text.Trim(),
                Password = _password.Text,
                InstanceName = NullIfBlank(_instance.Text),
                PohodaExePath = NullIfBlank(_pohodaExe.Text),
                Mode = _modeCli.Checked ? "cli" : "mserver",
                DataDirectory = _modeCli.Checked && _typeMdb.Checked ? NullIfBlank(_dataDirectory.Text) : null,
                SqlHost = _modeCli.Checked && _typeSql.Checked ? NullIfBlank(_sqlHost.Text) : null,
                SqlPort = _modeCli.Checked && _typeSql.Checked && int.TryParse(_sqlPort.Text.Trim(), out var sqlPort) ? sqlPort : null,
                SqlUserName = _modeCli.Checked && _typeSql.Checked ? NullIfBlank(_sqlUser.Text) : null,
                SqlPassword = _modeCli.Checked && _typeSql.Checked ? _sqlPassword.Text : null,
                EndpointId = _modeCli.Checked ? "pohoda-1" : "mserver-1",
                AllowedPublisherThumbprint = _defaults.PublisherThumbprint,
            }, new RollingFileAgentLog(), CancellationToken.None);
            _configured = true;
            _testResult.ForeColor = Color.DarkGreen;
            _testResult.Text = $"Spojenie je v poriadku.\nPOHODA: {result.Company.Company}\nDatabáza: {result.Company.DatabaseName}\nÚčtovný rok: {result.Company.Year}\nNájdené firmy: {result.Discovered.Count}\nHeartbeat: odoslaný";
            _diagnostics = $"Kód: OK\r\nAgent: {AgentVersion.Current}\r\nPOHODA: dostupná\r\nRok: {result.Company.Year}\r\nFirmy: {result.Discovered.Count}";
            _copyDiagnostics.Enabled = true;
            _next.Enabled = true;
        }
        catch (Exception error)
        {
            _configured = false;
            var code = ErrorCode(error);
            var safeMessage = Redact(error.Message);
            _testResult.ForeColor = Color.DarkRed;
            _testResult.Text = $"Spojenie sa nepodarilo. {FriendlyMessage(error)}\nTechnický kód: {code}";
            _diagnostics = $"Kód: {code}\r\nTyp: {error.GetType().Name}\r\nSpráva: {safeMessage}\r\nAgent: {AgentVersion.Current}";
            _copyDiagnostics.Enabled = true;
        }
        finally
        {
            _test.Enabled = true;
        }
    }

    private void DiscoverPohoda()
    {
        var path = PohodaDiscovery.FindExecutable();
        if (path is null)
        {
            _discovery.Text = "POHODA nebola automaticky nájdená. Skontrolujte adresu mServera a pokračujte ručne.";
            _discovery.ForeColor = Color.DarkOrange;
            return;
        }
        _pohodaExe.Text = path;
        var dataDirectory = PohodaDataDiscovery.FindDataDirectory(path);
        if (dataDirectory is not null) _dataDirectory.Text = dataDirectory;
        IReadOnlyList<DiscoveredCompany> companies = dataDirectory is null ? [] : PohodaDataDiscovery.Scan(dataDirectory);
        _discovery.Text = $"POHODA bola nájdená: {path}"
            + (dataDirectory is null
                ? "\nDátový priečinok sa nepodarilo určiť – vyberte ho ručne."
                : $"\nDátový priečinok: {dataDirectory} (firiem: {companies.Count})");
        _discovery.ForeColor = Color.DarkGreen;
    }

    private bool IcoValid()
    {
        var ico = _ico.Text.Trim();
        if (_modeCli.Checked && ico.Length == 0) return true;
        return System.Text.RegularExpressions.Regex.IsMatch(ico, "^[0-9]{8}$");
    }

    private bool SqlPortValid() => int.TryParse(_sqlPort.Text.Trim(), out var port) && port is >= 1 and <= 65535;

    private void UpdateNavigation()
    {
        _back.Enabled = _pages.SelectedIndex > 0;
        _next.Text = _pages.SelectedIndex == _pages.TabCount - 1 ? "Dokončiť" : "Pokračovať";
        _next.Enabled = _pages.SelectedIndex != 5 || _configured;
    }

    private static void TryStartExistingService()
    {
        var sc = Path.Combine(Environment.SystemDirectory, "sc.exe");
        using var query = Process.Start(new ProcessStartInfo(sc, "query DokladovkaService") { UseShellExecute = false, CreateNoWindow = true });
        query?.WaitForExit(5_000);
        if (query?.ExitCode != 0) return;
        using var start = Process.Start(new ProcessStartInfo(sc, "start DokladovkaService") { UseShellExecute = false, CreateNoWindow = true });
        start?.WaitForExit(10_000);
    }

    private static string? NullIfBlank(string value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string ErrorCode(Exception error) => error switch
    {
        BackendApiException { StatusCode: HttpStatusCode.Gone } => "PAIR-EXPIRED",
        BackendApiException { StatusCode: HttpStatusCode.Conflict } => "PAIR-CONFLICT",
        BackendApiException { StatusCode: HttpStatusCode.Unauthorized } => "CLOUD-AUTH",
        MServerException { StatusCode: HttpStatusCode.Unauthorized } => "MSERVER-AUTH",
        MServerException => "MSERVER-HTTP",
        HttpRequestException => "NETWORK-UNREACHABLE",
        PlatformNotSupportedException => "WINDOWS-UNSUPPORTED",
        UnauthorizedAccessException => "WINDOWS-ADMIN",
        _ => "CONFIG-FAILED",
    };

    private static string FriendlyMessage(Exception error) => error switch
    {
        BackendApiException { StatusCode: HttpStatusCode.Gone } => "Párovací kód expiroval. Vygenerujte nový kód vo webovej aplikácii.",
        BackendApiException { StatusCode: HttpStatusCode.Conflict } => error.Message,
        MServerException { StatusCode: HttpStatusCode.Unauthorized } => "Meno alebo heslo mServer nie je správne, prípadne chýba právo Dátová komunikácia.",
        MServerException => "POHODA mServer vrátil chybu. Skontrolujte, či je spustený.",
        HttpRequestException => "Cloud alebo mServer nie je dostupný. Skontrolujte internet, adresu a firewall.",
        UnauthorizedAccessException => "Chýbajú administrátorské práva na uloženie konfigurácie.",
        _ => error.Message,
    };

    private string Redact(string value)
    {
        foreach (var secret in new[] { _password.Text, _pairing.Text, _user.Text, _sqlPassword.Text })
            if (!string.IsNullOrEmpty(secret)) value = value.Replace(secret, "***", StringComparison.OrdinalIgnoreCase);
        return value;
    }
}
