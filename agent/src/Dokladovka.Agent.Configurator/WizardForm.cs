using System.Diagnostics;
using System.Net;
using Microsoft.Win32;
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
    private readonly TextBox _mServer = new() { Dock = DockStyle.Top };
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
        var page = Page("Vyhľadanie POHODA", "Sprievodca skúsi nájsť nainštalovanú POHODU. Adresu mServera môžete vždy zadať ručne.");
        var detect = new Button { Text = "Vyhľadať POHODU", AutoSize = true };
        detect.Click += (_, _) => DiscoverPohoda();
        page.Controls.Add(detect);
        page.Controls.Add(_discovery);
        AddField(page, "Adresa POHODA mServer", _mServer);
        AddField(page, "Cesta k pohoda.exe (voliteľné)", _pohodaExe);
        return page;
    }

    private TabPage BuildCredentialsPage()
    {
        var page = Page("Prihlásenie do mServer", "Údaje zostanú iba na tomto počítači a heslo sa uloží cez Windows DPAPI LocalMachine.");
        AddField(page, "Používateľ mServer", _user);
        AddField(page, "Heslo mServer", _password);
        AddField(page, "IČO firmy", _ico);
        AddField(page, "Názov inštancie (voliteľné)", _instance);
        return page;
    }

    private TabPage BuildCompanyPage()
    {
        var page = Page("Výber firmy", "IČO sa musí zhodovať s organizáciou vybranou pri vytvorení párovacieho kódu. Pri nezhode backend spojenie bezpečne odmietne.");
        page.Controls.Add(_companySummary);
        return page;
    }

    private TabPage BuildTestPage()
    {
        var page = Page("Test spojenia", "Overí sa POHODA mServer, prihlásenie, firma, účtovný rok, cloud, párovanie a dostupnosť XSD schém.");
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
            2 when !Uri.TryCreate(_mServer.Text.Trim(), UriKind.Absolute, out _) => "Zadajte platnú adresu mServera.",
            3 when string.IsNullOrWhiteSpace(_user.Text) => "Zadajte používateľa mServer.",
            3 when string.IsNullOrEmpty(_password.Text) => "Zadajte heslo mServer.",
            3 when !System.Text.RegularExpressions.Regex.IsMatch(_ico.Text.Trim(), "^[0-9]{8}$") => "IČO musí mať presne 8 číslic.",
            5 when !_configured => "Najprv úspešne vykonajte kontrolu spojenia.",
            _ => null,
        };
        if (error is null)
        {
            if (_pages.SelectedIndex == 3) _companySummary.Text = $"Firma s IČO: {_ico.Text.Trim()}\nAdresa mServera: {_mServer.Text.Trim()}";
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
                MServerUrl = _mServer.Text.Trim(),
                CompanyIco = _ico.Text.Trim(),
                UserName = _user.Text.Trim(),
                Password = _password.Text,
                InstanceName = NullIfBlank(_instance.Text),
                PohodaExePath = NullIfBlank(_pohodaExe.Text),
                AllowedPublisherThumbprint = _defaults.PublisherThumbprint,
            }, new RollingFileAgentLog(), CancellationToken.None);
            _configured = true;
            _testResult.ForeColor = Color.DarkGreen;
            _testResult.Text = $"Spojenie je v poriadku.\nPOHODA: {result.Company.Company}\nDatabáza: {result.Company.DatabaseName}\nÚčtovný rok: {result.Company.Year}\nHeartbeat: odoslaný";
            _diagnostics = $"Kód: OK\r\nAgent: {AgentVersion.Current}\r\nmServer: dostupný\r\nRok: {result.Company.Year}";
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
        _discovery.Text = $"POHODA bola nájdená: {path}";
        _discovery.ForeColor = Color.DarkGreen;
    }

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
        foreach (var secret in new[] { _password.Text, _pairing.Text, _user.Text })
            if (!string.IsNullOrEmpty(secret)) value = value.Replace(secret, "***", StringComparison.OrdinalIgnoreCase);
        return value;
    }
}

internal static class PohodaDiscovery
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
