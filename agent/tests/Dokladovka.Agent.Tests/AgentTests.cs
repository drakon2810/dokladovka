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
                  <inv:number><typ:numberRequested>OZ</typ:numberRequested></inv:number>
                  <inv:symVar>2026001</inv:symVar><inv:date>2026-07-14</inv:date><inv:dateTax>2026-07-14</inv:dateTax><inv:dateDue>2026-07-28</inv:dateDue>
                  <inv:accounting><typ:ids>518/321</typ:ids></inv:accounting><inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                  <inv:partnerIdentity><typ:address><typ:company>Test s.r.o.</typ:company><typ:ico>87654321</typ:ico></typ:address></inv:partnerIdentity>
                  <inv:paymentAccount><typ:accountNo>1234567890</typ:accountNo><typ:bankCode>1100</typ:bankCode></inv:paymentAccount>
                </inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:price3>100.00</typ:price3><typ:price3VAT>5.00</typ:price3VAT></inv:homeCurrency></inv:invoiceSummary></inv:invoice>
              </dat:dataPackItem>
              <dat:dataPackItem id="22222222-2222-4222-8222-222222222222" version="2.0">
                <vch:voucher version="2.0"><vch:voucherHeader>
                  <vch:voucherType>expense</vch:voucherType><vch:cashAccount><typ:ids>EUR</typ:ids></vch:cashAccount>
                  <vch:number><typ:numberRequested>VPD</typ:numberRequested></vch:number><vch:originalDocument>BLOK-1</vch:originalDocument>
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
    public void ParsesExistingCodeListResponseFixture()
    {
        var xml = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "code-lists-response-synthetic.xml"));
        var parsed = PohodaXml.ParseCodeLists(xml);
        Assert.Equal("022200", Assert.Single(parsed.Items["predkontacie"]).Kod);
        Assert.Equal("DD2odb", Assert.Single(parsed.Items["cleneniaDph"]).Kod);
        Assert.Equal("2025", Assert.Single(parsed.Items["ciselneRady"]).Kod);
        Assert.Equal("1", Assert.Single(parsed.Items["strediska"]).Kod);
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
