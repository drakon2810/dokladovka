// Exportný dialóg „Export POHODA / XML" pre schválené doklady (Doklado parita):
// program POHODA, usporiadanie dataPacku, voľba Nekontrolovať duplicity a formát
// Mostík (predvolený). Výber môže miešať organizácie — prenos sa založí per firma.
import { useState } from 'react';
import type { DocumentItem, Organization } from '../../data/types';
import { createMostikExportJob } from '../../data/mostik/mostikService';
import { Modal } from '../../components/ui';
import { showToast } from '../../components/toast';
import { t } from '../../i18n/sk';

type Usporiadanie = 'vytvorenie' | 'vydanie' | 'dodanie' | 'cislo';

const USPORIADANIE: Array<{ id: Usporiadanie; label: string }> = [
  { id: 'vytvorenie', label: 'Dátum vytvorenia' },
  { id: 'vydanie', label: 'Dátum vydania' },
  { id: 'dodanie', label: 'Dátum dodania' },
  { id: 'cislo', label: 'Číslo faktúry' },
];

function sortKey(document: DocumentItem, usporiadanie: Usporiadanie): string {
  if (usporiadanie === 'vytvorenie') return document.prijateDna ?? '';
  if (usporiadanie === 'vydanie') return document.extracted.datumVystavenia ?? '';
  if (usporiadanie === 'dodanie') return document.extracted.datumDodania ?? document.extracted.datumVystavenia ?? '';
  return document.extracted.cisloFaktury ?? '';
}

function Help({ text }: { text: string }) {
  // Button: nápoveda je dostupná aj z klávesnice a pre čítačky (aria-label).
  return (
    <button type="button" className="ml-1 inline-grid h-4 w-4 cursor-help place-items-center rounded-full border border-line text-[10px] text-ink-soft" title={text} aria-label={text}>
      ?
    </button>
  );
}

export function ExportPohodaModal({
  documents,
  organizations,
  onClose,
  onExported,
}: {
  documents: DocumentItem[];
  organizations: Organization[];
  onClose: () => void;
  /** Doklady úspešne zaradené do prenosu — rodič ich vyhodí z výberu. */
  onExported: (documentIds: string[]) => void;
}) {
  const [usporiadanie, setUsporiadanie] = useState<Usporiadanie>('dodanie');
  const [nekontrolovatDuplicity, setNekontrolovatDuplicity] = useState(false);
  const [mostik, setMostik] = useState(true);
  const [busy, setBusy] = useState(false);

  async function exportovat() {
    setBusy(true);
    try {
      const sorted = [...documents].sort((a, b) => sortKey(a, usporiadanie).localeCompare(sortKey(b, usporiadanie), 'sk', { numeric: true }));
      // DataPack sa vždy generuje pre jednu organizáciu — výber sa rozdelí per
      // firma. Zlyhanie jednej firmy nezhodí ostatné: úspešné doklady vypadnú
      // z výberu (druhý pokus ich už neposiela) a chyba pomenuje firmu.
      const podlaFirmy = new Map<string, string[]>();
      for (const document of sorted) {
        podlaFirmy.set(document.orgId, [...(podlaFirmy.get(document.orgId) ?? []), document.id]);
      }
      const exportedIds: string[] = [];
      const chyby: string[] = [];
      for (const [orgId, documentIds] of podlaFirmy) {
        try {
          await createMostikExportJob(orgId, documentIds, { nekontrolovatDuplicity });
          exportedIds.push(...documentIds);
        } catch (cause) {
          const nazov = organizations.find((organization) => organization.id === orgId)?.nazov ?? orgId;
          chyby.push(`${nazov}: ${cause instanceof Error && cause.message ? cause.message : t('chyba.vseobecna')}`);
        }
      }
      if (exportedIds.length > 0) onExported(exportedIds);
      if (chyby.length === 0) {
        showToast(t('mostik.prenosVytvoreny'));
        onClose();
      } else {
        showToast(chyby.join(' · '), { tone: 'error' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Export" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <label className="block">
          <span className="label">Účtovný program</span>
          <input className="input w-full" value="POHODA" readOnly disabled />
        </label>
        <label className="block">
          <span className="label">Usporiadanie exportu</span>
          <select className="input w-full" value={usporiadanie} onChange={(event) => setUsporiadanie(event.target.value as Usporiadanie)}>
            {USPORIADANIE.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>

        <div>
          <p className="mb-2 font-semibold">Nastavenia exportu</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={nekontrolovatDuplicity} onChange={(event) => setNekontrolovatDuplicity(event.target.checked)} />
            <span>Nekontrolovať duplicity</span>
            <Help text="Ak nechcete kontrolovať duplicitu dokladov pri importe do POHODY, označte túto možnosť. POHODA potom doklad naimportuje aj vtedy, keď tam s rovnakým číslom už je." />
          </label>
        </div>

        <div>
          <p className="mb-2 font-semibold">Formát exportu</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={mostik} onChange={(event) => setMostik(event.target.checked)} />
            <span>Exportovať do účtovného softvéru – Mostík</span>
            <span className="tnum rounded bg-app px-1.5 text-[11px] text-ink-soft">{documents.length}</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn" onClick={onClose}>{t('akcia.zrusit')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !mostik || documents.length === 0} onClick={() => void exportovat()}>
            {busy ? t('stav.nacitavam') : 'Exportovať'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
