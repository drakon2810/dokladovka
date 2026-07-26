// Samostatná stránka asistenta — všeobecné otázky o firme mimo konkrétneho
// dokladu. Firma sa berie z prepínača organizácie; pri „všetky organizácie"
// treba jednu vybrať, lebo asistent odpovedá vždy len za jednu firmu.
import { useState } from 'react';
import { useDataQuery } from '../../data/query';
import { AssistantPanel } from './AssistantPanel';

export function AssistantPage() {
  const { data, loading } = useDataQuery();
  const [zvolena, setZvolena] = useState<string>('');

  const organizacie = data?.organizations ?? [];
  const zPrepinaca = data?.currentOrgId && data.currentOrgId !== 'all' ? data.currentOrgId : '';
  const organizationId = zPrepinaca || zvolena;
  const organizacia = organizacie.find((item) => item.id === organizationId);

  if (loading && organizacie.length === 0) {
    return <div className="card p-6 text-sm text-ink-soft">Načítavam…</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Asistent</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Odpovedá na otázky o účtovaní vybranej firmy — z jej pravidiel, histórie a profilu.
        </p>
      </div>

      {!zPrepinaca && (
        <label className="flex max-w-sm flex-col gap-1 text-sm">
          <span className="text-ink-soft">Firma</span>
          <select
            className="h-10 rounded-lg border border-line px-3 text-sm"
            value={zvolena}
            onChange={(event) => setZvolena(event.target.value)}
          >
            <option value="">Vyberte firmu…</option>
            {organizacie.map((item) => (
              <option key={item.id} value={item.id}>{item.nazov}</option>
            ))}
          </select>
        </label>
      )}

      {organizationId ? (
        <div className="min-h-0 flex-1" style={{ minHeight: 520 }}>
          <AssistantPanel organizationId={organizationId} organizationName={organizacia?.nazov} />
        </div>
      ) : (
        <div className="card p-6 text-sm text-ink-soft">
          Vyberte firmu, ktorej sa chcete pýtať — asistent odpovedá vždy len za jednu organizáciu.
        </div>
      )}
    </div>
  );
}
