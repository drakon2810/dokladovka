import type { DocumentItem } from '../../data/types';
import { t } from '../../i18n/sk';

// Vizuálny náhľad bankového výpisu (SEPA camt.053) — transakcie sú položky dokladu.

function money(value: number | undefined, currency: string): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function BankStatementPreview({ doklad, zoom }: { doklad: DocumentItem; zoom: number }) {
  const extracted = doklad.extracted;
  const mena = extracted.mena ?? 'EUR';
  const transakcie = extracted.polozky ?? [];

  return (
    <div
      className="self-start bg-white p-8 shadow"
      style={{ width: Math.round(560 * zoom), minWidth: Math.round(560 * zoom) }}
      data-testid="bank-statement-preview"
    >
      <div className="flex items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-lg font-bold tracking-tight text-ink">{t('vypis.titulok')}</p>
          <p className="text-xs text-ink-soft">{t('vypis.podtitul')}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{t('vypis.cislo')}</p>
          <p className="tnum text-lg font-bold text-ink">{extracted.cisloFaktury || '—'}</p>
        </div>
      </div>

      <dl className="tnum mt-5 grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl bg-app px-4 py-3 text-sm">
        <div><dt className="text-xs text-ink-soft">{t('vypis.banka')}</dt><dd>{extracted.dodavatel.nazov || '—'}</dd></div>
        <div><dt className="text-xs text-ink-soft">{t('vypis.majitel')}</dt><dd>{extracted.odberatel?.nazov ?? '—'}</dd></div>
        {extracted.dodavatel.iban && (
          <div className="col-span-2"><dt className="text-xs text-ink-soft">IBAN</dt><dd>{extracted.dodavatel.iban}</dd></div>
        )}
      </dl>

      <table className="mt-5 w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
            <th className="py-1.5 pr-2">{t('vypis.transakcia')}</th>
            <th className="tnum py-1.5 text-right">{t('vypis.suma')}</th>
          </tr>
        </thead>
        <tbody>
          {transakcie.length === 0 && (
            <tr><td colSpan={2} className="py-3 text-center text-ink-soft">{t('vypis.ziadne')}</td></tr>
          )}
          {transakcie.map((item) => (
            <tr key={item.id} className="border-b border-line/60 align-top">
              <td className="py-1.5 pr-2">{item.popis || '—'}</td>
              <td className={`tnum py-1.5 text-right font-medium ${
                (item.sumaSpolu ?? 0) < 0 ? 'text-red-700' : 'text-accent-hover'
              }`}>
                {money(item.sumaSpolu, mena)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-5 flex justify-end">
        <div className="tnum flex w-72 items-baseline justify-between border-t border-line pt-2">
          <span className="font-semibold text-ink">{t('vypis.zostatok')}</span>
          <span className="text-lg font-bold text-ink">{money(extracted.sumaSpolu, mena)}</span>
        </div>
      </div>
    </div>
  );
}
