// Asistent firmy — chat nad overiteľnými dátami. História žije v komponente
// (posiela sa posledných 6 správ), na serveri sa nič neukladá. Odpoveď vždy
// nesie mieru istoty a zdroje; „neviem" je platná odpoveď a zobrazuje sa ako
// upozornenie, nie ako chyba.
import { useEffect, useRef, useState } from 'react';
import { askAssistant, listOrgDocuments, type AssistantOdpoved, type OrgDocumentSummary } from '../../data/api';
import './assistantPanel.css';

interface AssistantPanelProps {
  organizationId: string;
  organizationName?: string;
  /** Otvorený doklad — asistent naň dostane kontext (dodávateľ, položky, návrh). */
  documentId?: string;
  onClose?: () => void;
}

interface Sprava {
  rola: 'pouzivatel' | 'asistent';
  text: string;
  odpoved?: AssistantOdpoved;
}

const OTAZKY_DOKLAD = [
  'Prečo je navrhnutá práve táto predkontácia?',
  'Prečo toto členenie DPH?',
  'Ako sme tohto dodávateľa účtovali predtým?',
  'Čo mám na tomto doklade skontrolovať?',
];
const OTAZKY_FIRMA = [
  'Ako sa táto firma účtuje?',
  'Aké pravidlá má táto firma?',
  'Ktoré predkontácie firma najviac používa?',
  'Pri ktorých dodávateľoch je samozdanenie?',
];

const ANSWERABILITY_META: Record<AssistantOdpoved['answerability'], { label: string; tone: string } | null> = {
  grounded: null,
  insufficient_evidence: { label: 'Chýbajú podklady — over si to', tone: 'warn' },
  out_of_scope: { label: 'Mimo pôsobnosti asistenta', tone: 'muted' },
};

export function AssistantPanel({ organizationId, organizationName, documentId, onClose }: AssistantPanelProps) {
  const [spravy, setSpravy] = useState<Sprava[]>([]);
  const [otazka, setOtazka] = useState('');
  const [busy, setBusy] = useState(false);
  const [chyba, setChyba] = useState<string | null>(null);
  const [dokumenty, setDokumenty] = useState<OrgDocumentSummary[]>([]);
  const [prilohaId, setPrilohaId] = useState<string>('');
  const koniecRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    listOrgDocuments(organizationId)
      .then((items) => { if (active) setDokumenty(items); })
      .catch(() => { if (active) setDokumenty([]); });
    return () => { active = false; };
  }, [organizationId]);

  useEffect(() => { koniecRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [spravy, busy]);

  const posli = async (text: string) => {
    const query = text.trim();
    if (!query || busy) return;
    setChyba(null);
    setOtazka('');
    const historia = spravy.slice(-6).map((sprava) => ({ rola: sprava.rola, text: sprava.text }));
    setSpravy((current) => [...current, { rola: 'pouzivatel', text: query }]);
    setBusy(true);
    try {
      const odpoved = await askAssistant(organizationId, {
        otazka: query,
        documentId,
        prilohaId: prilohaId || undefined,
        historia,
      });
      setSpravy((current) => [...current, { rola: 'asistent', text: odpoved.odpoved, odpoved }]);
    } catch {
      setChyba('Asistenta sa nepodarilo osloviť. Skúste to znova.');
    }
    setBusy(false);
  };

  const navrhy = documentId ? OTAZKY_DOKLAD : OTAZKY_FIRMA;

  return (
    <div className="as-panel">
      <div className="as-head">
        <div className="as-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          Asistent
          {organizationName && <span className="as-org">{organizationName}</span>}
        </div>
        {onClose && (
          <button type="button" className="as-close" onClick={onClose} aria-label="Zavrieť asistenta">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        )}
      </div>

      <div className="as-body">
        {spravy.length === 0 && (
          <div className="as-empty">
            <p className="as-empty-text">
              Spýtajte sa na účtovanie tejto firmy{documentId ? ' alebo na otvorený doklad' : ''}.
              Odpovedám z pravidiel, histórie a profilu firmy — a z metodiky, ktorú viem doložiť zdrojom.
            </p>
            <div className="as-chips">
              {navrhy.map((navrh) => (
                <button key={navrh} type="button" className="as-chip" disabled={busy} onClick={() => void posli(navrh)}>
                  {navrh}
                </button>
              ))}
            </div>
          </div>
        )}

        {spravy.map((sprava, index) => (
          sprava.rola === 'pouzivatel' ? (
            <div key={index} className="as-msg as-user">{sprava.text}</div>
          ) : (
            <div key={index} className="as-msg as-bot">
              {(() => {
                const meta = sprava.odpoved ? ANSWERABILITY_META[sprava.odpoved.answerability] : null;
                return meta ? <div className={`as-flag as-flag-${meta.tone}`}>{meta.label}</div> : null;
              })()}
              <div className="as-text">{sprava.text}</div>
              {sprava.odpoved && (sprava.odpoved.zdroje.length > 0 || sprava.odpoved.istota === 'nizka' || sprava.odpoved.pouzitaPriloha) && (
                <div className="as-meta">
                  {sprava.odpoved.istota === 'nizka' && <span className="as-badge as-badge-warn">nízka istota</span>}
                  {sprava.odpoved.pouzitaPriloha && <span className="as-badge">{sprava.odpoved.pouzitaPriloha}</span>}
                  {sprava.odpoved.zdroje.map((zdroj) => (
                    <a key={zdroj.url} href={zdroj.url} target="_blank" rel="noopener noreferrer" className="as-zdroj">
                      {zdroj.nazov} ↗
                    </a>
                  ))}
                </div>
              )}
            </div>
          )
        ))}

        {busy && <div className="as-msg as-bot as-loading">Hľadám v dátach firmy a v metodike…</div>}
        {chyba && <div className="as-error">{chyba}</div>}
        <div ref={koniecRef} />
      </div>

      <div className="as-foot">
        {dokumenty.length > 0 && (
          <select
            className="as-select" value={prilohaId} disabled={busy}
            onChange={(event) => setPrilohaId(event.target.value)}
            aria-label="Priložiť firemný dokument k otázke"
          >
            <option value="">Bez prílohy</option>
            {dokumenty.map((dokument) => (
              <option key={dokument.id} value={dokument.id}>{dokument.fileName}</option>
            ))}
          </select>
        )}
        <div className="as-input-row">
          <input
            className="as-input" value={otazka} disabled={busy} placeholder="Opýtajte sa…"
            onChange={(event) => setOtazka(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void posli(otazka); } }}
          />
          <button type="button" className="as-send" disabled={busy || !otazka.trim()} onClick={() => void posli(otazka)}>
            Odoslať
          </button>
        </div>
      </div>
    </div>
  );
}
