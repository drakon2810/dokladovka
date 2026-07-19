// Nastavenia — SPEC §6.6 (iba admin; guard v App.tsx).
import { useState } from 'react';
import { resetDemoData } from '../../data/api';
import { t } from '../../i18n/sk';
import { ConfirmDialog } from '../../components/ui';
import { showToast } from '../../components/toast';
import { OrganizationsTab } from './OrganizationsTab';
import { CodeListsTab } from './CodeListsTab';
import { UsersTab } from './UsersTab';
import { MailboxesTab } from './MailboxesTab';
import { QueuesTab } from './QueuesTab';
import { MostikTab } from './MostikTab';
import { ApprovalRulesTab } from './ApprovalRulesTab';

const TABS = [
  { id: 'organizacie', label: 'nast.tab.organizacie' },
  { id: 'fronty', label: 'nast.tab.fronty' },
  { id: 'ciselniky', label: 'nast.tab.ciselniky' },
  { id: 'pouzivatelia', label: 'nast.tab.pouzivatelia' },
  { id: 'schvalovanie', label: 'nast.tab.schvalovanie' },
  { id: 'schranky', label: 'nast.tab.schranky' },
  { id: 'mostik', label: 'nast.tab.mostik' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function SettingsPage() {
  const [tab, setTab] = useState<TabId>('organizacie');
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('nast.titulok')}</h1>
        <button type="button" className="btn btn-danger" onClick={() => setConfirmReset(true)}>
          {t('nast.resetDemo')}
        </button>
      </div>

      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`-mb-px rounded-t border-b-2 px-3 py-2 text-sm font-medium ${
              tab === item.id
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-soft hover:text-ink'
            }`}
            onClick={() => setTab(item.id)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>

      {tab === 'organizacie' && <OrganizationsTab />}
      {tab === 'fronty' && <QueuesTab />}
      {tab === 'ciselniky' && <CodeListsTab />}
      {tab === 'pouzivatelia' && <UsersTab />}
      {tab === 'schvalovanie' && <ApprovalRulesTab />}
      {tab === 'schranky' && <MailboxesTab />}
      {tab === 'mostik' && <MostikTab />}

      {confirmReset && (
        <ConfirmDialog
          title={t('nast.resetDemo')}
          text={t('nast.resetDemoPotvrdenie')}
          danger
          onConfirm={() => {
            void resetDemoData().then(() => showToast(t('toast.resetHotovy')));
          }}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}
