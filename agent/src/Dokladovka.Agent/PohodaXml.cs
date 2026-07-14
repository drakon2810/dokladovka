using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using System.Xml.Schema;

namespace Dokladovka.Agent;

public sealed record ParsedCodeLists(IReadOnlyDictionary<string, IReadOnlyList<CodeListValue>> Items, IReadOnlyList<string> Warnings);
public sealed record ParsedExportResponse(IReadOnlyList<ExportDocumentResult> Results, string PackState, string? Note);

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
            values.Add(code, new CodeListValue(code, name,
                attributes ? item.Attribute("id")?.Value : FindText(item, "id"),
                attributes ? item.Attribute("agenda")?.Value : FindText(item, "agenda"),
                attributes ? item.Attribute("year")?.Value : FindText(item, "year")));
        }
        return values.Values.OrderBy(item => item.Kod, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static string? FindText(XElement parent, string localName) => parent.Descendants()
        .FirstOrDefault(item => IsStormware(item) && item.Name.LocalName == localName)?.Value.Trim();
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
