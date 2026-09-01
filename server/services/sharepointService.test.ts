import { describe, expect, it, vi } from 'vitest';
import { graphClient, SharePointError } from './sharepointService.js';

interface Volanie { url: string; init: RequestInit | undefined }

/** Fakeový fetch: postupne vracia pripravené odpovede a zapisuje, čo dostal. */
function fakeFetch(odpovede: Array<(url: string) => Response>) {
  const volania: Volanie[] = [];
  let index = 0;
  const impl = (async (url: unknown, init?: RequestInit) => {
    const adresa = String(url);
    volania.push({ url: adresa, init });
    const odpoved = odpovede[Math.min(index, odpovede.length - 1)];
    index += 1;
    return odpoved(adresa);
  }) as unknown as typeof fetch;
  return { impl, volania };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TOKEN = () => json({ access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1' });

function klient(odpovede: Array<(url: string) => Response>, onRotated = vi.fn(async () => {})) {
  const { impl, volania } = fakeFetch(odpovede);
  const client = graphClient({
    clientId: 'app', clientSecret: 'secret', fetchImpl: impl,
    tokens: { msTenantId: 'tenant-1', refreshToken: 'rt-0', onRefreshTokenRotated: onRotated },
  });
  return { client, volania, onRotated };
}

describe('Graph klient', () => {
  it('vypýta si token a druhýkrát ho už nepýta', async () => {
    const { client, volania } = klient([
      TOKEN,
      () => json({ value: [] }),
      () => json({ value: [] }),
    ]);
    await client.list('drive', 'folder');
    await client.list('drive', 'folder');
    expect(volania.filter((v) => v.url.includes('login.microsoftonline.com'))).toHaveLength(1);
  });

  it('nový refresh token uloží — inak by pripojenie po vypršaní odumrelo', async () => {
    const onRotated = vi.fn(async () => {});
    const { client } = klient([
      () => json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt-NOVY' }),
      () => json({ value: [] }),
    ], onRotated);
    await client.list('d', 'f');
    expect(onRotated).toHaveBeenCalledWith('rt-NOVY');
  });

  it('invalid_grant je trvalá chyba — treba nové prihlásenie, nie ďalší pokus', async () => {
    const { client } = klient([() => json({ error: 'invalid_grant', error_description: 'expired' }, 400)]);
    await expect(client.list('d', 'f')).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('priečinky preskočí a dotiahne ďalšiu stránku', async () => {
    const { client } = klient([
      TOKEN,
      () => json({
        value: [
          { id: '1', name: 'faktura.pdf', size: 10, file: { mimeType: 'application/pdf' } },
          { id: '2', name: 'archiv', folder: { childCount: 3 } },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/drives/d/items/f/children?$skiptoken=x',
      }),
      () => json({ value: [{ id: '3', name: 'druha.pdf', size: 20, file: {} }] }),
    ]);
    expect(await client.list('d', 'f')).toEqual([
      { id: '1', name: 'faktura.pdf', size: 10 },
      { id: '3', name: 'druha.pdf', size: 20 },
    ]);
  });

  it('sťahovanie neposiela náš token na cudziu adresu', async () => {
    const { client, volania } = klient([
      TOKEN,
      () => new Response(null, { status: 302, headers: { location: 'https://sharepoint-cdn.example/blob' } }),
      () => new Response(Buffer.from('%PDF-1.7')),
    ]);
    expect((await client.download('d', 'i')).toString()).toBe('%PDF-1.7');
    const stiahnutie = volania.find((v) => v.url.includes('sharepoint-cdn'));
    expect(stiahnutie).toBeDefined();
    expect((stiahnutie!.init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
  });

  it('presun pošle nový názov aj nový priečinok naraz', async () => {
    const { client, volania } = klient([TOKEN, () => json({ id: 'i' })]);
    await client.move('d', 'i', 'ciel', '2026-09-01_FP2600123_faktura.pdf');
    const patch = volania.at(-1)!;
    expect(patch.init?.method).toBe('PATCH');
    expect(patch.url).toContain('conflictBehavior=rename');
    expect(JSON.parse(String(patch.init?.body))).toEqual({
      name: '2026-09-01_FP2600123_faktura.pdf',
      parentReference: { id: 'ciel' },
    });
  });

  it('404 rozlíši od ostatných chýb', async () => {
    const { client } = klient([TOKEN, () => new Response('', { status: 404 })]);
    await expect(client.list('d', 'zmazany')).rejects.toBeInstanceOf(SharePointError);
    const { client: druhy } = klient([TOKEN, () => new Response('', { status: 404 })]);
    await expect(druhy.list('d', 'zmazany')).rejects.toMatchObject({ code: 'not_found' });
  });
});
