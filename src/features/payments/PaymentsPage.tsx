import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDataQuery } from '../../data/query';
import { EmptyState, OrgDot } from '../../components/ui';
import { formatDate, formatMoney } from '../../lib/format';
import { t } from '../../i18n/sk';

// Realizované úhrady — žurnál platieb naprieč dokladmi. Dáta pochádzajú
// z document_payments (manuálne úhrady + spárované z bankových výpisov).

export function PaymentsPage() {
  const { data, loading, error } = useDataQuery();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<'all' | 'manual' | 'bank_statement'>('all');
  const [month, setMonth] = useState('');

  const rows = useMemo(() => {
    if (!data) return [];
    const documentsById = new Map(data.documents.map((document) => [document.id, document]));
    const needle = search.trim().toLocaleLowerCase('sk');
    return (data.payments ?? [])
      .filter((payment) => data.currentOrgId === 'all' || payment.organizationId === data.currentOrgId)
      .filter((payment) => source === 'all' || payment.source === source)
      .filter((payment) => !month || payment.paidOn.startsWith(month))
      .map((payment) => ({ payment, document: documentsById.get(payment.documentId) }))
      .filter(({ payment, document }) => {
        if (!needle) return true;
        const haystack = [
          document?.extracted.dodavatel.nazov,
          document?.extracted.cisloFaktury,
          document?.extracted.variabilnySymbol,
          payment.note,
        ].filter(Boolean).join(' ').toLocaleLowerCase('sk');
        return haystack.includes(needle);
      })
      .sort((a, b) => b.payment.paidOn.localeCompare(a.payment.paidOn));
  }, [data, search, source, month]);

  const total = useMemo(
    () => rows.reduce((sum, { payment }) => sum + payment.amount, 0),
    [rows],
  );

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;

  const organizationsById = new Map(data.organizations.map((organization) => [organization.id, organization]));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('uhrady.titulok')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input w-64"
            type="search"
            placeholder={t('uhrady.hladat')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <input
            className="input tnum"
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            aria-label={t('uhrady.mesiac')}
          />
          <select
            className="input w-44"
            value={source}
            onChange={(event) => setSource(event.target.value as typeof source)}
          >
            <option value="all">{t('uhrady.zdroj.vsetky')}</option>
            <option value="manual">{t('uhrady.zdroj.manual')}</option>
            <option value="bank_statement">{t('uhrady.zdroj.bank_statement')}</option>
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          <p>{t('uhrady.ziadne')}</p>
        </EmptyState>
      ) : (
        <section className="card overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-3 py-2 font-medium">{t('uhrady.st.datum')}</th>
                <th className="px-3 py-2 font-medium">{t('uhrady.st.organizacia')}</th>
                <th className="px-3 py-2 font-medium">{t('uhrady.st.dodavatel')}</th>
                <th className="px-3 py-2 font-medium">{t('uhrady.st.doklad')}</th>
                <th className="px-3 py-2 font-medium">{t('uhrady.st.zdroj')}</th>
                <th className="px-3 py-2 font-medium">{t('uhrady.st.poznamka')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('uhrady.st.suma')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ payment, document }) => {
                const organization = organizationsById.get(payment.organizationId);
                return (
                  <tr key={payment.id} className="border-b border-line/60 last:border-0">
                    <td className="tnum px-3 py-2">{formatDate(payment.paidOn)}</td>
                    <td className="px-3 py-2">
                      {organization && (
                        <span className="flex items-center gap-1.5">
                          <OrgDot org={organization} />
                          {organization.nazov}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">{document?.extracted.dodavatel.nazov ?? '—'}</td>
                    <td className="px-3 py-2">
                      {document ? (
                        <Link className="text-accent hover:underline" to={`/doklady/${document.id}`}>
                          {document.extracted.cisloFaktury || document.id.slice(0, 8)}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-soft">
                        {t(`uhrady.zdroj.${payment.source}`)}
                      </span>
                    </td>
                    <td className="max-w-56 truncate px-3 py-2 text-ink-soft">{payment.note ?? ''}</td>
                    <td className="tnum px-3 py-2 text-right">{formatMoney(payment.amount, payment.currency as 'EUR' | 'CZK' | 'USD')}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-line text-sm font-semibold">
                <td className="px-3 py-2" colSpan={6}>{t('uhrady.spolu')} ({rows.length})</td>
                <td className="tnum px-3 py-2 text-right">{formatMoney(total)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}
    </div>
  );
}
