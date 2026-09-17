using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using System.Xml.Schema;

namespace Dokladovka.Agent;

public sealed record ParsedCodeLists(IReadOnlyDictionary<string, IReadOnlyList<CodeListValue>> Items, IReadOnlyList<string> Warnings);
public sealed record ParsedExportResponse(IReadOnlyList<ExportDocumentResult> Results, string PackState, string? Note);
public sealed record ParsedTrainingDecisions(IReadOnlyList<TrainingDecision> Items, IReadOnlyList<string> Warnings);

public static class PohodaXml
{
    private const string StormwareNamespace = "stormware.cz/schema/version_2/";

    public static string BuildCodeListRequest(string ico, string requestId) => $"""
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Export ciselnikov"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:lCen="http://www.stormware.cz/schema/version_2/list_centre.xsd">
  <dat:dataPackItem id="c01" version="2.0"><lst:listAccountingDoubleEntryRequest version="1.1"/></dat:dataPackItem>
  <dat:dataPackItem id="c02" version="2.0"><lst:listClassificationVATRequest version="2.0" classificationVATVersion="2.0"><lst:requestClassificationVAT/></lst:listClassificationVATRequest></dat:dataPackItem>
  <dat:dataPackItem id="c03" version="2.0"><lst:listNumericalSeriesRequest version="2.0" numericalSeriesVersion="2.0"><lst:requestNumericalSeries/></lst:listNumericalSeriesRequest></dat:dataPackItem>
  <dat:dataPackItem id="c04" version="2.0"><lCen:listCentreRequest version="2.0" centreVersion="2.0"><lCen:requestCentre/></lCen:listCentreRequest></dat:dataPackItem>
  <dat:dataPackItem id="c05" version="2.0"><lst:listBankAccountRequest version="2.0" bankAccountVersion="2.0"><lst:requestBankAccount/></lst:listBankAccountRequest></dat:dataPackItem>
</dat:dataPack>
""";

    // Prijaté typy agendy FA — parita s ručným importom .mdb (RelTpFak 11/12/15).
    private static readonly string[] ReceivedInvoiceTypes = ["receivedInvoice", "receivedCreditNotice", "receivedAdvanceInvoice"];

    /// <summary>invoiceType z POHODY → podtyp, ako ho pozná server.</summary>
    private static string PodtypZTypu(string? invoiceType) => invoiceType switch
    {
        "receivedCreditNotice" or "issuedCreditNotice" => "dobropis",
        "receivedDebitNote" or "issuedDebitNote" => "tarchopis",
        "receivedAdvanceInvoice" or "issuedAdvanceInvoice" => "zalohova",
        _ => "bezna",
    };
    // Zákonné sekcie kontrolného výkazu DPH (parita s CLENENIE_KV_KODY na webe).
    private static readonly HashSet<string> KvSekcie = new(["A1", "A2", "B1", "B2", "B3", "C1", "C2", "D1", "D2", "KN"], StringComparer.Ordinal);

    /// <summary>Tréning AI: export prijatých faktúr — číta históriu, v POHODE nič nemení.</summary>
    public static string BuildInvoiceListRequest(string ico, string requestId)
    {
        var items = string.Join("\n", ReceivedInvoiceTypes.Select((type, index) =>
            $"""  <dat:dataPackItem id="t{index + 1:D2}" version="2.0"><lst:listInvoiceRequest version="2.0" invoiceType="{type}" invoiceVersion="2.0"><lst:requestInvoice/></lst:listInvoiceRequest></dat:dataPackItem>"""));
        return $"""
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Export historie zauctovani"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd">
{items}
</dat:dataPack>
""";
    }

    public static ParsedTrainingDecisions ParseTrainingDecisions(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var root = document.Root ?? throw new InvalidOperationException("POHODA vrátila prázdne XML.");
        if (root.Attribute("state")?.Value == "error") throw new InvalidOperationException($"POHODA vrátila chybu: {ErrorNote(root)}");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var rows = new List<TrainingDecision>();
        foreach (var invoice in document.Descendants().Where(item => IsStormware(item) && item.Name.LocalName == "invoice"))
        {
            var header = invoice.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "invoiceHeader");
            if (header is null) continue;
            var type = FindText(header, "invoiceType");
            if (type is null || !ReceivedInvoiceTypes.Contains(type, StringComparer.Ordinal)) continue;
            var partner = header.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "partnerIdentity");
            var supplierIco = Trimmed(partner is null ? null : FindText(partner, "ico"));
            var supplierName = Trimmed(partner is null ? null : FindText(partner, "company"));
            var predkontacia = RefIds(header, "accounting");
            var clenenieDph = RefIds(header, "classificationVAT");
            if ((supplierIco is null && supplierName is null) || (predkontacia is null && clenenieDph is null)) continue;
            var row = new TrainingDecision(
                PodtypZTypu(type),
                supplierIco,
                supplierName,
                Trimmed(header.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "text")?.Value),
                predkontacia,
                clenenieDph,
                ZakladnaKvSekcia(RefIds(header, "classificationKVDPH")));
            // Opakované identické doklady sa zlúčia — server aj tak deduplikuje.
            var key = string.Join("\u0001", row.SupplierIco, row.SupplierName, row.LineText, row.PredkontaciaKod, row.ClenenieDphKod, row.ClenenieKvKod);
            if (seen.Add(key)) rows.Add(row);
        }
        // „warning" záznamy vrátil, takže manifest pamäte ho nesmie brať ako chybu (StavPoziadavky).
        var warnings = document.Descendants().Where(item => IsStormware(item) && item.Name.LocalName == "responsePackItem" && item.Attribute("state")?.Value is not ("ok" or "warning"))
            .Select(item => FindText(item, "note") ?? item.Attribute("note")?.Value ?? "POHODA nevrátila časť faktúr.").ToArray();
        return new ParsedTrainingDecisions(rows, warnings);
    }

    // Agendy korpusu histórie. Typ faktúry určuje agendu priamo; pokladňu delí
    // smer dokladu a interné doklady sú vlastná agenda. Banka sa neučí.
    //
    // Dobropis, ťarchopis a zálohová faktúra dostávajú VLASTNÚ agendu, hoci
    // v POHODE zdieľajú okno s faktúrou. Predtým sa všetky zliali do FP/FV a
    // korpus ich nevedel rozlíšiť: dobropis je oprava základu dane (sekcia KV
    // C1/C2, nie A1/B1) a zálohová do výkazu nevstupuje vôbec. V jednej hromade
    // si prevažujúce zaúčtovania protirečili.
    //
    // Ťarchopis (DebitNote) sa predtým nesťahoval vôbec — v zozname chýbal.
    private static readonly (string Type, string Agenda)[] HistoryInvoiceTypes =
    [
        ("receivedInvoice", "FP"), ("receivedCreditNotice", "FP-D"),
        ("receivedDebitNote", "FP-T"), ("receivedAdvanceInvoice", "FP-Z"),
        ("issuedInvoice", "FV"), ("issuedCreditNotice", "FV-D"),
        ("issuedDebitNote", "FV-T"), ("issuedAdvanceInvoice", "FV-Z"),
        // Ostatné pohľadávky — vlastná agenda korpusu. Bez nej by ich parsovanie
        // zaradilo do zvyšku agendy FA, teda medzi ostatné ZÁVÄZKY: pohľadávka
        // by sa v korpuse tvárila ako dlh.
        ("receivable", "OP"),
    ];

    // Celá agenda FA: typy s vlastnou agendou korpusu a ostatné záväzky (pozri nižšie).
    private static readonly (string Type, string Agenda)[] FakturoveAgendy = [.. HistoryInvoiceTypes, ("commitment", "OZ")];

    /// <summary>
    /// Účtovný profil: export VŠETKÝCH dokladových agend (faktúry prijaté aj
    /// vydané vrátane dobropisov, ťarchopisov a zálohových, ostatné záväzky,
    /// pokladňa, interné doklady) — banka zatiaľ nie.
    /// Číta históriu, v POHODE nič nemení. Na rozdiel od BuildInvoiceListRequest,
    /// ktorý plní pamäť dodávateľov a preto berie len prijaté faktúry.
    /// </summary>
    // Požiadavky histórie v poradí dataPackItemov h01, h02… Podľa poradia sa
    // odpoveď (responsePackItem id) páruje späť na agendu do manifestu prenosu.
    //
    // Ostatné záväzky (commitment) nie sú v HistoryInvoiceTypes zámerne —
    // tam ide o typy, ktoré majú vlastnú agendu korpusu. OZ vzniká až pri
    // parsovaní ako zvyšok agendy FA, ale dopyt naň sa musí poslať zvlášť,
    // inak POHODA žiadne nevráti. Presne to sa aj dialo: komentár sľuboval
    // ostatné záväzky, korpus ich nemal ani jeden a analýza pre agendu OZ
    // nenašla nič — nie preto, že by ich firma neúčtovala.
    // ponytail: jedna požiadavka bez stránkovania na databázu (stačí všetkým 8
    //   firmám). Keď firma narazí na parts alebo timeout, stránkovať agendy
    //   cez ftr:idFrom ako denník.
    // Likvidácie faktúry POHODA bez restrictionData neexportuje (predvolene false);
    // väzby (linkedDocuments, záložka „Doklady") áno.
    private static readonly (string Poziadavka, string? Agenda, string Xml)[] HistoryRequests =
    [
        .. FakturoveAgendy.Select(item => (item.Type, (string?)item.Agenda,
            $"""<lst:listInvoiceRequest version="2.0" invoiceType="{item.Type}" invoiceVersion="2.0"><lst:requestInvoice/><lst:restrictionData><lst:liquidations>true</lst:liquidations></lst:restrictionData></lst:listInvoiceRequest>""")),
        // Pokladňa nesie príjem aj výdaj (PPD/VPD) — agenda sa určí až z dokladu.
        ("voucher", null, """<lst:listVoucherRequest version="2.0" voucherVersion="2.0"><lst:requestVoucher/></lst:listVoucherRequest>"""),
        ("intDoc", "INT", """<lst:listIntDocRequest version="2.0" intDocVersion="2.0"><lst:requestIntDoc/></lst:listIntDocRequest>"""),
    ];

    public static string BuildHistoryListRequest(string ico, string requestId)
    {
        var items = HistoryRequests.Select((request, index) =>
            $"""  <dat:dataPackItem id="h{index + 1:D2}" version="2.0">{request.Xml}</dat:dataPackItem>""");
        return $"""
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Export historie pre uctovny profil"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd">
{string.Join("\n", items)}
</dat:dataPack>
""";
    }

    /// <summary>
    /// Neuhradené faktúry pre párovanie banky — celá agenda FA. Filter na
    /// neuhradené XML export nemá; vyberá ich ParseOpenInvoices podľa zostatku.
    /// </summary>
    public static string BuildOpenInvoicesRequest(string ico, string requestId)
    {
        var items = FakturoveAgendy.Select((item, index) =>
            $"""  <dat:dataPackItem id="o{index + 1:D2}" version="2.0"><lst:listInvoiceRequest version="2.0" invoiceType="{item.Type}" invoiceVersion="2.0"><lst:requestInvoice/></lst:listInvoiceRequest></dat:dataPackItem>""");
        return $"""
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Export otvorenych faktur"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd">
{string.Join("\n", items)}
</dat:dataPack>
""";
    }

    /// <summary>Neuhradená faktúra. Mena null = domáca; zostatok je „K likvidácii" z POHODY.</summary>
    public sealed record OpenInvoice(
        string Agenda, long DokladId, string? DokladCislo, string? PartnerIco, string? PartnerNazov, string? VarSymbol,
        string? Mena, decimal? Suma, decimal? SumaMena, decimal? Zostatok, decimal? ZostatokMena);

    /// <summary>
    /// Faktúry so zostatkom k likvidácii. Uhradená faktúra ho nemá — v jej
    /// liquidation POHODA vypíše len dátum (reálny export ALPINY). Server zoznam
    /// nahradí celý, preto neúplná odpoveď (chyba, chýbajúca požiadavka, parts)
    /// nevráti nič a spadne: časť faktúr by z párovania ticho zmizla.
    /// </summary>
    public static IReadOnlyList<OpenInvoice> ParseOpenInvoices(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var root = document.Root ?? throw new InvalidOperationException("POHODA vrátila prázdne XML.");
        if (root.Attribute("state")?.Value == "error") throw new InvalidOperationException($"POHODA vrátila chybu: {ErrorNote(root)}");
        for (var index = 1; index <= FakturoveAgendy.Length; index++)
        {
            var stav = StavPoziadavky(root.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "responsePackItem" && item.Attribute("id")?.Value == $"o{index:D2}"));
            if (stav != "ok") throw new InvalidOperationException($"POHODA nevrátila všetky faktúry ({FakturoveAgendy[index - 1].Agenda}: {stav}): {ErrorNote(root)}");
        }
        var faktury = new List<OpenInvoice>();
        foreach (var (element, _, agenda) in HistoryDocuments(document))
        {
            var header = Dieta(element, "invoiceHeader");
            var likvidacia = Dieta(header, "liquidation");
            var zostatok = Ciastka(likvidacia, "amountHome");
            var zostatokMena = Ciastka(likvidacia, "amountForeign");
            // Nenulový, nie kladný: zostatok dobropisu je záporný.
            if (header is null || NativeId(header) is not long dokladId || (zostatok ?? 0) == 0 && (zostatokMena ?? 0) == 0) continue;
            var h = CitajHlavicku(element, header, agenda(header), dokladId, null, null);
            decimal?[] casti = [h.ZakladNulova, h.ZakladZnizena, h.DphZnizena, h.ZakladZakladna, h.DphZakladna, h.Zaklad3, h.Dph3, h.Zaokruhlenie];
            var partner = Dieta(header, "partnerIdentity");
            faktury.Add(new OpenInvoice(
                h.Agenda, dokladId, Trimmed(FindText(header, "numberRequested") ?? FindText(header, "number")),
                Trimmed(partner is null ? null : FindText(partner, "ico")), Trimmed(partner is null ? null : FindText(partner, "company")),
                h.VarSymbol, h.Mena, casti.Any(cast => cast is not null) ? casti.Sum() : null, h.SumaMena, zostatok, zostatokMena));
        }
        return faktury;
    }

    /// <summary>
    /// Účtovný denník za jeden rok. Nesie to, čo hlavička ani položky neukážu:
    /// výsledné proviozky s účtami MD/DAL, teda aj to, na koľko účtov doklad
    /// nakoniec padol. Odpoveď sa neparsuje tu — posiela sa serveru surová,
    /// aby jeden formát nemal dva parsery (parseDennik už na serveri je).
    ///
    /// Strana má 10 000 proviozok — strop schémy (filter.xsd limitType). Denník
    /// sa preto stránkuje cez idFrom: SLO SERVICES narazila na strop presne
    /// (v korpuse ostalo 10 000 riadkov) a zvyšok roka sa nepreniesol vôbec.
    /// Prvá strana ide bez idFrom, ďalšie od najvyššieho id predchádzajúcej.
    /// </summary>
    public static string BuildDennikRequest(string ico, string requestId, int rok, long? idFrom = null) => $"""
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Export uctovneho dennika"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd">
  <dat:dataPackItem id="dennik" version="2.0">
    <lst:listAccountancyRequest version="2.0" accountancyVersion="2.0">
      <lst:limit>{(idFrom is long od ? $"<ftr:idFrom>{od}</ftr:idFrom>" : "")}<ftr:count>{DennikStrana}</ftr:count></lst:limit>
      <lst:requestAccountancy>
        <ftr:filter>
          <ftr:dateFrom>{rok:D4}-01-01</ftr:dateFrom>
          <ftr:dateTill>{rok:D4}-12-31</ftr:dateTill>
        </ftr:filter>
      </lst:requestAccountancy>
    </lst:listAccountancyRequest>
  </dat:dataPackItem>
</dat:dataPack>
""";

    /// <summary>Veľkosť strany účtovného denníka — strop schémy filter.xsd.</summary>
    public const int DennikStrana = 10_000;

    /// <summary>
    /// Koľko proviozok strana denníka nesie a najvyššie id medzi nimi — podľa
    /// toho sa pýta ďalšia strana. Odpoveď inak ide serveru surová (parseDennik),
    /// tu sa z nej číta len toto.
    /// </summary>
    public static (int Pocet, long? NajvyssieId) CitajStranuDennika(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var root = document.Root ?? throw new InvalidOperationException("POHODA vrátila prázdne XML.");
        if (root.Attribute("state")?.Value == "error") throw new InvalidOperationException($"POHODA vrátila chybu: {ErrorNote(root)}");
        // Chyba položky (napr. chýbajúce právo) nesmie vyzerať ako prázdna strana
        // — slučka by skončila a denník by sa ohlásil ako úspešne prenesený.
        if (root.Elements().Any(node => IsStormware(node) && node.Name.LocalName == "responsePackItem"
            && node.Attribute("state")?.Value is { } stav && stav != "ok"))
            throw new InvalidOperationException($"POHODA vrátila chybu denníka: {ErrorNote(root)}");
        var polozky = document.Descendants()
            .Where(node => IsStormware(node) && node.Name.LocalName == "accountingItem")
            .ToArray();
        long? najvyssie = null;
        foreach (var polozka in polozky)
        {
            var id = polozka.Elements().FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == "id")?.Value;
            if (long.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var hodnota)
                && (najvyssie is null || hodnota > najvyssie))
                najvyssie = hodnota;
        }
        return (polozky.Length, najvyssie);
    }

    /// <summary>Riadok korpusu histórie — musí sedieť s historyRowSchema na serveri.</summary>
    public sealed record HistoryRow(
        string Agenda,
        string? DokladCislo,
        string? Datum,
        string? SupplierIco,
        string? SupplierName,
        string LineText,
        string? PredkontaciaKod,
        string? ClenenieDphKod,
        string? ClenenieKvKod,
        /// <summary>0 = hlavička dokladu, 1..n jeho položky. Ide do odtlačku
        /// riadka na serveri; bez neho by položka dostala poradie podľa pozície
        /// v dávke a pri prvom doklade by kolidovala s vlastnou hlavičkou.</summary>
        int? RiadokIndex = null,
        /// <summary>Základ a DPH položky. Bez nich sa pomer rozúčtovania nedá
        /// prečítať a krátenie odpočtu (PHM 50 %) z podielu základu nevyplýva.</summary>
        decimal? Suma = null,
        decimal? SumaDph = null,
        /// <summary>Sadzba DPH položky ako číslo. Bez nej korpus nevie odlíšiť
        /// tuzemskú daň s odpočtom (23 %) od cudzej bez odpočtu (20 % AT) —
        /// a práve to rozhoduje medzi PD a PN, aj pri delení PHM 80/20.</summary>
        decimal? SadzbaDph = null,
        /// <summary>Stredisko riadku. Bez neho ho história nevie navrhnúť nikdy.</summary>
        string? StrediskoKod = null,
        /// <summary>Číselný rad dokladu tak, ako ho POHODA nesie v hlavičke:
        /// identifikátor (typ:id) a prefix (typ:ids). Bez nich server rad nového
        /// dokladu hádal zo začiatku čísla — a marcová faktúra 26030… sa zhodla
        /// s ťarchopismi 2603. Z histórie sa tak rad pre druh dokladu počíta.</summary>
        string? RadExternalId = null,
        string? RadKod = null,
        /// <summary>Krajina protistrany (ISO kód). Firma rady delí aj podľa nej
        /// („Prijaté faktúry SK" proti „zahraničné") a bez nej sa to z histórie
        /// nedá vyčítať.</summary>
        string? Krajina = null,
        /// <summary>Natívne id dokladu a položky v POHODE (inv:id). Číslo, dátum
        /// aj poradie položky sa dajú zmeniť, id nie — server z nich skladá
        /// identitu riadka. Starý server ich nepozná, posielajú sa len v protokole 2.</summary>
        long? DokladId = null,
        long? PolozkaId = null);

    /// <summary>
    /// Číselný rad prečítaný z DOKLADU, nie z číselníka. POHODA rad, ktorý nemá
    /// vyplnené Obdobie, do listNumericalSeries vôbec nedá — v jej schéme je
    /// element „period" povinný, takže taký záznam nevie zapísať. ALPINA tak
    /// prišla o päť radov vrátane 26OZ, na ktorom má stovky dokladov.
    /// Doklad ten istý rad nesie bez problémov: &lt;typ:id&gt; je jeho identifikátor
    /// a &lt;typ:ids&gt; prefix, presne ako ich vracia číselník.
    /// </summary>
    public sealed record SeriesRow(string ExternalId, string Kod, string Agenda, string? PosledneCislo);

    /// <summary>
    /// Hlavička dokladu — to, čo riadok korpusu nenesie: dátum dane, účtovania,
    /// dodania a KV (každý zvlášť, nie jeden dátum za všetky), číslo dokladu
    /// dodávateľa (originalDocument) oddelene od opravovaného dokladu
    /// (originalDocumentNumber), symboly, mena s kurzom a súhrn podľa sadzieb
    /// DPH. Znížená/základná/tretia sadzba sú polia POHODY (priceLow/High/3),
    /// percento nesie atribút rate. Doklad bez natívneho id sa neposiela.
    /// </summary>
    public sealed record HistoryDoklad(
        string Agenda, long DokladId, string? DokladCislo,
        string? Datum, string? DatumDane, string? DatumUctovania, string? DatumDodania, string? DatumKvDph, string? DatumUplatneniaDph,
        string? ExterneCislo, string? OpravovanyDoklad, string? VarSymbol, string? ParSymbol,
        string? Mena, decimal? Kurz, int? KurzMnozstvo, decimal? SumaMena,
        decimal? ZakladNulova, decimal? ZakladZnizena, decimal? DphZnizena, decimal? SadzbaZnizena,
        decimal? ZakladZakladna, decimal? DphZakladna, decimal? SadzbaZakladna,
        decimal? Zaklad3, decimal? Dph3, decimal? Sadzba3, decimal? Zaokruhlenie,
        IReadOnlyList<HistoryVazba> Vazby);

    /// <summary>Väzba dokladu (linkedDocuments: link = prenos, manualLink = ručná
    /// väzba) alebo jeho likvidácia (liquidation) s druhým dokladom a sumou.
    /// Iba export — importom sa väzba v POHODE nezaloží.</summary>
    public sealed record HistoryVazba(
        string Typ, string? DruhaAgenda, long? DruhyDokladId, string? DruhyDokladCislo,
        long? LikvidaciaId = null, string? Datum = null, decimal? Suma = null, decimal? SumaMena = null);

    /// <summary>Agendy = manifest prenosu po požiadavkách (h01…): stav, počty
    /// a preskočené podľa dôvodu. ProgramVersion a Kluc sú z hlavičky odpovede.</summary>
    public sealed record ParsedHistory(
        IReadOnlyList<HistoryRow> Rows, IReadOnlyList<string> Warnings, IReadOnlyList<SeriesRow> Series,
        IReadOnlyList<ImportAgenda> Agendy, string? ProgramVersion, string? Kluc, IReadOnlyList<HistoryDoklad> Doklady);

    /// <summary>
    /// Rozloží odpoveď na BuildHistoryListRequest na riadky korpusu. Hlavička bez
    /// textu alebo bez predkontácie aj členenia sa preskočí, jej položky nie.
    /// Duplicity sa NEZLUČUJÚ: početnosť je pre analýzu hlavný signál
    /// a odtlačok riadka na serveri ich rozlíši podľa čísla dokladu.
    /// </summary>
    /// <summary>Záznam adresára POHODY — to, čo účtovník o firme raz zadal.</summary>
    public sealed record AddressBookRow(
        string Nazov, string? Ico, string? Dic, string? IcDph,
        string? Ulica, string? Mesto, string? Psc, string? Krajina);

    /// <summary>
    /// Dopyt na adresár. Údaje o firme (IČ DPH, adresa) sa dovtedy čítali iba
    /// z PDF každej faktúry nanovo — a pri nezvyklom cudzom blankete sa
    /// nenašli, hoci ich účtovník má v POHODE dávno zadané.
    ///
    /// POZOR na menný priestor: listAddressBookRequest NIE JE v list.xsd ako
    /// ostatné zoznamy, ale vo vlastnom list_addBook.xsd. S prefixom `lst:`
    /// POHODA celý dataPackItem odmietne a adresár sa ticho nestiahne.
    /// </summary>
    public static string BuildAddressBookRequest(string ico, string requestId) => $"""
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Export adresara"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lAdb="http://www.stormware.cz/schema/version_2/list_addBook.xsd">
  <dat:dataPackItem id="ab01" version="2.0"><lAdb:listAddressBookRequest version="2.0" addressBookVersion="2.0"><lAdb:requestAddressBook/></lAdb:listAddressBookRequest></dat:dataPackItem>
</dat:dataPack>
""";

    public static IReadOnlyList<AddressBookRow> ParseAddressBookRows(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var root = document.Root ?? throw new InvalidOperationException("POHODA vrátila prázdne XML.");
        if (root.Attribute("state")?.Value == "error") throw new InvalidOperationException($"POHODA vrátila chybu: {ErrorNote(root)}");

        var rows = new List<AddressBookRow>();
        foreach (var header in document.Descendants().Where(item => IsStormware(item) && item.Name.LocalName == "addressbookHeader"))
        {
            // Fakturačná adresa je v identity/address; company je názov firmy.
            var address = header.Descendants().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "address");
            if (address is null) continue;
            var nazov = Trimmed(FindText(address, "company")) ?? Trimmed(FindText(address, "name"));
            // Bez názvu sa firma nemá ako spárovať s dodávateľom z faktúry.
            if (nazov is null) continue;
            rows.Add(new AddressBookRow(
                nazov,
                Trimmed(FindText(address, "ico")),
                Trimmed(FindText(address, "dic")),
                Trimmed(FindText(address, "icDph")),
                Trimmed(FindText(address, "street")),
                Trimmed(FindText(address, "city")),
                Trimmed(FindText(address, "zip")),
                Trimmed(address.Descendants().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "country")?
                    .Descendants().FirstOrDefault(item => item.Name.LocalName == "ids")?.Value)));
        }
        return rows;
    }

    public static ParsedHistory ParseHistoryRows(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var root = document.Root ?? throw new InvalidOperationException("POHODA vrátila prázdne XML.");
        if (root.Attribute("state")?.Value == "error") throw new InvalidOperationException($"POHODA vrátila chybu: {ErrorNote(root)}");
        var rows = new List<HistoryRow>();
        var doklady = new List<HistoryDoklad>();
        var series = new Dictionary<string, SeriesRow>(StringComparer.Ordinal);

        // Počty po responsePackItem (h01…) — z nich je manifest prenosu.
        var pocty = new Dictionary<string, PoctyPoziadavky>(StringComparer.Ordinal);

        foreach (var (element, headerName, agenda) in HistoryDocuments(document))
        {
            var idPoziadavky = element.Ancestors().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "responsePackItem")?.Attribute("id")?.Value ?? string.Empty;
            if (!pocty.TryGetValue(idPoziadavky, out var pocet)) pocty[idPoziadavky] = pocet = new PoctyPoziadavky();
            pocet.Dokladov++;
            var header = element.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == headerName);
            if (header is null)
            {
                pocet.Preskoc("bezHlavicky");
                continue;
            }
            // Rad sa zbiera PRED preskočením hlavičky nižšie: doklad bez textu
            // alebo bez predkontácie pre korpus signál nenesie, ale svoj číselný
            // rad má rovnako platný ako každý iný.
            var (radExternalId, radKod) = ZozbierajRad(series, header, headerName);
            var textHlavicky = VlastnyText(header);
            var predkontacia = RefIds(header, "accounting");
            var clenenieDph = RefIds(header, "classificationVAT");
            var polozky = DetailItems(element, headerName).ToArray();
            pocet.Poloziek += polozky.Length;
            var partner = header.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "partnerIdentity");
            var dokladCislo = Trimmed(FindText(header, "numberRequested") ?? FindText(header, "number"));
            var datum = IsoDate(FindText(header, "date"));
            var partnerIco = Trimmed(partner is null ? null : FindText(partner, "ico"));
            var partnerNazov = Trimmed(partner is null ? null : FindText(partner, "company"));
            var agendaDokladu = agenda(header);
            var strediskoHlavicky = RefIds(header, "centre");
            var krajina = KrajinaPartnera(partner);
            var dokladId = NativeId(header);
            // Hlavička ide za každý doklad, aj ten, ktorý korpusu nič nedá.
            if (dokladId is long id) doklady.Add(CitajHlavicku(element, header, agendaDokladu, id, dokladCislo, datum));
            // Hlavička bez textu alebo bez zaúčtovania doteraz zahodila celý doklad
            // aj s položkami (F11) — a práve v nich býva rozúčtovanie, napríklad
            // „Natural 95 (nedaňová časť 20 %)" s PHM-Nadspotreba / PN. Hlavičkový
            // riadok ide do korpusu, keď má zaúčtovanie; bez vlastného textu si
            // požičia text prvej položky. Položky sa čítajú vždy. Rovnako to robí
            // ručná cesta na serveri (uctoHistoriaXml.ts).
            var lineText = textHlavicky ?? polozky.Select(dvojica => VlastnyText(dvojica.Item)).FirstOrDefault(text => text is not null);
            if (predkontacia is null && clenenieDph is null) pocet.Preskoc("hlavickaBezKodu");
            else if (lineText is null) pocet.Preskoc("hlavickaBezTextu");
            else
            {
                // Sadzba na hlavičke sa nedáva: doklad ich máva viac (5 % aj 19 %
                // na jednom bločku) a jedna hodnota by klamala. Nesú ju položky.
                rows.Add(new HistoryRow(
                    agendaDokladu, dokladCislo, datum, partnerIco, partnerNazov, lineText,
                    predkontacia, clenenieDph,
                    ZakladnaKvSekcia(RefIds(header, "classificationKVDPH")), 0,
                    StrediskoKod: strediskoHlavicky,
                    RadExternalId: radExternalId, RadKod: radKod, Krajina: krajina, DokladId: dokladId));
                pocet.Riadkov++;
            }

            // Položky dokladu. POHODA ich v odpovedi posiela celé (invoiceItem
            // má text, accounting aj classificationVAT), korpus z nich doteraz
            // nevidel nič — čítala sa iba hlavička. Pritom práve v nich je to,
            // čo z hlavičky ani z účtovného denníka vyčítať NEJDE: faktúra za
            // PHM má hlavičku „PHM / PHM-501200 / PD" a v denníku po nej ostanú
            // štyri proviozky s textom „PHM", zatiaľ čo rozúčtovanie je až
            // v položkách — „Natural 95 (nedaňová časť 20 %)" s predkontáciou
            // PHM-Nadspotreba a členením PN.
            //
            // Berú sa položky s VLASTNÝM zaúčtovaním — tie, kde sa účtovník
            // rozhodol inak než na hlavičke — a položky s vlastným TEXTOM;
            // tie nesú, čo sa kupovalo. Položka bez jedného aj druhého by
            // korpus iba zopakovala.
            // Keď je doklad rozúčtovaný, berú sa VŠETKY jeho položky — aj tie,
            // ktoré zaúčtovanie dedia. Pomer sa totiž číta z DVOJICE: „Natural
            // 95 (daňová časť 80 %)" za 52,68 drží hlavičkové zaúčtovanie
            // a inak by v korpuse ostalo len osamotené „13,17 nedaňové",
            // z ktorého pomer nikto nevyčíta.
            var rozuctovany = polozky.Any(dvojica =>
            {
                var itemPredkontacia = RefIds(dvojica.Item, "accounting");
                var itemClenenie = RefIds(dvojica.Item, "classificationVAT");
                return (itemPredkontacia is not null || itemClenenie is not null)
                    && !(itemPredkontacia == predkontacia && itemClenenie == clenenieDph);
            });
            foreach (var (item, poradie) in polozky)
            {
                var itemPredkontacia = RefIds(item, "accounting");
                var itemClenenie = RefIds(item, "classificationVAT");
                // Položka, ktorá zaúčtovanie hlavičky iba zopakuje, sa berie
                // vtedy, keď má VLASTNÝ text. O zaúčtovaní nepovie nič nové,
                // ale povie, ČO sa kupovalo — a to hlavička zahmlieva:
                // „Importné colné služby a administratívne poplatky" proti
                // „1 x Importabfertigung im HZA-Wien" na položke. AGS účtuje
                // prijaté faktúry na jeden účet, takže rozúčtovaná je len každá
                // siedma a text zvyšných šiestich sa strácal — pritom rozlíšiť
                // treba práve súrodenecké účty služieb (preprava/colné/
                // destinácia, tuzemsko/zahraničie, s § 69 aj bez).
                // Bez vlastného textu ide o čistý duplikát hlavičky a preskočí sa;
                // korpus tak rastie o texty, nie o zopakované zaúčtovanie.
                var vlastnyText = VlastnyText(item);
                if (!rozuctovany && vlastnyText is null
                    && ((itemPredkontacia is null && itemClenenie is null)
                        || (itemPredkontacia == predkontacia && itemClenenie == clenenieDph)))
                {
                    pocet.Preskoc("polozkaDuplikatHlavicky");
                    continue;
                }
                // Text položky smie chýbať. Na reálnom exporte ALPINY je bez textu
                // 18 zo 68 rozúčtovaných položiek — a sú medzi nimi tie
                // najvýrečnejšie: faktúra Print-Office má prázdny text presne na
                // riadku, ktorý ide na „repre / PN / KN", teda mimo priznania aj
                // mimo kontrolného výkazu. Preskočiť ich znamená prísť práve
                // o dôkaz rozúčtovania. Namiesto toho sa berie text hlavičky —
                // ten účtovník pri položke aj tak vidí.
                // Dedí sa len VLASTNÝ text hlavičky — text inej položky by riadok
                // opísal cudzím nákupom. Bez textu či bez zaúčtovania (hlavička ho
                // nemá a položka tiež nie) riadok nemá čo naučiť.
                var itemText = vlastnyText ?? textHlavicky;
                var kodPredkontacie = itemPredkontacia ?? predkontacia;
                var kodClenenia = itemClenenie ?? clenenieDph;
                if (itemText is null)
                {
                    pocet.Preskoc("polozkaBezTextu");
                    continue;
                }
                if (kodPredkontacie is null && kodClenenia is null)
                {
                    pocet.Preskoc("polozkaBezKodu");
                    continue;
                }
                var ceny = item.Elements()
                    .FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == "homeCurrency");
                rows.Add(new HistoryRow(
                    agendaDokladu, dokladCislo, datum, partnerIco, partnerNazov, itemText,
                    kodPredkontacie, kodClenenia,
                    ZakladnaKvSekcia(RefIds(item, "classificationKVDPH"))
                        ?? ZakladnaKvSekcia(RefIds(header, "classificationKVDPH")),
                    poradie,
                    Suma: Ciastka(ceny, "price"),
                    SumaDph: Ciastka(ceny, "priceVAT"),
                    SadzbaDph: SadzbaDph(item),
                    StrediskoKod: RefIds(item, "centre") ?? strediskoHlavicky,
                    // Rad aj krajina patria dokladu, položka ich dedí z hlavičky.
                    RadExternalId: radExternalId, RadKod: radKod, Krajina: krajina,
                    DokladId: dokladId, PolozkaId: NativeId(item)));
                pocet.Riadkov++;
            }
        }

        var warnings = document.Descendants()
            .Where(item => IsStormware(item) && item.Name.LocalName == "responsePackItem" && item.Attribute("state")?.Value != "ok")
            .Select(item => FindText(item, "note") ?? item.Attribute("note")?.Value ?? "POHODA nevrátila časť dokladov.")
            .ToArray();
        // Manifest: každá odoslaná požiadavka so stavom a počtami. Celkový počet
        // záznamov POHODA nevracia — dôkazom úplnosti je len stav a absencia parts.
        var agendy = HistoryRequests.Select((poziadavka, index) =>
        {
            var id = $"h{index + 1:D2}";
            var polozka = root.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "responsePackItem" && item.Attribute("id")?.Value == id);
            var pocet = pocty.GetValueOrDefault(id) ?? new PoctyPoziadavky();
            var poznamka = Trimmed(polozka?.Attribute("note")?.Value);
            return new ImportAgenda(
                poziadavka.Poziadavka, poziadavka.Agenda, StavPoziadavky(polozka),
                poznamka is { Length: > 1000 } ? poznamka[..1000] : poznamka,
                pocet.Dokladov, pocet.Poloziek, pocet.Riadkov, pocet.Preskocene);
        }).ToArray();
        return new ParsedHistory(rows, warnings, series.Values.ToArray(), agendy,
            Trimmed(root.Attribute("programVersion")?.Value), Trimmed(root.Attribute("key")?.Value), doklady);
    }

    private static XElement? Dieta(XElement? rodic, string localName) =>
        rodic?.Elements().FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == localName);

    /// <summary>Hlavička dokladu. Polia sú priame deti hlavičky — FindText by
    /// vzal aj date z likvidácie. Súhrn je súrodenec hlavičky (invoiceSummary…).</summary>
    private static HistoryDoklad CitajHlavicku(XElement element, XElement header, string agenda, long dokladId, string? dokladCislo, string? datum)
    {
        string? Pole(string localName) => Trimmed(Dieta(header, localName)?.Value);
        var suhrn = Dieta(element, $"{element.Name.LocalName}Summary");
        var domaca = Dieta(suhrn, "homeCurrency");
        var cudzia = Dieta(suhrn, "foreignCurrency");
        var zaokruhlenie = Dieta(domaca, "round");
        decimal? Sadzba(string localName) =>
            decimal.TryParse(Dieta(domaca, localName)?.Attribute("rate")?.Value, NumberStyles.Number, CultureInfo.InvariantCulture, out var sadzba) ? sadzba : null;
        return new HistoryDoklad(
            agenda, dokladId, dokladCislo,
            datum, IsoDate(Pole("dateTax")), IsoDate(Pole("dateAccounting")), IsoDate(Pole("dateDelivery")),
            IsoDate(Pole("dateKVDPH")), IsoDate(Pole("dateApplicationVAT")),
            Pole("originalDocument"), Pole("originalDocumentNumber"), Pole("symVar"), Pole("symPar"),
            cudzia is null ? null : RefIds(cudzia, "currency"), Ciastka(cudzia, "rate"), (int?)Ciastka(cudzia, "amount"), Ciastka(cudzia, "priceSum"),
            Ciastka(domaca, "priceNone"), Ciastka(domaca, "priceLow"), Ciastka(domaca, "priceLowVAT"), Sadzba("priceLowVAT"),
            Ciastka(domaca, "priceHigh"), Ciastka(domaca, "priceHighVAT"), Sadzba("priceHighVAT"),
            Ciastka(domaca, "price3"), Ciastka(domaca, "price3VAT"), Sadzba("price3VAT"),
            Ciastka(zaokruhlenie, "priceRound") ?? Ciastka(zaokruhlenie, "priceRoundSum"),
            [
                .. (Dieta(element, "linkedDocuments")?.Elements().Where(IsStormware) ?? []).Select(vazba =>
                {
                    var zdroj = Dieta(vazba, "sourceDocument");
                    return new HistoryVazba(vazba.Name.LocalName, Trimmed(Dieta(vazba, "sourceAgenda")?.Value),
                        zdroj is null ? null : NativeId(zdroj), Trimmed(Dieta(zdroj, "number")?.Value));
                }),
                .. (Dieta(element, "liquidations")?.Elements().Where(IsStormware) ?? []).Select(likvidacia =>
                {
                    var zdroj = Dieta(likvidacia, "sourceDocument");
                    return new HistoryVazba("liquidation", Trimmed(Dieta(likvidacia, "sourceAgenda")?.Value),
                        zdroj is null ? null : NativeId(zdroj), Trimmed(Dieta(zdroj, "number")?.Value),
                        NativeId(likvidacia), IsoDate(Dieta(likvidacia, "date")?.Value),
                        Ciastka(likvidacia, "amount"), Ciastka(likvidacia, "foreignCurrencyAmount"));
                }),
            ]);
    }

    private sealed class PoctyPoziadavky
    {
        public int Dokladov { get; set; }
        public int Poloziek { get; set; }
        public int Riadkov { get; set; }
        public Dictionary<string, int> Preskocene { get; } = new(StringComparer.Ordinal);
        public void Preskoc(string dovod) => Preskocene[dovod] = Preskocene.GetValueOrDefault(dovod) + 1;
    }

    /// <summary>
    /// Stav požiadavky v odpovedi: chýbajúca je chyba, inak stav položky,
    /// potom stav zoznamu a nakoniec rdc:parts — POHODA vrátila len časť
    /// záznamov a zvyšok rozdelila do ďalších súborov.
    /// </summary>
    private static string StavPoziadavky(XElement? polozka)
    {
        if (polozka is null) return "chyba";
        // „warning" znamená, že POHODA požiadavku spracovala a záznamy vrátila —
        // poznámka ide do manifestu. Keby blokoval publikáciu, história firmy by sa
        // pri neškodnom upozornení už nikdy neobnovila.
        if (polozka.Attribute("state")?.Value is { } stav && stav is not ("ok" or "warning")) return stav;
        var zoznam = polozka.Elements().FirstOrDefault(IsStormware);
        if (zoznam?.Attribute("state")?.Value is { } stavZoznamu && stavZoznamu is not ("ok" or "warning")) return stavZoznamu;
        return zoznam?.Elements().Any(node => IsStormware(node) && node.Name.LocalName == "parts") == true ? "parts" : "ok";
    }

    /// <summary>
    /// Natívne id záznamu POHODY — LEN priame dieťa „id". FindText hľadá
    /// v potomkoch a vrátil by typ:id číselného radu (number/typ:id) či
    /// predkontácie, teda id niečoho iného.
    /// </summary>
    private static long? NativeId(XElement element) =>
        long.TryParse(element.Elements().FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == "id")?.Value.Trim(),
            NumberStyles.Integer, CultureInfo.InvariantCulture, out var id) && id > 0 ? id : null;

    private static string? VlastnyText(XElement element) =>
        Trimmed(element.Elements().FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == "text")?.Value);

    // Agenda číselníka podľa typu dokladu. POZOR, je to iný slovník než agendy
    // korpusu (FP/FV/OZ…): rad sa v ponuke filtruje presnou zhodou s agendou,
    // akú posiela číselník POHODY, takže tu musí vzniknúť rovnaká hodnota.
    private static string? AgendaCiselnika(XElement header, string headerName) => headerName switch
    {
        "voucherHeader" => "pokladna",
        "intDocHeader" => "interni_doklady",
        "invoiceHeader" => FindText(header, "invoiceType") switch
        {
            "receivedAdvanceInvoice" => "prijate_zalohove_faktury",
            "issuedAdvanceInvoice" => "vydane_zalohove_faktury",
            "commitment" => "ostatni_zavazky",
            // Dobropis aj ťarchopis zdieľajú číselný rad s bežnou faktúrou.
            "issuedInvoice" or "issuedCreditNotice" or "issuedDebitNote" => "vydane_faktury",
            "receivedInvoice" or "receivedCreditNotice" or "receivedDebitNote" => "prijate_faktury",
            _ => null,
        },
        _ => null,
    };

    /// <summary>
    /// Číselný rad z hlavičky dokladu. Kľúčom je identifikátor radu v POHODE
    /// (typ:id) — ten je jedinečný aj tam, kde prefix nie je: ALPINA má dva
    /// rôzne rady pokladne s prefixom „26". Identifikátor a prefix vráti aj
    /// tam, kde sa rad nezbiera (agenda mimo číselníka) — riadky histórie ich
    /// nesú vždy.
    /// </summary>
    private static (string? ExternalId, string? Kod) ZozbierajRad(IDictionary<string, SeriesRow> series, XElement header, string headerName)
    {
        var number = header.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "number");
        if (number is null) return (null, null);
        var externalId = Trimmed(FindText(number, "id"));
        var kod = Trimmed(FindText(number, "ids"));
        var agenda = AgendaCiselnika(header, headerName);
        if (externalId is null || kod is null || agenda is null) return (externalId, kod);
        // Posledné číslo je najvyššie číslo dokladu v rade — presne to, čo pri
        // vyexportovaných radoch vracia POHODA ako topNumber. Slúži len na odhad
        // ďalšieho čísla v karte dokladu; samotné číslo prideľuje POHODA.
        var cislo = Trimmed(FindText(number, "numberRequested"));
        if (!series.TryGetValue(externalId, out var existing))
        {
            series[externalId] = new SeriesRow(externalId, kod, agenda, cislo);
        }
        else if (cislo is not null && (existing.PosledneCislo is null
            || string.CompareOrdinal(cislo, existing.PosledneCislo) > 0))
        {
            series[externalId] = existing with { PosledneCislo = cislo };
        }
        return (externalId, kod);
    }

    /// <summary>
    /// Krajina partnera dokladu: kód krajiny z jeho adresy, inak prefix IČ DPH
    /// (CZ123… → CZ). Adresa sa berie len priamo z partnerIdentity — dodacia
    /// adresa (shipToAddress) má vlastnú krajinu a o protistrane nehovorí.
    /// </summary>
    private static string? KrajinaPartnera(XElement? partner)
    {
        var adresa = partner?.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "address");
        if (adresa is null) return null;
        var krajina = RefIds(adresa, "country");
        if (krajina is not null) return krajina.ToUpperInvariant();
        var icDph = Trimmed(adresa.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "icDph")?.Value);
        return icDph is { Length: >= 2 } && char.IsAsciiLetter(icDph[0]) && char.IsAsciiLetter(icDph[1])
            ? icDph[..2].ToUpperInvariant()
            : null;
    }

    /// <summary>Doklady všetkých agend so spôsobom, ako z hlavičky určiť agendu.</summary>
    private static IEnumerable<(XElement Element, string HeaderName, Func<XElement, string> Agenda)> HistoryDocuments(XDocument document)
    {
        foreach (var element in document.Descendants().Where(item => IsStormware(item)))
        {
            switch (element.Name.LocalName)
            {
                case "invoice":
                    yield return (element, "invoiceHeader", header =>
                        HistoryInvoiceTypes.FirstOrDefault(item => item.Type == FindText(header, "invoiceType")).Agenda
                        // Zvyšok agendy FA sú ostatné záväzky (commitment); pohľadávky
                        // majú vlastnú položku v HistoryInvoiceTypes.
                        ?? "OZ");
                    break;
                case "voucher":
                    // Smer pokladne nesie voucherType: receipt = príjem, expense = výdaj.
                    yield return (element, "voucherHeader", header =>
                        FindText(header, "voucherType") == "receipt" ? "PPD" : "VPD");
                    break;
                case "intDoc":
                    yield return (element, "intDocHeader", _ => "INT");
                    break;
            }
        }
    }

    /// <summary>
    /// Položky dokladu aj s poradím od 1 — nula patrí hlavičke. Názvy elementov
    /// sú tie isté, aké export do POHODY zapisuje (pohodaXml.ts, DETAIL_TAGS).
    /// </summary>
    private static IEnumerable<(XElement Item, int Poradie)> DetailItems(XElement document, string headerName)
    {
        var (detailName, itemName) = headerName switch
        {
            "invoiceHeader" => ("invoiceDetail", "invoiceItem"),
            "voucherHeader" => ("voucherDetail", "voucherItem"),
            "intDocHeader" => ("intDocDetail", "intDocItem"),
            _ => (null, null),
        };
        if (detailName is null || itemName is null) yield break;
        var detail = document.Elements()
            .FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == detailName);
        if (detail is null) yield break;
        var poradie = 0;
        foreach (var item in detail.Elements().Where(node => IsStormware(node) && node.Name.LocalName == itemName))
        {
            poradie += 1;
            yield return (item, poradie);
        }
    }

    /// <summary>POHODA vracia dátum ako yyyy-MM-dd; čokoľvek iné korpus nezaujíma.</summary>
    private static string? IsoDate(string? value)
    {
        var trimmed = value?.Trim();
        return trimmed is not null && trimmed.Length >= 10 && DateOnly.TryParse(trimmed[..10], out var date)
            ? date.ToString("yyyy-MM-dd")
            : null;
    }

    /// <summary>Priečinok dokumentov jedného dokladu (záložka „Dokumenty").</summary>
    public sealed record DocumentFolder(string Cislo, string? CompanyFolder, string? SubFolder);

    // Hodnoty invoiceType podľa invoice.xsd. Dobropis, ťarchopis ani zálohová
    // faktúra nie sú „obyčajná faktúra": dopyt na priečinok filtrovaný cudzím
    // invoiceType doklad nenájde a sken sa ticho zahodí (scan_folder_unknown).
    private static readonly HashSet<string> InvoiceTypes = new(StringComparer.Ordinal)
    {
        "receivedInvoice", "receivedCreditNotice", "receivedDebitNote", "receivedAdvanceInvoice",
        "issuedInvoice", "issuedCreditNotice", "issuedDebitNote", "issuedAdvanceInvoice",
        "commitment",
    };

    // Agenda dokladu → element zoznamu v POHODE. Kľúčom je typ tak, ako ho nesie
    // sám dataPack (pri faktúrach priamo invoiceType) — nie preložená agenda,
    // aby sa medzi čítaním packu a dopytom nemal kde stratiť podtyp dokladu.
    private static (string Request, string Item, string VersionAttribute, string? InvoiceType)? FolderRequestShape(string documentType) => documentType switch
    {
        "voucher" => ("listVoucherRequest", "requestVoucher", "voucherVersion", null),
        "intDoc" => ("listIntDocRequest", "requestIntDoc", "intDocVersion", null),
        _ when InvoiceTypes.Contains(documentType) => ("listInvoiceRequest", "requestInvoice", "invoiceVersion", documentType),
        _ => null,
    };

    /// <summary>
    /// Dopyt na priečinok dokumentov konkrétnych dokladov. POHODA cestu pozná —
    /// vrátane lokalizovaného segmentu („Podvojné účtovníctvo\Pokladňa") aj
    /// priečinka číselného radu — takže ju neskladáme sami z nastavení.
    /// </summary>
    public static string? BuildDocumentFolderRequest(string ico, string documentType, IReadOnlyList<string> numbers, string requestId)
    {
        if (numbers.Count == 0) return null;
        var shape = FolderRequestShape(documentType);
        if (shape is null) return null;
        // invoiceType je pri faktúrach povinný atribút dopytu; hodnota je z
        // uzavretého zoznamu InvoiceTypes, takže do atribútu ide bezpečne.
        var typeAttribute = shape.Value.InvoiceType is null ? string.Empty : $" invoiceType=\"{shape.Value.InvoiceType}\"";
        var selected = string.Join("\n", numbers.Select(number =>
            $"          <ftr:number><typ:numberRequested>{Escape(number)}</typ:numberRequested></ftr:number>"));
        return $"""
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Priecinok dokumentov"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <dat:dataPackItem id="folders" version="2.0">
    <lst:{shape.Value.Request} version="2.0"{typeAttribute} {shape.Value.VersionAttribute}="2.0">
      <lst:{shape.Value.Item}>
        <ftr:filter>
          <ftr:selectedNumbers>
{selected}
          </ftr:selectedNumbers>
        </ftr:filter>
      </lst:{shape.Value.Item}>
      <lst:restrictionData>
        <lst:attachments>true</lst:attachments>
      </lst:restrictionData>
    </lst:{shape.Value.Request}>
  </dat:dataPackItem>
</dat:dataPack>
""";
    }

    /// <summary>IČO účtovnej jednotky z hlavičky dataPacku.</summary>
    public static string? ReadDataPackIco(string xml) =>
        Trimmed(XDocument.Parse(xml, LoadOptions.None).Root?.Attribute("ico")?.Value);

    /// <summary>Typ dokladu každej položky dataPacku (id → voucher/intDoc/invoiceType).
    /// Agenda sa číta z tela položky, nie z cloudu — dopyt na priečinok musí
    /// ísť do tej agendy, do ktorej doklad naozaj išiel. Faktúra nesie priamo
    /// svoj invoiceType: preklad na FP/FV/OZ predtým zlial VŠETKY podtypy do
    /// „prijatej faktúry", takže dobropis, ťarchopis ani zálohová faktúra sa
    /// pri spätnom dopyte nenašli a ich sken sa do POHODY nikdy nedostal.</summary>
    public static IReadOnlyDictionary<string, string> ReadDataPackItemTypes(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var types = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var item in document.Descendants().Where(item => IsStormware(item) && item.Name.LocalName == "dataPackItem"))
        {
            var id = item.Attribute("id")?.Value;
            if (string.IsNullOrWhiteSpace(id)) continue;
            var body = item.Elements().FirstOrDefault(child => IsStormware(child));
            var typ = body?.Name.LocalName switch
            {
                "voucher" => "voucher",
                "intDoc" => "intDoc",
                // Neznámy invoiceType radšej vynecháme, než by mal ísť do dopytu:
                // XSD pozná uzavretý zoznam a prázdny atribút zhodí celý dopyt.
                "invoice" => Trimmed(FindText(body, "invoiceType")) is { } invoiceType && InvoiceTypes.Contains(invoiceType) ? invoiceType : null,
                _ => null,
            };
            if (typ is not null) types[id] = typ;
        }
        return types;
    }

    /// <summary>Priečinky dokumentov z odpovede POHODY, kľúčované číslom dokladu.</summary>
    public static IReadOnlyList<DocumentFolder> ParseDocumentFolders(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var root = document.Root ?? throw new InvalidOperationException("POHODA vrátila prázdne XML.");
        if (root.Attribute("state")?.Value == "error") throw new InvalidOperationException($"POHODA vrátila chybu: {ErrorNote(root)}");
        var folders = new List<DocumentFolder>();
        foreach (var header in document.Descendants().Where(item => IsStormware(item)
            && item.Name.LocalName is "invoiceHeader" or "voucherHeader" or "intDocHeader"))
        {
            var doklad = header.Parent;
            if (doklad is null) continue;
            var number = header.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "number");
            var cislo = Trimmed(number is null ? null : (FindText(number, "numberRequested") ?? number.Value));
            if (cislo is null) continue;
            // attachments je súrodenec hlavičky (v tele dokladu), nie jej dieťa.
            var files = doklad.Descendants().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "files");
            folders.Add(new DocumentFolder(
                cislo,
                files is null ? null : Trimmed(FindText(files, "companyDocumentsFolder")),
                files is null ? null : Trimmed(FindText(files, "subFolder"))));
        }
        return folders;
    }

    /// <summary>Ochrana POHODY: agent smie doklady len vytvárať. Vráti zoznam
    /// zakázaných prvkov (actionType update/delete a transformation — XSLT by
    /// mohla dataPack prepísať až v POHODE); prázdny zoznam = v poriadku.</summary>
    public static IReadOnlyList<string> FindDestructiveActions(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var destructive = document.Descendants()
            .Where(item => IsStormware(item) && item.Name.LocalName == "actionType")
            .SelectMany(item => item.Descendants())
            .Where(item => item.Name.LocalName is "update" or "delete")
            .Select(item => item.Name.LocalName);
        var transformations = document.Descendants()
            .Where(item => IsStormware(item) && item.Name.LocalName == "transformation")
            .Select(item => item.Name.LocalName);
        return destructive.Concat(transformations).Distinct(StringComparer.Ordinal).ToArray();
    }

    // Kód referencie (typ:ids) priamo pod daným elementom — hlavičkou aj položkou.
    // Pozerá len na priamych potomkov, takže z hlavičky nikdy nevytiahne
    // zaúčtovanie položky (invoiceDetail je súrodenec hlavičky, nie jej dieťa).
    /// <summary>Suma z typ:typeCurrencyHomeItem — POHODA ju píše bodkou, nie čiarkou.</summary>
    private static decimal? Ciastka(XElement? ceny, string localName)
    {
        var hodnota = ceny is null ? null : Trimmed(ceny.Elements()
            .FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == localName)?.Value);
        return decimal.TryParse(hodnota, NumberStyles.Number, CultureInfo.InvariantCulture, out var suma) ? suma : null;
    }

    /// <summary>
    /// Sadzba DPH položky ako číslo. POHODA ju pri exporte píše do atribútu value
    /// elementu rateVAT (type.xsd vatRateType: „Hodnota sazby DPH (pouze export)");
    /// text elementu je iba kód high/low/none. Z kódu sa číslo bez dátumu odvodiť
    /// nedá — SK menila sadzby v roku 2025 — preto najprv value, potom percentVAT,
    /// a „none" je nula.
    /// </summary>
    private static decimal? SadzbaDph(XElement item)
    {
        var sadzba = item.Elements().FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == "rateVAT");
        if (decimal.TryParse(sadzba?.Attribute("value")?.Value, NumberStyles.Number, CultureInfo.InvariantCulture, out var hodnota)) return hodnota;
        var percento = Trimmed(item.Elements().FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == "percentVAT")?.Value);
        if (decimal.TryParse(percento, NumberStyles.Number, CultureInfo.InvariantCulture, out var zPercenta)) return zPercenta;
        return Trimmed(sadzba?.Value) == "none" ? 0m : null;
    }

    private static string? RefIds(XElement header, string localName)
    {
        var element = header.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == localName);
        return element is null ? null : Trimmed(FindText(element, "ids"));
    }

    // POHODA má rozšírené KV kódy (C2B1, B1-0…) — základná zákonná sekcia sú prvé dva znaky.
    private static string? ZakladnaKvSekcia(string? kod)
    {
        var text = kod?.Trim().ToUpperInvariant();
        if (string.IsNullOrEmpty(text)) return null;
        if (KvSekcie.Contains(text)) return text;
        var zaklad = text.Length >= 2 ? text[..2] : text;
        return KvSekcie.Contains(zaklad) ? zaklad : null;
    }

    public static ParsedCodeLists ParseCodeLists(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var root = document.Root ?? throw new InvalidOperationException("POHODA vrátila prázdne XML.");
        if (root.Attribute("state")?.Value == "error") throw new InvalidOperationException($"POHODA vrátila chybu: {ErrorNote(root)}");
        var result = new Dictionary<string, IReadOnlyList<CodeListValue>>
        {
            ["predkontacie"] = ParseContainer(document, "listAccountingDoubleEntry", "itemAccounting", attributes: true),
            ["cleneniaDph"] = ParseContainer(document, "listClassificationVAT", "classificationVAT"),
            ["ciselneRady"] = ParseContainer(document, "listNumericalSeries", "numericalSeries", prefixCode: true),
            ["strediska"] = ParseContainer(document, "listCentre", "centre"),
            ["bankoveUcty"] = ParseBankAccounts(document),
        };
        var warnings = document.Descendants().Where(item => IsStormware(item) && item.Name.LocalName == "responsePackItem" && item.Attribute("state")?.Value != "ok")
            .Select(item => FindText(item, "note") ?? item.Attribute("note")?.Value ?? "POHODA nevrátila časť číselníkov.").ToArray();
        return new ParsedCodeLists(result, warnings);
    }

    public static ParsedExportResponse ParseExportResponse(string xml, IReadOnlyCollection<string> expectedDocumentIds)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        var root = document.Root ?? throw new InvalidOperationException("POHODA vrátila prázdne XML.");
        var packState = root.Attribute("state")?.Value ?? "error";
        var rootNote = FindText(root, "note") ?? root.Attribute("note")?.Value;
        var items = document.Descendants().Where(item => IsStormware(item) && item.Name.LocalName == "responsePackItem")
            .ToDictionary(item => item.Attribute("id")?.Value ?? string.Empty, StringComparer.Ordinal);
        var results = new List<ExportDocumentResult>();
        foreach (var documentId in expectedDocumentIds)
        {
            if (!items.TryGetValue(documentId, out var item))
            {
                results.Add(new ExportDocumentResult(documentId, "error", Message: rootNote ?? "POHODA nevrátila výsledok dokladu."));
                continue;
            }
            var state = item.Attribute("state")?.Value;
            state = state is "ok" or "warning" or "error" ? state : "error";
            var message = FindText(item, "note") ?? item.Attribute("note")?.Value;
            var produced = item.Descendants().FirstOrDefault(value => IsStormware(value) && value.Name.LocalName == "producedDetails");
            var number = (produced ?? item).Descendants()
                .FirstOrDefault(value => value.Name.LocalName is "number" or "numberRequested" or "ids")?.Value.Trim();
            // POHODA vie odpovedať state="ok" a doklad pritom nezaložiť (napr. „Doklad
            // so zadaným číslom už existuje"). Bez producedDetails sa doklad v cloude
            // nesmie označiť za prenesený — inak účtovník verí, že je v POHODE.
            if (state == "ok" && produced is null)
            {
                state = "warning";
                message ??= "POHODA doklad nezaložila (bez potvrdenia o vytvorení).";
            }
            results.Add(new ExportDocumentResult(documentId, state, number, message));
        }
        return new ParsedExportResponse(results, packState, rootNote);
    }

    public static IReadOnlyList<string> ReadDataPackItemIds(string xml)
    {
        var document = XDocument.Parse(xml, LoadOptions.None);
        return document.Descendants()
            .Where(item => IsStormware(item) && item.Name.LocalName == "dataPackItem")
            .Select(item => item.Attribute("id")?.Value.Trim())
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Cast<string>()
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    public static string Sha256(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static IReadOnlyList<CodeListValue> ParseContainer(XDocument document, string containerName, string itemName, bool attributes = false, bool prefixCode = false)
    {
        var container = document.Descendants().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == containerName);
        if (container is null) return Array.Empty<CodeListValue>();
        var values = new Dictionary<string, CodeListValue>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in container.Descendants().Where(value => IsStormware(value) && value.Name.LocalName == itemName))
        {
            var code = attributes ? item.Attribute("code")?.Value.Trim() : FindText(item, prefixCode ? "prefix" : "code");
            var name = attributes ? (item.Attribute("accounting")?.Value ?? item.Attribute("name")?.Value)?.Trim() : FindText(item, "name");
            if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(name)) continue;
            // Číselný rad sa kľúčuje identifikátorom v POHODE, nie prefixom. Ten
            // istý prefix POHODA používa vo viacerých agendách (rad 26 je v pokladni
            // aj v ostatných záväzkoch, dve pokladne majú každá svoj) a kľúč podľa
            // kódu by druhý rad ticho zahodil. id sa berie LEN ako priame dieťa
            // hlavičky radu — cashAccount či unitPZD nesú vlastné typ:id.
            var externalId = attributes ? item.Attribute("id")?.Value
                : prefixCode ? Trimmed(item.Elements().FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == "numericalSeriesHeader")?
                    .Elements().FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == "id")?.Value)
                : FindText(item, "id");
            var key = prefixCode ? externalId ?? code : code;
            if (values.ContainsKey(key)) continue;
            // debit/credit = účty MD/DAL predkontácie (len itemAccounting ich má; inde vráti null).
            // topNumber = najvyššie číslo číselného radu (len numericalSeries; fallback number).
            values.Add(key, new CodeListValue(code, name,
                externalId,
                attributes ? item.Attribute("agenda")?.Value : FindText(item, "agenda"),
                attributes ? item.Attribute("year")?.Value : FindText(item, "year"),
                attributes ? Trimmed(item.Attribute("debit")?.Value) : null,
                attributes ? Trimmed(item.Attribute("credit")?.Value) : null,
                prefixCode ? Trimmed(FindText(item, "topNumber") ?? FindText(item, "number")) : null,
                // Pokladňa radu (numericalSeriesHeader.cashAccount). ids sa hľadá
                // LEN pod cashAccount — FindText cez celý rad by vzal prvé ids,
                // aké nájde, napríklad z účtovnej jednotky.
                PokladnaKod: prefixCode ? PokladnaRadu(item) : null));
        }
        return values.Values.OrderBy(item => item.Kod, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static string? PokladnaRadu(XElement rad)
    {
        var pokladna = rad.Descendants().FirstOrDefault(node => IsStormware(node) && node.Name.LocalName == "cashAccount");
        return pokladna is null ? null : Trimmed(FindText(pokladna, "ids"));
    }

    /// <summary>
    /// Bankové účty (listBankAccount): kód = skratka (ids), názov = banka.
    /// Hlavička má vlastnú štruktúru — ids/analyticAccount/currency sú refType,
    /// preto sa kód číta len z PRIAMEHO dieťaťa hlavičky, nie z potomkov.
    /// Zrušené účty (cancelled) sa preskakujú.
    /// </summary>
    private static IReadOnlyList<CodeListValue> ParseBankAccounts(XDocument document)
    {
        var container = document.Descendants().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "listBankAccount");
        if (container is null) return Array.Empty<CodeListValue>();
        var values = new Dictionary<string, CodeListValue>(StringComparer.OrdinalIgnoreCase);
        foreach (var header in container.Descendants().Where(value => IsStormware(value) && value.Name.LocalName == "bankAccountHeader"))
        {
            string? Direct(string localName) =>
                Trimmed(header.Elements().FirstOrDefault(child => child.Name.LocalName == localName)?.Value);
            if (Direct("cancelled") is not null) continue;
            var code = Direct("ids");
            if (string.IsNullOrWhiteSpace(code) || values.ContainsKey(code)) continue;
            var cisloUctu = Direct("numberAccount");
            var kodBanky = Direct("codeBank");
            var name = Direct("nameBank")
                ?? (cisloUctu is not null ? kodBanky is not null ? $"{cisloUctu}/{kodBanky}" : cisloUctu : code);
            var iban = Direct("IBAN")?.Replace(" ", "", StringComparison.Ordinal);
            var mena = Trimmed(header.Elements().FirstOrDefault(child => child.Name.LocalName == "currencyBankAccount")
                ?.Descendants().FirstOrDefault(child => child.Name.LocalName == "ids")?.Value);
            values.Add(code, new CodeListValue(code, name, Direct("id"), null, null, null, null, null, iban, mena));
        }
        return values.Values.OrderBy(item => item.Kod, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    /// <summary>Popis chyby z odpovede POHODY. Text chodí ako ATRIBÚT note na
    /// responsePack/responsePackItem — element „note" v response.xsd neexistuje,
    /// takže hľadanie elementu vrátilo vždy „bez popisu" (a v odpovedi s dokladmi
    /// dokonca cudzí obchodný note faktúry). Pri viacerých chybách sa spoja.</summary>
    private static string ErrorNote(XElement root)
    {
        var notes = new List<string>();
        void Add(string? note)
        {
            var text = Trimmed(note);
            if (text is not null && !notes.Contains(text, StringComparer.Ordinal)) notes.Add(text);
        }
        Add(root.Attribute("note")?.Value);
        foreach (var item in root.Descendants().Where(item => IsStormware(item)
            && item.Name.LocalName == "responsePackItem" && item.Attribute("state")?.Value != "ok"))
        {
            Add(item.Attribute("note")?.Value);
        }
        return notes.Count == 0 ? "bez popisu" : string.Join(" · ", notes);
    }

    private static string? FindText(XElement parent, string localName) => parent.Descendants()
        .FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == localName)?.Value.Trim();
    private static string? Trimmed(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    private static bool IsStormware(XElement element) => element.Name.NamespaceName.Contains(StormwareNamespace, StringComparison.OrdinalIgnoreCase);
    private static string Escape(string value) => System.Security.SecurityElement.Escape(value) ?? string.Empty;
}

public sealed class PohodaSchemaValidator
{
    private readonly string _schemaDirectory;

    public PohodaSchemaValidator(string schemaDirectory)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        _schemaDirectory = schemaDirectory;
    }

    public IReadOnlyList<string> ValidateDataPack(string xml)
    {
        var rootSchema = Path.Combine(_schemaDirectory, "data.xsd");
        if (!File.Exists(rootSchema)) throw new InvalidOperationException($"Chýba oficiálna POHODA XSD schéma: {rootSchema}");
        var errors = new List<string>();
        var schemas = new XmlSchemaSet { XmlResolver = new XmlUrlResolver() };
        schemas.Add(null, rootSchema);
        schemas.Compile();
        var settings = new XmlReaderSettings
        {
            ValidationType = ValidationType.Schema,
            Schemas = schemas,
            DtdProcessing = DtdProcessing.Prohibit,
            XmlResolver = null,
        };
        settings.ValidationFlags |= XmlSchemaValidationFlags.ReportValidationWarnings;
        settings.ValidationEventHandler += (_, args) => errors.Add(args.Message);
        using var input = new StringReader(xml);
        using var reader = XmlReader.Create(input, settings);
        while (reader.Read()) { }
        return errors;
    }
}
