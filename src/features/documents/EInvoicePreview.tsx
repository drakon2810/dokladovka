import type { DocumentItem } from '../../data/types';
import { t } from '../../i18n/sk';

// Vizuálna faktúra vygenerovaná z dát PEPPOL XML (SPEC: e-faktúra bez PDF).
// Účtovník vidí doklad ako bežnú faktúru; originálom zostáva strojový XML.

function money(value: number | undefined, currency: string): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function date(value: string | undefined): string {
  if (!value) return '—';
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

function Party({ title, nazov, ico, dic, icDph, adresa }: {
  title: string; nazov?: string; ico?: string; dic?: string; icDph?: string; adresa?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{title}</p>
      <p className="mt-1 font-semibold text-ink">{nazov || '—'}</p>
      {adresa && <p className="whitespace-pre-line text-sm text-ink-soft">{adresa}</p>}
      <dl className="tnum mt-1.5 space-y-0.5 text-sm text-ink-soft">
        {ico && <div>IČO: {ico}</div>}
        {dic && <div>DIČ: {dic}</div>}
        {icDph && <div>IČ DPH: {icDph}</div>}
      </dl>
    </div>
  );
}

export function EInvoicePreview({ doklad, zoom }: { doklad: DocumentItem; zoom: number }) {
  const extracted = doklad.extracted;
  const mena = extracted.mena ?? 'EUR';
  const polozky = extracted.polozky ?? [];
  const rozpis = extracted.rozpisDph ?? [];

  return (
    <div
      className="self-start bg-white p-8 shadow"
      style={{ width: Math.round(560 * zoom), minWidth: Math.round(560 * zoom) }}
      data-testid="einvoice-preview"
    >
      <div className="flex items-start justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-lg font-bold tracking-tight text-ink">{t('einvoice.titulok')}</p>
          <p className="text-xs text-ink-soft">{t('einvoice.podtitul')}</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{t('einvoice.cislo')}</p>
          <p className="tnum text-lg font-bold text-ink">{extracted.cisloFaktury || '—'}</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-6">
        <Party title={t('einvoice.dodavatel')} {...extracted.dodavatel} />
        <Party title={t('einvoice.odberatel')} {...(extracted.odberatel ?? {})} />
      </div>

      <dl className="tnum mt-5 grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl bg-app px-4 py-3 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-ink-soft">{t('einvoice.vystavena')}</dt><dd>{date(extracted.datumVystavenia)}</dd></div>
        <div><dt className="text-xs text-ink-soft">{t('einvoice.dodanie')}</dt><dd>{date(extracted.datumDodania)}</dd></div>
        <div><dt className="text-xs text-ink-soft">{t('einvoice.splatnost')}</dt><dd>{date(extracted.datumSplatnosti)}</dd></div>
        {extracted.variabilnySymbol && (
          <div><dt className="text-xs text-ink-soft">{t('einvoice.vs')}</dt><dd>{extracted.variabilnySymbol}</dd></div>
        )}
        {extracted.dodavatel.iban && (
          <div className="col-span-2"><dt className="text-xs text-ink-soft">{t('einvoice.iban')}</dt><dd>{extracted.dodavatel.iban}</dd></div>
        )}
      </dl>

      {polozky.length > 0 && (
        <table className="mt-5 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
              <th className="py-1.5 pr-2">{t('einvoice.popis')}</th>
              <th className="tnum py-1.5 pr-2 text-right">{t('einvoice.mnozstvo')}</th>
              <th className="tnum py-1.5 pr-2 text-right">{t('einvoice.cena')}</th>
              <th className="tnum py-1.5 text-right">{t('einvoice.suma')}</th>
            </tr>
          </thead>
          <tbody>
            {polozky.map((item) => (
              <tr key={item.id} className="border-b border-line/60 align-top">
                <td className="py-1.5 pr-2">{item.popis || '—'}</td>
                <td className="tnum py-1.5 pr-2 text-right">
                  {item.mnozstvo ?? '—'}{item.jednotka ? ` ${item.jednotka}` : ''}
                </td>
                <td className="tnum py-1.5 pr-2 text-right">{money(item.jednotkovaCenaBezDph, mena)}</td>
                <td className="tnum py-1.5 text-right">{money(item.sumaBezDph, mena)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-5 flex justify-end">
        <div className="w-64 space-y-1 text-sm">
          {rozpis.map((row) => (
            <div key={row.sadzba} className="tnum flex justify-between text-ink-soft">
              <span>{t('einvoice.zaklad')} {row.sadzba} %: {money(row.zaklad, mena)}</span>
              <span>{t('einvoice.dph')}: {money(row.dph, mena)}</span>
            </div>
          ))}
          <div className="tnum flex items-baseline justify-between border-t border-line pt-2">
            <span className="font-semibold text-ink">{t('einvoice.spolu')}</span>
            <span className="text-lg font-bold text-ink">{money(extracted.sumaSpolu, mena)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
