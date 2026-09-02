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
            var predkontacia = HeaderRefIds(header, "accounting");
            var clenenieDph = HeaderRefIds(header, "classificationVAT");
            if ((supplierIco is null && supplierName is null) || (predkontacia is null && clenenieDph is null)) continue;
            var row = new TrainingDecision(
                PodtypZTypu(type),
                supplierIco,
                supplierName,
                Trimmed(header.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "text")?.Value),
                predkontacia,
                clenenieDph,
                ZakladnaKvSekcia(HeaderRefIds(header, "classificationKVDPH")));
            // Opakované identické doklady sa zlúčia — server aj tak deduplikuje.
            var key = string.Join("\u0001", row.SupplierIco, row.SupplierName, row.LineText, row.PredkontaciaKod, row.ClenenieDphKod, row.ClenenieKvKod);
            if (seen.Add(key)) rows.Add(row);
        }
        var warnings = document.Descendants().Where(item => IsStormware(item) && item.Name.LocalName == "responsePackItem" && item.Attribute("state")?.Value != "ok")
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
    ];

    /// <summary>
    /// Účtovný profil: export VŠETKÝCH dokladových agend (faktúry prijaté aj
    /// vydané vrátane dobropisov, ťarchopisov a zálohových, ostatné záväzky,
    /// pokladňa, interné doklady) — banka zatiaľ nie.
    /// Číta históriu, v POHODE nič nemení. Na rozdiel od BuildInvoiceListRequest,
    /// ktorý plní pamäť dodávateľov a preto berie len prijaté faktúry.
    /// </summary>
    public static string BuildHistoryListRequest(string ico, string requestId)
    {
        var items = new List<string>();
        // Ostatné záväzky (commitment) nie sú v HistoryInvoiceTypes zámerne —
        // tam ide o typy, ktoré majú vlastnú agendu korpusu. OZ vzniká až pri
        // parsovaní ako zvyšok agendy FA, ale dopyt naň sa musí poslať zvlášť,
        // inak POHODA žiadne nevráti. Presne to sa aj dialo: komentár sľuboval
        // ostatné záväzky, korpus ich nemal ani jeden a analýza pre agendu OZ
        // nenašla nič — nie preto, že by ich firma neúčtovala.
        foreach (var (type, _) in HistoryInvoiceTypes.Append(("commitment", "OZ")))
        {
            items.Add($"""  <dat:dataPackItem id="h{items.Count + 1:D2}" version="2.0"><lst:listInvoiceRequest version="2.0" invoiceType="{type}" invoiceVersion="2.0"><lst:requestInvoice/></lst:listInvoiceRequest></dat:dataPackItem>""");
        }
        items.Add($"""  <dat:dataPackItem id="h{items.Count + 1:D2}" version="2.0"><lst:listVoucherRequest version="2.0" voucherVersion="2.0"><lst:requestVoucher/></lst:listVoucherRequest></dat:dataPackItem>""");
        items.Add($"""  <dat:dataPackItem id="h{items.Count + 1:D2}" version="2.0"><lst:listIntDocRequest version="2.0" intDocVersion="2.0"><lst:requestIntDoc/></lst:listIntDocRequest></dat:dataPackItem>""");
        return $"""
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Export historie pre uctovny profil"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd">
{string.Join("\n", items)}
</dat:dataPack>
""";
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
        string? ClenenieKvKod);

    public sealed record ParsedHistory(IReadOnlyList<HistoryRow> Rows, IReadOnlyList<string> Warnings);

    /// <summary>
    /// Rozloží odpoveď na BuildHistoryListRequest na riadky korpusu. Doklad bez
    /// textu alebo bez predkontácie aj členenia sa preskočí — pre analýzu nenesie
    /// signál. Duplicity sa NEZLUČUJÚ: početnosť je pre analýzu hlavný signál
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
    /// </summary>
    public static string BuildAddressBookRequest(string ico, string requestId) => $"""
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Export adresara"
  xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd">
  <dat:dataPackItem id="ab01" version="2.0"><lst:listAddressBookRequest version="2.0" addressBookVersion="2.0"><lst:requestAddressBook/></lst:listAddressBookRequest></dat:dataPackItem>
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

        foreach (var (element, headerName, agenda) in HistoryDocuments(document))
        {
            var header = element.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == headerName);
            if (header is null) continue;
            var lineText = Trimmed(header.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "text")?.Value);
            var predkontacia = HeaderRefIds(header, "accounting");
            var clenenieDph = HeaderRefIds(header, "classificationVAT");
            if (lineText is null || (predkontacia is null && clenenieDph is null)) continue;
            var partner = header.Elements().FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == "partnerIdentity");
            rows.Add(new HistoryRow(
                agenda(header),
                Trimmed(FindText(header, "numberRequested") ?? FindText(header, "number")),
                IsoDate(FindText(header, "date")),
                Trimmed(partner is null ? null : FindText(partner, "ico")),
                Trimmed(partner is null ? null : FindText(partner, "company")),
                lineText,
                predkontacia,
                clenenieDph,
                ZakladnaKvSekcia(HeaderRefIds(header, "classificationKVDPH"))));
        }

        var warnings = document.Descendants()
            .Where(item => IsStormware(item) && item.Name.LocalName == "responsePackItem" && item.Attribute("state")?.Value != "ok")
            .Select(item => FindText(item, "note") ?? item.Attribute("note")?.Value ?? "POHODA nevrátila časť dokladov.")
            .ToArray();
        return new ParsedHistory(rows, warnings);
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
                        // Zvyšok agendy FA sú ostatné záväzky/pohľadávky.
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

    // Agenda dokladu → element zoznamu v POHODE. Priečinok pýtame len pre agendy,
    // ktoré vôbec exportujeme (faktúry, pokladňa, interné doklady).
    private static (string Request, string Item, string VersionAttribute)? FolderRequestShape(string documentType) => documentType switch
    {
        "FP" or "FV" or "OZ" => ("listInvoiceRequest", "requestInvoice", "invoiceVersion"),
        "PD" => ("listVoucherRequest", "requestVoucher", "voucherVersion"),
        "MZDY" => ("listIntDocRequest", "requestIntDoc", "intDocVersion"),
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
        // invoiceType je pri faktúrach povinný atribút dopytu.
        var invoiceType = documentType switch { "FV" => "issuedInvoice", "OZ" => "commitment", _ => "receivedInvoice" };
        var typeAttribute = shape.Value.Request == "listInvoiceRequest" ? $" invoiceType=\"{invoiceType}\"" : string.Empty;
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

    /// <summary>Typ dokladu každej položky dataPacku (id → FP/FV/OZ/PD/MZDY).
    /// Agenda sa číta z tela položky, nie z cloudu — dopyt na priečinok musí
    /// ísť do tej agendy, do ktorej doklad naozaj išiel.</summary>
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
                "voucher" => "PD",
                "intDoc" => "MZDY",
                "invoice" => FindText(body, "invoiceType") switch
                {
                    "issuedInvoice" => "FV",
                    "commitment" => "OZ",
                    _ => "FP",
                },
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

    // Kód referencie (typ:ids) priamo pod elementom hlavičky — nezachádza do položiek.
    private static string? HeaderRefIds(XElement header, string localName)
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
            if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(name) || values.ContainsKey(code)) continue;
            // debit/credit = účty MD/DAL predkontácie (len itemAccounting ich má; inde vráti null).
            // topNumber = najvyššie číslo číselného radu (len numericalSeries; fallback number).
            values.Add(code, new CodeListValue(code, name,
                attributes ? item.Attribute("id")?.Value : FindText(item, "id"),
                attributes ? item.Attribute("agenda")?.Value : FindText(item, "agenda"),
                attributes ? item.Attribute("year")?.Value : FindText(item, "year"),
                attributes ? Trimmed(item.Attribute("debit")?.Value) : null,
                attributes ? Trimmed(item.Attribute("credit")?.Value) : null,
                prefixCode ? Trimmed(FindText(item, "topNumber") ?? FindText(item, "number")) : null));
        }
        return values.Values.OrderBy(item => item.Kod, StringComparer.OrdinalIgnoreCase).ToArray();
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
