// Ľudia kancelárie — pozvánky a prístup k firmám (model ako v Doklado:
// kancelária → ľudia → firmy). Všetko ide cez server: prístup k firme určuje
// organization_memberships a nič z toho nežije v pamäti prehliadača. Mostík
// patrí kancelárii, takže pozvaný s ním pracuje tiež bez nového párovania.
import { useCallback, useEffect, useState } from 'react';
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

function VyberFiriem({ firmy, vybrane, zmen }: {
  firmy: readonly Organization[];
  vybrane: readonly string[];
  zmen: (ids: string[]) => void;
}) {
  const prepni = (id: string) => zmen(vybrane.includes(id) ? vybrane.filter((x) => x !== id) : [...vybrane, id]);
  return (
    <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded border border-line p-2">
      {firmy.map((firma) => (
        <label key={firma.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={vybrane.includes(firma.id)} onChange={() => prepni(firma.id)} />
          <span>{firma.nazov}</span>
          {firma.ico && <span className="text-xs text-ink-soft">{firma.ico}</span>}
        </label>
      ))}
    </div>
  );
}

function popisFiriem(rola: Rola, ids: readonly string[], firmy: readonly Organization[]): string {
  if (rola === 'admin') return t('nast.pouz.vsetkyFirmy');
  if (ids.length === 0) return t('nast.pouz.ziadnaFirma');
  const nazvy = ids.map((id) => firmy.find((firma) => firma.id === id)?.nazov).filter(Boolean);
  return nazvy.length <= 2 ? nazvy.join(', ') : `${nazvy.slice(0, 2).join(', ')} +${nazvy.length - 2}`;
}

export function UsersTab() {
  const { session } = useAuth();
  const firmy = useDataQuery().data?.organizations ?? [];
  const [users, setUsers] = useState<PouzivatelKancelarie[]>([]);
  const [pozvanky, setPozvanky] = useState<PozvankaKancelarie[]>([]);
  const [chyba, setChyba] = useState('');
  const [info, setInfo] = useState('');
  const [upravuje, setUpravuje] = useState<{ id: string; ids: string[] } | null>(null);
  const [nova, setNova] = useState({ email: '', meno: '', rola: 'uctovnik' as Rola, ids: [] as string[] });
  const [odosiela, setOdosiela] = useState(false);

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
    if (odoslana) setNova({ email: '', meno: '', rola: 'uctovnik', ids: [] });
    setOdosiela(false);
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <form onSubmit={pozvi} className="card flex flex-col gap-3 p-4">
        <div>
          <h3 className="font-semibold">{t('nast.pouz.pozvat')}</h3>
          <p className="text-sm text-ink-soft">{t('nast.pouz.pozvatPopis')}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="label">{t('nast.pouz.email')}</span>
            <input className="input" type="email" required value={nova.email}
              onChange={(e) => setNova({ ...nova, email: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">{t('nast.pouz.meno')}</span>
            <input className="input" required value={nova.meno}
              onChange={(e) => setNova({ ...nova, meno: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label">{t('nast.pouz.rola')}</span>
            <select className="input" value={nova.rola} onChange={(e) => setNova({ ...nova, rola: e.target.value as Rola })}>
              {ROLY.map((rola) => <option key={rola} value={rola}>{t(`rola.${rola}`)}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <span className="label">{t('nast.pouz.firmy')}</span>
          {nova.rola === 'admin'
            ? <p className="text-sm text-ink-soft">{t('nast.pouz.adminVidiVsetko')}</p>
            : <VyberFiriem firmy={firmy} vybrane={nova.ids} zmen={(ids) => setNova({ ...nova, ids })} />}
        </div>
        <div>
          <button type="submit" className="btn btn-primary" disabled={odosiela}>{t('nast.pouz.odoslatPozvanku')}</button>
        </div>
      </form>

      {chyba && <div className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{chyba}</div>}
      {info && <div className="rounded border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900">{info}</div>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-soft">
              <th className="px-3 py-2 font-medium">{t('nast.pouz.meno')}</th>
              <th className="px-3 py-2 font-medium">{t('nast.pouz.email')}</th>
              <th className="px-3 py-2 font-medium">{t('nast.pouz.rola')}</th>
              <th className="px-3 py-2 font-medium">{t('nast.pouz.firmy')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-line align-top last:border-0">
                <td className="px-3 py-2.5 font-medium">
                  {user.meno}{user.ja && <span className="ml-1 text-xs text-ink-soft">({t('nast.pouz.ja')})</span>}
                </td>
                <td className="px-3 py-2.5">{user.email}</td>
                <td className="px-3 py-2.5">
                  <select
                    className="input w-auto"
                    value={user.rola}
                    onChange={(e) => void akcia(() => upravPouzivatela(user.id, { rola: e.target.value as Rola }))}
                    aria-label={`${t('nast.pouz.rola')} — ${user.meno}`}
                  >
                    {ROLY.map((rola) => <option key={rola} value={rola}>{t(`rola.${rola}`)}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2.5">
                  {upravuje?.id === user.id ? (
                    <div className="flex flex-col gap-2">
                      <VyberFiriem firmy={firmy} vybrane={upravuje.ids} zmen={(ids) => setUpravuje({ id: user.id, ids })} />
                      <div className="flex gap-2">
                        <button type="button" className="btn btn-primary px-2 py-1 text-xs"
                          onClick={() => void akcia(() => upravPouzivatela(user.id, { organizationIds: upravuje.ids })).then((ok) => { if (ok) setUpravuje(null); })}>
                          {t('nast.pouz.ulozit')}
                        </button>
                        <button type="button" className="btn px-2 py-1 text-xs" onClick={() => setUpravuje(null)}>{t('nast.pouz.zrusit')}</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <span>{popisFiriem(user.rola, user.organizationIds, firmy)}</span>
                      {user.rola !== 'admin' && (
                        <button type="button" className="self-start text-xs text-accent underline-offset-2 hover:underline"
                          onClick={() => setUpravuje({ id: user.id, ids: user.organizationIds })}>
                          {t('nast.pouz.upravitFirmy')}
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {!user.ja && (
                    <button type="button" className="btn btn-danger px-2 py-1 text-xs"
                      onClick={() => {
                        if (window.confirm(tv('nast.pouz.odstranitPotvrd', { meno: user.meno }))) {
                          void akcia(() => odstranPouzivatela(user.id));
                        }
                      }}>
                      {t('nast.pouz.odstranit')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pozvanky.length > 0 && (
        <div className="card p-4">
          <h3 className="mb-2 font-semibold">{t('nast.pouz.cakajuce')}</h3>
          <ul className="flex flex-col gap-2 text-sm">
            {pozvanky.map((pozvanka) => (
              <li key={pozvanka.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{pozvanka.email}</span>
                  {' · '}{t(`rola.${pozvanka.rola}`)}
                  {' · '}{popisFiriem(pozvanka.rola, pozvanka.organizationIds, firmy)}
                  {' · '}<span className="text-ink-soft">
                    {tv('nast.pouz.platiDo', { datum: new Date(pozvanka.expiresAt).toLocaleDateString('sk-SK') })}
                  </span>
                </span>
                <button type="button" className="btn px-2 py-1 text-xs" onClick={() => void akcia(() => odvolajPozvanku(pozvanka.id))}>
                  {t('nast.pouz.odvolat')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
