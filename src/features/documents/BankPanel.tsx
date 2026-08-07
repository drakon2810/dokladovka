// Editor bankového výpisu — polia agendy Banka v POHODE namiesto fakturového
// formulára: účet, číslo a dátum výpisu + tabuľka pohybov (dátum platby, text,
// protistrana, VS, suma, predkontácia na pohyb). Smer príjem/výdaj určuje
// znamienko sumy; členenie DPH banka nemá. Verné k rozloženiu InvoicePanel
// (dk-* triedy), tabuľka pohybov je vlastná — stĺpce faktúry sem nesedia.
import { useMemo, useState } from 'react';
import type {
  CodeListItem, DocumentExtractedData, DocumentItem, DocumentLineItem, DocumentType, DocumentUcto,
} from '../../data/types';
import { requestMostikCodeListSync } from '../../data/mostik/mostikService';
import { showToast } from '../../components/toast';
import { DcCell, DcPick, formatDateSk, type DcOption } from './DcInline';
import { fmtMoney } from './ItemsSection';
import { TYP_OPTIONS } from './InvoicePanel';

/**
 * Suma pohybu: znamienko je SMER pohybu, tak sa nečíselný vstup (rozpísané
 * „-", preklep) drží ako prázdny namiesto tichej nuly — nula by z výdaja
 * spravila nulový pohyb, ktorý prejde schválením.
 */
function parseSuma(raw: string): number | undefined {
  const text = raw.replace(/\s/g, '').replace(',', '.');
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface BankCodeLists {
  predkontacie: CodeListItem[];
  bankoveUcty: CodeListItem[];
}

interface BankPanelProps {
  draft: DocumentItem;
  readOnly: boolean;
  codeLists: BankCodeLists;
  onExport?: () => void;
  exportDisabledReason?: string;
  setTyp: (typ: DocumentType) => void;
  updateUcto: (patch: Partial<DocumentUcto>) => void;
  updateExtracted: <K extends keyof DocumentExtractedData>(key: K, value: DocumentExtractedData[K]) => void;
  /** Predvolená pokladňa firmy — pri prepnutí na PD sa predvyplní ako v InvoicePanel. */
  predvolenaPokladna?: string;
}

function IcoExternal() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14L21 3" />
    </svg>
  );
}

function IcoWarn() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#B26B00" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" />
    </svg>
  );
}

export function BankPanel({
  draft, readOnly, codeLists, onExport, exportDisabledReason, setTyp, updateUcto, updateExtracted,
  predvolenaPokladna,
}: BankPanelProps) {
  const ex = draft.extracted;
  const ucto = draft.ucto;
  const pohyby = ex.polozky ?? [];
  const [open, setOpen] = useState<string>();

  const syncMostik = readOnly ? undefined : () => {
    requestMostikCodeListSync(draft.orgId)
      .then(() => showToast('Synchronizácia číselníkov cez Mostík je vyžiadaná — zoznam sa obnoví do minúty.'))
      .catch((cause: unknown) => showToast(cause instanceof Error && cause.message ? cause.message : 'Synchronizáciu sa nepodarilo vyžiadať.', { tone: 'error' }));
  };

  const uctyOpts: DcOption[] = useMemo(() => codeLists.bankoveUcty.map((item) => ({
    value: item.kod,
    label: `${item.kod} · ${item.nazov}`,
    title: item.iban ? `IBAN ${item.iban}` : item.nazov,
  })), [codeLists.bankoveUcty]);

  const predkOpts: DcOption[] = useMemo(() => [
    // Prázdna voľba = predkontácia hlavičky výpisu, nie „bez predkontácie".
    { value: '', label: '— ako výpis' },
    ...codeLists.predkontacie.map((item) => ({ value: item.id, label: `${item.kod} · ${item.nazov}`, title: item.nazov })),
  ], [codeLists.predkontacie]);
  const headerPredkOpts: DcOption[] = useMemo(
    () => codeLists.predkontacie.map((item) => ({ value: item.id, label: `${item.kod} · ${item.nazov}`, title: item.nazov })),
    [codeLists.predkontacie],
  );
  const predkKod = (id?: string) => codeLists.predkontacie.find((item) => item.id === id)?.kod;

  const patch = (index: number, value: Partial<DocumentLineItem>) => {
    updateExtracted('polozky', pohyby.map((item, i) => (i === index ? { ...item, ...value } : item)));
  };
  const patchPredkontacia = (index: number, id: string) => {
    const { predkontaciaId: _stara, ...rest } = pohyby[index].ucto ?? {};
    patch(index, { ucto: id ? { ...rest, predkontaciaId: id } : rest });
  };
  const addPohyb = () => {
    updateExtracted('polozky', [...pohyby, {
      id: crypto.randomUUID(), popis: '', datumPlatby: ex.datumVystavenia,
    }]);
  };
  const removePohyb = (index: number) => {
    updateExtracted('polozky', pohyby.filter((_, i) => i !== index));
  };

  const ucetOk = codeLists.bankoveUcty.some((item) => item.kod.trim() === ucto.bankUcetKod?.trim());
  const bezPredkontacie = pohyby.filter((pohyb) => !pohyb.ucto?.predkontaciaId && !ucto.predkontaciaId).length;
  const prijmy = pohyby.reduce((sum, pohyb) => sum + Math.max(0, pohyb.sumaSpolu ?? 0), 0);
  const vydaje = pohyby.reduce((sum, pohyb) => sum + Math.min(0, pohyb.sumaSpolu ?? 0), 0);
  const vybranyUcet = codeLists.bankoveUcty.find((item) => item.kod.trim() === ucto.bankUcetKod?.trim());

  return (
    <div className="dk-doc">
      <div className="dk-head">
        <span className="dk-head-mark">B</span>
        <span className="dk-head-title">Zaúčtovanie bankového výpisu</span>
        <div className="dk-head-actions">
          {onExport && (
            <button type="button" className="dk-btn" disabled={Boolean(exportDisabledReason)} title={exportDisabledReason} onClick={onExport}>
              Export do POHODA
              <IcoExternal />
            </button>
          )}
        </div>
      </div>

      <div className={`dk-mode${!ucetOk || bezPredkontacie > 0 ? ' dk-mode-warn' : ''}`}>
        {!ucetOk || bezPredkontacie > 0 ? <IcoWarn /> : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0E7A5F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></svg>
        )}
        {!ucetOk
          ? <span>Výpis potrebuje <strong>účet POHODY</strong> — vyberte ho z číselníka bankových účtov.</span>
          : bezPredkontacie > 0
            ? <span><strong>{bezPredkontacie}</strong> pohybov nemá predkontáciu — doplňte ju pri pohybe alebo nastavte predkontáciu výpisu.</span>
            : <span>Výpis sa importuje na účet <strong>{ucto.bankUcetKod}</strong> ako <strong className="tnum">{pohyby.length}</strong> bankových pohybov.</span>}
      </div>

      <div className="dk-two">
        <div className="dk-card">
          <div className="dk-card-title">Výpis</div>
          <div className="dk-grid dk-grid-main">
            <span className="dk-lbl">Typ dokladu</span>
            <DcPick
              value="BV" options={TYP_OPTIONS} disabled={readOnly}
              onChange={(value) => {
                const option = TYP_OPTIONS.find((item) => item.value === value);
                if (!option || option.typ === draft.typ) return;
                // Rovnaké správanie ako prepínač v InvoicePanel: smer pokladne
                // z voľby a predvolená pokladňa firmy, inak by „Príjmový
                // pokladničný doklad" skončil ako výdaj bez pokladne.
                const patch: Partial<DocumentUcto> = {};
                if (option.pokladnaTyp && option.pokladnaTyp !== ucto.pokladnaTyp) patch.pokladnaTyp = option.pokladnaTyp;
                if (option.typ === 'PD' && !ucto.pokladnaKod?.trim() && predvolenaPokladna) patch.pokladnaKod = predvolenaPokladna;
                if (Object.keys(patch).length > 0) updateUcto(patch);
                setTyp(option.typ);
              }}
            />

            <span className="dk-lbl">Účet</span>
            <DcPick
              value={ucto.bankUcetKod} options={uctyOpts} disabled={readOnly} onMostikSync={syncMostik}
              placeholder="—" title={vybranyUcet?.iban ? `IBAN ${vybranyUcet.iban}` : undefined}
              onChange={(value) => updateUcto({ bankUcetKod: value || undefined })}
            />

            <span className="dk-lbl">Číslo výpisu</span>
            <DcCell
              value={ex.cisloVypisu ?? ''} disabled={readOnly} placeholder="006"
              title="Max. 10 znakov — POHODA z neho skladá evidenčné číslo pohybu"
              onCommit={(raw) => updateExtracted('cisloVypisu', raw.slice(0, 10) || undefined)}
            />

            <span className="dk-lbl">Dátum výpisu</span>
            <DcCell type="date" value={ex.datumVystavenia ?? ''} display={formatDateSk(ex.datumVystavenia)} disabled={readOnly} onCommit={(raw) => updateExtracted('datumVystavenia', raw)} />

            <span className="dk-lbl">Predkontácia výpisu</span>
            <DcPick
              value={ucto.predkontaciaId} options={headerPredkOpts} disabled={readOnly} onMostikSync={syncMostik}
              title="Použije sa pre pohyby bez vlastnej predkontácie"
              onChange={(value) => updateUcto({ predkontaciaId: value })}
            />
          </div>
        </div>

        <div className="dk-card">
          <div className="dk-card-title">Banka</div>
          <div className="dk-grid dk-grid-sup">
            <span className="dk-lbl">Banka</span>
            <DcCell value={ex.dodavatel.nazov ?? ''} disabled={readOnly} onCommit={(raw) => updateExtracted('dodavatel', { ...ex.dodavatel, nazov: raw })} />
            <span className="dk-lbl">IBAN výpisu</span>
            <DcCell value={ex.dodavatel.iban ?? ''} disabled={readOnly} onCommit={(raw) => updateExtracted('dodavatel', { ...ex.dodavatel, iban: raw.replace(/\s/g, '') || undefined })} />
            <span className="dk-lbl">Poznámka</span>
            <DcCell value={ucto.poznamka ?? ''} disabled={readOnly} onCommit={(raw) => updateUcto({ poznamka: raw || undefined })} />
          </div>
        </div>
      </div>

      <div className="dk-card">
        <div className="dk-items-head">
          <span className="dk-items-title">Pohyby výpisu ({pohyby.length})</span>
        </div>
        {pohyby.length === 0 ? (
          <div className="dk-items-empty">Výpis zatiaľ nemá žiadne pohyby — pridajte ich tlačidlom nižšie.</div>
        ) : (
          <div className="dk-items-scroll">
            <div className="dk-bank-row dk-row-head">
              <span>#</span><span>Dátum</span><span>Text</span><span>Protistrana</span><span>VS</span>
              <span className="dk-r">Suma</span><span>Predkontácia</span><span />
            </div>
            {pohyby.map((pohyb, index) => {
              const chybaPredkontacia = !pohyb.ucto?.predkontaciaId && !ucto.predkontaciaId;
              return (
                <div key={pohyb.id}>
                  <div className="dk-bank-row dk-row-item">
                    <span className="dk-row-no tnum">{index + 1}</span>
                    <DcCell type="date" value={pohyb.datumPlatby ?? ''} display={formatDateSk(pohyb.datumPlatby)} disabled={readOnly} onCommit={(raw) => patch(index, { datumPlatby: raw || undefined })} />
                    <DcCell value={pohyb.popis} disabled={readOnly} title={pohyb.popis} onCommit={(raw) => patch(index, { popis: raw })} />
                    <DcCell value={pohyb.protistrana ?? ''} disabled={readOnly} title={pohyb.protistrana} onCommit={(raw) => patch(index, { protistrana: raw || undefined })} />
                    <DcCell value={pohyb.vs ?? ''} inputMode="numeric" disabled={readOnly} onCommit={(raw) => patch(index, { vs: raw.replace(/\D/g, '') || undefined })} />
                    <div className={`dk-r${(pohyb.sumaSpolu ?? 0) < 0 ? ' dk-neg' : ''}`}>
                      <DcCell
                        align="right" inputMode="decimal" disabled={readOnly}
                        value={pohyb.sumaSpolu === undefined ? '' : String(pohyb.sumaSpolu)}
                        display={pohyb.sumaSpolu === undefined ? '' : fmtMoney(pohyb.sumaSpolu, ex.mena)}
                        title="Záporná suma = výdaj, kladná = príjem"
                        onCommit={(raw) => patch(index, { sumaSpolu: parseSuma(raw) })}
                      />
                    </div>
                    <DcPick
                      value={pohyb.ucto?.predkontaciaId ?? ''} options={predkOpts} disabled={readOnly}
                      placeholder={predkKod(ucto.predkontaciaId) ?? '—'}
                      title={chybaPredkontacia ? 'Pohyb nemá predkontáciu' : undefined}
                      srcClass={chybaPredkontacia ? ' dk-cell-err' : ''}
                      onChange={(value) => patchPredkontacia(index, value)}
                    />
                    <button
                      type="button" className="dk-caret" disabled={false}
                      aria-label="Ďalšie polia pohybu"
                      onClick={() => setOpen((current) => (current === pohyb.id ? undefined : pohyb.id))}
                    >
                      {open === pohyb.id ? '▴' : '▾'}
                    </button>
                  </div>
                  {open === pohyb.id && (
                    <div className="dk-sub">
                      <span className="dk-lbl">Protiúčet IBAN</span>
                      <DcCell value={pohyb.protiucetIban ?? ''} disabled={readOnly} onCommit={(raw) => patch(index, { protiucetIban: raw.replace(/\s/g, '') || undefined })} />
                      <span className="dk-lbl">Konšt. symbol</span>
                      <DcCell value={pohyb.ks ?? ''} disabled={readOnly} onCommit={(raw) => patch(index, { ks: raw.slice(0, 4) || undefined })} />
                      <span className="dk-lbl">Špec. symbol</span>
                      <DcCell value={pohyb.ss ?? ''} disabled={readOnly} onCommit={(raw) => patch(index, { ss: raw.slice(0, 16) || undefined })} />
                      {!readOnly && (
                        <button type="button" className="dk-sub-del" onClick={() => removePohyb(index)}>
                          Odstrániť pohyb
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="dk-bank-row dk-row-total">
              <span /><span /><span>Príjmy / výdaje</span><span />
              <span />
              <span className="dk-r">
                <span className="dk-strong">{fmtMoney(prijmy, ex.mena)}</span>
                {' / '}
                <span className={vydaje < 0 ? 'dk-neg' : ''}>{fmtMoney(vydaje, ex.mena)}</span>
              </span>
              <span /><span />
            </div>
          </div>
        )}
        {!readOnly && (
          <button type="button" className="dk-add" onClick={addPohyb}>+ Pridať pohyb</button>
        )}
      </div>

      <div className="dk-card">
        <div className="dk-card-title">Zostatok</div>
        <div className="dk-grid dk-grid-pay">
          <span className="dk-lbl">Počiatočný zostatok</span>
          <div className="dk-r">
            <DcCell
              align="right" inputMode="decimal" disabled={readOnly}
              value={ex.pociatocnyZostatok === undefined ? '' : String(ex.pociatocnyZostatok)}
              display={ex.pociatocnyZostatok === undefined ? '' : fmtMoney(ex.pociatocnyZostatok, ex.mena)}
              onCommit={(raw) => updateExtracted('pociatocnyZostatok', parseSuma(raw))}
            />
          </div>
          <span className="dk-lbl">Konečný zostatok výpisu</span>
          <div className="dk-r">
            <DcCell
              align="right" inputMode="decimal" disabled={readOnly}
              value={String(ex.sumaSpolu ?? '')}
              display={Number.isFinite(ex.sumaSpolu) ? fmtMoney(ex.sumaSpolu, ex.mena) : ''}
              onCommit={(raw) => updateExtracted('sumaSpolu', parseSuma(raw) ?? 0)}
            />
          </div>
        </div>
        {/* Rovnica výpisu na očiach: keď nesedí, pravdepodobne chýba pohyb. */}
        {ex.pociatocnyZostatok !== undefined
          && pohyby.every((pohyb) => Number.isFinite(pohyb.sumaSpolu))
          && Math.abs((ex.pociatocnyZostatok + prijmy + vydaje) - ex.sumaSpolu) > 0.02 && (
          <p className="mt-2 text-xs text-amber-800">
            Počiatočný zostatok + pohyby ({fmtMoney(ex.pociatocnyZostatok + prijmy + vydaje, ex.mena)}) nesedí
            s konečným zostatkom — skontrolujte, či sa načítali všetky pohyby.
          </p>
        )}
      </div>
    </div>
  );
}
