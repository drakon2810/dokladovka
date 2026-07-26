// Asistent firmy — chat nad overiteľnými dátami. Konverzácie sa ukladajú na
// server po vláknach (jedna firma = vlastná história), takže sa dá vrátiť
// k staršiemu chatu alebo začať nový. Históriu do modelu berie server priamo
// z vlákna — klient ju neposiela. Odpoveď vždy nesie mieru istoty a zdroje;
// „neviem" je platná odpoveď a zobrazuje sa ako upozornenie, nie ako chyba.
import { useEffect, useRef, useState } from 'react';
import {
  askAssistant, deleteAssistantThread, getAssistantThread, listAssistantThreads, listOrgDocuments,
  type AssistantSprava, type AssistantThreadHead, type OrgDocumentSummary,
} from '../../data/api';
import './assistantPanel.css';

interface AssistantPanelProps {
  organizationId: string;
  organizationName?: string;
  /** Otvorený doklad — asistent naň dostane kontext (dodávateľ, položky, návrh). */
  documentId?: string;
  onClose?: () => void;
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

const ANSWERABILITY_META: Record<string, { label: string; tone: string } | null> = {
  grounded: null,
  insufficient_evidence: { label: 'Chýbajú podklady — over si to', tone: 'warn' },
  out_of_scope: { label: 'Mimo pôsobnosti asistenta', tone: 'muted' },
};

function datum(hodnota?: string): string {
  if (!hodnota) return '';
  const date = new Date(hodnota);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('sk-SK', { day: 'numeric', month: 'numeric' });
}

export function AssistantPanel({ organizationId, organizationName, documentId, onClose }: AssistantPanelProps) {
  const [spravy, setSpravy] = useState<AssistantSprava[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [vlakna, setVlakna] = useState<AssistantThreadHead[]>([]);
  const [historiaOpen, setHistoriaOpen] = useState(false);
  const [otazka, setOtazka] = useState('');
  const [busy, setBusy] = useState(false);
  const [chyba, setChyba] = useState<string | null>(null);
  const [dokumenty, setDokumenty] = useState<OrgDocumentSummary[]>([]);
  const [prilohaId, setPrilohaId] = useState<string>('');
  const koniecRef = useRef<HTMLDivElement>(null);

  const nacitajVlakna = () => {
    listAssistantThreads(organizationId)
      .then(setVlakna)
      .catch(() => setVlakna([]));
  };

  // Prepnutie firmy = iná história aj iné dokumenty; rozpísaný chat sa zahodí.
  useEffect(() => {
    setSpravy([]);
    setThreadId(undefined);
    setHistoriaOpen(false);
    setPrilohaId('');
    nacitajVlakna();
    listOrgDocuments(organizationId).then(setDokumenty).catch(() => setDokumenty([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  useEffect(() => { koniecRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [spravy, busy]);

  const novyChat = () => {
    setSpravy([]);
    setThreadId(undefined);
    setHistoriaOpen(false);
    setChyba(null);
  };

  const otvorVlakno = async (id: string) => {
    setHistoriaOpen(false);
    setChyba(null);
    try {
      const vlakno = await getAssistantThread(organizationId, id);
      setSpravy(vlakno.spravy);
      setThreadId(vlakno.id);
    } catch {
      setChyba('Chat sa nepodarilo otvoriť.');
    }
  };

  const zmazVlakno = async (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await deleteAssistantThread(organizationId, id);
      setVlakna((current) => current.filter((item) => item.id !== id));
      if (threadId === id) novyChat();
    } catch {
      setChyba('Chat sa nepodarilo zmazať.');
    }
  };

  const posli = async (text: string) => {
    const query = text.trim();
    if (!query || busy) return;
    setChyba(null);
    setOtazka('');
    setSpravy((current) => [...current, { rola: 'pouzivatel', text: query }]);
    setBusy(true);
    try {
      const odpoved = await askAssistant(organizationId, {
        otazka: query,
        documentId,
        prilohaId: prilohaId || undefined,
        threadId,
      });
      setThreadId(odpoved.threadId);
      setSpravy((current) => [...current, {
        rola: 'asistent', text: odpoved.odpoved,
        answerability: odpoved.answerability, istota: odpoved.istota,
        zdroje: odpoved.zdroje, pouzitaPriloha: odpoved.pouzitaPriloha,
      }]);
      nacitajVlakna();
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
        <div className="as-head-actions">
          <button
            type="button" className={`as-icon${historiaOpen ? ' as-icon-on' : ''}`}
            onClick={() => setHistoriaOpen((open) => !open)}
            title="História chatov" aria-label="História chatov"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          </button>
          <button type="button" className="as-icon" onClick={novyChat} title="Nový chat" aria-label="Nový chat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          {onClose && (
            <button type="button" className="as-icon" onClick={onClose} aria-label="Zavrieť asistenta">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>
      </div>

      {historiaOpen && (
        <div className="as-historia">
          {vlakna.length === 0 ? (
            <div className="as-historia-empty">Zatiaľ žiadne uložené chaty.</div>
          ) : vlakna.map((vlakno) => (
            <button
              key={vlakno.id} type="button"
              className={`as-vlakno${vlakno.id === threadId ? ' as-vlakno-on' : ''}`}
              onClick={() => void otvorVlakno(vlakno.id)}
            >
              <span className="as-vlakno-title">{vlakno.title}</span>
              <span className="as-vlakno-meta">{datum(vlakno.updatedAt)}</span>
              <span
                role="button" tabIndex={0} className="as-vlakno-del" aria-label="Zmazať chat"
                onClick={(event) => void zmazVlakno(vlakno.id, event)}
                onKeyDown={(event) => { if (event.key === 'Enter') void zmazVlakno(vlakno.id, event as unknown as React.MouseEvent); }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="as-body">
        {spravy.length === 0 && !busy && (
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
                const meta = sprava.answerability ? ANSWERABILITY_META[sprava.answerability] : null;
                return meta ? <div className={`as-flag as-flag-${meta.tone}`}>{meta.label}</div> : null;
              })()}
              <div className="as-text">{sprava.text}</div>
              {((sprava.zdroje?.length ?? 0) > 0 || sprava.istota === 'nizka' || sprava.pouzitaPriloha) && (
                <div className="as-meta">
                  {sprava.istota === 'nizka' && <span className="as-badge as-badge-warn">nízka istota</span>}
                  {sprava.pouzitaPriloha && <span className="as-badge">{sprava.pouzitaPriloha}</span>}
                  {(sprava.zdroje ?? []).map((zdroj) => (
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
