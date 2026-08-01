using System.Diagnostics;
using System.Net;
using System.Text;
using Dokladovka.Agent;

namespace Dokladovka.Agent.Configurator;

public sealed class WizardForm : Form
{
    private readonly AgentDefaults _defaults;
    private readonly TabControl _pages = new() { Dock = DockStyle.Fill, Appearance = TabAppearance.FlatButtons, ItemSize = new Size(0, 1), SizeMode = TabSizeMode.Fixed };
    private readonly Button _back = new() { Text = "Späť", AutoSize = true };
    private readonly Button _next = new() { Text = "Pokračovať", AutoSize = true };
    // Polia sú bez Dock: šírku im dáva AddField. Dokované pole by v AutoSize
    // skupine zmerali na preferovanú šírku a zmrštilo by sa na šírku popisu.
    private readonly TextBox _cloud = new();
    private readonly TextBox _pairing = new() { CharacterCasing = CharacterCasing.Upper };
    private readonly RadioButton _modeMServer = new() { Text = "POHODA mServer (HTTP, beží trvalo)", AutoSize = true };
    private readonly RadioButton _modeCli = new() { Text = "Priamy XML import (pohoda.exe /XML, bez mServera) – všetky firmy automaticky", AutoSize = true, Checked = true };
    private readonly TextBox _mServer = new();
    private readonly RadioButton _typeMdb = new() { Text = "POHODA MDB (databázy sú súbory StwPh_*.mdb v dátovom priečinku)", AutoSize = true, Checked = true };
    private readonly RadioButton _typeSql = new() { Text = "POHODA SQL / E1 (databázy sú na Microsoft SQL Serveri)", AutoSize = true };
    private readonly TextBox _dataDirectory = new();
    private readonly TextBox _sqlHost = new();
    private readonly TextBox _sqlPort = new() { Text = "1433" };
    private readonly TextBox _sqlUser = new() { Text = "sa" };
    private readonly TextBox _sqlPassword = new() { UseSystemPasswordChar = true };
    private readonly TextBox _pohodaExe = new();
    private readonly TextBox _user = new();
    private readonly TextBox _password = new() { UseSystemPasswordChar = true };
    private readonly TextBox _ico = new() { MaxLength = 8 };
    private readonly TextBox _instance = new();
    private readonly Label _discovery = new() { AutoSize = true, MaximumSize = new Size(660, 0), ForeColor = Color.DimGray };
    private readonly Label _companySummary = new() { AutoSize = true, MaximumSize = new Size(660, 0) };
    private readonly Label _testResult = new() { AutoSize = true, MaximumSize = new Size(660, 0), ForeColor = Color.DimGray };
    private readonly Button _test = new() { Text = "Skontrolovať a pripojiť", AutoSize = true };
    private readonly Button _diagnosticsButton = new() { Text = "Diagnostika", AutoSize = true, Enabled = false, Margin = new Padding(12, 3, 3, 3) };
    private bool _configured;
    private string _diagnostics = string.Empty;

    public WizardForm(AgentDefaults defaults)
    {
        _defaults = defaults;
        Text = "Dokladovka Agent – Nastavenie";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(780, 620);
        ClientSize = new Size(820, 660);
        Font = new Font("Segoe UI", 9F);
        // Sizable: dlhé chybové hlásenia a zoznam firiem sa inak nezmestia.
        FormBorderStyle = FormBorderStyle.Sizable;
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
        _diagnosticsButton.Click += (_, _) => ShowDiagnostics();
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
        // Režim a typ POHODY sú dve nezávislé voľby — každá dvojica RadioButtonov
        // musí mať vlastný kontajner, inak ich WinForms spojí do jednej skupiny
        // a výber typu SQL/E1 by zrušil výber priameho importu.
        AddToPage(page, RadioGroup(_modeMServer, _modeCli));
        var detect = new Button { Text = "Vyhľadať POHODU", AutoSize = true, Margin = new Padding(3, 12, 3, 3) };
        detect.Click += (_, _) => DiscoverPohoda();
        AddToPage(page, detect);
        AddToPage(page, _discovery);
        var mServerField = AddField(page, "Adresa POHODA mServer", _mServer);
        var exeField = AddField(page, "Cesta k pohoda.exe", _pohodaExe);
        var typeLabel = new Label { Text = "Typ POHODY", AutoSize = true, Margin = new Padding(3, 16, 3, 6), Font = new Font(Font, FontStyle.Bold) };
        AddToPage(page, typeLabel);
        var typeGroup = RadioGroup(_typeMdb, _typeSql);
        AddToPage(page, typeGroup);
        var dataField = AddField(page, "Dátový priečinok POHODA s StwPh_*.mdb", _dataDirectory);
        var browse = new Button { Text = "Prehľadávať…", AutoSize = true, Margin = new Padding(3, 6, 3, 3) };
        browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { Description = "Vyberte dátový priečinok POHODA (obsahuje StwPh_*.mdb)" };
            if (Directory.Exists(_dataDirectory.Text)) dialog.SelectedPath = _dataDirectory.Text;
            if (dialog.ShowDialog(this) == DialogResult.OK) _dataDirectory.Text = dialog.SelectedPath;
        };
        AddToPage(page, browse);
        // Agent číta iba zoznam databáz (SELECT na master.sys.databases) — stačí
        // login s právom VIEW ANY DATABASE, sysadmin nie je potrebný.
        Control[] sqlFields =
        [
            AddField(page, "SQL Server – adresa alebo IP", _sqlHost),
            AddField(page, "SQL Server – port", _sqlPort),
            AddField(page, "SQL Server – používateľ (stačí právo čítania, napr. sa)", _sqlUser),
            AddField(page, "SQL Server – heslo", _sqlPassword),
        ];

        // Zobrazia sa iba polia zvoleného režimu — inak sprievodca pýta údaje,
        // ktoré sa v danom režime vôbec nepoužijú (napr. MDB priečinok pri SQL/E1).
        void UpdateFieldVisibility()
        {
            var cli = _modeCli.Checked;
            mServerField.Visible = !cli;
            exeField.Visible = cli;
            typeLabel.Visible = cli;
            typeGroup.Visible = cli;
            dataField.Visible = cli && _typeMdb.Checked;
            browse.Visible = cli && _typeMdb.Checked;
            foreach (var field in sqlFields) field.Visible = cli && _typeSql.Checked;
        }
        _modeCli.CheckedChanged += (_, _) => UpdateFieldVisibility();
        _typeSql.CheckedChanged += (_, _) => UpdateFieldVisibility();
        UpdateFieldVisibility();
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
        var page = Page("Výber firmy", "Pri priamom importe sa všetky nájdené firmy spárujú s Dokladovkou automaticky podľa IČO. Pri režime mServer sa IČO musí zhodovať s vybranou organizáciou.");
        AddToPage(page, _companySummary);
        return page;
    }

    private TabPage BuildTestPage()
    {
        var page = Page("Test spojenia", "Overí sa POHODA, prihlásenie, firma, účtovný rok, cloud, párovanie a dostupnosť XSD schém. Pri priamom XML importe sa POHODA spustí na pozadí a test môže trvať aj minútu.");
        var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, WrapContents = false, AutoSize = true, Margin = new Padding(0, 0, 0, 12) };
        buttons.Controls.Add(_test);
        buttons.Controls.Add(_diagnosticsButton);
        AddToPage(page, buttons);
        AddToPage(page, _testResult);
        return page;
    }

    private TabPage BuildFinishPage() => Page(
        "Dokončenie",
        "Mostík bol úspešne nakonfigurovaný. Po dokončení sa zaregistruje a spustí služba DokladovkaService. Stav sa do niekoľkých sekúnd zobrazí vo webovej aplikácii.");

    private static FlowLayoutPanel RadioGroup(params RadioButton[] buttons)
    {
        var group = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Margin = new Padding(0) };
        foreach (var button in buttons) group.Controls.Add(button);
        return group;
    }

    private static TabPage Page(string title, string description)
    {
        var page = new TabPage { Padding = new Padding(28), AutoScroll = true };
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true };
        panel.Controls.Add(new Label { Text = title, Font = new Font("Segoe UI", 14F, FontStyle.Bold), AutoSize = true });
        panel.Controls.Add(new Label { Text = description, AutoSize = true, MaximumSize = new Size(660, 0), ForeColor = Color.DimGray, Margin = new Padding(3, 8, 3, 18) });
        page.Controls.Add(panel);
        return page;
    }

    // Obsah stránky patrí do vnútorného panela s nadpisom — priamo na TabPage by
    // sa kreslil cez nadpis (prekrývajúci sa text v sprievodcovi).
    private static void AddToPage(TabPage page, Control control) => ((FlowLayoutPanel)page.Controls[0]).Controls.Add(control);

    /// <summary>Popis + pole ako jeden celok, aby sa dali skryť naraz.</summary>
    private static Control AddField(TabPage page, string label, TextBox input)
    {
        var group = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Margin = new Padding(0, 8, 0, 0) };
        group.Controls.Add(new Label { Text = label, AutoSize = true, Margin = new Padding(3, 0, 3, 3) });
        input.Dock = DockStyle.None;
        input.Width = 640;
        group.Controls.Add(input);
        AddToPage(page, group);
        return group;
    }

    private void MoveStep(int direction)
    {
        if (direction > 0 && !ValidateCurrentPage()) return;
        if (_pages.SelectedIndex == _pages.TabCount - 1 && direction > 0)
        {
            EnsureServiceRegisteredAndStarted();
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
        _diagnosticsButton.Enabled = false;
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
            _diagnostics = BuildDiagnostics("OK", null,
                $"POHODA: {result.Company.Company}\r\nDatabáza: {result.Company.DatabaseName}\r\nÚčtovný rok: {result.Company.Year}\r\nNájdené firmy: {result.Discovered.Count}");
            _diagnosticsButton.Enabled = true;
            _next.Enabled = true;
        }
        catch (Exception error)
        {
            _configured = false;
            var code = ErrorCode(error);
            _testResult.ForeColor = Color.DarkRed;
            _testResult.Text = $"Spojenie sa nepodarilo. {FriendlyMessage(error)}\nTechnický kód: {code}\nPodrobnosti a log nájdete cez tlačidlo Diagnostika.";
            _diagnostics = BuildDiagnostics(code, error, null);
            _diagnosticsButton.Enabled = true;
        }
        finally
        {
            _test.Enabled = true;
        }
    }

    // Diagnostika pre používateľa aj podporu: čo sa testovalo, ktorá chyba padla
    // (celá reťaz vnútorných výnimiek) a koniec logu agenta. Heslá sú prekryté.
    private string BuildDiagnostics(string code, Exception? error, string? summary)
    {
        var text = new StringBuilder();
        text.AppendLine($"Kód: {code}");
        text.AppendLine($"Čas: {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}");
        text.AppendLine($"Agent: {AgentVersion.Current}");
        text.AppendLine($"Počítač: {Environment.MachineName} · Windows {Environment.OSVersion.Version}");
        text.AppendLine();
        text.AppendLine("== Nastavenie ==");
        text.AppendLine($"Cloud: {_cloud.Text.Trim()}");
        text.AppendLine($"Režim: {(_modeCli.Checked ? "priamy XML import (pohoda.exe /XML)" : "mServer")}");
        if (_modeCli.Checked)
        {
            text.AppendLine($"Typ POHODY: {(_typeSql.Checked ? "SQL / E1" : "MDB")}");
            text.AppendLine($"pohoda.exe: {_pohodaExe.Text.Trim()}");
            text.AppendLine(_typeSql.Checked
                ? $"SQL Server: {_sqlHost.Text.Trim()}:{_sqlPort.Text.Trim()} (používateľ {_sqlUser.Text.Trim()})"
                : $"Dátový priečinok: {_dataDirectory.Text.Trim()}");
        }
        else
        {
            text.AppendLine($"mServer: {_mServer.Text.Trim()}");
        }
        text.AppendLine($"Používateľ POHODA: {_user.Text.Trim()}");
        text.AppendLine();
        if (summary is not null)
        {
            text.AppendLine("== Výsledok ==");
            text.AppendLine(summary);
            text.AppendLine();
        }
        if (error is not null)
        {
            text.AppendLine("== Chyba ==");
            for (var current = error; current is not null; current = current.InnerException)
                text.AppendLine($"{current.GetType().Name}: {Redact(current.Message)}");
            text.AppendLine();
        }
        text.AppendLine($"== Log agenta ({AgentPaths.Logs}) ==");
        text.AppendLine(Redact(ReadLogTail(80)));
        return text.ToString();
    }

    private static string ReadLogTail(int lines)
    {
        try
        {
            var path = Path.Combine(AgentPaths.Logs, "agent.log");
            if (!File.Exists(path)) return "(log zatiaľ neexistuje)";
            // Do logu súbežne píše aj služba agenta, preto FileShare.ReadWrite.
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            var tail = new Queue<string>(lines);
            while (reader.ReadLine() is { } line)
            {
                if (tail.Count == lines) tail.Dequeue();
                tail.Enqueue(line);
            }
            return tail.Count == 0 ? "(log je prázdny)" : string.Join(Environment.NewLine, tail);
        }
        catch (Exception error)
        {
            return $"(log sa nepodarilo prečítať: {error.Message})";
        }
    }

    private void ShowDiagnostics()
    {
        using var dialog = new Form
        {
            Text = "Diagnostika spojenia",
            StartPosition = FormStartPosition.CenterParent,
            ClientSize = new Size(840, 560),
            MinimumSize = new Size(520, 320),
            MinimizeBox = false,
            Font = Font,
        };
        dialog.Controls.Add(new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            Font = new Font("Consolas", 9F),
            Text = _diagnostics,
        });
        var footer = new FlowLayoutPanel { Dock = DockStyle.Bottom, FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Padding = new Padding(8) };
        var close = new Button { Text = "Zavrieť", AutoSize = true, DialogResult = DialogResult.OK };
        var copy = new Button { Text = "Kopírovať", AutoSize = true };
        copy.Click += (_, _) => Clipboard.SetText(_diagnostics);
        var openLogs = new Button { Text = "Otvoriť priečinok s logmi", AutoSize = true, Enabled = Directory.Exists(AgentPaths.Logs) };
        openLogs.Click += (_, _) => Process.Start(new ProcessStartInfo(AgentPaths.Logs) { UseShellExecute = true });
        footer.Controls.Add(close);
        footer.Controls.Add(copy);
        footer.Controls.Add(openLogs);
        dialog.Controls.Add(footer);
        dialog.AcceptButton = close;
        dialog.ShowDialog(this);
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

    // Konfigurátor beží ako administrátor, takže službu vie sám zaregistrovať —
    // inštalátor ju vytvoriť nemôže, jeho [Run] kroky bežia ešte pred sprievodcom.
    private static void EnsureServiceRegisteredAndStarted()
    {
        var sc = Path.Combine(Environment.SystemDirectory, "sc.exe");
        if (RunSc(sc, "query DokladovkaService") != 0)
        {
            var agentExe = Path.Combine(AppContext.BaseDirectory, "Dokladovka.Agent.exe");
            RunSc(sc, $"create DokladovkaService binPath= \"{agentExe}\" start= auto DisplayName= \"Dokladovka Agent\"");
            RunSc(sc, "description DokladovkaService \"Bezpečný odchádzajúci most medzi Dokladovkou a POHODA mServer\"");
            RunSc(sc, "failure DokladovkaService reset= 86400 actions= restart/5000/restart/15000/restart/60000");
        }
        RunSc(sc, "start DokladovkaService");
    }

    private static int RunSc(string sc, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(sc, arguments) { UseShellExecute = false, CreateNoWindow = true });
        if (process is null || !process.WaitForExit(15_000)) return -1;
        return process.ExitCode;
    }

    private static string? NullIfBlank(string value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    // POHODA odmietla XML komunikáciu vlastnou chybou (často bez popisu) — má
    // vlastný kód, inak by sa stratila medzi generickými CONFIG-FAILED.
    private static bool IsPohodaXmlRejection(Exception error) =>
        error.Message.Contains("POHODA vrátila chybu", StringComparison.Ordinal)
        || error.Message.Contains("bez súboru odpovede", StringComparison.Ordinal);

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
        _ when IsPohodaXmlRejection(error) => "POHODA-XML",
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
        _ when IsPohodaXmlRejection(error) =>
            "POHODA odmietla XML komunikáciu. Najčastejšie príčiny: používateľ nemá právo Dátová komunikácia, POHODA nie je na tomto počítači aktivovaná (licencia), databáza je zamknutá alebo POHODA čaká na dialóg (napr. prevod databáz po aktualizácii).",
        _ => error.Message,
    };

    private string Redact(string value)
    {
        foreach (var secret in new[] { _password.Text, _pairing.Text, _user.Text, _sqlPassword.Text })
            if (!string.IsNullOrEmpty(secret)) value = value.Replace(secret, "***", StringComparison.OrdinalIgnoreCase);
        return value;
    }
}
