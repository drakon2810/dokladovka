using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Dokladovka.Agent;

public sealed record PairOrganization(string Id, string Ico, string Nazov);
public sealed record PairResponse(
    string AgentToken,
    string? InstallationId = null,
    string? TenantId = null,
    string? OrganizationId = null,
    PairOrganization? Organization = null);
public sealed record AgentOrganization(
    string OrganizationId,
    string Ico,
    string Nazov,
    string? DbName,
    string? UctovnyRok,
    string PreferredYear);
public sealed record HeartbeatCompany(string Ico, string DbName, string UctovnyRok);
public sealed record CodeListValue(string Kod, string Nazov, string? ExternalId = null, string? Agenda = null, string? UctovnyRok = null);
public sealed record AgentExportJob(string ExportJobId, string DataPackXml, string IdempotencyKey);
public sealed record ExportDocumentResult(string DocumentId, string State, string? PohodaNumber = null, string? Message = null);
public sealed record AgentRelease(
    bool Available,
    string? Version = null,
    string? DownloadUrl = null,
    string? Sha256 = null,
    long? FileSize = null,
    DateTimeOffset? PublishedAt = null,
    string? Publisher = null,
    string? PublisherThumbprint = null,
    string? MinimumWindowsVersion = null,
    bool Signed = false,
    string? Reason = null);
public sealed record AgentSyncResult(string OrganizationId, string Kind, string State, int ItemCount, int DurationMs, string? ErrorCode = null);

public sealed class BackendApiException(HttpStatusCode statusCode, string message, bool transient = false) : Exception(message)
{
    public HttpStatusCode StatusCode { get; } = statusCode;
    public bool IsTransient { get; } = transient;
}

public sealed class BackendClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
    private readonly HttpClient _http;
    private readonly IAgentLog _log;

    public BackendClient(string baseUrl, string token, IAgentLog log, HttpMessageHandler? handler = null)
    {
        _log = log;
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        _http.Timeout = TimeSpan.FromSeconds(120);
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd($"Dokladovka-Agent/{AgentVersion.Current}");
    }

    public static async Task<PairResponse> PairAsync(
        string baseUrl,
        string pairingCode,
        string hostname,
        string agentVersion,
        string companyIco,
        CancellationToken cancellationToken)
    {
        using var http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(30) };
        using var response = await http.PostAsJsonAsync("api/agent/pair", new { pairingCode, hostname, agentVersion, companyIco }, JsonOptions, cancellationToken);
        if (!response.IsSuccessStatusCode) throw await ToException(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<PairResponse>(JsonOptions, cancellationToken)
            ?? throw new InvalidOperationException("Backend nevrátil token agenta.");
    }

    public Task<IReadOnlyList<AgentOrganization>> GetOrganizationsAsync(CancellationToken cancellationToken) =>
        SendJsonAsync<IReadOnlyList<AgentOrganization>>(() => new HttpRequestMessage(HttpMethod.Get, "api/agent/organizations"), cancellationToken);

    public Task SendHeartbeatAsync(IReadOnlyList<HeartbeatCompany> companies, CancellationToken cancellationToken) =>
        SendJsonAsync<JsonElement>(() => JsonRequest(HttpMethod.Post, "api/agent/heartbeat", new { companies, agentVersion = AgentVersion.Current }), cancellationToken);

    public Task SyncCodeListAsync(string organizationId, string kind, IReadOnlyList<CodeListValue> items, CancellationToken cancellationToken) =>
        SendJsonAsync<JsonElement>(() => JsonRequest(HttpMethod.Put, $"api/agent/organizations/{Uri.EscapeDataString(organizationId)}/code-lists", new { kind, items }), cancellationToken);

    public Task SendSyncResultAsync(AgentSyncResult result, CancellationToken cancellationToken) =>
        SendJsonAsync<JsonElement>(() => JsonRequest(HttpMethod.Post, "api/agent/sync-results", result), cancellationToken);

    public Task<IReadOnlyList<AgentExportJob>> GetExportQueueAsync(string organizationId, CancellationToken cancellationToken) =>
        SendJsonAsync<IReadOnlyList<AgentExportJob>>(
            () => new HttpRequestMessage(HttpMethod.Get, $"api/agent/export-queue?organizationId={Uri.EscapeDataString(organizationId)}"), cancellationToken);

    public Task SendExportResultsAsync(
        string exportJobId,
        IReadOnlyList<ExportDocumentResult> perDocument,
        object rawResponseMeta,
        CancellationToken cancellationToken) =>
        SendJsonAsync<JsonElement>(() => JsonRequest(HttpMethod.Post, "api/agent/export-results", new { exportJobId, perDocument, rawResponseMeta }), cancellationToken);

    public Task<AgentRelease> GetLatestReleaseAsync(CancellationToken cancellationToken) =>
        SendJsonAsync<AgentRelease>(() => new HttpRequestMessage(HttpMethod.Get, "api/agent/latest"), cancellationToken);

    private static HttpRequestMessage JsonRequest(HttpMethod method, string path, object body) => new(method, path)
    {
        Content = JsonContent.Create(body, options: JsonOptions),
    };

    private async Task<T> SendJsonAsync<T>(Func<HttpRequestMessage> requestFactory, CancellationToken cancellationToken)
    {
        Exception? last = null;
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            try
            {
                using var request = requestFactory();
                using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    if (response.StatusCode == HttpStatusCode.NoContent) return default!;
                    return await response.Content.ReadFromJsonAsync<T>(JsonOptions, cancellationToken)
                        ?? throw new InvalidOperationException("Backend vrátil prázdnu odpoveď.");
                }
                var exception = await ToException(response, cancellationToken);
                if (!exception.IsTransient) throw exception;
                last = exception;
            }
            catch (Exception error) when ((error is HttpRequestException or TaskCanceledException) && !cancellationToken.IsCancellationRequested)
            {
                last = error;
            }
            if (attempt < 5)
            {
                var delay = TimeSpan.FromMilliseconds(Math.Min(30_000, 500 * Math.Pow(2, attempt - 1) + Random.Shared.Next(50, 500)));
                _log.Info("backend_retry", new { attempt, delayMs = (int)delay.TotalMilliseconds, error = last?.GetType().Name });
                await Task.Delay(delay, cancellationToken);
            }
        }
        throw last ?? new InvalidOperationException("Backend požiadavka zlyhala.");
    }

    private static async Task<BackendApiException> ToException(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        string? message = null;
        try
        {
            var body = await response.Content.ReadFromJsonAsync<JsonElement>(JsonOptions, cancellationToken);
            if (body.TryGetProperty("message", out var property)) message = property.GetString();
        }
        catch (JsonException) { }
        var transient = response.StatusCode is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
            || (int)response.StatusCode >= 500;
        return new BackendApiException(response.StatusCode, message ?? $"Backend vrátil HTTP {(int)response.StatusCode}.", transient);
    }
}

public static class AgentVersion
{
    public static string Current { get; } = typeof(AgentVersion).Assembly.GetName().Version is { } version
        ? $"{version.Major}.{version.Minor}.{Math.Max(0, version.Build)}"
        : "0.1.0";
}
