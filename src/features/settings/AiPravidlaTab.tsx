import { useDataQuery } from '../../data/query';
import { useOrgSelection } from '../../data/orgSelection';
import { t } from '../../i18n/sk';
import { PravidlaEditor } from '../pravidla/PravidlaEditor';

// Pravidlá pre AI písané účtovníkom — platia len pre práve zvolenú firmu a pri
// rozpore prebijú globálne pravidlá správcu platformy.

export function AiPravidlaTab() {
  const { data, loading, error } = useDataQuery();
  const { orgId } = useOrgSelection();

  if (loading) return <p className="text-sm text-ink-soft">{t('stav.nacitavam')}</p>;
  if (error || !data) return <p className="text-sm text-red-700">{t('chyba.vseobecna')}</p>;
  if (!orgId) return <p className="text-sm text-ink-soft">{t('pravidla.vybertefirmu')}</p>;

  const firma = data.organizations.find((org) => org.id === orgId)?.nazov;
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">
        {t('pravidla.firma.popis')} {firma && <span className="font-medium text-ink">{firma}</span>}
      </p>
      <PravidlaEditor organizationId={orgId} />
    </div>
  );
}
