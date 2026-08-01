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
</dat:dataPack>
""";

    // Prijaté typy agendy FA — parita s ručným importom .mdb (RelTpFak 11/12/15).
    private static readonly string[] ReceivedInvoiceTypes = ["receivedInvoice", "receivedCreditNotice", "receivedAdvanceInvoice"];
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
        if (root.Attribute("state")?.Value == "error") throw new InvalidOperationException($"POHODA vrátila chybu: {FindText(root, "note") ?? "bez popisu"}");
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
        if (root.Attribute("state")?.Value == "error") throw new InvalidOperationException($"POHODA vrátila chybu: {FindText(root, "note") ?? "bez popisu"}");
        var result = new Dictionary<string, IReadOnlyList<CodeListValue>>
        {
            ["predkontacie"] = ParseContainer(document, "listAccountingDoubleEntry", "itemAccounting", attributes: true),
            ["cleneniaDph"] = ParseContainer(document, "listClassificationVAT", "classificationVAT"),
            ["ciselneRady"] = ParseContainer(document, "listNumericalSeries", "numericalSeries", prefixCode: true),
            ["strediska"] = ParseContainer(document, "listCentre", "centre"),
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
            var number = item.Descendants().FirstOrDefault(value => value.Name.LocalName is "number" or "numberRequested" or "ids")?.Value.Trim();
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
            values.Add(code, new CodeListValue(code, name,
                attributes ? item.Attribute("id")?.Value : FindText(item, "id"),
                attributes ? item.Attribute("agenda")?.Value : FindText(item, "agenda"),
                attributes ? item.Attribute("year")?.Value : FindText(item, "year"),
                attributes ? Trimmed(item.Attribute("debit")?.Value) : null,
                attributes ? Trimmed(item.Attribute("credit")?.Value) : null));
        }
        return values.Values.OrderBy(item => item.Kod, StringComparer.OrdinalIgnoreCase).ToArray();
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
