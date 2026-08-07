using Dokladovka.Agent;
using System.Net;
using System.Text;
using Xunit;

namespace Dokladovka.Agent.Tests;

public sealed class AgentTests
{
    [Fact]
    public void SettingsRejectRemotePlainHttp()
    {
        var settings = Settings("http://cloud.example.sk");
        var error = Assert.Throws<InvalidOperationException>(() => AgentSettings.Validate(settings));
        Assert.Contains("HTTPS", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SettingsAllowLocalDevelopmentHttp()
    {
        AgentSettings.Validate(Settings("http://localhost:3001"));
    }

    [Fact]
    public void ReadsDataPackIdsAndParsesResponse()
    {
        const string request = """
            <dat:dataPack xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd">
              <dat:dataPackItem id="0c41dedd-bc4f-4558-8968-13874cd5a040" version="2.0" />
            </dat:dataPack>
            """;
        var ids = PohodaXml.ReadDataPackItemIds(request);
        Assert.Equal(["0c41dedd-bc4f-4558-8968-13874cd5a040"], ids);

        const string response = """
            <dat:responsePack xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd" state="ok">
              <dat:responsePackItem id="0c41dedd-bc4f-4558-8968-13874cd5a040" state="ok"><dat:producedDetails><dat:number>FP26001</dat:number></dat:producedDetails></dat:responsePackItem>
            </dat:responsePack>
            """;
        var parsed = PohodaXml.ParseExportResponse(response, ids);
        Assert.Equal("ok", parsed.PackState);
        Assert.Equal("FP26001", Assert.Single(parsed.Results).PohodaNumber);
        Assert.Equal("ok", Assert.Single(parsed.Results).State);
    }

    [Fact]
    public void ResponseWithoutProducedDetailsIsNotReportedAsExported()
    {
        // Reálny prípad: POHODA vrátila state="ok" s poznámkou „Doklad so zadaným
        // číslom už existuje" a doklad nezaložila — cloud ho napriek tomu označil
        // za prenesený.
        const string response = """
            <dat:responsePack xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd" state="ok">
              <dat:responsePackItem id="11111111-1111-4111-8111-111111111111" state="ok" note="Doklad so zadaným číslom už existuje." />
            </dat:responsePack>
            """;
        var parsed = PohodaXml.ParseExportResponse(response, ["11111111-1111-4111-8111-111111111111"]);
        var result = Assert.Single(parsed.Results);
        Assert.Equal("warning", result.State);
        Assert.Contains("už existuje", result.Message, StringComparison.Ordinal);
        Assert.Null(result.PohodaNumber);
    }

    [Fact]
    public void CodeListRequestConformsToBundledOfficialSchema()
    {
        var schemaDirectory = Path.Combine(AppContext.BaseDirectory, "Schemas");
        Assert.True(File.Exists(Path.Combine(schemaDirectory, "data.xsd")), "Najprv spustite agent/scripts/fetch-pohoda-xsd.ps1.");
        var xml = PohodaXml.BuildCodeListRequest("12345678", "test-request");
        Assert.Empty(new PohodaSchemaValidator(schemaDirectory).ValidateDataPack(xml));
    }

    [Fact]
    public void InvoiceListRequestConformsToBundledOfficialSchema()
    {
        var schemaDirectory = Path.Combine(AppContext.BaseDirectory, "Schemas");
        Assert.True(File.Exists(Path.Combine(schemaDirectory, "data.xsd")), "Najprv spustite agent/scripts/fetch-pohoda-xsd.ps1.");
        var xml = PohodaXml.BuildInvoiceListRequest("12345678", "trening-request");
        Assert.Empty(new PohodaSchemaValidator(schemaDirectory).ValidateDataPack(xml));
    }

    [Fact]
    public void ParsesTrainingDecisionsFromInvoiceListResponse()
    {
        const string response = """
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" state="ok">
              <rsp:responsePackItem id="t01" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:text>Prenájom kancelárie</inv:text>
                      <inv:partnerIdentity><typ:address><typ:company>Reality s.r.o.</typ:company><typ:ico>87654321</typ:ico></typ:address></inv:partnerIdentity>
                      <inv:accounting><typ:ids>518/321</typ:ids></inv:accounting>
                      <inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                      <inv:classificationKVDPH><typ:ids>C2B1</typ:ids></inv:classificationKVDPH>
                    </inv:invoiceHeader>
                  </lst:invoice>
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:text>Prenájom kancelárie</inv:text>
                      <inv:partnerIdentity><typ:address><typ:company>Reality s.r.o.</typ:company><typ:ico>87654321</typ:ico></typ:address></inv:partnerIdentity>
                      <inv:accounting><typ:ids>518/321</typ:ids></inv:accounting>
                      <inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                      <inv:classificationKVDPH><typ:ids>C2B1</typ:ids></inv:classificationKVDPH>
                    </inv:invoiceHeader>
                  </lst:invoice>
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>issuedInvoice</inv:invoiceType>
                      <inv:partnerIdentity><typ:address><typ:company>Odberateľ a.s.</typ:company></typ:address></inv:partnerIdentity>
                      <inv:accounting><typ:ids>311/604</typ:ids></inv:accounting>
                    </inv:invoiceHeader>
                  </lst:invoice>
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:partnerIdentity><typ:address><typ:company>Bez zaúčtovania s.r.o.</typ:company></typ:address></inv:partnerIdentity>
                    </inv:invoiceHeader>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var parsed = PohodaXml.ParseTrainingDecisions(response);
        // Duplicitná faktúra sa zlúči, vydaná a nezaúčtovaná sa preskočia.
        var row = Assert.Single(parsed.Items);
        Assert.Equal(new TrainingDecision("87654321", "Reality s.r.o.", "Prenájom kancelárie", "518/321", "PD", "C2"), row);
        Assert.Empty(parsed.Warnings);
    }

    [Fact]
    public void HistoriaBerieVsetkyAgendyAjSoSmeromPokladne()
    {
        const string response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" state="ok">
              <rsp:responsePackItem id="h01" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>issuedInvoice</inv:invoiceType>
                      <inv:number><typ:numberRequested>26FV001</typ:numberRequested></inv:number>
                      <inv:date>2026-03-05</inv:date>
                      <inv:text>Predaj tovaru</inv:text>
                      <inv:partnerIdentity><typ:address><typ:company>Odberateľ a.s.</typ:company><typ:ico>99998888</typ:ico></typ:address></inv:partnerIdentity>
                      <inv:accounting><typ:ids>311/604</typ:ids></inv:accounting>
                      <inv:classificationVAT><typ:ids>UD</typ:ids></inv:classificationVAT>
                    </inv:invoiceHeader>
                  </lst:invoice>
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedOtherLiability</inv:invoiceType>
                      <inv:text>Poistné</inv:text>
                      <inv:accounting><typ:ids>548/379</typ:ids></inv:accounting>
                    </inv:invoiceHeader>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
              <rsp:responsePackItem id="h07" state="ok">
                <lst:listVoucher xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:voucher xmlns:vch="http://www.stormware.cz/schema/version_2/voucher.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <vch:voucherHeader>
                      <vch:voucherType>expense</vch:voucherType>
                      <vch:text>Váženie vozidla</vch:text>
                      <vch:accounting><typ:ids>518900 ost.sl.</typ:ids></vch:accounting>
                    </vch:voucherHeader>
                  </lst:voucher>
                  <lst:voucher xmlns:vch="http://www.stormware.cz/schema/version_2/voucher.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <vch:voucherHeader>
                      <vch:voucherType>receipt</vch:voucherType>
                      <vch:text>Tržba v hotovosti</vch:text>
                      <vch:accounting><typ:ids>211/604</typ:ids></vch:accounting>
                    </vch:voucherHeader>
                  </lst:voucher>
                </lst:listVoucher>
              </rsp:responsePackItem>
              <rsp:responsePackItem id="h08" state="ok">
                <lst:listIntDoc xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:intDoc xmlns:int="http://www.stormware.cz/schema/version_2/intDoc.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <int:intDocHeader>
                      <int:text>Mzdy 03/2026</int:text>
                      <int:accounting><typ:ids>521/331</typ:ids></int:accounting>
                      <int:classificationVAT><typ:ids>UN</typ:ids></int:classificationVAT>
                    </int:intDocHeader>
                  </lst:intDoc>
                </lst:listIntDoc>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var parsed = PohodaXml.ParseHistoryRows(response);
        Assert.Equal(5, parsed.Rows.Count);
        // Vydaná faktúra patrí do korpusu (na rozdiel od pamäte dodávateľov).
        Assert.Equal(new PohodaXml.HistoryRow("FV", "26FV001", "2026-03-05", "99998888", "Odberateľ a.s.", "Predaj tovaru", "311/604", "UD", null), parsed.Rows[0]);
        // Zvyšok agendy FA = ostatné záväzky, nie spoločné „INE".
        Assert.Equal("OZ", parsed.Rows[1].Agenda);
        // Smer pokladne rozdeľuje výdaj a príjem — tie isté slová sa v nich účtujú opačne.
        Assert.Equal("VPD", parsed.Rows[2].Agenda);
        Assert.Equal("PPD", parsed.Rows[3].Agenda);
        Assert.Equal("INT", parsed.Rows[4].Agenda);
        Assert.Empty(parsed.Warnings);
    }

    [Fact]
    public void HistoriaPreskociDokladBezTextuAleboBezZauctovania()
    {
        const string response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" state="ok">
              <rsp:responsePackItem id="h01" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:accounting><typ:ids>518/321</typ:ids></inv:accounting>
                    </inv:invoiceHeader>
                  </lst:invoice>
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:text>Bez zaúčtovania</inv:text>
                    </inv:invoiceHeader>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        Assert.Empty(PohodaXml.ParseHistoryRows(response).Rows);
    }

    [Fact]
    public void PohodaErrorMessageComesFromNoteAttributesNotForeignElements()
    {
        // POHODA posiela popis chyby ako ATRIBÚT note (element „note" v response.xsd
        // neexistuje) — hľadanie elementu vracalo vždy „bez popisu", prípadne cudziu
        // obchodnú poznámku faktúry z tela odpovede.
        const string response = """
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" state="error" note="Účtovná jednotka s IČO 12345678 sa nenašla.">
              <rsp:responsePackItem id="c01" state="error" note="Používateľ nemá právo Dátová komunikácia.">
                <inv:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"><inv:note>Obchodná poznámka faktúry</inv:note></inv:invoice>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        foreach (var parse in new Action[] { () => PohodaXml.ParseCodeLists(response), () => PohodaXml.ParseTrainingDecisions(response) })
        {
            var error = Assert.Throws<InvalidOperationException>(parse);
            Assert.Contains("Účtovná jednotka s IČO 12345678 sa nenašla.", error.Message, StringComparison.Ordinal);
            Assert.Contains("Používateľ nemá právo Dátová komunikácia.", error.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("Obchodná poznámka", error.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void FindsDestructiveActionsOnlyInUpdateOrDeleteDataPacks()
    {
        const string updatePack = """
            <dat:dataPack xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd">
              <dat:dataPackItem id="1" version="2.0">
                <inv:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                  <inv:actionType><typ:update><typ:filter><typ:id>1</typ:id></typ:filter></typ:update></inv:actionType>
                </inv:invoice>
              </dat:dataPackItem>
            </dat:dataPack>
            """;
        Assert.Equal(["update"], PohodaXml.FindDestructiveActions(updatePack));

        // XSLT transformácia by mohla dataPack prepísať až v POHODE — zakázaná.
        const string transformationPack = """
            <dat:dataPack xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd">
              <dat:transformation><dat:xsltName>rewrite.xsl</dat:xsltName></dat:transformation>
              <dat:dataPackItem id="1" version="2.0" />
            </dat:dataPack>
            """;
        Assert.Equal(["transformation"], PohodaXml.FindDestructiveActions(transformationPack));

        const string createPack = """
            <dat:dataPack xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd">
              <dat:dataPackItem id="1" version="2.0">
                <inv:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                  <inv:actionType><typ:add/></inv:actionType>
                  <inv:invoiceHeader><inv:invoiceType>receivedInvoice</inv:invoiceType></inv:invoiceHeader>
                </inv:invoice>
              </dat:dataPackItem>
            </dat:dataPack>
            """;
        Assert.Empty(PohodaXml.FindDestructiveActions(createPack));
    }

    [Fact]
    public void ConfirmedInvoiceAndVoucherMappingsConformToOfficialSchema()
    {
        const string xml = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <dat:dataPack version="2.0" id="schema-test" ico="12345678" application="Dokladovka" note="Schema test"
              xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
              xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"
              xmlns:vch="http://www.stormware.cz/schema/version_2/voucher.xsd"
              xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
              <dat:dataPackItem id="11111111-1111-4111-8111-111111111111" version="2.0">
                <inv:invoice version="2.0"><inv:invoiceHeader>
                  <inv:invoiceType>commitment</inv:invoiceType>
                  <inv:number><typ:ids>OZ</typ:ids></inv:number>
                  <inv:symVar>2026001</inv:symVar><inv:date>2026-07-14</inv:date><inv:dateTax>2026-07-14</inv:dateTax><inv:dateDue>2026-07-28</inv:dateDue>
                  <inv:accounting><typ:ids>518/321</typ:ids></inv:accounting><inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                  <inv:partnerIdentity><typ:address><typ:company>Test s.r.o.</typ:company><typ:ico>87654321</typ:ico></typ:address></inv:partnerIdentity>
                  <inv:paymentAccount><typ:accountNo>1234567890</typ:accountNo><typ:bankCode>1100</typ:bankCode></inv:paymentAccount>
                </inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:price3>100.00</typ:price3><typ:price3VAT>5.00</typ:price3VAT></inv:homeCurrency></inv:invoiceSummary></inv:invoice>
              </dat:dataPackItem>
              <dat:dataPackItem id="22222222-2222-4222-8222-222222222222" version="2.0">
                <vch:voucher version="2.0"><vch:voucherHeader>
                  <vch:voucherType>expense</vch:voucherType><vch:cashAccount><typ:ids>EUR</typ:ids></vch:cashAccount>
                  <vch:number><typ:ids>VPD</typ:ids></vch:number><vch:originalDocument>BLOK-1</vch:originalDocument>
                  <vch:date>2026-07-14</vch:date><vch:dateTax>2026-07-14</vch:dateTax>
                  <vch:accounting><typ:ids>501/211</typ:ids></vch:accounting><vch:classificationVAT><typ:ids>PD</typ:ids></vch:classificationVAT>
                  <vch:text>Pokladničný doklad</vch:text><vch:partnerIdentity><typ:address><typ:company>Test s.r.o.</typ:company></typ:address></vch:partnerIdentity>
                </vch:voucherHeader><vch:voucherSummary><vch:homeCurrency><typ:priceHigh>100.00</typ:priceHigh><typ:priceHighVAT>23.00</typ:priceHighVAT></vch:homeCurrency></vch:voucherSummary></vch:voucher>
              </dat:dataPackItem>
            </dat:dataPack>
            """;
        var schemaDirectory = Path.Combine(AppContext.BaseDirectory, "Schemas");
        Assert.Empty(new PohodaSchemaValidator(schemaDirectory).ValidateDataPack(xml));
    }

    [Fact]
    public async Task MServerClientUsesDocumentedStatusXmlAndStwHeaders()
    {
        var requests = new List<HttpRequestMessage>();
        var handler = new DelegateHandler(async request =>
        {
            requests.Add(await CopyAsync(request));
            var xml = request.Method == HttpMethod.Get
                ? "<status><company>Test s.r.o.</company><databaseName>StwPh_12345678_2026</databaseName><year>2026</year><period>1-12</period></status>"
                : "<rsp:responsePack xmlns:rsp=\"http://www.stormware.cz/schema/version_2/response.xsd\" state=\"ok\"/>";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(xml, Encoding.UTF8, "text/xml") };
        });
        var endpoint = new MServerEndpointSettings { Id = "one", BaseUrl = "http://localhost:444", CompanyIco = "12345678" };
        var secret = new MServerSecret { EndpointId = "one", UserName = "user", Password = "password" };
        var client = new MServerClient(endpoint, secret, new NullLog(), handler);

        var company = await client.GetCompanyAsync(CancellationToken.None);
        Assert.Equal("StwPh_12345678_2026", company.DatabaseName);
        await client.PostXmlAsync("<xml/>", "job-1", true, CancellationToken.None);

        Assert.Equal("/status?companyDetail", requests[0].RequestUri?.PathAndQuery);
        Assert.Equal("Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("user:password")), requests[1].Headers.GetValues("STW-Authorization").Single());
        Assert.Equal("Dokladovka", requests[1].Headers.GetValues("STW-Application").Single());
        Assert.Equal("job-1", requests[1].Headers.GetValues("STW-Instance").Single());
        Assert.Equal("true", requests[1].Headers.GetValues("STW-Check-Duplicity").Single());
        Assert.Equal("windows-1250", requests[1].Content?.Headers.ContentType?.CharSet, ignoreCase: true);
    }

    [Fact]
    public void CliSettingsRequireDatabaseAndExe()
    {
        var withoutDatabase = Settings("http://localhost:3001") with
        {
            MServers = [new MServerEndpointSettings { Id = "one", CompanyIco = "12345678", Mode = "cli", PohodaExePath = @"C:\Pohoda\Pohoda.exe" }],
        };
        Assert.Contains("databázy", Assert.Throws<InvalidOperationException>(() => AgentSettings.Validate(withoutDatabase)).Message);

        var withoutExe = Settings("http://localhost:3001") with
        {
            MServers = [new MServerEndpointSettings { Id = "one", CompanyIco = "12345678", Mode = "cli", Database = "StwPh_12345678_2026.mdb" }],
        };
        Assert.Contains("pohoda.exe", Assert.Throws<InvalidOperationException>(() => AgentSettings.Validate(withoutExe)).Message);

        AgentSettings.Validate(Settings("http://localhost:3001") with
        {
            MServers = [new MServerEndpointSettings { Id = "one", CompanyIco = "12345678", Mode = "cli", Database = "StwPh_12345678_2026.mdb", PohodaExePath = @"C:\Pohoda\Pohoda.exe" }],
        });
    }

    [Fact]
    public void CliSettingsRejectDatabaseWithoutYear()
    {
        var withoutYear = Settings("http://localhost:3001") with
        {
            MServers = [new MServerEndpointSettings { Id = "one", CompanyIco = "12345678", Mode = "cli", Database = "Ucto", PohodaExePath = @"C:\Pohoda\Pohoda.exe" }],
        };
        Assert.Contains("rok", Assert.Throws<InvalidOperationException>(() => AgentSettings.Validate(withoutYear)).Message);
    }

    [Fact]
    public async Task CliGetCompanyFailsWhenPohodaExeMissing()
    {
        var endpoint = new MServerEndpointSettings
        {
            Id = "one", CompanyIco = "12345678", Mode = "cli",
            Database = "StwPh_12345678_2026.mdb", PohodaExePath = @"C:\does-not-exist\Pohoda.exe",
        };
        var client = new PohodaCliClient(endpoint, new MServerSecret { EndpointId = "one", UserName = "Admin", Password = "x" }, new NullLog());
        await Assert.ThrowsAsync<FileNotFoundException>(() => client.GetCompanyAsync(CancellationToken.None));
    }

    [Theory]
    [InlineData("StwPh_12345678_2026.mdb", "2026")]
    [InlineData("StwPh_12345678_2026", "2026")]
    [InlineData("Ucto", "")]
    public void YearFromDatabaseParses(string database, string expected) =>
        Assert.Equal(expected, PohodaCliClient.YearFromDatabase(database));

    [Fact]
    public async Task CliClientWritesWindows1250FilesAndReadsResponse()
    {
        var previous = Environment.GetEnvironmentVariable("DOKLADOVKA_AGENT_DATA_DIR");
        var temporary = Path.Combine(Path.GetTempPath(), $"dokladovka-cli-test-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable("DOKLADOVKA_AGENT_DATA_DIR", temporary);
        try
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            var windows1250 = Encoding.GetEncoding(1250);
            Directory.CreateDirectory(temporary);
            var pohodaExe = Path.Combine(temporary, "Pohoda.exe");
            File.WriteAllText(pohodaExe, string.Empty);
            var endpoint = new MServerEndpointSettings
            {
                Id = "one", CompanyIco = "12345678", Mode = "cli",
                Database = "StwPh_12345678_2026.mdb", PohodaExePath = pohodaExe,
            };
            var secret = new MServerSecret { EndpointId = "one", UserName = "Admin", Password = "tajné" };
            const string requestXml = "<?xml version=\"1.0\" encoding=\"Windows-1250\"?><dataPack>Faktúra č. 1</dataPack>";
            const string responseXml = "<?xml version=\"1.0\" encoding=\"Windows-1250\"?><responsePack state=\"ok\">Doklad založený – číslo FV2600123</responsePack>";
            string? iniContent = null;
            string? inputContent = null;
            List<string>? arguments = null;

            var client = new PohodaCliClient(endpoint, secret, new NullLog(), (start, _) =>
            {
                arguments = start.ArgumentList.ToList();
                var iniPath = start.ArgumentList[3];
                iniContent = windows1250.GetString(File.ReadAllBytes(iniPath));
                var responsePath = iniContent.Split("\r\n").Single(line => line.StartsWith("response_xml=", StringComparison.Ordinal))["response_xml=".Length..];
                var inputPath = iniContent.Split("\r\n").Single(line => line.StartsWith("input_xml=", StringComparison.Ordinal))["input_xml=".Length..];
                inputContent = windows1250.GetString(File.ReadAllBytes(inputPath));
                File.WriteAllBytes(responsePath, windows1250.GetBytes(responseXml));
                return Task.FromResult(0);
            });

            var response = await client.PostXmlAsync(requestXml, "job/1", true, CancellationToken.None);

            Assert.Equal(responseXml, response);
            Assert.Equal(requestXml, inputContent);
            Assert.Equal(["/XML", "Admin", "tajné"], arguments!.Take(3));
            Assert.Contains("database=StwPh_12345678_2026.mdb", iniContent);
            Assert.Contains("check_duplicity=1", iniContent);
            Assert.False(Directory.EnumerateFiles(Path.Combine(temporary, "xml")).Any(), "Pracovné súbory sa musia po behu upratať.");

            var company = await client.GetCompanyAsync(CancellationToken.None);
            Assert.Equal(new MServerCompany("12345678", "StwPh_12345678_2026.mdb", "2026", string.Empty), company);
        }
        finally
        {
            Environment.SetEnvironmentVariable("DOKLADOVKA_AGENT_DATA_DIR", previous);
            try { Directory.Delete(temporary, recursive: true); } catch { }
        }
    }

    [Fact]
    public void DiscoveryFindsOnlyCompanyDatabases()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"dokladovka-discovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            foreach (var file in new[]
            {
                "StwPh_12345678_2026.mdb", "StwPh_12345678_2025.mdb", "StwPh_87654321_2026.MDB",
                "StwPh.mdb", "StwPhProfile_12345678.mdb", "StwPh_1234_2026.mdb", "iné.mdb", "StwPh_12345678_2026.bak",
            })
            {
                File.WriteAllText(Path.Combine(directory, file), string.Empty);
            }
            var discovered = PohodaDataDiscovery.Scan(directory);
            Assert.Equal(3, discovered.Count);
            Assert.Equal(["12345678", "12345678", "87654321"], discovered.Select(company => company.Ico));
            // Najnovší rok pre rovnaké IČO je prvý.
            Assert.Equal("2026", discovered[0].Year);
            Assert.Equal("2025", discovered[1].Year);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void DiscoveryReturnsEmptyForMissingDirectory() =>
        Assert.Empty(PohodaDataDiscovery.Scan(Path.Combine(Path.GetTempPath(), $"neexistuje-{Guid.NewGuid():N}")));

    [Fact]
    public void AutoSettingsAllowEmptyMServersAndRequireFields()
    {
        var auto = Settings("http://localhost:3001") with
        {
            MServers = [],
            PohodaAuto = new PohodaAutoSettings { PohodaExePath = @"C:\Pohoda\Pohoda.exe", DataDirectory = @"C:\Pohoda\Data" },
        };
        AgentSettings.Validate(auto);

        var withoutAnything = Settings("http://localhost:3001") with { MServers = [] };
        Assert.Throws<InvalidOperationException>(() => AgentSettings.Validate(withoutAnything));

        var withoutDirectory = auto with { PohodaAuto = auto.PohodaAuto! with { DataDirectory = " " } };
        Assert.Contains("priečinok", Assert.Throws<InvalidOperationException>(() => AgentSettings.Validate(withoutDirectory)).Message);

        // SQL/E1 variant: stačí SqlHost bez dátového priečinka.
        var sqlOnly = auto with { PohodaAuto = auto.PohodaAuto! with { DataDirectory = null, SqlHost = "192.168.16.3" } };
        AgentSettings.Validate(sqlOnly);
        var badPort = sqlOnly with { PohodaAuto = sqlOnly.PohodaAuto! with { SqlPort = 0 } };
        Assert.Contains("Port", Assert.Throws<InvalidOperationException>(() => AgentSettings.Validate(badPort)).Message);
    }

    [Fact]
    public void SqlDatabaseNameParsing()
    {
        var company = PohodaDataDiscovery.ParseSqlDatabaseName("StwPh_51743124_2026");
        Assert.NotNull(company);
        Assert.Equal(("51743124", "StwPh_51743124_2026", "2026"), (company!.Ico, company.Database, company.Year));
        // Systémové a cudzie databázy sa ignorujú.
        Assert.Null(PohodaDataDiscovery.ParseSqlDatabaseName("StwPh"));
        Assert.Null(PohodaDataDiscovery.ParseSqlDatabaseName("StwPhProfile"));
        Assert.Null(PohodaDataDiscovery.ParseSqlDatabaseName("StwPh_1234_2026"));
        Assert.Null(PohodaDataDiscovery.ParseSqlDatabaseName("StwPh_51743124_2026.mdb"));
        Assert.Null(PohodaDataDiscovery.ParseSqlDatabaseName("master"));
        // Rok z názvu SQL databázy vie odvodiť aj cli klient (heartbeat, validácia).
        Assert.Equal("2026", PohodaCliClient.YearFromDatabase("StwPh_51743124_2026"));
    }

    [Fact]
    public void MatchEndpointPrefersDbNameThenPreferredYearThenLatest()
    {
        static (MServerEndpointSettings, MServerCompany) Live(string ico, string database, string year) => (
            new MServerEndpointSettings { Id = "auto:" + database, CompanyIco = ico, Mode = "cli", Database = database, PohodaExePath = @"C:\Pohoda\Pohoda.exe" },
            new MServerCompany(ico, database, year, string.Empty));
        var live = new[]
        {
            Live("12345678", "StwPh_12345678_2025.mdb", "2025"),
            Live("12345678", "StwPh_12345678_2026.mdb", "2026"),
            Live("87654321", "StwPh_87654321_2026.mdb", "2026"),
        };

        var byDb = AgentCycleRunner.MatchEndpoint(
            new AgentOrganization("org-1", "12345678", "Firma", "StwPh_12345678_2025.mdb", "2025", "latest"), live);
        Assert.Equal("2025", byDb!.Value.Company.Year);

        var byPreferredYear = AgentCycleRunner.MatchEndpoint(
            new AgentOrganization("org-1", "12345678", "Firma", null, null, "2025"), live);
        Assert.Equal("2025", byPreferredYear!.Value.Company.Year);

        var latest = AgentCycleRunner.MatchEndpoint(
            new AgentOrganization("org-1", "12345678", "Firma", null, null, "latest"), live);
        Assert.Equal("2026", latest!.Value.Company.Year);

        Assert.Null(AgentCycleRunner.MatchEndpoint(
            new AgentOrganization("org-2", "00000000", "Iná", null, null, "latest"), live));
    }

    [Fact]
    public void HeartbeatReportsOnlyProjectOrganizations()
    {
        static (MServerEndpointSettings, MServerCompany) Live(string ico, string database, string year) => (
            new MServerEndpointSettings { Id = "auto:" + database, CompanyIco = ico, Mode = "cli", Database = database, PohodaExePath = @"C:\Pohoda\Pohoda.exe" },
            new MServerCompany(ico, database, year, string.Empty));
        var live = new[]
        {
            Live("12345678", "StwPh_12345678_2026", "2026"),
            Live("99999999", "StwPh_99999999_2026", "2026"), // cudzia firma na tom istom SQL serveri
        };
        var organizations = new[] { new AgentOrganization("org-1", "12345678", "Firma", null, null, "latest") };
        var filtered = AgentCycleRunner.FilterToKnownOrganizations(live, organizations);
        Assert.Equal("12345678", Assert.Single(filtered).Endpoint.CompanyIco);
    }

    [Fact]
    public void ParsesExistingCodeListResponseFixture()
    {
        var xml = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "code-lists-response-synthetic.xml"));
        var parsed = PohodaXml.ParseCodeLists(xml);
        Assert.Equal("022200", Assert.Single(parsed.Items["predkontacie"]).Kod);
        Assert.Equal("DD2odb", Assert.Single(parsed.Items["cleneniaDph"]).Kod);
        var rad = Assert.Single(parsed.Items["ciselneRady"]);
        Assert.Equal("2025", rad.Kod);
        // topNumber z POHODY = posledné použité číslo radu (predikcia interného čísla).
        Assert.Equal("20250042", rad.PosledneCislo);
        Assert.Equal("1", Assert.Single(parsed.Items["strediska"]).Kod);
        // Bankové účty: IBAN bez medzier, mena len pri devízovom účte, zrušený sa preskočí.
        var ucty = parsed.Items["bankoveUcty"];
        Assert.Equal(2, ucty.Count);
        Assert.Equal("PB", ucty[0].Kod);
        Assert.Equal("SK3131000000004040272818", ucty[0].Iban);
        Assert.Null(ucty[0].Mena);
        Assert.Equal("SBUS", ucty[1].Kod);
        Assert.Equal("USD", ucty[1].Mena);
    }

    private static async Task<HttpRequestMessage> CopyAsync(HttpRequestMessage source)
    {
        var copy = new HttpRequestMessage(source.Method, source.RequestUri);
        foreach (var header in source.Headers) copy.Headers.TryAddWithoutValidation(header.Key, header.Value);
        if (source.Content is not null)
        {
            copy.Content = new ByteArrayContent(await source.Content.ReadAsByteArrayAsync());
            foreach (var header in source.Content.Headers) copy.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
        return copy;
    }

    private sealed class DelegateHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request);
    }

    private sealed class NullLog : IAgentLog
    {
        public void Info(string eventName, object? data = null) { }
        public void Error(string eventName, Exception error, object? data = null) { }
    }

    private static AgentSettings Settings(string cloud) => new()
    {
        CloudBaseUrl = cloud,
        InstallationName = "Test",
        MServers =
        [
            new MServerEndpointSettings { Id = "one", BaseUrl = "http://localhost:444", CompanyIco = "12345678" },
        ],
    };
}

public sealed class DocumentFolderTests
{
    [Theory]
    [InlineData("FP")]
    [InlineData("PD")]
    [InlineData("MZDY")]
    public void FolderRequestConformsToBundledOfficialSchema(string documentType)
    {
        var schemaDirectory = Path.Combine(AppContext.BaseDirectory, "Schemas");
        var xml = PohodaXml.BuildDocumentFolderRequest("12345678", documentType, ["26HP026"], "folders-test");
        Assert.NotNull(xml);
        Assert.Empty(new PohodaSchemaValidator(schemaDirectory).ValidateDataPack(xml!));
    }
    
    [Fact]
    public void SafeFileName_ocisti_meno_z_hlavicky()
    {
        // Cudzí vstup: cesta, traversal aj prázdna hodnota musia skončiť pri jednom mene súboru.
        Assert.Equal("faktura.pdf", AgentCycleRunner.SafeFileName(@"..\..\Windows\faktura.pdf", "26HP026"));
        Assert.Equal("26HP026.pdf", AgentCycleRunner.SafeFileName("..", "26HP026"));
        Assert.Equal("26HP026.pdf", AgentCycleRunner.SafeFileName(null, "26HP026"));
        Assert.Equal("ab.pdf", AgentCycleRunner.SafeFileName("a<b>.pdf", "26HP026"));
        var dlhe = AgentCycleRunner.SafeFileName(new string('x', 200) + ".pdf", "26HP026");
        Assert.Equal(90, dlhe.Length);
        Assert.EndsWith(".pdf", dlhe);
    }

    [Fact]
    public void ParsujePriecinokDokumentovZOdpovede()
    {
        // Cestu skladá POHODA — vrátane lokalizovaného segmentu a priečinka číselného radu.
        var response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack version="2.0" state="ok"
              xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"
              xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
              xmlns:vch="http://www.stormware.cz/schema/version_2/voucher.xsd"
              xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
              <rsp:responsePackItem version="2.0" state="ok">
                <lst:listVoucher version="2.0">
                  <lst:voucher>
                    <vch:voucherHeader>
                      <vch:number><typ:numberRequested>26HP026</typ:numberRequested></vch:number>
                    </vch:voucherHeader>
                    <vch:attachments>
                      <typ:files>
                        <typ:companyDocumentsFolder>C:\Pohoda SQL Komplet\Dokumenty\AGS\Podvojné účtovníctvo\Pokladňa</typ:companyDocumentsFolder>
                        <typ:subFolder>26HP\26HP026</typ:subFolder>
                      </typ:files>
                    </vch:attachments>
                  </lst:voucher>
                </lst:listVoucher>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var folder = Assert.Single(PohodaXml.ParseDocumentFolders(response));
        Assert.Equal("26HP026", folder.Cislo);
        Assert.Equal(@"C:\Pohoda SQL Komplet\Dokumenty\AGS\Podvojné účtovníctvo\Pokladňa", folder.CompanyFolder);
        Assert.Equal(@"26HP\26HP026", folder.SubFolder);
    }

    [Fact]
    public void CitaIcoZHlavickyDataPacku()
    {
        var xml = PohodaXml.BuildCodeListRequest("35761571", "req-1");
        Assert.Equal("35761571", PohodaXml.ReadDataPackIco(xml));
    }
}
