// Mock zoznam používateľov — SPEC §6.6 (iba prezeranie / úprava roly).
import { updateUserRole } from '../../data/api';
import { useDataQuery } from '../../data/query';
import type { Role } from '../../data/types';
import { t } from '../../i18n/sk';

export function UsersTab() {
  const users = useDataQuery().data?.users ?? [];
  return (
    <div className="card max-w-2xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-soft">
            <th className="px-3 py-2 font-medium">{t('nast.pouz.meno')}</th>
            <th className="px-3 py-2 font-medium">{t('nast.pouz.email')}</th>
            <th className="px-3 py-2 font-medium">{t('nast.pouz.rola')}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-line last:border-0">
              <td className="px-3 py-2.5 font-medium">{user.meno}</td>
              <td className="px-3 py-2.5">{user.email}</td>
              <td className="px-3 py-2.5">
                <select
                  className="input w-auto"
                  value={user.rola}
                  onChange={(e) => void updateUserRole(user.id, e.target.value as Role)}
                  aria-label={`${t('nast.pouz.rola')} — ${user.meno}`}
                >
                  <option value="uctovnik">{t('rola.uctovnik')}</option>
                  <option value="schvalovatel">{t('rola.schvalovatel')}</option>
                  <option value="admin">{t('rola.admin')}</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
