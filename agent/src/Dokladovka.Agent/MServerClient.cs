using System.Net;
using System.Text;
using System.Xml.Linq;

namespace Dokladovka.Agent;

public sealed record MServerCompany(string Company, string DatabaseName, string Year, string Period);

public sealed class MServerException(HttpStatusCode statusCode, string message, bool transient) : Exception(message)
{
    public HttpStatusCode StatusCode { get; } = statusCode;
    public bool IsTransient { get; } = transient;
}

public sealed class MServerClient : IPohodaClient
{
    private readonly HttpClient _http;
    private readonly string _authorization;
    private readonly SemaphoreSlim _serializationGate = new(1, 1);
    private readonly IAgentLog _log;

    static MServerClient() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

    public MServerClient(MServerEndpointSettings endpoint, MServerSecret secret, IAgentLog log, HttpMessageHandler? handler = null)
    {
        _log = log;
        _http = handler is null
            ? new HttpClient(new HttpClientHandler { AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate })
            : new HttpClient(handler, disposeHandler: false);
        var baseUrl = endpoint.BaseUrl ?? throw new InvalidOperationException($"Endpoint {endpoint.Id} nemá nastavenú URL mServera.");
        _http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        _http.Timeout = TimeSpan.FromMinutes(2);
        _authorization = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes($"{secret.UserName}:{secret.Password}"));
    }

    public async Task<MServerCompany> GetCompanyAsync(CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "status?companyDetail");
        request.Headers.TryAddWithoutValidation("STW-Authorization", _authorization);
        using var response = await SendWithRetryAsync(() => Clone(request), cancellationToken);
        var xml = await ReadXmlAsync(response, cancellationToken);
        var root = XDocument.Parse(xml, LoadOptions.None).Root ?? throw new InvalidOperationException("mServer vrátil prázdne XML.");
        string Required(string name) => root.Descendants().FirstOrDefault(item => item.Name.LocalName == name)?.Value.Trim()
            ?? throw new InvalidOperationException($"mServer status neobsahuje {name}.");
        return new MServerCompany(Required("company"), Required("databaseName"), Required("year"), Required("period"));
    }

    public async Task<string> PostXmlAsync(string xml, string instanceId, bool checkDuplicity, CancellationToken cancellationToken)
    {
        await _serializationGate.WaitAsync(cancellationToken);
        try
        {
            using var response = await SendWithRetryAsync(() =>
            {
                var request = new HttpRequestMessage(HttpMethod.Post, "xml");
                request.Headers.TryAddWithoutValidation("STW-Authorization", _authorization);
                request.Headers.TryAddWithoutValidation("STW-Application", "Dokladovka");
                request.Headers.TryAddWithoutValidation("STW-Instance", instanceId);
                if (checkDuplicity) request.Headers.TryAddWithoutValidation("STW-Check-Duplicity", "true");
                request.Headers.AcceptEncoding.ParseAdd("gzip, deflate");
                request.Content = new ByteArrayContent(Encoding.GetEncoding(1250).GetBytes(xml));
                request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("text/xml") { CharSet = "Windows-1250" };
                return request;
            }, cancellationToken);
            return await ReadXmlAsync(response, cancellationToken);
        }
        finally
        {
            _serializationGate.Release();
        }
    }

    private async Task<HttpResponseMessage> SendWithRetryAsync(Func<HttpRequestMessage> factory, CancellationToken cancellationToken)
    {
        Exception? last = null;
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            try
            {
                using var request = factory();
                var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                if (response.IsSuccessStatusCode) return response;
                var transient = response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
                    || (int)response.StatusCode >= 500;
                var exception = new MServerException(response.StatusCode, $"POHODA mServer vrátil HTTP {(int)response.StatusCode}.", transient);
                response.Dispose();
                if (!transient) throw exception;
                last = exception;
            }
            catch (Exception error) when ((error is HttpRequestException or TaskCanceledException) && !cancellationToken.IsCancellationRequested)
            {
                last = error;
            }
            if (attempt < 5)
            {
                var delay = TimeSpan.FromMilliseconds(Math.Min(30_000, 500 * Math.Pow(2, attempt - 1) + Random.Shared.Next(50, 500)));
                _log.Info("mserver_retry", new { attempt, delayMs = (int)delay.TotalMilliseconds, error = last?.GetType().Name });
                await Task.Delay(delay, cancellationToken);
            }
        }
        throw last ?? new InvalidOperationException("POHODA mServer požiadavka zlyhala.");
    }

    private static HttpRequestMessage Clone(HttpRequestMessage source)
    {
        var clone = new HttpRequestMessage(source.Method, source.RequestUri);
        foreach (var header in source.Headers) clone.Headers.TryAddWithoutValidation(header.Key, header.Value);
        return clone;
    }

    private static async Task<string> ReadXmlAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        var charset = response.Content.Headers.ContentType?.CharSet?.Trim('"').ToLowerInvariant();
        var encoding = charset is "windows-1250" or "cp1250" ? Encoding.GetEncoding(1250) : Encoding.UTF8;
        return encoding.GetString(bytes);
    }
}
