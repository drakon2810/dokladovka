import { useState } from 'react';
import { saveApprovalRule } from '../../data/api';
import { useDataQuery } from '../../data/query';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

// Schvaľovanie podľa sumy (vzor Doklado): od zadaného prahu smie doklad
// schváliť len vyhradená rola. Jedno pravidlo na organizáciu; admin vždy môže.

export function ApprovalRulesTab() {
  const { data, loading, error } = useDataQuery();
  const [busyOrg, setBusyOrg] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, { minAmount: string; requiredRole: 'admin' | 'schvalovatel'; active: boolean }>>({});

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;

  const organizations = data.organizations.filter((org) => !org.archived);
  const ruleFor = (orgId: string) => data.approvalRules?.find((rule) => rule.organizationId === orgId);
  const draftFor = (orgId: string) => {
    if (drafts[orgId]) return drafts[orgId];
    const rule = ruleFor(orgId);
    return {
      minAmount: rule ? String(rule.minAmount) : '1000',
      requiredRole: rule?.requiredRole ?? ('schvalovatel' as const),
      active: rule?.active ?? false,
    };
  };

  async function save(orgId: string) {
    const draft = draftFor(orgId);
    const minAmount = Number(draft.minAmount.replace(',', '.'));
    if (!Number.isFinite(minAmount) || minAmount < 0) {
      showToast(t('schvalovanie.neplatnaSuma'));
      return;
    }
    setBusyOrg(orgId);
    try {
      await saveApprovalRule(orgId, { minAmount, requiredRole: draft.requiredRole, active: draft.active });
      showToast(t('schvalovanie.ulozeneOk'));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : t('chyba.vseobecna'));
    } finally {
      setBusyOrg(undefined);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">{t('schvalovanie.popis')}</p>
      {organizations.map((org) => {
        const draft = draftFor(org.id);
        return (
          <section key={org.id} className="card flex flex-wrap items-end gap-3 p-4">
            <div className="min-w-40 flex-1">
              <p className="font-medium text-ink">{org.nazov}</p>
              <p className="tnum text-xs text-ink-soft">IČO {org.ico}</p>
            </div>
            <label className="block">
              <span className="label">{t('schvalovanie.aktivne')}</span>
              <input
                type="checkbox"
                className="mt-2 block h-5 w-5"
                checked={draft.active}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [org.id]: { ...draft, active: event.target.checked } }))
                }
              />
            </label>
            <label className="block">
              <span className="label">{t('schvalovanie.odSumy')}</span>
              <input
                className="input tnum w-32"
                inputMode="decimal"
                value={draft.minAmount}
                disabled={!draft.active}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [org.id]: { ...draft, minAmount: event.target.value } }))
                }
              />
            </label>
            <label className="block">
              <span className="label">{t('schvalovanie.rola')}</span>
              <select
                className="input w-44"
                value={draft.requiredRole}
                disabled={!draft.active}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [org.id]: { ...draft, requiredRole: event.target.value as 'admin' | 'schvalovatel' },
                  }))
                }
              >
                <option value="schvalovatel">{t('rola.schvalovatel')}</option>
                <option value="admin">{t('rola.admin')}</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busyOrg === org.id}
              onClick={() => void save(org.id)}
            >
              {busyOrg === org.id ? t('stav.nacitavam') : t('schvalovanie.ulozit')}
            </button>
          </section>
        );
      })}
    </div>
  );
}
