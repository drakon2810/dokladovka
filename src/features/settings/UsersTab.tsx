// Ľudia kancelárie — pozvánky a prístup k firmám (model ako v Doklado:
// kancelária → ľudia → firmy). Všetko ide cez server: prístup k firme určuje
// organization_memberships a nič z toho nežije v pamäti prehliadača. Mostík
// patrí kancelárii, takže pozvaný s ním pracuje tiež bez nového párovania.
//
// Karty namiesto tabuľky: prístup k firmám je zoznam, nie jedna hodnota, a
// v riadku tabuľky sa buď nezmestil, alebo z nej urobil harmoniku. Na karte
// má vlastné miesto — čipy s firmami a rozbaľovací výber pod nimi.
//
// Pozvánka je PRVÁ dlaždica mriežky a rozbalí sa na mieste. Predtým to bol
// formulár nad zoznamom, ktorý zaberal pol obrazovky aj vtedy, keď admin nikoho
// nepozýval — a to je väčšina času.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import {
  nacitajPouzivatelov,
  odstranPouzivatela,
  odvolajPozvanku,
  pozviPouzivatela,
  upravPouzivatela,
  type PouzivatelKancelarie,
  type PozvankaKancelarie,
} from '../../data/api';
import { useDataQuery } from '../../data/query';
import type { Organization } from '../../data/types';
import { t, tv } from '../../i18n/sk';

type Rola = PouzivatelKancelarie['rola'];
const ROLY: readonly Rola[] = ['uctovnik', 'schvalovatel', 'admin'];
/** Koľko firiem sa vypíše čipmi, kým sa zvyšok zloží do „+N". */
const CIPOV_PRED_ZVYSKOM = 2;

const AVATARY = [
  { bg: '#E7F2ED', ink: '#0E7A5F' },
  { bg: '#E6EEF3', ink: '#2F5B78' },
  { bg: '#F1EDE4', ink: '#7A6234' },
  { bg: '#EDE9F1', ink: '#5A4A75' },
] as const;

/** Stabilná farba avatara — tá istá osoba má vždy tú istú, bez ukladania. */
function avatarPre(id: string) {
  let suma = 0;
  for (let index = 0; index < id.length; index += 1) suma += id.charCodeAt(index);
  return AVATARY[suma % AVATARY.length];
}

function iniciale(meno: string, email: string): string {
  const zdroj = meno.trim() || email.replace(/@.*$/, '');
  const casti = zdroj.split(/[\s._-]+/).filter(Boolean);
  if (casti.length >= 2) return (casti[0][0] + casti[1][0]).toLocaleUpperCase('sk');
  return zdroj.slice(0, 2).toLocaleUpperCase('sk');
}

/**
 * „dnes 09:12" · „včera 16:22" · „11. 9. 2026". Presný dátum je pri dnešnom
 * vstupe zbytočný a pri starom naopak jediné, čo hovorí — preto dve podoby.
 */
function poslednyText(iso?: string): string {
  if (!iso) return t('nast.pouz.nikdyNeprihlaseny');
  const kedy = new Date(iso);
  const dnes = new Date();
  const cas = `${String(kedy.getHours()).padStart(2, '0')}:${String(kedy.getMinutes()).padStart(2, '0')}`;
  const denRozdiel = Math.floor(
    (new Date(dnes.getFullYear(), dnes.getMonth(), dnes.getDate()).getTime()
      - new Date(kedy.getFullYear(), kedy.getMonth(), kedy.getDate()).getTime()) / 86_400_000,
  );
  if (denRozdiel === 0) return `${t('nast.pouz.dnes')} ${cas}`;
  if (denRozdiel === 1) return `${t('nast.pouz.vcera')} ${cas}`;
  return `${kedy.getDate()}. ${kedy.getMonth() + 1}. ${kedy.getFullYear()}`;
}

export function UsersTab() {
  const { session } = useAuth();
  const firmy = useDataQuery().data?.organizations ?? [];
  const [users, setUsers] = useState<PouzivatelKancelarie[]>([]);
  const [pozvanky, setPozvanky] = useState<PozvankaKancelarie[]>([]);
  const [chyba, setChyba] = useState('');
  const [info, setInfo] = useState('');
  const [upravuje, setUpravuje] = useState<{ id: string; ids: string[] }>();
  const [pozvanieOtvorene, setPozvanieOtvorene] = useState(false);
  const [nova, setNova] = useState({ email: '', meno: '', rola: 'uctovnik' as Rola, ids: [] as string[] });
  const [odosiela, setOdosiela] = useState(false);
  const [hladanie, setHladanie] = useState('');
  const [filterRoly, setFilterRoly] = useState<Rola | 'vsetci'>('vsetci');
  const [zoradenie, setZoradenie] = useState<'meno' | 'rola' | 'firmy' | 'posledny'>('meno');

  const nacitaj = useCallback(async () => {
    try {
      const data = await nacitajPouzivatelov();
      setUsers(data.users);
      setPozvanky(data.pozvanky);
    } catch (error) {
      setChyba(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => { void nacitaj(); }, [nacitaj]);

  // Každá akcia sa po sebe prenačíta zo servera — ten je jediný zdroj pravdy.
  async function akcia(fn: () => Promise<unknown>, spravaOk?: string): Promise<boolean> {
    setChyba('');
    setInfo('');
    try {
      await fn();
      if (spravaOk) setInfo(spravaOk);
      await nacitaj();
      return true;
    } catch (error) {
      setChyba(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  const vyhovuje = useCallback((meno: string, email: string, rola: Rola) => {
    if (filterRoly !== 'vsetci' && rola !== filterRoly) return false;
    const dopyt = hladanie.trim().toLocaleLowerCase('sk');
    if (!dopyt) return true;
    return `${meno} ${email}`.toLocaleLowerCase('sk').includes(dopyt);
  }, [filterRoly, hladanie]);

  const zobrazeni = useMemo(() => {
    const pocetFiriem = (osoba: PouzivatelKancelarie) =>
      (osoba.rola === 'admin' ? firmy.length : osoba.organizationIds.length);
    return users
      .filter((osoba) => vyhovuje(osoba.meno, osoba.email, osoba.rola))
      .slice()
      .sort((a, b) => {
        if (zoradenie === 'rola') return ROLY.indexOf(a.rola) - ROLY.indexOf(b.rola) || a.meno.localeCompare(b.meno, 'sk');
        if (zoradenie === 'firmy') return pocetFiriem(b) - pocetFiriem(a) || a.meno.localeCompare(b.meno, 'sk');
        // Kto tu nebol nikdy, patrí na konec — nie na začiatok ako „najstarší".
        if (zoradenie === 'posledny') {
          return (b.poslednyVstup ?? '').localeCompare(a.poslednyVstup ?? '') || a.meno.localeCompare(b.meno, 'sk');
        }
        return a.meno.localeCompare(b.meno, 'sk');
      });
  }, [users, vyhovuje, zoradenie, firmy.length]);

  const zobrazenePozvanky = useMemo(
    () => pozvanky.filter((pozvanka) => vyhovuje(pozvanka.meno, pozvanka.email, pozvanka.rola)),
    [pozvanky, vyhovuje],
  );

  if (session?.user.role !== 'admin') {
    return <div className="card max-w-2xl p-4 text-sm text-ink-soft">{t('nast.pouz.lenAdmin')}</div>;
  }

  async function pozvi(event: React.FormEvent) {
    event.preventDefault();
    setOdosiela(true);
    const odoslana = await akcia(
      () => pozviPouzivatela({ email: nova.email, meno: nova.meno, rola: nova.rola, organizationIds: nova.ids }),
      tv('nast.pouz.pozvankaOdoslana', { email: nova.email }),
    );
    // Formulár sa vyprázdni len po úspechu — pri odmietnutí (adresa v inej
    // kancelárii) by inak účtovník prišiel o všetko, čo vyplnil.
    if (odoslana) {
      setNova({ email: '', meno: '', rola: 'uctovnik', ids: [] });
      setPozvanieOtvorene(false);
    }
    setOdosiela(false);
  }

  const prazdno = zobrazeni.length === 0 && zobrazenePozvanky.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {chyba && <div className="card border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{chyba}</div>}
      {info && <div className="card border-accent/30 bg-tint p-3 text-sm text-accent">{info}</div>}

      {/* Hľadanie, filter podľa roly, počet a zoradenie. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex w-[300px] items-center gap-2 rounded-[10px] border border-line bg-surface px-3 py-2 focus-within:border-accent">
          <span className="text-ink-faint">⌕</span>
          <input
            value={hladanie}
            onChange={(udalost) => setHladanie(udalost.target.value)}
            placeholder={t('nast.pouz.hladat')}
            className="w-full border-0 bg-transparent text-[12.5px] text-ink outline-none"
          />
        </div>
        <div className="flex gap-1.5">
          {(['vsetci', ...ROLY] as const).map((rola) => {
            const aktivna = filterRoly === rola;
            return (
              <button
                key={rola}
                type="button"
                onClick={() => setFilterRoly(rola)}
                className="rounded-full border px-3 py-1.5 text-[12.5px] transition-colors"
                style={aktivna
                  ? { background: '#E7F2ED', borderColor: '#A7D9C9', color: '#0A6650', fontWeight: 600 }
                  : { background: '#FFFFFF', borderColor: '#E4E8E4', color: '#5A635D', fontWeight: 500 }}
              >
                {rola === 'vsetci' ? t('nast.pouz.vsetci') : t(`rola.${rola}`)}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-[12.5px] text-ink-faint">
          {tv('nast.pouz.pocetLudi', {
            ludi: String(zobrazeni.length),
            pozvanych: String(zobrazenePozvanky.length),
          })}
        </span>
        <select
          value={zoradenie}
          onChange={(udalost) => setZoradenie(udalost.target.value as typeof zoradenie)}
          className="rounded-[10px] border border-line bg-surface px-2.5 py-2 text-[12.5px] font-medium text-ink"
          aria-label={t('nast.pouz.zoradit')}
        >
          <option value="meno">{t('nast.pouz.zoradit')}: {t('nast.pouz.meno')}</option>
          <option value="rola">{t('nast.pouz.zoradit')}: {t('nast.pouz.rola')}</option>
          <option value="firmy">{t('nast.pouz.zoradit')}: {t('nast.pouz.pocetFiriem')}</option>
          <option value="posledny">{t('nast.pouz.zoradit')}: {t('nast.pouz.poslednyVstup')}</option>
        </select>
      </div>

      <div className="grid grid-cols-1 items-start gap-3.5 md:grid-cols-2 xl:grid-cols-3">
        {pozvanieOtvorene ? (
          <form
            onSubmit={pozvi}
            className="col-span-full flex flex-col gap-3 rounded-[14px] bg-surface p-4.5 shadow-card"
            style={{ border: '1px solid #A7D9C9', padding: 18 }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-[14.5px] font-semibold text-ink">{t('nast.pouz.pozvat')}</span>
                <span className="max-w-[640px] text-[12.5px] leading-relaxed text-ink-soft">
                  {t('nast.pouz.pozvatPopis')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setPozvanieOtvorene(false)}
                aria-label={t('nast.pouz.zrusit')}
                className="h-[30px] w-[30px] rounded-[9px] border border-line bg-surface text-ink-soft"
              >
                ×
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_200px]">
              <label className="flex flex-col gap-1.5">
                <span className="text-[11.5px] font-medium text-ink-soft">{t('nast.pouz.email')}</span>
                <input
                  type="email"
                  required
                  value={nova.email}
                  onChange={(udalost) => setNova({ ...nova, email: udalost.target.value })}
                  placeholder="kolega@firma.sk"
                  className="input"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11.5px] font-medium text-ink-soft">{t('nast.pouz.meno')}</span>
                <input
                  value={nova.meno}
                  onChange={(udalost) => setNova({ ...nova, meno: udalost.target.value })}
                  placeholder={t('nast.pouz.menoPlaceholder')}
                  className="input"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11.5px] font-medium text-ink-soft">{t('nast.pouz.rola')}</span>
                <select
                  value={nova.rola}
                  onChange={(udalost) => setNova({ ...nova, rola: udalost.target.value as Rola })}
                  className="input"
                >
                  {ROLY.map((rola) => <option key={rola} value={rola}>{t(`rola.${rola}`)}</option>)}
                </select>
              </label>
            </div>
            {/* Admin dostane všetky firmy automaticky — výber by klamal. */}
            {nova.rola !== 'admin' && (
              <div className="flex flex-col gap-2">
                <span className="text-[11.5px] font-medium text-ink-soft">{t('nast.pouz.firmy')}</span>
                <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                  {firmy.filter((firma) => !firma.archived).map((firma) => {
                    const vybrana = nova.ids.includes(firma.id);
                    return (
                      <label
                        key={firma.id}
                        className="flex cursor-pointer items-center gap-2 rounded-[10px] border px-2.5 py-2"
                        style={vybrana
                          ? { borderColor: '#A7D9C9', background: '#E7F2ED' }
                          : { borderColor: '#E4E8E4', background: '#FFFFFF' }}
                      >
                        <input
                          type="checkbox"
                          checked={vybrana}
                          onChange={() => setNova({
                            ...nova,
                            ids: vybrana ? nova.ids.filter((id) => id !== firma.id) : [...nova.ids, firma.id],
                          })}
                          className="h-[15px] w-[15px] accent-accent"
                        />
                        <span className="truncate text-[12px] font-medium text-ink">{firma.nazov}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex items-center gap-3">
              <button type="submit" disabled={odosiela} className="btn btn-primary px-4 py-2 text-[13px]">
                {t('nast.pouz.poslat')}
              </button>
              <span className="text-[12.5px] text-ink-faint">{t(`nast.pouz.popisRoly.${nova.rola}`)}</span>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setPozvanieOtvorene(true)}
            className="flex min-h-[184px] w-full flex-col items-start gap-2 rounded-[14px] p-5 text-left transition-colors hover:border-accent hover:bg-tint"
            style={{ border: '1.5px dashed #C9D0CB', background: '#FBFCFA' }}
          >
            <span className="grid h-[38px] w-[38px] place-items-center rounded-xl bg-accent text-lg text-white shadow-glow">+</span>
            <span className="text-[14.5px] font-semibold text-ink">{t('nast.pouz.pozvat')}</span>
            <span className="text-[12.5px] leading-relaxed text-ink-soft">{t('nast.pouz.pozvatKratko')}</span>
          </button>
        )}

        {zobrazeni.map((osoba) => (
          <KartaOsoby
            key={osoba.id}
            osoba={osoba}
            firmy={firmy}
            upravuje={upravuje?.id === osoba.id ? upravuje.ids : undefined}
            onZacniUpravu={() => setUpravuje({ id: osoba.id, ids: osoba.organizationIds })}
            onZmenVyber={(ids) => setUpravuje({ id: osoba.id, ids })}
            onZrus={() => setUpravuje(undefined)}
            onUloz={() => void akcia(() => upravPouzivatela(osoba.id, { organizationIds: upravuje?.ids ?? [] }))
              .then((ok) => { if (ok) setUpravuje(undefined); })}
            onZmenRolu={(rola) => void akcia(() => upravPouzivatela(osoba.id, { rola }))}
            onOdstran={() => {
              if (window.confirm(tv('nast.pouz.odstranitPotvrd', { meno: osoba.meno }))) {
                void akcia(() => odstranPouzivatela(osoba.id));
              }
            }}
          />
        ))}

        {zobrazenePozvanky.map((pozvanka) => (
          <KartaPozvanky
            key={pozvanka.id}
            pozvanka={pozvanka}
            firmy={firmy}
            onOdvolaj={() => void akcia(() => odvolajPozvanku(pozvanka.id))}
          />
        ))}
      </div>

      {prazdno && (
        <div className="p-8 text-center text-[13px] text-ink-faint">{t('nast.pouz.nikdoNesedi')}</div>
      )}
    </div>
  );
}

/* ── Karta ──────────────────────────────────────────────────────────────── */

function StavPilulka({ pozvany }: { pozvany?: boolean }) {
  const styl = pozvany
    ? { background: '#F0F2EF', color: '#5A635D', dot: '#9AA39C' }
    : { background: '#E7F2ED', color: '#0A6650', dot: '#16A37B' };
  return (
    <span
      className="inline-flex flex-none items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{ background: styl.background, color: styl.color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: styl.dot }} />
      {pozvany ? t('nast.pouz.pozvany') : t('nast.pouz.aktivny')}
    </span>
  );
}

function Hlavicka({ id, meno, email, ja, pozvany }: {
  id: string; meno: string; email: string; ja?: boolean; pozvany?: boolean;
}) {
  const farba = avatarPre(id);
  return (
    <div className="flex items-start gap-3">
      <span
        className="grid h-10 w-10 flex-none place-items-center rounded-xl text-[13.5px] font-semibold"
        style={{ background: farba.bg, color: farba.ink }}
      >
        {iniciale(meno, email)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[14px] font-semibold text-ink">{meno || email}</span>
          {ja && <span className="flex-none text-[11.5px] text-ink-faint">{t('nast.pouz.vy')}</span>}
        </div>
        <span className="truncate text-[12px] text-ink-soft">{email}</span>
      </div>
      <StavPilulka pozvany={pozvany} />
    </div>
  );
}

function Cipy({ rola, ids, firmy }: { rola: Rola; ids: readonly string[]; firmy: readonly Organization[] }) {
  if (rola === 'admin') {
    return <span className="text-[11.5px] font-medium text-ink-soft">{t('nast.pouz.vsetkyFirmy')}</span>;
  }
  const nazvy = ids.map((id) => firmy.find((firma) => firma.id === id)?.nazov).filter(Boolean) as string[];
  if (nazvy.length === 0) {
    return <span className="text-[11.5px] font-medium text-ink-soft">{t('nast.pouz.ziadnaFirma')}</span>;
  }
  return (
    <>
      {nazvy.slice(0, CIPOV_PRED_ZVYSKOM).map((nazov) => (
        <span
          key={nazov}
          className="inline-flex max-w-full truncate rounded-full border border-line px-2.5 py-0.5 text-[11.5px] font-medium text-ink"
          style={{ background: '#F0F2EF' }}
        >
          {nazov}
        </span>
      ))}
      {nazvy.length > CIPOV_PRED_ZVYSKOM && (
        <span className="self-center text-[11.5px] font-medium text-accent">
          +{nazvy.length - CIPOV_PRED_ZVYSKOM}
        </span>
      )}
    </>
  );
}

function KartaOsoby({
  osoba, firmy, upravuje, onZacniUpravu, onZmenVyber, onZrus, onUloz, onZmenRolu, onOdstran,
}: {
  osoba: PouzivatelKancelarie;
  firmy: readonly Organization[];
  upravuje?: readonly string[];
  onZacniUpravu: () => void;
  onZmenVyber: (ids: string[]) => void;
  onZrus: () => void;
  onUloz: () => void;
  onZmenRolu: (rola: Rola) => void;
  onOdstran: () => void;
}) {
  const pocet = osoba.rola === 'admin' ? firmy.length : osoba.organizationIds.length;
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-4 shadow-card">
      <Hlavicka id={osoba.id} meno={osoba.meno} email={osoba.email} ja={osoba.ja} />
      <div className="h-px" style={{ background: '#F0F2EF' }} />

      {/* Rolu si admin nesmie zmeniť sám — kancelária bez admina nemá kto spravovať. */}
      {osoba.ja ? (
        <span
          className="self-start rounded-[9px] px-2.5 py-1.5 text-[12px] font-medium text-ink-soft"
          style={{ border: '1px dashed #D8DED9' }}
        >
          {t(`rola.${osoba.rola}`)}
        </span>
      ) : (
        <div className="flex gap-1 rounded-[10px] p-0.5" style={{ background: '#F0F2EF' }}>
          {ROLY.map((rola) => {
            const aktivna = osoba.rola === rola;
            return (
              <button
                key={rola}
                type="button"
                onClick={() => { if (!aktivna) onZmenRolu(rola); }}
                className="flex-1 rounded-lg px-1 py-1.5 text-[12px] transition-colors"
                style={aktivna
                  ? { background: '#FFFFFF', color: '#0A6650', fontWeight: 600, boxShadow: '0 1px 2px rgba(27,31,29,.08)' }
                  : { background: 'transparent', color: '#5A635D', fontWeight: 500 }}
              >
                {t(`rola.${rola}`)}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] font-medium text-ink-soft">{t('nast.pouz.firmy')}</span>
          <span className="tnum text-[11.5px] font-semibold" style={{ color: '#0A6650' }}>
            {tv('nast.pouz.zFiriem', { pocet: String(pocet), celkom: String(firmy.length) })}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          <Cipy rola={osoba.rola} ids={osoba.organizationIds} firmy={firmy} />
        </div>

        {osoba.rola !== 'admin' && (
          <button
            type="button"
            onClick={() => (upravuje ? onZrus() : onZacniUpravu())}
            className="self-start text-[11.5px] font-medium text-accent hover:underline"
          >
            {t('nast.pouz.upravitFirmy')} {upravuje ? '▴' : '▾'}
          </button>
        )}

        {upravuje && (
          <div className="flex flex-col gap-2 rounded-[11px] border border-line p-2.5" style={{ background: '#FBFCFA' }}>
            <div className="flex max-h-[150px] flex-col gap-0.5 overflow-y-auto">
              {firmy.filter((firma) => !firma.archived).map((firma) => {
                const vybrana = upravuje.includes(firma.id);
                return (
                  <label
                    key={firma.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1"
                    style={{ background: vybrana ? '#E7F2ED' : 'transparent' }}
                  >
                    <input
                      type="checkbox"
                      checked={vybrana}
                      onChange={() => onZmenVyber(vybrana
                        ? upravuje.filter((id) => id !== firma.id)
                        : [...upravuje, firma.id])}
                      className="h-3.5 w-3.5 accent-accent"
                    />
                    <span className="truncate text-[12px] text-ink">{firma.nazov}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex gap-1.5">
              <button type="button" onClick={onUloz} className="btn btn-primary px-3 py-1.5 text-[12px]">
                {t('nast.pouz.ulozit')}
              </button>
              <button type="button" onClick={onZrus} className="btn px-3 py-1.5 text-[12px]">
                {t('nast.pouz.zrusit')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        className="flex items-center justify-between gap-2 pt-1"
        style={{ borderTop: '1px solid #F0F2EF' }}
      >
        <span className="tnum text-[11.5px]" style={{ color: '#9AA39C' }}>{poslednyText(osoba.poslednyVstup)}</span>
        {!osoba.ja && (
          <button
            type="button"
            onClick={onOdstran}
            className="rounded-[9px] bg-surface px-2.5 py-1.5 text-[11.5px] font-medium"
            style={{ border: '1px solid #EFE2E2', color: '#B4322F' }}
          >
            {t('nast.pouz.odstranit')}
          </button>
        )}
      </div>
    </div>
  );
}

function KartaPozvanky({ pozvanka, firmy, onOdvolaj }: {
  pozvanka: PozvankaKancelarie;
  firmy: readonly Organization[];
  onOdvolaj: () => void;
}) {
  const pocet = pozvanka.rola === 'admin' ? firmy.length : pozvanka.organizationIds.length;
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface p-4 shadow-card">
      <Hlavicka id={pozvanka.id} meno={pozvanka.meno} email={pozvanka.email} pozvany />
      <div className="h-px" style={{ background: '#F0F2EF' }} />
      <span
        className="self-start rounded-[9px] px-2.5 py-1.5 text-[12px] font-medium text-ink-soft"
        style={{ border: '1px dashed #D8DED9' }}
      >
        {t(`rola.${pozvanka.rola}`)}
      </span>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] font-medium text-ink-soft">{t('nast.pouz.firmy')}</span>
          <span className="tnum text-[11.5px] font-semibold" style={{ color: '#0A6650' }}>
            {tv('nast.pouz.zFiriem', { pocet: String(pocet), celkom: String(firmy.length) })}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          <Cipy rola={pozvanka.rola} ids={pozvanka.organizationIds} firmy={firmy} />
        </div>
        {/* Pozvanému sa firmy menia až po prijatí — dovtedy neexistuje ako člen. */}
        <span className="text-[11.5px] text-ink-faint">{t('nast.pouz.firmyPoPrijati')}</span>
      </div>
      <div className="flex items-center justify-between gap-2 pt-1" style={{ borderTop: '1px solid #F0F2EF' }}>
        <span className="tnum text-[11.5px]" style={{ color: '#9AA39C' }}>
          {tv('nast.pouz.platiDo', { datum: new Date(pozvanka.expiresAt).toLocaleDateString('sk-SK') })}
        </span>
        <button
          type="button"
          onClick={onOdvolaj}
          className="rounded-[9px] bg-surface px-2.5 py-1.5 text-[11.5px] font-medium"
          style={{ border: '1px solid #EFE2E2', color: '#B4322F' }}
        >
          {t('nast.pouz.odvolat')}
        </button>
      </div>
    </div>
  );
}
