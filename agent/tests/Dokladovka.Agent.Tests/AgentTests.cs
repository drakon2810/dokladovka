using Dokladovka.Agent;
using System.Net;
using System.Text;
using System.Text.Json;
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
        Assert.Equal(new TrainingDecision("bezna", "87654321", "Reality s.r.o.", "Prenájom kancelárie", "518/321", "PD", "C2"), row);
        Assert.Empty(parsed.Warnings);
    }

    // Dobropis lezal v pamati ako bezna prijata faktura a sluzil jej ako
    // priklad, hoci sa uctuje opacne a do inej sekcie kontrolneho vykazu.
    [Fact]
    public void PamatNesiePodtypFaktury()
    {
        static string Faktura(string typ, string firma, string text) => $"""
              <rsp:responsePackItem id="x" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>{typ}</inv:invoiceType>
                      <inv:partnerIdentity><typ:address><typ:company>{firma}</typ:company></typ:address></inv:partnerIdentity>
                      <inv:text>{text}</inv:text>
                      <inv:accounting><typ:ids>518/321</typ:ids></inv:accounting>
                    </inv:invoiceHeader>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            """;
        var response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" state="ok">
            """
            + Faktura("receivedInvoice", "Dodávateľ s.r.o.", "Servis vozidla")
            + Faktura("receivedCreditNotice", "Dodávateľ s.r.o.", "Oprava základu dane")
            + Faktura("receivedAdvanceInvoice", "Dodávateľ s.r.o.", "Preddavok")
            + "</rsp:responsePack>";

        var podtypy = PohodaXml.ParseTrainingDecisions(response).Items.Select(row => row.Podtyp).ToArray();
        Assert.Equal(new[] { "bezna", "dobropis", "zalohova" }, podtypy);
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
        Assert.Equal(new PohodaXml.HistoryRow("FV", "26FV001", "2026-03-05", "99998888", "Odberateľ a.s.", "Predaj tovaru", "311/604", "UD", null, 0), parsed.Rows[0]);
        // Zvyšok agendy FA = ostatné záväzky, nie spoločné „INE".
        Assert.Equal("OZ", parsed.Rows[1].Agenda);
        // Smer pokladne rozdeľuje výdaj a príjem — tie isté slová sa v nich účtujú opačne.
        Assert.Equal("VPD", parsed.Rows[2].Agenda);
        Assert.Equal("PPD", parsed.Rows[3].Agenda);
        Assert.Equal("INT", parsed.Rows[4].Agenda);
        Assert.Empty(parsed.Warnings);
    }

    // Dobropis, ťarchopis a zálohová faktúra sa predtým zlievali do FP/FV a
    // korpus ich nevedel rozlíšiť. Dobropis je pritom oprava základu dane
    // (sekcia KV C1/C2, nie A1/B1) a zálohová do výkazu nevstupuje vôbec —
    // v jednej hromade si prevažujúce zaúčtovania protirečili.
    // Ťarchopis sa navyše nesťahoval vôbec, v zozname typov chýbal.
    [Fact]
    public void DobropisTarchopisAZalohovaMajuVlastnuAgendu()
    {
        static string Faktura(string typ, string cislo) => $"""
              <rsp:responsePackItem id="x" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>{typ}</inv:invoiceType>
                      <inv:number><typ:numberRequested>{cislo}</typ:numberRequested></inv:number>
                      <inv:partnerIdentity><typ:address><typ:company>Dodávateľ s.r.o.</typ:company></typ:address></inv:partnerIdentity>
                      <inv:text>Oprava základu dane</inv:text>
                      <inv:accounting><typ:ids>518/321</typ:ids></inv:accounting>
                    </inv:invoiceHeader>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            """;
        var response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" state="ok">
            """
            + Faktura("receivedInvoice", "F1")
            + Faktura("receivedCreditNotice", "D1")
            + Faktura("receivedDebitNote", "T1")
            + Faktura("receivedAdvanceInvoice", "Z1")
            + Faktura("issuedCreditNotice", "D2")
            + Faktura("issuedDebitNote", "T2")
            + Faktura("issuedAdvanceInvoice", "Z2")
            + "</rsp:responsePack>";

        var agendy = PohodaXml.ParseHistoryRows(response).Rows.Select(row => row.Agenda).ToArray();
        Assert.Equal(new[] { "FP", "FP-D", "FP-T", "FP-Z", "FV-D", "FV-T", "FV-Z" }, agendy);
    }

    [Fact]
    public void PoziadavkaHistorieSiPytaAjTarchopisy()
    {
        var request = PohodaXml.BuildHistoryListRequest("35761571", "req-1");
        foreach (var typ in new[]
        {
            "receivedInvoice", "receivedCreditNotice", "receivedDebitNote", "receivedAdvanceInvoice",
            "issuedInvoice", "issuedCreditNotice", "issuedDebitNote", "issuedAdvanceInvoice",
            // Ostatné záväzky sa nepýtali vôbec, hoci parser ich vie zaradiť —
            // korpus ich preto nemal ani jeden a agenda OZ zostala prázdna.
            "commitment",
        })
        {
            Assert.Contains($"invoiceType=\"{typ}\"", request);
        }
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
    public void CiselnyRadSaCitaAjZDokladu()
    {
        // POHODA rad bez vyplneného Obdobia do číselníka nedá — jej schéma
        // vyžaduje element „period". Doklad ten istý rad nesie: typ:id je
        // identifikátor, typ:ids prefix. Bez toho by rad 26OZ, na ktorom má
        // ALPINA vyše 370 dokladov, v ponuke nebol nikdy.
        const string response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" state="ok">
              <rsp:responsePackItem id="h01" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>commitment</inv:invoiceType>
                      <inv:number><typ:id>575</typ:id><typ:ids>26OZ</typ:ids><typ:numberRequested>26OZ370</typ:numberRequested></inv:number>
                      <inv:text>Pokuta</inv:text>
                      <inv:accounting><typ:ids>545/325100</typ:ids></inv:accounting>
                    </inv:invoiceHeader>
                  </lst:invoice>
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>commitment</inv:invoiceType>
                      <inv:number><typ:id>575</typ:id><typ:ids>26OZ</typ:ids><typ:numberRequested>26OZ371</typ:numberRequested></inv:number>
                    </inv:invoiceHeader>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var parsed = PohodaXml.ParseHistoryRows(response);
        var rad = Assert.Single(parsed.Series);
        Assert.Equal("575", rad.ExternalId);
        Assert.Equal("26OZ", rad.Kod);
        // Agenda musí sedieť so slovníkom číselníka POHODY — v ponuke sa rad
        // filtruje presnou zhodou, „OZ" by nenašlo nič.
        Assert.Equal("ostatni_zavazky", rad.Agenda);
        // Druhý doklad je pre korpus bezcenný (bez textu aj predkontácie), ale
        // svoj rad má rovnako platný — a nesie vyššie číslo.
        Assert.Equal("26OZ371", rad.PosledneCislo);
        Assert.Single(parsed.Rows);
    }

    [Theory]
    [InlineData("receivedInvoice", "prijate_faktury")]
    [InlineData("receivedCreditNotice", "prijate_faktury")]
    [InlineData("issuedInvoice", "vydane_faktury")]
    [InlineData("issuedAdvanceInvoice", "vydane_zalohove_faktury")]
    [InlineData("commitment", "ostatni_zavazky")]
    public void AgendaRaduZDokladuSediSoSlovnikomPohody(string invoiceType, string agenda)
    {
        var response = $"""
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" state="ok">
              <rsp:responsePackItem id="h01" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>{invoiceType}</inv:invoiceType>
                      <inv:number><typ:id>1</typ:id><typ:ids>RAD</typ:ids></inv:number>
                    </inv:invoiceHeader>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        Assert.Equal(agenda, Assert.Single(PohodaXml.ParseHistoryRows(response).Series).Agenda);
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
        // Vrátane priečinka dokumentov: attachments je v XSD až za súhrnom dokladu
        // a jediný element mimo poradia odmietne CELÝ dataPack — teda aj bezchybné
        // doklady tej istej dávky. Miesto sa preto overuje proti oficiálnej schéme.
        const string xml = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <dat:dataPack version="2.0" id="schema-test" ico="12345678" application="Dokladovka" note="Schema test"
              xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
              xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"
              xmlns:vch="http://www.stormware.cz/schema/version_2/voucher.xsd"
              xmlns:int="http://www.stormware.cz/schema/version_2/intDoc.xsd"
              xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
              <dat:dataPackItem id="11111111-1111-4111-8111-111111111111" version="2.0">
                <inv:invoice version="2.0"><inv:invoiceHeader>
                  <inv:invoiceType>commitment</inv:invoiceType>
                  <inv:number><typ:ids>OZ</typ:ids></inv:number>
                  <inv:symVar>2026001</inv:symVar><inv:date>2026-07-14</inv:date><inv:dateTax>2026-07-14</inv:dateTax><inv:dateDue>2026-07-28</inv:dateDue>
                  <inv:accounting><typ:ids>518/321</typ:ids></inv:accounting><inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                  <inv:partnerIdentity><typ:address><typ:company>Test s.r.o.</typ:company><typ:ico>87654321</typ:ico></typ:address></inv:partnerIdentity>
                  <inv:paymentAccount><typ:accountNo>1234567890</typ:accountNo><typ:bankCode>1100</typ:bankCode></inv:paymentAccount>
                </inv:invoiceHeader><inv:invoiceSummary><inv:homeCurrency><typ:price3>100.00</typ:price3><typ:price3VAT>5.00</typ:price3VAT></inv:homeCurrency></inv:invoiceSummary>
                <inv:attachments><typ:files><typ:subFolder>Fakturácia\Ostatné záväzky\26OZ\1f2e3d4c5b6a</typ:subFolder></typ:files></inv:attachments></inv:invoice>
              </dat:dataPackItem>
              <dat:dataPackItem id="22222222-2222-4222-8222-222222222222" version="2.0">
                <vch:voucher version="2.0"><vch:voucherHeader>
                  <vch:voucherType>expense</vch:voucherType><vch:cashAccount><typ:ids>EUR</typ:ids></vch:cashAccount>
                  <vch:number><typ:ids>VPD</typ:ids></vch:number><vch:originalDocument>BLOK-1</vch:originalDocument>
                  <vch:date>2026-07-14</vch:date><vch:dateTax>2026-07-14</vch:dateTax>
                  <vch:accounting><typ:ids>501/211</typ:ids></vch:accounting><vch:classificationVAT><typ:ids>PD</typ:ids></vch:classificationVAT>
                  <vch:text>Pokladničný doklad</vch:text><vch:partnerIdentity><typ:address><typ:company>Test s.r.o.</typ:company></typ:address></vch:partnerIdentity>
                </vch:voucherHeader><vch:voucherSummary><vch:homeCurrency><typ:priceHigh>100.00</typ:priceHigh><typ:priceHighVAT>23.00</typ:priceHighVAT></vch:homeCurrency></vch:voucherSummary>
                <vch:attachments><typ:files><typ:subFolder>Podvojné účtovníctvo\Pokladňa\26HP\22222222-222</typ:subFolder></typ:files></vch:attachments></vch:voucher>
              </dat:dataPackItem>
              <dat:dataPackItem id="33333333-3333-4333-8333-333333333333" version="2.0">
                <int:intDoc version="2.0"><int:intDocHeader>
                  <int:number><typ:ids>INT</typ:ids></int:number><int:date>2026-07-14</int:date>
                  <int:accounting><typ:ids>331/221</typ:ids></int:accounting><int:classificationVAT><typ:ids>PN</typ:ids></int:classificationVAT>
                  <int:text>Mzdová páska</int:text>
                </int:intDocHeader><int:intDocSummary><int:homeCurrency><typ:priceNone>4120.74</typ:priceNone></int:homeCurrency></int:intDocSummary>
                <int:attachments><typ:files><typ:subFolder>Podvojné účtovníctvo\Interné doklady\26INT\33333333-333</typ:subFolder></typ:files></int:attachments></int:intDoc>
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

    // Sadzba DPH a stredisko v korpuse. V produkcii ich nemal ani jeden z 25 952
    // riadkov: agent ich nečítal, hoci server ich prijíma. Sadzba pritom
    // rozhoduje medzi tuzemskou daňou s odpočtom a cudzou bez neho.
    [Fact]
    public void ParseHistoryRows_NesieSadzbuDphAStredisko()
    {
        const string response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="h01" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:number><typ:numberRequested>DF260200</typ:numberRequested></inv:number>
                      <inv:date>2026-07-31</inv:date>
                      <inv:text>Tankovanie</inv:text>
                      <inv:accounting><typ:ids>PHM-501200</typ:ids></inv:accounting>
                      <inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                      <inv:centre><typ:ids>BA</typ:ids></inv:centre>
                    </inv:invoiceHeader>
                    <inv:invoiceDetail>
                      <inv:invoiceItem>
                        <inv:text>Nafta</inv:text>
                        <inv:rateVAT value="23">high</inv:rateVAT>
                      </inv:invoiceItem>
                      <inv:invoiceItem>
                        <inv:text>Dialnicna znamka</inv:text>
                        <inv:rateVAT>none</inv:rateVAT>
                        <inv:centre><typ:ids>KE</typ:ids></inv:centre>
                      </inv:invoiceItem>
                      <inv:invoiceItem>
                        <inv:text>Obcerstvenie</inv:text>
                        <inv:percentVAT>5</inv:percentVAT>
                      </inv:invoiceItem>
                    </inv:invoiceDetail>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var rows = PohodaXml.ParseHistoryRows(response).Rows;
        Assert.Equal(4, rows.Count);
        // Hlavička nesie stredisko, ale sadzbu nie — doklad ich má viac.
        Assert.Equal("BA", rows[0].StrediskoKod);
        Assert.Null(rows[0].SadzbaDph);
        // Číslo z atribútu value, nie kód „high": ten sa bez dátumu previesť nedá.
        Assert.Equal(23m, rows[1].SadzbaDph);
        Assert.Equal("BA", rows[1].StrediskoKod);
        // „none" je nula a vlastné stredisko položky má prednosť pred hlavičkou.
        Assert.Equal(0m, rows[2].SadzbaDph);
        Assert.Equal("KE", rows[2].StrediskoKod);
        // Bez atribútu value sa berie percentVAT.
        Assert.Equal(5m, rows[3].SadzbaDph);
    }

    // Ostatné pohľadávky majú vlastnú agendu. Bez nej by padli do zvyšku agendy
    // FA — medzi ostatné ZÁVÄZKY — a pohľadávka by sa v korpuse tvárila ako dlh.
    [Fact]
    public void ParseHistoryRows_OstatnaPohladavkaNiejeZavazok()
    {
        static string Doklad(string typ, string cislo) =>
            "<lst:invoice xmlns:inv=\"http://www.stormware.cz/schema/version_2/invoice.xsd\" xmlns:typ=\"http://www.stormware.cz/schema/version_2/type.xsd\" version=\"2.0\">"
            + "<inv:invoiceHeader>"
            + $"<inv:invoiceType>{typ}</inv:invoiceType>"
            + $"<inv:number><typ:numberRequested>{cislo}</typ:numberRequested></inv:number>"
            + "<inv:text>Financna ciastka</inv:text>"
            + "<inv:accounting><typ:ids>378100</typ:ids></inv:accounting>"
            + "</inv:invoiceHeader></lst:invoice>";
        var response =
            "<?xml version=\"1.0\" encoding=\"Windows-1250\"?>"
            + "<rsp:responsePack xmlns:rsp=\"http://www.stormware.cz/schema/version_2/response.xsd\" version=\"2.0\" state=\"ok\">"
            + "<rsp:responsePackItem id=\"h01\" state=\"ok\">"
            + "<lst:listInvoice xmlns:lst=\"http://www.stormware.cz/schema/version_2/list.xsd\" version=\"2.0\">"
            + Doklad("receivable", "26OP001")
            + Doklad("commitment", "26OZ001")
            + "</lst:listInvoice></rsp:responsePackItem></rsp:responsePack>";
        var agendy = PohodaXml.ParseHistoryRows(response).Rows.Select(row => (row.DokladCislo, row.Agenda)).ToArray();
        Assert.Contains(("26OP001", "OP"), agendy);
        Assert.Contains(("26OZ001", "OZ"), agendy);
    }

    // Požiadavka histórie pýta aj ostatné pohľadávky a ostáva platná podľa XSD.
    [Fact]
    public void HistoryListRequest_PytaAjOstatnePohladavky()
    {
        var schemaDirectory = Path.Combine(AppContext.BaseDirectory, "Schemas");
        Assert.True(File.Exists(Path.Combine(schemaDirectory, "data.xsd")), "Najprv spustite agent/scripts/fetch-pohoda-xsd.ps1.");
        var xml = PohodaXml.BuildHistoryListRequest("12345678", "historia-request");
        Assert.Contains("invoiceType=\"receivable\"", xml, StringComparison.Ordinal);
        // Likvidácie faktúr POHODA bez restrictionData neexportuje.
        Assert.Equal(10, xml.Split("<lst:liquidations>true</lst:liquidations>").Length - 1);
        Assert.Empty(new PohodaSchemaValidator(schemaDirectory).ValidateDataPack(xml));
        var otvorene = PohodaXml.BuildOpenInvoicesRequest("12345678", "faktury-request");
        Assert.Equal(10, otvorene.Split("<lst:listInvoiceRequest ").Length - 1);
        Assert.Empty(new PohodaSchemaValidator(schemaDirectory).ValidateDataPack(otvorene));
    }

    // Pokladňa číselného radu. POHODA ju drží na rade pokladne (cashAccount),
    // agent ju nečítal a pokladničný doklad prichádzal bez nej. ids sa smie
    // hľadať LEN pod cashAccount — inak by sa vzalo prvé ids v rade.
    [Fact]
    public void ParseCodeLists_CitaPokladnuCiselnehoRadu()
    {
        const string response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="c03" state="ok">
                <lst:listNumericalSeries xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:numericalSeries xmlns:nms="http://www.stormware.cz/schema/version_2/numericalSeries.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <nms:numericalSeriesHeader>
                      <nms:id>12</nms:id>
                      <nms:prefix>26HP</nms:prefix>
                      <nms:name>Hotovostny prijem</nms:name>
                      <nms:agenda>pokladna</nms:agenda>
                      <nms:accountingUnit><typ:ids>NEPLATI</typ:ids></nms:accountingUnit>
                      <nms:cashAccount><typ:ids>HP1</typ:ids></nms:cashAccount>
                    </nms:numericalSeriesHeader>
                  </lst:numericalSeries>
                  <lst:numericalSeries xmlns:nms="http://www.stormware.cz/schema/version_2/numericalSeries.xsd" version="2.0">
                    <nms:numericalSeriesHeader>
                      <nms:id>13</nms:id>
                      <nms:prefix>2026</nms:prefix>
                      <nms:name>Prijate faktury</nms:name>
                      <nms:agenda>prijate_faktury</nms:agenda>
                    </nms:numericalSeriesHeader>
                  </lst:numericalSeries>
                </lst:listNumericalSeries>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var rady = PohodaXml.ParseCodeLists(response).Items["ciselneRady"];
        Assert.Equal("HP1", rady.Single(rad => rad.Kod == "26HP").PokladnaKod);
        // Rad inej agendy pokladňu nemá.
        Assert.Null(rady.Single(rad => rad.Kod == "2026").PokladnaKod);
    }

    // Rady s rovnakým prefixom v rôznych agendách. Kľúč podľa kódu druhý rad
    // ticho zahodil a server potom rad hádal podľa prefixu. id sa berie len
    // z hlavičky radu: typ:id pokladne tu schválne koliduje s prvým radom.
    [Fact]
    public void ParseCodeLists_RadySRovnakymPrefixomOstanuObidva()
    {
        const string response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="c03" state="ok">
                <lst:listNumericalSeries xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:numericalSeries xmlns:nms="http://www.stormware.cz/schema/version_2/numericalSeries.xsd" version="2.0">
                    <nms:numericalSeriesHeader>
                      <nms:id>13</nms:id>
                      <nms:prefix>2026</nms:prefix>
                      <nms:name>Prijate faktury</nms:name>
                      <nms:agenda>prijate_faktury</nms:agenda>
                    </nms:numericalSeriesHeader>
                  </lst:numericalSeries>
                  <lst:numericalSeries xmlns:nms="http://www.stormware.cz/schema/version_2/numericalSeries.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <nms:numericalSeriesHeader>
                      <nms:cashAccount><typ:id>13</typ:id><typ:ids>HP1</typ:ids></nms:cashAccount>
                      <nms:id>27</nms:id>
                      <nms:prefix>2026</nms:prefix>
                      <nms:name>Pokladna</nms:name>
                      <nms:agenda>pokladna</nms:agenda>
                    </nms:numericalSeriesHeader>
                  </lst:numericalSeries>
                </lst:listNumericalSeries>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var rady = PohodaXml.ParseCodeLists(response).Items["ciselneRady"];
        Assert.Equal(
            new (string?, string?, string?)[] { ("2026", "13", "prijate_faktury"), ("2026", "27", "pokladna") },
            rady.Select(rad => ((string?)rad.Kod, rad.ExternalId, rad.Agenda)));
    }

    // Rad a krajina dokladu v korpuse. Bez nich server rad nového dokladu hádal
    // zo začiatku čísla. Nesie ich hlavička aj každá položka; krajina bez kódu
    // krajiny v adrese sa berie z prefixu IČ DPH, nikdy z dodacej adresy.
    [Fact]
    public void ParseHistoryRows_NesieRadAKrajinuDokladu()
    {
        const string response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="h01" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:number><typ:id>41</typ:id><typ:ids>DF260</typ:ids><typ:numberRequested>DF260200</typ:numberRequested></inv:number>
                      <inv:partnerIdentity><typ:address><typ:company>Print-Office s.r.o.</typ:company><typ:icDph>CZ99887766</typ:icDph><typ:country><typ:ids>sk</typ:ids></typ:country></typ:address></inv:partnerIdentity>
                      <inv:text>Tonery</inv:text>
                      <inv:accounting><typ:ids>501/321</typ:ids></inv:accounting>
                    </inv:invoiceHeader>
                    <inv:invoiceDetail>
                      <inv:invoiceItem><inv:text>Toner HP</inv:text></inv:invoiceItem>
                    </inv:invoiceDetail>
                  </lst:invoice>
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:number><typ:id>42</typ:id><typ:ids>ZF260</typ:ids><typ:numberRequested>ZF260414</typ:numberRequested></inv:number>
                      <inv:partnerIdentity>
                        <typ:address><typ:company>Dodavatel CZ</typ:company><typ:icDph>CZ123</typ:icDph></typ:address>
                        <typ:shipToAddress><typ:country><typ:ids>AT</typ:ids></typ:country></typ:shipToAddress>
                      </inv:partnerIdentity>
                      <inv:text>Preprava</inv:text>
                      <inv:accounting><typ:ids>518/321</typ:ids></inv:accounting>
                    </inv:invoiceHeader>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var rows = PohodaXml.ParseHistoryRows(response).Rows;
        Assert.Equal(
            new (string?, string?, string?)[] { ("41", "DF260", "SK"), ("41", "DF260", "SK"), ("42", "ZF260", "CZ") },
            rows.Select(row => (row.RadExternalId, row.RadKod, row.Krajina)));
        Assert.Equal(new int?[] { 0, 1, 0 }, rows.Select(row => row.RiadokIndex));
    }

    // Stránkovanie denníka. Strana je 10 000 proviozok (strop schémy); SLO SERVICES
    // naň narazila presne a zvyšok roka sa nepreniesol.
    [Fact]
    public void DennikStrankovanie_IdFromJePlatneAStranaSaCitaSpravne()
    {
        var schemaDirectory = Path.Combine(AppContext.BaseDirectory, "Schemas");
        Assert.True(File.Exists(Path.Combine(schemaDirectory, "data.xsd")), "Najprv spustite agent/scripts/fetch-pohoda-xsd.ps1.");
        var prva = PohodaXml.BuildDennikRequest("12345678", "dennik-1", 2026);
        var dalsia = PohodaXml.BuildDennikRequest("12345678", "dennik-2", 2026, 55001);
        Assert.DoesNotContain("idFrom", prva, StringComparison.Ordinal);
        Assert.Contains("<ftr:idFrom>55001</ftr:idFrom>", dalsia, StringComparison.Ordinal);
        var validator = new PohodaSchemaValidator(schemaDirectory);
        Assert.Empty(validator.ValidateDataPack(prva));
        Assert.Empty(validator.ValidateDataPack(dalsia));

        const string strana = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="dennik" state="ok">
                <lst:listAccountancy xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:accountancy xmlns:acu="http://www.stormware.cz/schema/version_2/accountancy.xsd" version="2.0">
                    <acu:accountingItem><acu:id>100</acu:id></acu:accountingItem>
                    <acu:accountingItem><acu:id>250</acu:id></acu:accountingItem>
                    <acu:accountingItem><acu:id>180</acu:id></acu:accountingItem>
                  </lst:accountancy>
                </lst:listAccountancy>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        // Najvyššie id, nie posledné: ďalšia strana ide od neho, nie od poradia.
        Assert.Equal((3, 250L), PohodaXml.CitajStranuDennika(strana));
    }

    // Chyba položky denníka (chýbajúce právo) vyzerala ako prázdna strana:
    // slučka skončila a denník sa ohlásil ako úspešne prenesený.
    [Fact]
    public void DennikChybaPolozkyNieJePrazdnaStrana()
    {
        const string strana = """
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="dennik" state="error" note="Chýba právo na účtovný denník." />
            </rsp:responsePack>
            """;
        Assert.Contains("Chýba právo", Assert.Throws<InvalidOperationException>(() => PohodaXml.CitajStranuDennika(strana)).Message, StringComparison.Ordinal);
    }

    // Starý server pole historiaProtokol nemá: agent musí poslať presne to, čo
    // doteraz — strict schéma by nový kľúč odmietla (400) a prenos by padal.
    [Fact]
    public async Task Protokol1PosielaPrenosBezNovychKlucov()
    {
        var poziadavky = await SpustiCyklusAsync(Organizacie(null), poziadavka => OdpovedPohody(poziadavka));
        static string[] Kluce(string telo) => JsonDocument.Parse(telo).RootElement.EnumerateObject().Select(property => property.Name).ToArray();

        var historia = Assert.Single(poziadavky, poziadavka => poziadavka.Cesta.EndsWith("/ucto-history", StringComparison.Ordinal));
        Assert.Equal(["rows", "reset", "series"], Kluce(historia.Telo));
        var polozka = JsonDocument.Parse(historia.Telo).RootElement.GetProperty("rows")[1];
        Assert.DoesNotContain(polozka.EnumerateObject(), property => property.Name is "dokladId" or "polozkaId");
        Assert.Equal(["rows", "done", "reset"], Kluce(Assert.Single(poziadavky, poziadavka => poziadavka.Cesta.EndsWith("/training-decisions", StringComparison.Ordinal)).Telo));
        Assert.Equal(["xml"], Kluce(Assert.Single(poziadavky, poziadavka => poziadavka.Cesta.EndsWith("/ucto-dennik", StringComparison.Ordinal)).Telo));
        Assert.DoesNotContain(poziadavky, poziadavka => poziadavka.Cesta.EndsWith("/publikuj", StringComparison.Ordinal));
        Assert.Equal("ok|", VysledokTelemetrie(poziadavky, "treningAi"));
    }

    // Protokol 2: každý druh má vlastný importId na každej dávke, reset sa
    // neposiela a živé dáta vymení až publikácia s manifestom. Žiadosť o sync
    // zmaže prázdne done=true až po všetkých troch publikáciách.
    [Fact]
    public async Task Protokol2PosielaImportIdNaDavkachAManifestPriPublikacii()
    {
        var poziadavky = await SpustiCyklusAsync(Organizacie(2), poziadavka => OdpovedPohody(poziadavka));
        var davky = poziadavky
            .Where(poziadavka => poziadavka.Metoda == "PUT" && (poziadavka.Cesta.EndsWith("/training-decisions", StringComparison.Ordinal)
                || poziadavka.Cesta.EndsWith("/ucto-history", StringComparison.Ordinal) || poziadavka.Cesta.EndsWith("/ucto-dennik", StringComparison.Ordinal)))
            .Select(poziadavka => (poziadavka.Cesta, Telo: JsonDocument.Parse(poziadavka.Telo).RootElement))
            .ToArray();
        Assert.Equal(4, davky.Length);
        var zaver = davky[^1];
        Assert.EndsWith("/training-decisions", zaver.Cesta, StringComparison.Ordinal);
        Assert.False(zaver.Telo.TryGetProperty("importId", out _));
        Assert.True(zaver.Telo.GetProperty("done").GetBoolean());
        foreach (var davka in davky[..^1])
        {
            Assert.Equal(0, davka.Telo.GetProperty("davka").GetInt32());
            Assert.False(davka.Telo.TryGetProperty("reset", out _), davka.Cesta);
        }
        var importIds = davky[..^1].Select(davka => davka.Telo.GetProperty("importId").GetString()!).ToArray();
        Assert.Equal(3, importIds.Distinct().Count());
        var polozka = davky[1].Telo.GetProperty("rows")[1];
        Assert.Equal((10L, 11L), (polozka.GetProperty("dokladId").GetInt64(), polozka.GetProperty("polozkaId").GetInt64()));
        // Hlavičky dokladov server s protokolom 2 nepozná (strict schéma).
        Assert.False(davky[1].Telo.TryGetProperty("doklady", out _));
        Assert.DoesNotContain(poziadavky, poziadavka => poziadavka.Cesta.EndsWith("/open-invoices", StringComparison.Ordinal));

        var publikacie = poziadavky.Where(poziadavka => poziadavka.Cesta.EndsWith("/publikuj", StringComparison.Ordinal)).ToArray();
        Assert.Equal(importIds.Select(id => $"/api/agent/organizations/org-1/importy/{id}/publikuj"), publikacie.Select(poziadavka => poziadavka.Cesta));
        var tela = publikacie.Select(poziadavka => JsonDocument.Parse(poziadavka.Telo).RootElement).ToArray();
        Assert.Equal(["pamat", "historia", "dennik"], tela.Select(telo => telo.GetProperty("druh").GetString()!));
        Assert.All(tela, telo => Assert.Equal("StwPh_12345678_2026", telo.GetProperty("manifest").GetProperty("databaza").GetString()));
        var historia = tela[1];
        Assert.Equal("1|2|12", $"{historia.GetProperty("davok").GetInt32()}|{historia.GetProperty("pocet").GetInt32()}|{historia.GetProperty("manifest").GetProperty("agendy").GetArrayLength()}");
        Assert.Equal(2026, tela[2].GetProperty("manifest").GetProperty("rok").GetInt32());
        Assert.Equal("ok|", VysledokTelemetrie(poziadavky, "treningAi"));
    }

    // Protokol 3: dávka histórie nesie aj hlavičky dokladov s väzbami. Otvorené
    // faktúry idú na žiadosť servera celé v jednej požiadavke s databázou.
    [Fact]
    public async Task Protokol3PosielaHlavickyAOtvoreneFaktury()
    {
        var poziadavky = await SpustiCyklusAsync(Organizacie(3, otvoreneFaktury: true), poziadavka => OdpovedPohody(poziadavka));
        var historia = JsonDocument.Parse(Assert.Single(poziadavky, poziadavka => poziadavka.Cesta.EndsWith("/ucto-history", StringComparison.Ordinal)).Telo).RootElement;
        var doklad = Assert.Single(historia.GetProperty("doklady").EnumerateArray());
        Assert.Equal("FP|10|DF260169|2026-07-16|0", $"{doklad.GetProperty("agenda").GetString()}|{doklad.GetProperty("dokladId").GetInt64()}|{doklad.GetProperty("dokladCislo").GetString()}|{doklad.GetProperty("datum").GetString()}|{doklad.GetProperty("vazby").GetArrayLength()}");

        var otvorene = JsonDocument.Parse(Assert.Single(poziadavky, poziadavka => poziadavka.Cesta == "/api/agent/organizations/org-1/open-invoices").Telo).RootElement;
        Assert.Equal("StwPh_12345678_2026", otvorene.GetProperty("databaza").GetString());
        var faktura = Assert.Single(otvorene.GetProperty("faktury").EnumerateArray());
        Assert.Equal("FP|20|123", $"{faktura.GetProperty("agenda").GetString()}|{faktura.GetProperty("dokladId").GetInt64()}|{faktura.GetProperty("zostatok").GetDecimal()}");
        Assert.Equal("ok|", VysledokTelemetrie(poziadavky, "otvoreneFaktury"));
    }

    // Po troch zlyhaniach exportu sa agent vzdá: server žiadosť zmaže bez nahradenia
    // zoznamu a nová žiadosť z webu spustí export znova — nečaká na reštart služby.
    // Nespárovaná firma žiadosť uzavrie rovnako, inak by visela bez stopy.
    [Theory]
    [InlineData("12345678", 4, "error|InvalidOperationException")]
    [InlineData("87654321", 0, "error|organization_unmatched")]
    public async Task OtvoreneFakturyPoStropePokusovZmazuZiadost(string ico, int exportov, string telemetria)
    {
        var pokusy = 0;
        var poziadavky = await SpustiCyklusAsync(Organizacie(3, otvoreneFaktury: true).Replace("12345678", ico, StringComparison.Ordinal), poziadavka =>
        {
            if (!poziadavka.Contains("note=\"Export otvorenych faktur\"", StringComparison.Ordinal)) return OdpovedPohody(poziadavka);
            Interlocked.Increment(ref pokusy);
            return """<rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="error" note="Databáza je zamknutá."/>""";
        }, cyklov: 4);
        var vzdanie = Assert.Single(poziadavky, poziadavka => poziadavka.Cesta == "/api/agent/organizations/org-1/open-invoices");
        Assert.Equal("""{"vzdat":true}""", vzdanie.Telo);
        Assert.Equal(exportov, pokusy);
        Assert.Equal(telemetria, VysledokTelemetrie(poziadavky, "otvoreneFaktury"));
    }

    // Výnimka histórie išla doteraz len do lokálneho logu a tréning sa ohlásil
    // ako ok — na serveri neúplný prenos vyzeral rovnako ako úspešný.
    [Fact]
    public async Task ChybaHistorieIdeDoTelemetrieATreningNieJeOk()
    {
        var poziadavky = await SpustiCyklusAsync(Organizacie(2), poziadavka => OdpovedPohody(poziadavka,
            """<rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="error" note="Databáza je zamknutá."/>"""));
        Assert.Equal("error|InvalidOperationException", VysledokTelemetrie(poziadavky, "uctovnyProfil"));
        Assert.Equal("ok|", VysledokTelemetrie(poziadavky, "uctovnyDennik"));
        Assert.Equal("error|uctovnyProfil", VysledokTelemetrie(poziadavky, "treningAi"));
        // Žiadosť o sync ostáva — celý prenos sa zopakuje ďalším cyklom.
        Assert.DoesNotContain(poziadavky, poziadavka => poziadavka.Cesta.EndsWith("/training-decisions", StringComparison.Ordinal) && !poziadavka.Telo.Contains("importId", StringComparison.Ordinal));
    }

    // Neúplná pamäť (t03 bez práv → 422 pri publikácii) blokuje len svoju
    // publikáciu. História a denník majú vlastné prenosy a v 0.17 prešli.
    [Fact]
    public async Task OdmietnutaPamatNezastaviHistoriuADennik()
    {
        var poziadavky = await SpustiCyklusAsync(Organizacie(2), poziadavka => OdpovedPohody(poziadavka), (cesta, telo) =>
            cesta.EndsWith("/publikuj", StringComparison.Ordinal) && telo.Contains("\"druh\":\"pamat\"", StringComparison.Ordinal)
                ? (HttpStatusCode.UnprocessableEntity, """{"code":"import_neuplny","message":"Prenos je neúplný: agenda FP: error"}""")
                : null);
        var druhy = poziadavky.Where(poziadavka => poziadavka.Cesta.EndsWith("/publikuj", StringComparison.Ordinal))
            .Select(poziadavka => JsonDocument.Parse(poziadavka.Telo).RootElement.GetProperty("druh").GetString());
        Assert.Equal(["pamat", "historia", "dennik"], druhy);
        Assert.Equal("ok|", VysledokTelemetrie(poziadavky, "uctovnyProfil"));
        Assert.Equal("error|BackendApiException", VysledokTelemetrie(poziadavky, "treningAi"));
        // Žiadosť o sync ostáva, kým neprejdú všetky tri publikácie.
        Assert.DoesNotContain(poziadavky, poziadavka => poziadavka.Cesta.EndsWith("/training-decisions", StringComparison.Ordinal) && !poziadavka.Telo.Contains("importId", StringComparison.Ordinal));
    }

    // Strop 20 000 je pre servery do 0.17. Nový server berie viac a riadok
    // agenta je novší než riadok publikácie — orezaný by klamal v prehľade.
    [Fact]
    public async Task Protokol2NeorezavaPocetVTelemetrii()
    {
        var poziadavky = await SpustiCyklusAsync(Organizacie(2), poziadavka => OdpovedPohody(poziadavka), (cesta, _) =>
            cesta.EndsWith("/publikuj", StringComparison.Ordinal)
                ? (HttpStatusCode.OK, """{"imported":1,"duplicates":0,"rejected":0,"ulozenych":25000}""")
                : null);
        var dennik = poziadavky.Where(poziadavka => poziadavka.Cesta == "/api/agent/sync-results")
            .Select(poziadavka => JsonDocument.Parse(poziadavka.Telo).RootElement)
            .Last(telo => telo.GetProperty("kind").GetString() == "uctovnyDennik");
        Assert.Equal(25_000, dennik.GetProperty("itemCount").GetInt32());
    }

    private static string Organizacie(int? protokol, bool otvoreneFaktury = false) =>
        $$"""[{"organizationId":"org-1","ico":"12345678","nazov":"Firma","dbName":null,"uctovnyRok":null,"preferredYear":"latest","syncRequested":false,"trainingSyncRequested":true{{(protokol is null ? "" : $",\"historiaProtokol\":{protokol}")}}{{(otvoreneFaktury ? ",\"openInvoicesSyncRequested\":true" : "")}}}]""";

    private static string VysledokTelemetrie(IEnumerable<(string Metoda, string Cesta, string Telo)> poziadavky, string kind)
    {
        var vysledok = poziadavky.Where(poziadavka => poziadavka.Cesta == "/api/agent/sync-results")
            .Select(poziadavka => JsonDocument.Parse(poziadavka.Telo).RootElement)
            .Last(telo => telo.GetProperty("kind").GetString() == kind);
        return $"{vysledok.GetProperty("state").GetString()}|{(vysledok.TryGetProperty("errorCode", out var kod) ? kod.GetString() : null)}";
    }

    private const string PrazdnaOdpoved = """<rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="ok"/>""";

    private static string OdpovedPohody(string poziadavka, string? historia = null)
    {
        const string hlavicka = """<rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" xmlns:acu="http://www.stormware.cz/schema/version_2/accountancy.xsd" version="2.0" state="ok">""";
        if (poziadavka.Contains("note=\"Export historie zauctovani\"", StringComparison.Ordinal))
        {
            return hlavicka + """
                <rsp:responsePackItem id="t01" state="ok"><lst:listInvoice version="2.0"><lst:invoice version="2.0"><inv:invoiceHeader>
                  <inv:invoiceType>receivedInvoice</inv:invoiceType><inv:text>Tonery</inv:text>
                  <inv:partnerIdentity><typ:address><typ:company>Print-Office s.r.o.</typ:company></typ:address></inv:partnerIdentity>
                  <inv:accounting><typ:ids>501/321</typ:ids></inv:accounting>
                </inv:invoiceHeader></lst:invoice></lst:listInvoice></rsp:responsePackItem></rsp:responsePack>
                """;
        }
        if (poziadavka.Contains("note=\"Export historie pre uctovny profil\"", StringComparison.Ordinal))
        {
            return historia ?? hlavicka + """
                <rsp:responsePackItem id="h01" state="ok"><lst:listInvoice version="2.0" state="ok"><lst:invoice version="2.0">
                  <inv:invoiceHeader><inv:id>10</inv:id><inv:invoiceType>receivedInvoice</inv:invoiceType>
                    <inv:number><typ:id>615</typ:id><typ:ids>DF260</typ:ids><typ:numberRequested>DF260169</typ:numberRequested></inv:number>
                    <inv:date>2026-07-16</inv:date><inv:text>Tonery</inv:text><inv:accounting><typ:ids>501/321</typ:ids></inv:accounting>
                  </inv:invoiceHeader>
                  <inv:invoiceDetail><inv:invoiceItem><inv:id>11</inv:id><inv:text>Toner HP</inv:text></inv:invoiceItem></inv:invoiceDetail>
                </lst:invoice></lst:listInvoice></rsp:responsePackItem>
                """ + string.Concat(Enumerable.Range(2, 11).Select(index => $"""<rsp:responsePackItem id="h{index:D2}" state="ok"/>""")) + "</rsp:responsePack>";
        }
        if (poziadavka.Contains("note=\"Export otvorenych faktur\"", StringComparison.Ordinal))
        {
            return hlavicka + """
                <rsp:responsePackItem id="o01" state="ok"><lst:listInvoice version="2.0" state="ok"><lst:invoice version="2.0">
                  <inv:invoiceHeader><inv:id>20</inv:id><inv:invoiceType>receivedInvoice</inv:invoiceType><inv:liquidation><typ:amountHome>123</typ:amountHome></inv:liquidation></inv:invoiceHeader>
                </lst:invoice></lst:listInvoice></rsp:responsePackItem>
                """ + string.Concat(Enumerable.Range(2, 9).Select(index => $"""<rsp:responsePackItem id="o{index:D2}" state="ok"/>""")) + "</rsp:responsePack>";
        }
        if (poziadavka.Contains("note=\"Export uctovneho dennika\"", StringComparison.Ordinal))
        {
            return hlavicka + """
                <rsp:responsePackItem id="dennik" state="ok"><lst:listAccountancy version="2.0"><lst:accountancy version="2.0">
                  <acu:accountingItem><acu:id>100</acu:id></acu:accountingItem>
                </lst:accountancy></lst:listAccountancy></rsp:responsePackItem></rsp:responsePack>
                """;
        }
        return PrazdnaOdpoved;
    }

    /// <summary>Cykly jedného behu služby proti podstrčenému cloudu aj mServeru. Vráti požiadavky na cloud.</summary>
    private static async Task<List<(string Metoda, string Cesta, string Telo)>> SpustiCyklusAsync(
        string organizacie, Func<string, string> pohoda, Func<string, string, (HttpStatusCode Status, string Json)?>? cloud = null, int cyklov = 1)
    {
        var poziadavky = new List<(string Metoda, string Cesta, string Telo)>();
        var handler = new DelegateHandler(async request =>
        {
            var telo = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync();
            var cesta = request.RequestUri!.AbsolutePath;
            if (request.RequestUri.Port == 444)
            {
                var xml = request.Method == HttpMethod.Get
                    ? "<status><company>Firma</company><databaseName>StwPh_12345678_2026</databaseName><year>2026</year><period>1-12</period></status>"
                    : pohoda(telo);
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(xml, Encoding.UTF8, "text/xml") };
            }
            lock (poziadavky) poziadavky.Add((request.Method.Method, cesta, telo));
            var (status, json) = cloud?.Invoke(cesta, telo) ?? cesta switch
            {
                "/api/agent/organizations" => (HttpStatusCode.OK, organizacie),
                "/api/agent/export-queue" => (HttpStatusCode.OK, "[]"),
                "/api/agent/latest" => (HttpStatusCode.NotFound, "{}"),
                _ when cesta.EndsWith("/training-decisions", StringComparison.Ordinal) => (HttpStatusCode.OK, """{"imported":1,"duplicates":0,"rejected":0}"""),
                _ when cesta.EndsWith("/publikuj", StringComparison.Ordinal) => (HttpStatusCode.OK, """{"imported":1,"duplicates":0,"rejected":0,"ulozenych":1}"""),
                _ => (HttpStatusCode.OK, "{}"),
            };
            return new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        });
        var previous = Environment.GetEnvironmentVariable("DOKLADOVKA_AGENT_DATA_DIR");
        var temporary = Path.Combine(Path.GetTempPath(), $"dokladovka-cyklus-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable("DOKLADOVKA_AGENT_DATA_DIR", temporary);
        try
        {
            var secrets = new AgentSecrets { AgentToken = "token", MServers = [new MServerSecret { EndpointId = "one", UserName = "user", Password = "password" }] };
            var runner = new AgentCycleRunner(Settings("http://localhost:3001"), secrets, new NullLog(), handler);
            for (var cyklus = 0; cyklus < cyklov; cyklus++) await runner.RunOnceAsync(CancellationToken.None);
        }
        finally
        {
            Environment.SetEnvironmentVariable("DOKLADOVKA_AGENT_DATA_DIR", previous);
            try { Directory.Delete(temporary, recursive: true); } catch { }
        }
        return poziadavky;
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
    [InlineData("receivedInvoice")]
    [InlineData("receivedCreditNotice")]
    [InlineData("issuedInvoice")]
    [InlineData("issuedCreditNotice")]
    [InlineData("commitment")]
    [InlineData("voucher")]
    [InlineData("intDoc")]
    public void FolderRequestConformsToBundledOfficialSchema(string documentType)
    {
        var schemaDirectory = Path.Combine(AppContext.BaseDirectory, "Schemas");
        var xml = PohodaXml.BuildDocumentFolderRequest("12345678", documentType, ["26HP026"], "folders-test");
        Assert.NotNull(xml);
        Assert.Empty(new PohodaSchemaValidator(schemaDirectory).ValidateDataPack(xml!));
    }

    [Fact]
    public void NeznamaAgendaDopytNepostavi()
    {
        // Radšej žiadny dopyt než dopyt s prázdnym invoiceType: XSD pozná uzavretý
        // zoznam a chybný atribút by zhodil celú skupinu dokladov.
        Assert.Null(PohodaXml.BuildDocumentFolderRequest("12345678", "bank", ["26HP026"], "folders-test"));
        Assert.Null(PohodaXml.BuildDocumentFolderRequest("12345678", "FP", ["26HP026"], "folders-test"));
    }

    [Fact]
    public void TypPolozkyPackuNesiePodtypFaktury()
    {
        // Dobropis vydanej faktúry sa predtým čítal ako „prijatá faktúra" a spätný
        // dopyt na priečinok ho v POHODE nenašiel — sken sa ticho stratil.
        var pack = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <dat:dataPack version="2.0" id="p1" ico="12345678"
              xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
              xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"
              xmlns:vch="http://www.stormware.cz/schema/version_2/voucher.xsd"
              xmlns:int="http://www.stormware.cz/schema/version_2/intDoc.xsd">
              <dat:dataPackItem id="d1" version="2.0"><inv:invoice version="2.0"><inv:invoiceHeader>
                <inv:invoiceType>issuedCreditNotice</inv:invoiceType></inv:invoiceHeader></inv:invoice></dat:dataPackItem>
              <dat:dataPackItem id="d2" version="2.0"><inv:invoice version="2.0"><inv:invoiceHeader>
                <inv:invoiceType>commitment</inv:invoiceType></inv:invoiceHeader></inv:invoice></dat:dataPackItem>
              <dat:dataPackItem id="d3" version="2.0"><vch:voucher version="2.0"><vch:voucherHeader/></vch:voucher></dat:dataPackItem>
              <dat:dataPackItem id="d4" version="2.0"><int:intDoc version="2.0"><int:intDocHeader/></int:intDoc></dat:dataPackItem>
            </dat:dataPack>
            """;
        var typy = PohodaXml.ReadDataPackItemTypes(pack);
        Assert.Equal("issuedCreditNotice", typy["d1"]);
        Assert.Equal("commitment", typy["d2"]);
        Assert.Equal("voucher", typy["d3"]);
        Assert.Equal("intDoc", typy["d4"]);
        // A dopyt zloží presne pre ten podtyp, s ktorým doklad vznikol.
        Assert.Contains("invoiceType=\"issuedCreditNotice\"", PohodaXml.BuildDocumentFolderRequest("12345678", typy["d1"], ["26FV001"], "req")!);
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

    [Fact]
    public void AdresarDaUdajeFirmy()
    {
        var response = """
<?xml version="1.0" encoding="utf-8"?>
<rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:adb="http://www.stormware.cz/schema/version_2/addressbook.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" state="ok">
  <rsp:responsePackItem>
    <lst:listAddressBook>
      <lst:addressbook>
        <adb:addressbookHeader>
          <adb:identity>
            <typ:address>
              <typ:company>B.R. Pneumatici S.p.A.</typ:company>
              <typ:city>Thiene</typ:city>
              <typ:street>Via Gombe 5</typ:street>
              <typ:zip>360 16</typ:zip>
              <typ:icDph>IT01800220244</typ:icDph>
              <typ:country><typ:ids>IT</typ:ids></typ:country>
            </typ:address>
          </adb:identity>
        </adb:addressbookHeader>
      </lst:addressbook>
      <lst:addressbook>
        <adb:addressbookHeader>
          <adb:identity>
            <typ:address>
              <typ:company>Slovenská firma s.r.o.</typ:company>
              <typ:ico>35761571</typ:ico>
              <typ:dic>2020254170</typ:dic>
              <typ:icDph>SK2020254170</typ:icDph>
              <typ:city>Bratislava</typ:city>
            </typ:address>
          </adb:identity>
        </adb:addressbookHeader>
      </lst:addressbook>
    </lst:listAddressBook>
  </rsp:responsePackItem>
</rsp:responsePack>
""";
        var rows = PohodaXml.ParseAddressBookRows(response);
        Assert.Equal(2, rows.Count);
        // Presne to, co sa z talianskeho blanketu nedalo vycitat.
        Assert.Equal(new PohodaXml.AddressBookRow(
            "B.R. Pneumatici S.p.A.", null, null, "IT01800220244", "Via Gombe 5", "Thiene", "360 16", "IT"), rows[0]);
        Assert.Equal("35761571", rows[1].Ico);
        Assert.Equal("Bratislava", rows[1].Mesto);
    }

    [Fact]
    public void AdresarPreskociZaznamBezNazvu()
    {
        var response = """
<?xml version="1.0" encoding="utf-8"?>
<rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:adb="http://www.stormware.cz/schema/version_2/addressbook.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" state="ok">
  <rsp:responsePackItem><lst:listAddressBook><lst:addressbook><adb:addressbookHeader><adb:identity>
    <typ:address><typ:city>Bratislava</typ:city></typ:address>
  </adb:identity></adb:addressbookHeader></lst:addressbook></lst:listAddressBook></rsp:responsePackItem>
</rsp:responsePack>
""";
        // Bez nazvu sa firma nema ako sparovat s dodavatelom z faktury.
        Assert.Empty(PohodaXml.ParseAddressBookRows(response));
    }

    [Fact]
    public void PoziadavkaAdresaraJeSpravna()
    {
        var request = PohodaXml.BuildAddressBookRequest("35761571", "req-ab");
        Assert.Contains("listAddressBookRequest", request);
        Assert.Contains("requestAddressBook", request);
        Assert.Contains("ico=\"35761571\"", request);
    }

    // Prva verzia pouzila prefix `lst:` (list.xsd), lenze listAddressBookRequest
    // je vo vlastnom list_addBook.xsd. POHODA cely dataPackItem odmietla a
    // adresar sa ticho nestiahol — schema to zachyti okamzite.
    [Fact]
    public void AddressBookRequestConformsToBundledOfficialSchema()
    {
        var schemaDirectory = Path.Combine(AppContext.BaseDirectory, "Schemas");
        Assert.True(File.Exists(Path.Combine(schemaDirectory, "data.xsd")), "Najprv spustite agent/scripts/fetch-pohoda-xsd.ps1.");
        var xml = PohodaXml.BuildAddressBookRequest("12345678", "test-request");
        Assert.Empty(new PohodaSchemaValidator(schemaDirectory).ValidateDataPack(xml));
    }
    // Rozúčtovanie PHM na daňovú a nedaňovú časť je vidieť LEN v položkách.
    // Hlavička faktúry nesie „PHM / PHM-501200 / PD" a v účtovnom denníku po
    // nej ostanú štyri proviozky s textom „PHM" — ani z jedného sa nedá zistiť,
    // že delený bol iba Natural 95 a že nedaňová časť ide na PHM-Nadspotreba
    // s členením PN. Korpus preto musí položky s vlastným zaúčtovaním vidieť.
    [Fact]
    public void ParseHistoryRows_BerieAjPolozkySVlastnymZauctovanim()
    {
        const string response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="h01" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:number><typ:numberRequested>DF260181</typ:numberRequested></inv:number>
                      <inv:date>2026-07-31</inv:date>
                      <inv:partnerIdentity><typ:address><typ:company>Up Déjeuner, s. r. o.</typ:company><typ:ico>53528654</typ:ico></typ:address></inv:partnerIdentity>
                      <inv:text>PHM</inv:text>
                      <inv:accounting><typ:ids>PHM-501200</typ:ids></inv:accounting>
                      <inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                      <inv:classificationKVDPH><typ:ids>B2</typ:ids></inv:classificationKVDPH>
                    </inv:invoiceHeader>
                    <inv:invoiceDetail>
                      <inv:invoiceItem>
                        <inv:text>Nafta</inv:text>
                        <inv:homeCurrency><typ:price>100.09</typ:price></inv:homeCurrency>
                      </inv:invoiceItem>
                      <inv:invoiceItem>
                        <inv:text>Natural 95 (daňová časť 80 %)</inv:text>
                        <inv:homeCurrency><typ:price>52.68</typ:price></inv:homeCurrency>
                        <inv:accounting><typ:ids>PHM-501200</typ:ids></inv:accounting>
                        <inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                      </inv:invoiceItem>
                      <inv:invoiceItem>
                        <inv:text>Natural 95 (nedaňová časť 20 %)</inv:text>
                        <inv:homeCurrency><typ:price>13.17</typ:price></inv:homeCurrency>
                        <inv:accounting><typ:ids>PHM-Nadspotreba</typ:ids></inv:accounting>
                        <inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>
                      </inv:invoiceItem>
                    </inv:invoiceDetail>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var rows = PohodaXml.ParseHistoryRows(response).Rows;
        // Doklad je rozúčtovaný, takže sa berú VŠETKY jeho položky — hlavička,
        // nafta, daňová aj nedaňová časť. Daňová časť drží hlavičkové
        // zaúčtovanie a sama o sebe by do korpusu nepatrila, lenže bez nej
        // ostane len osamotené „13,17 nedaňové" a pomer z toho nikto nevyčíta.
        Assert.Equal(4, rows.Count);
        Assert.Equal(new PohodaXml.HistoryRow(
            "FP", "DF260181", "2026-07-31", "53528654", "Up Déjeuner, s. r. o.",
            "PHM", "PHM-501200", "PD", "B2", 0), rows[0]);
        // Sekcia KV sa dedí z hlavičky, keď ju položka nemá vlastnú.
        Assert.Equal(new PohodaXml.HistoryRow(
            "FP", "DF260181", "2026-07-31", "53528654", "Up Déjeuner, s. r. o.",
            "Natural 95 (nedaňová časť 20 %)", "PHM-Nadspotreba", "PN", "B2", 3, 13.17m), rows[3]);
        // Pomer základu 80/20 je čitateľný až z dvojice: 52,68 a 13,17.
        Assert.Equal(new decimal?[] { 52.68m, 13.17m }, rows.Skip(2).Select(row => row.Suma).ToArray());
    }
    // Denník sa dovtedy sťahoval iba ručne. Request je jediné, čo agent pre
    // neho skladá — odpoveď rozoberá server —, takže schéma je jediná kontrola,
    // ktorú tu vieme mať. A stojí za ňu: listNumericSeriesRequest (bez „al")
    // POHODA odmietla ako neznámu žiadosť a ticho nevrátila nič.
    [Fact]
    public void DennikRequestConformsToBundledOfficialSchema()
    {
        var schemaDirectory = Path.Combine(AppContext.BaseDirectory, "Schemas");
        Assert.True(File.Exists(Path.Combine(schemaDirectory, "data.xsd")), "Najprv spustite agent/scripts/fetch-pohoda-xsd.ps1.");
        var xml = PohodaXml.BuildDennikRequest("12345678", "dennik-test", 2026);
        Assert.Contains("<ftr:dateFrom>2026-01-01</ftr:dateFrom>", xml);
        Assert.Contains("<ftr:dateTill>2026-12-31</ftr:dateTill>", xml);
        Assert.Empty(new PohodaSchemaValidator(schemaDirectory).ValidateDataPack(xml));
    }
    // Faktúra Print-Office DF260169 z reálneho exportu ALPINY: dve z troch
    // položiek nemajú text vôbec — a práve na jednej z nich je „repre / PN /
    // KN", teda plnenie mimo priznania aj mimo kontrolného výkazu. Podmienka
    // „bez textu preskoč" o ten dôkaz pripravila korpus úplne. Na celom exporte
    // je bez textu 18 zo 68 rozúčtovaných položiek.
    [Fact]
    public void ParseHistoryRows_BerieAjPolozkuBezTextu()
    {
        const string response = """
            <?xml version="1.0" encoding="Windows-1250"?>
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="h01" state="ok">
                <lst:listInvoice xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" version="2.0">
                  <lst:invoice xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0">
                    <inv:invoiceHeader>
                      <inv:invoiceType>receivedInvoice</inv:invoiceType>
                      <inv:number><typ:numberRequested>DF260169</typ:numberRequested></inv:number>
                      <inv:date>2026-07-16</inv:date>
                      <inv:partnerIdentity><typ:address><typ:company>Print-Office s.r.o.</typ:company><typ:ico>54085292</typ:ico></typ:address></inv:partnerIdentity>
                      <inv:text>spese di rappres./repre</inv:text>
                      <inv:accounting><typ:ids>repre</typ:ids></inv:accounting>
                      <inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                      <inv:classificationKVDPH><typ:ids>B2</typ:ids></inv:classificationKVDPH>
                    </inv:invoiceHeader>
                    <inv:invoiceDetail>
                      <inv:invoiceItem>
                        <inv:homeCurrency><typ:price>49.70</typ:price></inv:homeCurrency>
                        <inv:accounting><typ:ids>kancelár.potreby</typ:ids></inv:accounting>
                        <inv:classificationVAT><typ:ids>PD</typ:ids></inv:classificationVAT>
                        <inv:classificationKVDPH><typ:ids>B2</typ:ids></inv:classificationKVDPH>
                      </inv:invoiceItem>
                      <inv:invoiceItem>
                        <inv:homeCurrency><typ:price>165.44</typ:price></inv:homeCurrency>
                        <inv:accounting><typ:ids>repre</typ:ids></inv:accounting>
                        <inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>
                        <inv:classificationKVDPH><typ:ids>KN</typ:ids></inv:classificationKVDPH>
                      </inv:invoiceItem>
                    </inv:invoiceDetail>
                  </lst:invoice>
                </lst:listInvoice>
              </rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var rows = PohodaXml.ParseHistoryRows(response).Rows;
        // Hlavička + obe položky. Bez textu si berú text hlavičky — ten účtovník
        // pri položke aj tak vidí.
        Assert.Equal(3, rows.Count);
        Assert.Equal(new PohodaXml.HistoryRow(
            "FP", "DF260169", "2026-07-16", "54085292", "Print-Office s.r.o.",
            "spese di rappres./repre", "kancelár.potreby", "PD", "B2", 1, 49.70m), rows[1]);
        // Tá istá predkontácia ako hlavička, ale mimo priznania aj mimo výkazu.
        Assert.Equal(new PohodaXml.HistoryRow(
            "FP", "DF260169", "2026-07-16", "54085292", "Print-Office s.r.o.",
            "spese di rappres./repre", "repre", "PN", "KN", 2, 165.44m), rows[2]);
    }
    // TEN ISTÝ súbor číta aj server (uctoHistoriaXml.test.ts). Formát majú
    // zatiaľ dva parsery — agent v C# a server v TypeScripte pre ručnú cestu —
    // a jediné, čo ich drží pri sebe, je táto spoločná fixtúra z reálneho
    // exportu ALPINY. Keď sa rozídu, korpus bude mať dva rôzne tvary toho
    // istého dokladu a nikto si toho nevšimne.
    [Fact]
    public void ParseHistoryRows_SediSoServerovymParserom()
    {
        var rows = PohodaXml.ParseHistoryRows(ServerovaFixtura()).Rows;
        var printOffice = rows.Where(row => row.DokladCislo == "DF260169").ToArray();
        Assert.Equal(
            new[]
            {
                "0|repre|PD|B2",
                "1|kancelár.potreby|PD|B2",
                "2|repre|PN|KN",
                "3|548-vratný obal|PN|KN",
            },
            printOffice.Select(row => $"{row.RiadokIndex}|{row.PredkontaciaKod}|{row.ClenenieDphKod}|{row.ClenenieKvKod}").ToArray());
        // Položka bez textu si berie text hlavičky — inak by z korpusu vypadla.
        Assert.Equal("spese di rappres./repre", printOffice[2].LineText);

        var phm = rows.Where(row => row.DokladCislo == "DF260181").ToArray();
        Assert.Equal(
            new[]
            {
                "0|PHM|PHM-501200|PD",
                "1|Nafta|PHM-501200|PD",
                "2|Natural 95 (daňová časť 80 %)|PHM-501200|PD",
                "3|Natural 95 (nedaňová časť 20 %)|PHM-Nadspotreba|PN",
                "4|PHM|PHM-501200|PD",
            },
            phm.Select(row => $"{row.RiadokIndex}|{row.LineText}|{row.PredkontaciaKod}|{row.ClenenieDphKod}").ToArray());
        Assert.Equal("B2", phm[3].ClenenieKvKod);
        // Sumy su to podstatne: 52,68 a 13,17 dava pomer zakladu 80/20, kym DPH
        // 7,58 a 7,57 ukazuje kratenie odpoctu na polovicu (§ 49 ods. 5).
        Assert.Equal(new decimal?[] { 52.68m, 13.17m }, phm.Skip(2).Take(2).Select(row => row.Suma).ToArray());
        Assert.Equal(new decimal?[] { 7.58m, 7.57m }, phm.Skip(2).Take(2).Select(row => row.SumaDph).ToArray());
    }

    // Doklad účtovaný celý na jeden účet. AGS tak vedie prijaté faktúry, takže
    // rozúčtovaná je len každá siedma — a text zvyšných šiestich sa strácal,
    // hoci rozlíšiť treba práve súrodenecké účty služieb a hlavička na to slová
    // nemá. Rovnaké dva prípady drží server v uctoHistoriaXml.test.ts.
    [Theory]
    [InlineData("<inv:text>T-1 Erledigung elektronisch im System</inv:text>", 2)]
    [InlineData("", 1)]
    public void ParseHistoryRows_PolozkaBezVlastnehoUctovaniaOstaneLenSTextom(string textPolozky, int ocakavanychRiadkov)
    {
        var xml = $@"<?xml version=""1.0"" encoding=""Windows-1250""?>
<rsp:responsePack version=""2.0"" state=""ok"" ico=""36283410""
  xmlns:rsp=""http://www.stormware.cz/schema/version_2/response.xsd""
  xmlns:typ=""http://www.stormware.cz/schema/version_2/type.xsd""
  xmlns:lst=""http://www.stormware.cz/schema/version_2/list.xsd""
  xmlns:inv=""http://www.stormware.cz/schema/version_2/invoice.xsd"">
  <rsp:responsePackItem version=""2.0"" id=""p01"" state=""ok"">
    <lst:listInvoice version=""2.0"" invoiceType=""receivedInvoice"" state=""ok"">
      <lst:invoice version=""2.0""><inv:invoiceHeader><inv:id>1</inv:id>
        <inv:invoiceType>receivedInvoice</inv:invoiceType>
        <inv:number><typ:numberRequested>2026345</typ:numberRequested></inv:number>
        <inv:date>2026-07-31</inv:date><inv:dateTax>2026-07-31</inv:dateTax>
        <inv:accounting><typ:ids>518900 ost.sl.-tuz.</typ:ids></inv:accounting>
        <inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>
        <inv:text>Importné colné služby a administratívne poplatky</inv:text>
        <inv:partnerIdentity><typ:address><typ:company>MUNDUS Spedition</typ:company></typ:address></inv:partnerIdentity>
      </inv:invoiceHeader><inv:invoiceDetail><inv:invoiceItem>{textPolozky}
        <inv:homeCurrency><typ:price>20</typ:price><typ:priceVAT>0</typ:priceVAT></inv:homeCurrency>
        <inv:accounting><typ:ids>518900 ost.sl.-tuz.</typ:ids></inv:accounting>
        <inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>
      </inv:invoiceItem></inv:invoiceDetail></lst:invoice>
    </lst:listInvoice>
  </rsp:responsePackItem>
</rsp:responsePack>";

        var rows = PohodaXml.ParseHistoryRows(xml).Rows;
        Assert.Equal(ocakavanychRiadkov, rows.Count);
        if (ocakavanychRiadkov == 2)
        {
            Assert.Equal("T-1 Erledigung elektronisch im System", rows[1].LineText);
            // Zaúčtovanie sa dedí z hlavičky — položka o ňom nič nové nehovorí.
            Assert.Equal("518900 ost.sl.-tuz.", rows[1].PredkontaciaKod);
        }
    }

    // Natívne id POHODY (inv:id) je identita dokladu aj položky — číslo, dátum
    // ani poradie ňou nie sú. Číta sa LEN priame dieťa: number/typ:id je id
    // číselného radu (615) a accounting/typ:id id predkontácie.
    [Fact]
    public void ParseHistoryRows_CitaNativneIdDokladuAPolozky()
    {
        var printOffice = PohodaXml.ParseHistoryRows(ServerovaFixtura()).Rows.Where(row => row.DokladCislo == "DF260169").ToArray();
        Assert.Equal(new long?[] { 54393, 54393, 54393, 54393 }, printOffice.Select(row => row.DokladId));
        Assert.Equal(new long?[] { null, 50075, 50076, 50077 }, printOffice.Select(row => row.PolozkaId));

        const string bezId = """
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="h01" state="ok"><lst:listInvoice version="2.0"><lst:invoice version="2.0">
                <inv:invoiceHeader><inv:invoiceType>receivedInvoice</inv:invoiceType>
                  <inv:number><typ:id>615</typ:id><typ:ids>DF260</typ:ids><typ:numberRequested>DF260169</typ:numberRequested></inv:number>
                  <inv:accounting><typ:id>271</typ:id><typ:ids>repre</typ:ids></inv:accounting><inv:text>Repre</inv:text></inv:invoiceHeader>
                <inv:invoiceDetail><inv:invoiceItem><inv:text>Kava</inv:text><inv:accounting><typ:id>764</typ:id><typ:ids>repre</typ:ids></inv:accounting></inv:invoiceItem></inv:invoiceDetail>
              </lst:invoice></lst:listInvoice></rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var riadky = PohodaXml.ParseHistoryRows(bezId).Rows;
        Assert.Equal(2, riadky.Count);
        Assert.All(riadky, row => Assert.True(row.DokladId is null && row.PolozkaId is null));
    }

    // F11: hlavička bez textu zahodila celý doklad aj s položkami — a práve
    // v nich bolo rozúčtovanie. Rovnaké dva prípady drží server v uctoHistoriaXml.test.ts.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ParseHistoryRows_PolozkyHlavickyBezTextuNeprepadnu(bool hlavickaMaZauctovanie)
    {
        var zauctovanie = hlavickaMaZauctovanie
            ? "<inv:accounting><typ:ids>518900 ost.sl.-tuz.</typ:ids></inv:accounting><inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT>"
            : string.Empty;
        var xml = $"""
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="h01" state="ok"><lst:listInvoice version="2.0" state="ok"><lst:invoice version="2.0">
                <inv:invoiceHeader><inv:invoiceType>receivedInvoice</inv:invoiceType>
                  <inv:number><typ:numberRequested>2026345</typ:numberRequested></inv:number>{zauctovanie}
                </inv:invoiceHeader>
                <inv:invoiceDetail>
                  <inv:invoiceItem><inv:text>Natural 95 (nedaňová časť 20 %)</inv:text>
                    <inv:accounting><typ:ids>PHM-Nadspotreba</typ:ids></inv:accounting><inv:classificationVAT><typ:ids>PN</typ:ids></inv:classificationVAT></inv:invoiceItem>
                  <inv:invoiceItem><inv:text>Nafta</inv:text></inv:invoiceItem>
                </inv:invoiceDetail>
              </lst:invoice></lst:listInvoice></rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var parsed = PohodaXml.ParseHistoryRows(xml);
        var riadky = parsed.Rows.Select(row => $"{row.RiadokIndex}|{row.LineText}|{row.PredkontaciaKod}|{row.ClenenieDphKod}").ToArray();
        var preskocene = parsed.Agendy[0].Preskocene.OrderBy(dvojica => dvojica.Key, StringComparer.Ordinal).Select(dvojica => $"{dvojica.Key}={dvojica.Value}");
        if (hlavickaMaZauctovanie)
        {
            // Hlavička si požičia text prvej položky, položky idú ako pri každom doklade.
            Assert.Equal(
                ["0|Natural 95 (nedaňová časť 20 %)|518900 ost.sl.-tuz.|PN", "1|Natural 95 (nedaňová časť 20 %)|PHM-Nadspotreba|PN", "2|Nafta|518900 ost.sl.-tuz.|PN"],
                riadky);
            Assert.Empty(preskocene);
        }
        else
        {
            // Nafta nemá čo zdediť; každý preskočený riadok má dôvod, takže neúplná
            // história sa dá odlíšiť od prázdnej.
            Assert.Equal(["1|Natural 95 (nedaňová časť 20 %)|PHM-Nadspotreba|PN"], riadky);
            Assert.Equal(["hlavickaBezKodu=1", "polozkaBezKodu=1"], preskocene);
        }
        Assert.Equal($"1|2|{riadky.Length}", $"{parsed.Agendy[0].Dokladov}|{parsed.Agendy[0].Poloziek}|{parsed.Agendy[0].Riadkov}");
    }

    // Manifest prenosu: POHODA nevracia celkový počet záznamov, úplnosť dokazuje
    // len stav každej požiadavky. Chyba položky, požiadavka bez odpovede a delenie
    // na časti (rdc:parts) nesmú vyzerať ako úplná agenda.
    [Fact]
    public void ParseHistoryRows_ManifestPoznaChybuChybajucuPoziadavkuAParts()
    {
        const string response = """
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:rdc="http://www.stormware.cz/schema/version_2/documentresponse.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0" state="ok" programVersion="14301.4 SQL" key="a36b615a">
              <rsp:responsePackItem id="h01" state="ok"><lst:listInvoice version="2.0" state="ok"><lst:invoice version="2.0">
                <inv:invoiceHeader><inv:invoiceType>receivedInvoice</inv:invoiceType><inv:text>Tonery</inv:text><inv:accounting><typ:ids>501/321</typ:ids></inv:accounting></inv:invoiceHeader>
              </lst:invoice></lst:listInvoice></rsp:responsePackItem>
              <rsp:responsePackItem id="h02" state="error" note="Používateľ nemá právo na dobropisy." />
              <rsp:responsePackItem id="h03" state="ok"><lst:listInvoice version="2.0" state="ok"><rdc:parts><rdc:part>h03-2.xml</rdc:part></rdc:parts></lst:listInvoice></rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var parsed = PohodaXml.ParseHistoryRows(response);
        Assert.Equal("14301.4 SQL|a36b615a", $"{parsed.ProgramVersion}|{parsed.Kluc}");
        // Každá odoslaná požiadavka má v manifeste miesto — aj tá bez odpovede.
        Assert.Equal(12, parsed.Agendy.Count);
        Assert.Equal(
            ["receivedInvoice|FP|ok|1|1|", "receivedCreditNotice|FP-D|error|0|0|Používateľ nemá právo na dobropisy.", "receivedDebitNote|FP-T|parts|0|0|", "receivedAdvanceInvoice|FP-Z|chyba|0|0|"],
            parsed.Agendy.Take(4).Select(agenda => $"{agenda.Poziadavka}|{agenda.Agenda}|{agenda.Stav}|{agenda.Dokladov}|{agenda.Riadkov}|{agenda.Poznamka}"));
        Assert.Equal("intDoc|INT|chyba", $"{parsed.Agendy[11].Poziadavka}|{parsed.Agendy[11].Agenda}|{parsed.Agendy[11].Stav}");
    }

    // Upozornenie POHODY záznamy nezahodí — agenda je úplná a poznámka ostane
    // v manifeste. Inak by neškodný warning navždy blokoval publikáciu histórie.
    [Fact]
    public void ParseHistoryRows_WarningJeUplnaAgendaSPoznamkou()
    {
        const string response = """
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="h01" state="warning" note="Niektoré polia neboli exportované."><lst:listInvoice version="2.0" state="warning"><lst:invoice version="2.0">
                <inv:invoiceHeader><inv:invoiceType>receivedInvoice</inv:invoiceType><inv:text>Tonery</inv:text><inv:accounting><typ:ids>501/321</typ:ids></inv:accounting></inv:invoiceHeader>
              </lst:invoice></lst:listInvoice></rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var agenda = PohodaXml.ParseHistoryRows(response).Agendy[0];
        Assert.Equal("ok|1|Niektoré polia neboli exportované.", $"{agenda.Stav}|{agenda.Dokladov}|{agenda.Poznamka}");
        Assert.Empty(PohodaXml.ParseTrainingDecisions(response).Warnings);
    }

    // Hlavička dokladu: riadok korpusu nesie len dátum vystavenia. Dátum dane,
    // účtovania, dodania a KV, číslo dodávateľa, opravovaný doklad, symboly,
    // mena s kurzom a súhrn podľa sadzieb idú zvlášť — aj pri doklade, ktorý
    // korpusu nič nedá (dobropis nižšie nemá zaúčtovanie).
    [Fact]
    public void ParseHistoryRows_CitaHlavickuDokladuAVazby()
    {
        string Hlavicka(PohodaXml.HistoryDoklad d) => Riadok(
            d.Agenda, d.DokladId, d.DokladCislo, d.Datum, d.DatumDane, d.DatumUctovania, d.DatumDodania, d.DatumKvDph, d.DatumUplatneniaDph,
            d.ExterneCislo, d.OpravovanyDoklad, d.VarSymbol, d.ParSymbol, d.Mena, d.Kurz, d.KurzMnozstvo, d.SumaMena,
            d.ZakladNulova, d.ZakladZnizena, d.DphZnizena, d.SadzbaZnizena, d.ZakladZakladna, d.DphZakladna, d.SadzbaZakladna,
            d.Zaklad3, d.Dph3, d.Sadzba3, d.Zaokruhlenie);
        string Vazba(PohodaXml.HistoryVazba v) => Riadok(v.Typ, v.DruhaAgenda, v.DruhyDokladId, v.DruhyDokladCislo, v.LikvidaciaId, v.Datum, v.Suma, v.SumaMena);

        // Reálny export ALPINY: date z likvidácie (2026-07-27) nesmie prekryť dátumy hlavičky.
        var printOffice = PohodaXml.ParseHistoryRows(ServerovaFixtura()).Doklady.First(doklad => doklad.DokladId == 54393);
        Assert.Equal(
            "FP|54393|DF260169|2026-07-16|2026-07-16|2026-07-16|2026-07-16|||262201902||262201902|262201902|||||181.64|0|0|19|49.7|11.43|23|0|0|5|0",
            Hlavicka(printOffice));
        Assert.Empty(printOffice.Vazby);

        const string xml = """
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:int="http://www.stormware.cz/schema/version_2/intDoc.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="h02" state="ok"><lst:listInvoice version="2.0" state="ok"><lst:invoice version="2.0">
                <inv:invoiceHeader><inv:id>70</inv:id><inv:invoiceType>receivedCreditNotice</inv:invoiceType>
                  <inv:number><typ:id>615</typ:id><typ:numberRequested>DF260200</typ:numberRequested></inv:number>
                  <inv:originalDocument>CN-77</inv:originalDocument><inv:originalDocumentNumber>INV-2024-118</inv:originalDocumentNumber>
                  <inv:date>2026-08-03</inv:date><inv:dateTax>2026-07-31</inv:dateTax><inv:dateApplicationVAT>2026-08-01</inv:dateApplicationVAT>
                </inv:invoiceHeader>
                <inv:invoiceSummary>
                  <inv:homeCurrency><typ:priceHigh>-40</typ:priceHigh><typ:priceHighVAT rate="23">-9.2</typ:priceHighVAT><typ:round><typ:priceRound>0.01</typ:priceRound></typ:round></inv:homeCurrency>
                  <inv:foreignCurrency><typ:currency><typ:id>3</typ:id><typ:ids>CZK</typ:ids></typ:currency><typ:rate>25.12</typ:rate><typ:amount>1</typ:amount><typ:priceSum>-1236</typ:priceSum></inv:foreignCurrency>
                </inv:invoiceSummary>
                <inv:linkedDocuments>
                  <typ:link><typ:sourceAgenda>receivedInvoice</typ:sourceAgenda><typ:sourceDocument><typ:id>54393</typ:id><typ:number>DF260169</typ:number></typ:sourceDocument></typ:link>
                  <typ:manualLink><typ:sourceAgenda>internalDocuments</typ:sourceAgenda><typ:sourceDocument><typ:number>INT0005</typ:number></typ:sourceDocument></typ:manualLink>
                </inv:linkedDocuments>
                <inv:liquidations><typ:liquidation><typ:id>901</typ:id><typ:date>2026-08-20</typ:date><typ:sourceAgenda>bank</typ:sourceAgenda>
                  <typ:sourceDocument><typ:id>3301</typ:id><typ:number>BV26-015</typ:number></typ:sourceDocument>
                  <typ:amount>-49.19</typ:amount><typ:foreignCurrencyAmount>-1236</typ:foreignCurrencyAmount><typ:foreignCurrencySource>0</typ:foreignCurrencySource></typ:liquidation></inv:liquidations>
              </lst:invoice></lst:listInvoice></rsp:responsePackItem>
              <rsp:responsePackItem id="h12" state="ok"><lst:listIntDoc version="2.0" state="ok"><lst:intDoc version="2.0">
                <int:intDocHeader><int:id>70</int:id><int:number><typ:numberRequested>INT0005</typ:numberRequested></int:number>
                  <int:symVar>2607</int:symVar><int:symPar>DF260200</int:symPar><int:originalDocumentNumber>DF260169</int:originalDocumentNumber>
                  <int:date>2026-07-31</int:date><int:dateTax>2026-07-30</int:dateTax><int:dateAccounting>2026-08-02</int:dateAccounting>
                  <int:dateDelivery>2026-07-15</int:dateDelivery><int:dateKVDPH>2026-08-01</int:dateKVDPH>
                  <int:text>Samozdanenie</int:text><int:accounting><typ:ids>DD</typ:ids></int:accounting>
                </int:intDocHeader>
                <int:linkedDocuments><typ:manualLink><typ:sourceAgenda>receivedInvoice</typ:sourceAgenda><typ:sourceDocument><typ:id>54393</typ:id><typ:number>DF260169</typ:number></typ:sourceDocument></typ:manualLink></int:linkedDocuments>
              </lst:intDoc></lst:listIntDoc></rsp:responsePackItem>
            </rsp:responsePack>
            """;
        var parsed = PohodaXml.ParseHistoryRows(xml);
        Assert.Equal(
            [
                "FP-D|70|DF260200|2026-08-03|2026-07-31||||2026-08-01|CN-77|INV-2024-118|||CZK|25.12|1|-1236|||||-40|-9.2|23||||0.01",
                "INT|70|INT0005|2026-07-31|2026-07-30|2026-08-02|2026-07-15|2026-08-01|||DF260169|2607|DF260200|||||||||||||||",
            ],
            parsed.Doklady.Select(Hlavicka));
        Assert.Equal(
            ["link|receivedInvoice|54393|DF260169||||", "manualLink|internalDocuments||INT0005||||", "liquidation|bank|3301|BV26-015|901|2026-08-20|-49.19|-1236"],
            parsed.Doklady[0].Vazby.Select(Vazba));
        Assert.Equal(["manualLink|receivedInvoice|54393|DF260169||||"], parsed.Doklady[1].Vazby.Select(Vazba));
        // Dobropis bez zaúčtovania korpusu nič nedal, hlavičku áno.
        Assert.Equal(["INT"], parsed.Rows.Select(row => row.Agenda));
    }

    // Neuhradené faktúry: uhradená má v likvidácii len dátum, zostatok dobropisu
    // je záporný a devízová nesie zostatok v mene. Suma je súhrn podľa sadzieb.
    [Fact]
    public void ParseOpenInvoices_BerieLenFakturySoZostatkom()
    {
        static string Odpoved(string o03) => """
            <rsp:responsePack xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd" xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd" version="2.0" state="ok">
              <rsp:responsePackItem id="o01" state="ok"><lst:listInvoice version="2.0" state="ok">
                <lst:invoice version="2.0"><inv:invoiceHeader><inv:id>1</inv:id><inv:invoiceType>receivedInvoice</inv:invoiceType>
                  <inv:number><typ:numberRequested>DF260001</typ:numberRequested></inv:number><inv:liquidation><typ:date>2026-02-01</typ:date></inv:liquidation></inv:invoiceHeader></lst:invoice>
                <lst:invoice version="2.0"><inv:invoiceHeader><inv:id>2</inv:id><inv:invoiceType>receivedInvoice</inv:invoiceType>
                  <inv:number><typ:id>615</typ:id><typ:numberRequested>DF260300</typ:numberRequested></inv:number><inv:symVar>260300</inv:symVar>
                  <inv:partnerIdentity><typ:id>9</typ:id><typ:address><typ:company>Dodavatel s.r.o.</typ:company><typ:ico>12345678</typ:ico></typ:address></inv:partnerIdentity>
                  <inv:liquidation><typ:amountHome>123</typ:amountHome></inv:liquidation></inv:invoiceHeader>
                  <inv:invoiceSummary><inv:homeCurrency><typ:priceHigh>100</typ:priceHigh><typ:priceHighVAT rate="23">23</typ:priceHighVAT><typ:priceHighSum>123</typ:priceHighSum></inv:homeCurrency></inv:invoiceSummary></lst:invoice>
                <lst:invoice version="2.0"><inv:invoiceHeader><inv:id>3</inv:id><inv:invoiceType>receivedInvoice</inv:invoiceType>
                  <inv:number><typ:numberRequested>DF260301</typ:numberRequested></inv:number>
                  <inv:liquidation><typ:date>2026-03-01</typ:date><typ:amountHome>99.52</typ:amountHome><typ:amountForeign>2500</typ:amountForeign></inv:liquidation></inv:invoiceHeader>
                  <inv:invoiceSummary><inv:homeCurrency><typ:priceNone>199.04</typ:priceNone></inv:homeCurrency>
                    <inv:foreignCurrency><typ:currency><typ:ids>CZK</typ:ids></typ:currency><typ:rate>25.12</typ:rate><typ:priceSum>5000</typ:priceSum></inv:foreignCurrency></inv:invoiceSummary></lst:invoice>
              </lst:listInvoice></rsp:responsePackItem>
            """ + o03 + string.Concat(Enumerable.Range(4, 7).Select(index => index == 6
                ? """<rsp:responsePackItem id="o06" state="ok"><lst:listInvoice version="2.0" state="ok"><lst:invoice version="2.0"><inv:invoiceHeader><inv:id>2</inv:id><inv:invoiceType>issuedCreditNotice</inv:invoiceType><inv:liquidation><typ:amountHome>-50</typ:amountHome></inv:liquidation></inv:invoiceHeader></lst:invoice></lst:listInvoice></rsp:responsePackItem>"""
                : $"""<rsp:responsePackItem id="o{index:D2}" state="ok"/>""")) + """<rsp:responsePackItem id="o02" state="ok"/></rsp:responsePack>""";

        var faktury = PohodaXml.ParseOpenInvoices(Odpoved("""<rsp:responsePackItem id="o03" state="ok"/>"""));
        Assert.Equal(
            [
                "FP|2|DF260300|12345678|Dodavatel s.r.o.|260300||123||123|",
                "FP|3|DF260301||||CZK|199.04|5000|99.52|2500",
                "FV-D|2||||||||-50|",
            ],
            faktury.Select(f => Riadok(f.Agenda, f.DokladId, f.DokladCislo, f.PartnerIco, f.PartnerNazov, f.VarSymbol, f.Mena, f.Suma, f.SumaMena, f.Zostatok, f.ZostatokMena)));
        // Neúplná odpoveď by na serveri nahradila celý zoznam — radšej nič.
        var chyba = Assert.Throws<InvalidOperationException>(() => PohodaXml.ParseOpenInvoices(Odpoved("""<rsp:responsePackItem id="o03" state="error" note="Chýba právo."/>""")));
        Assert.Contains("FP-T: error", chyba.Message, StringComparison.Ordinal);
    }

    private static string Riadok(params object?[] polia) => string.Join("|", polia.Select(pole => Convert.ToString(pole, System.Globalization.CultureInfo.InvariantCulture)));

    private static string ServerovaFixtura()
    {
        var koren = AppContext.BaseDirectory;
        while (koren is not null && !File.Exists(Path.Combine(koren, "server", "services", "__fixtures__", "pohoda-doklady-s-polozkami.xml")))
        {
            koren = Path.GetDirectoryName(koren);
        }
        Assert.NotNull(koren);
        return File.ReadAllText(Path.Combine(koren!, "server", "services", "__fixtures__", "pohoda-doklady-s-polozkami.xml"));
    }
}
