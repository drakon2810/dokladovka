// Deterministické demo dáta (SPEC §9). Tokeny aliasov sú fixné v seede,
// aby „Reset demo dát" dával reprodukovateľný výsledok.
import type {
  CodeListItem,
  CodeListKind,
  DocumentItem,
  DocumentQueue,
  DocumentStatus,
  DocumentType,
  ExportBatch,
  InboundEmail,
  Organization,
  OrganizationBankAccount,
  OrganizationEmailAlias,
  ProcessingStatus,
  VatBreakdownRow,
  VatRate,
} from '../types';
import { MOCK_TENANT_ID, PUBLIC_MAIL_RECEIVING_DOMAIN } from '../config';
import { round2 } from '../../lib/validate';
import { buildDataPack } from '../xml/pohodaDataPack';

// Pomocník: ISO dátum N dní dozadu od fixného ukotvenia (stabilné demo)
const ANCHOR = new Date('2026-07-10T09:00:00.000Z');
function daysAgo(days: number, hourOffset = 0): string {
  const d = new Date(ANCHOR);
  d.setDate(d.getDate() - days);
  d.setHours(d.getHours() + hourOffset);
  return d.toISOString();
}
function dateOnly(days: number): string {
  return daysAgo(days).slice(0, 10);
}
function dateAhead(days: number): string {
  const d = new Date(ANCHOR);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ===== Organizácie (SPEC §9) =====
export const seedOrganizations: Organization[] = [
  {
    id: 'org-alfa',
    tenantId: MOCK_TENANT_ID,
    nazov: 'Alfa Trade s.r.o.',
    ico: '36123456',
    dic: '2021234567',
    icDph: 'SK2021234567',
    emailAlias: `alfa-trade-k7m4q2@${PUBLIC_MAIL_RECEIVING_DOMAIN}`,
    farba: '#0E7A5F',
  },
  {
    id: 'org-beta',
    tenantId: MOCK_TENANT_ID,
    nazov: 'Beta Gastro s.r.o.',
    ico: '47654321',
    dic: '2023456789',
    icDph: 'SK2023456789',
    emailAlias: `beta-gastro-p9x2vd@${PUBLIC_MAIL_RECEIVING_DOMAIN}`,
    farba: '#B45309',
  },
  {
    id: 'org-gama',
    tenantId: MOCK_TENANT_ID,
    nazov: 'Gama Servis s.r.o.',
    ico: '51987654',
    dic: '2029876543',
    icDph: 'SK2029876543',
    emailAlias: `gama-servis-r4c8wn@${PUBLIC_MAIL_RECEIVING_DOMAIN}`,
    farba: '#4338CA',
  },
];

function mkAlias(
  org: Organization,
  slug: string,
  token: string,
  queueId?: string,
  isPrimary = true,
): OrganizationEmailAlias {
  const localPart = `${slug}-${token}`;
  const address = `${localPart}@${PUBLIC_MAIL_RECEIVING_DOMAIN}`;
  return {
    id: `alias-${org.id}-${token}`,
    tenantId: MOCK_TENANT_ID,
    organizationId: org.id,
    queueId,
    address,
    addressNormalized: address,
    localPart,
    domain: PUBLIC_MAIL_RECEIVING_DOMAIN,
    slugAtCreation: slug,
    token,
    status: 'active',
    isPrimary,
    createdAt: daysAgo(180),
  };
}

export const seedAliases: OrganizationEmailAlias[] = [
  mkAlias(seedOrganizations[0], 'alfa-trade', 'k7m4q2', 'queue-org-alfa-received'),
  mkAlias(seedOrganizations[1], 'beta-gastro', 'p9x2vd', 'queue-org-beta-received'),
  mkAlias(seedOrganizations[2], 'gama-servis', 'r4c8wn', 'queue-org-gama-received'),
  mkAlias(seedOrganizations[0], 'alfa-vydane', 'f3n8sz', 'queue-org-alfa-issued', false),
  mkAlias(seedOrganizations[1], 'beta-vydane', 'h6w2kt', 'queue-org-beta-issued', false),
  mkAlias(seedOrganizations[2], 'gama-vydane', 'm4q7cx', 'queue-org-gama-issued', false),
  mkAlias(seedOrganizations[0], 'alfa-ine', 'd8r5vp', 'queue-org-alfa-other', false),
  mkAlias(seedOrganizations[1], 'beta-ine', 'n2k7wf', 'queue-org-beta-other', false),
  mkAlias(seedOrganizations[2], 'gama-ine', 's9c4hm', 'queue-org-gama-other', false),
];

function queueFeatures(extraction: boolean): DocumentQueue['features'] {
  return {
    extraction,
    approval: true,
    validation: true,
    spamDetection: true,
    requireApprovalNote: false,
    autoAttachEmailAttachments: true,
  };
}

export function queueIdForDocumentType(orgId: string, type: DocumentType): string {
  if (type === 'FV') return `queue-${orgId}-issued`;
  if (type === 'FP' || type === 'OZ') return `queue-${orgId}-received`;
  return `queue-${orgId}-other`;
}

export const seedQueues: DocumentQueue[] = seedOrganizations.flatMap((organization) => {
  const definitions: Array<Pick<DocumentQueue, 'id' | 'name' | 'kind' | 'documentTypes' | 'features'>> = [
    {
      id: `queue-${organization.id}-received`,
      name: 'Prijaté faktúry',
      kind: 'received_invoices',
      documentTypes: ['FP', 'OZ'],
      features: queueFeatures(true),
    },
    {
      id: `queue-${organization.id}-issued`,
      name: 'Vystavené faktúry',
      kind: 'issued_invoices',
      documentTypes: ['FV'],
      features: queueFeatures(true),
    },
    {
      id: `queue-${organization.id}-other`,
      name: 'Ostatné doklady',
      kind: 'other',
      documentTypes: ['BV', 'MZDY', 'PD'],
      features: queueFeatures(false),
    },
  ];
  return definitions.map((definition) => ({
    ...definition,
    tenantId: MOCK_TENANT_ID,
    organizationId: organization.id,
    importAlias: seedAliases.find((alias) => alias.queueId === definition.id)?.address,
    active: true,
    warningThreshold: 0.8,
    automation: {},
  }));
});

export const seedBankAccounts: OrganizationBankAccount[] = [
  {
    id: 'bank-org-alfa-eur',
    tenantId: MOCK_TENANT_ID,
    organizationId: 'org-alfa',
    label: 'Hlavný účet EUR',
    iban: 'SK6511000000002628004523',
    bic: 'TATRSKBX',
    currency: 'EUR',
    isDefault: true,
    active: true,
  },
  {
    id: 'bank-org-beta-eur',
    tenantId: MOCK_TENANT_ID,
    organizationId: 'org-beta',
    label: 'Prevádzkový účet EUR',
    iban: 'SK5811000000002926860291',
    bic: 'TATRSKBX',
    currency: 'EUR',
    isDefault: true,
    active: true,
  },
  {
    id: 'bank-org-gama-eur',
    tenantId: MOCK_TENANT_ID,
    organizationId: 'org-gama',
    label: 'Hlavný účet EUR',
    iban: 'SK4811000000002949013137',
    bic: 'TATRSKBX',
    currency: 'EUR',
    isDefault: true,
    active: true,
  },
];

// ===== Číselníky per organizácia (SPEC §9) =====
// Pozn.: reálne kódy prídu zo synchronizácie s POHODA vo Fáze 2.
function codeListsFor(orgId: string): Record<CodeListKind, CodeListItem[]> {
  const mk = (kind: string, kod: string, nazov: string): CodeListItem => ({
    id: `${orgId}-${kind}-${kod}`,
    tenantId: MOCK_TENANT_ID,
    kod,
    nazov,
    orgId,
    source: 'manual',
    active: true,
  });
  return {
    predkontacie: [
      mk('pk', '518/321', 'Služby'),
      mk('pk', '501/321', 'Materiál'),
      mk('pk', '511/321', 'Opravy'),
      mk('pk', '112/321', 'Tovar'),
    ],
    cleneniaDph: [
      mk('cd', 'PD', 'Tuzemské plnenie, odpočet 100 %'),
      mk('cd', 'PDpdp', 'Prenesenie daňovej povinnosti'),
      mk('cd', 'PNzahr', 'Nadobudnutie z EÚ'),
      mk('cd', 'BEZ', 'Bez vplyvu na DPH'),
    ],
    ciselneRady: [
      mk('cr', '26FP', 'Faktúry prijaté 2026'),
      mk('cr', '26FV', 'Faktúry vydané 2026'),
      mk('cr', '26OZ', 'Ostatné záväzky 2026'),
    ],
    strediska: [mk('st', 'HLAVNE', 'Hlavné stredisko'), mk('st', 'SKLAD', 'Sklad')],
  };
}

export function buildSeedCodeLists(): Record<CodeListKind, CodeListItem[]> {
  const all: Record<CodeListKind, CodeListItem[]> = {
    predkontacie: [],
    cleneniaDph: [],
    ciselneRady: [],
    strediska: [],
  };
  for (const org of seedOrganizations) {
    const lists = codeListsFor(org.id);
    (Object.keys(all) as CodeListKind[]).forEach((k) => all[k].push(...lists[k]));
  }
  return all;
}

// ===== Dodávatelia (SPEC §9) =====
interface SeedSupplier {
  nazov: string;
  ico: string;
  dic: string;
  icDph: string;
  iban: string;
  adresa: string;
}
const SUPPLIERS: Record<string, SeedSupplier> = {
  telekom: {
    nazov: 'Slovak Telekom, a.s.',
    ico: '35763469',
    dic: '2020273893',
    icDph: 'SK2020273893',
    iban: 'SK6511000000002628004523',
    adresa: 'Bajkalská 28, 817 62 Bratislava',
  },
  zse: {
    nazov: 'ZSE Energia, a.s.',
    ico: '36677281',
    dic: '2022249295',
    icDph: 'SK2022249295',
    iban: 'SK5811000000002926860291',
    adresa: 'Čulenova 6, 816 47 Bratislava',
  },
  alza: {
    nazov: 'Alza.sk s. r. o.',
    ico: '36562939',
    dic: '2021863071',
    icDph: 'SK2021863071',
    iban: 'SK4811000000002949013137',
    adresa: 'Bottova 7939/2A, 811 09 Bratislava',
  },
  metro: {
    nazov: 'METRO Cash & Carry SR s.r.o.',
    ico: '45952671',
    dic: '2023150056',
    icDph: 'SK2023150056',
    iban: 'SK6511000000002620798102',
    adresa: 'Senecká cesta 1881, 900 28 Ivanka pri Dunaji',
  },
  orange: {
    nazov: 'Orange Slovensko, a.s.',
    ico: '35697270',
    dic: '2020310578',
    icDph: 'SK2020310578',
    iban: 'SK3211000000002620077501',
    adresa: 'Metodova 8, 821 08 Bratislava',
  },
  officeo: {
    nazov: 'Kancelárske potreby OFFICEO s.r.o.',
    ico: '44123123',
    dic: '2022676767',
    icDph: 'SK2022676767',
    iban: 'SK1309000000005044111222',
    adresa: 'Pri Šajbách 1, 831 06 Bratislava',
  },
  autoservis: {
    nazov: 'AutoServis Krajčír s.r.o.',
    ico: '50333444',
    dic: '2120333444',
    icDph: 'SK2120333444',
    iban: 'SK6309000000005112223334',
    adresa: 'Dlhá 15, 949 01 Nitra',
  },
};

// ===== Dokumenty =====
function vatRow(sadzba: VatRate, zaklad: number, dphOverride?: number): VatBreakdownRow {
  return {
    sadzba,
    zaklad,
    dph: dphOverride ?? round2(zaklad * (sadzba / 100)),
  };
}
function totalOf(rows: VatBreakdownRow[]): number {
  return round2(rows.reduce((s, r) => s + r.zaklad + r.dph, 0));
}

interface DocSeedOptions {
  id: string;
  orgId: string;
  typ: DocumentType;
  status: DocumentStatus;
  supplier: SeedSupplier;
  cisloFaktury: string;
  vs?: string;
  receivedDaysAgo: number;
  issueDaysAgo?: number;
  dueDate?: string;
  taxDaysAgo?: number;
  rows: VatBreakdownRow[];
  sumaOverride?: number;
  confidence?: number;
  fieldConfidence?: Record<string, number>;
  processingStatus?: ProcessingStatus;
  pdf?: string;
  ucto?: DocumentItem['ucto'];
  zdrojTyp?: 'email' | 'manual' | 'upload';
  missingVs?: boolean;
  missingDuzp?: boolean;
  exportId?: string;
  quarantineReason?: string;
  duplicateOfDocumentId?: string;
  polozky?: DocumentItem['extracted']['polozky'];
  odberatelIcoOverride?: string;
  historyExtra?: DocumentItem['history'];
}

function mkDoc(o: DocSeedOptions): DocumentItem {
  const org = seedOrganizations.find((x) => x.id === o.orgId)!;
  const issueDays = o.issueDaysAgo ?? o.receivedDaysAgo + 2;
  const suma = o.sumaOverride ?? totalOf(o.rows);
  const alias = seedAliases.find((a) => a.organizationId === o.orgId)!;
  const statusToProcessing: Record<DocumentStatus, ProcessingStatus> = {
    novy: 'queued',
    extrahovany: 'ready_for_review',
    na_kontrole: 'ready_for_review',
    schvaleny: 'ready_for_review',
    exportovany: 'ready_for_review',
    chyba: 'failed_permanent',
    karantena: 'ready_for_review',
    duplicita: 'ready_for_review',
    zamietnuty: 'ready_for_review',
  };
  const history: DocumentItem['history'] = [
    { ts: daysAgo(o.receivedDaysAgo), user: 'system', akcia: 'Doklad prijatý e-mailom' },
  ];
  if (o.status !== 'novy') {
    history.push({
      ts: daysAgo(o.receivedDaysAgo, 1),
      user: 'system',
      akcia: 'AI extrakcia dokončená',
    });
  }
  if (['na_kontrole', 'schvaleny', 'exportovany'].includes(o.status)) {
    history.push({
      ts: daysAgo(Math.max(o.receivedDaysAgo - 1, 0)),
      user: 'Mária Účtovníčka',
      akcia: 'Otvorené na kontrolu',
    });
  }
  if (['schvaleny', 'exportovany'].includes(o.status)) {
    history.push({
      ts: daysAgo(Math.max(o.receivedDaysAgo - 2, 0)),
      user: 'Mária Účtovníčka',
      akcia: 'Doklad schválený',
    });
  }
  if (o.historyExtra) history.push(...o.historyExtra);

  return {
    id: o.id,
    tenantId: MOCK_TENANT_ID,
    orgId: o.orgId,
    queueId: queueIdForDocumentType(o.orgId, o.typ),
    typ: o.typ,
    status: o.status,
    processingStatus: o.processingStatus ?? statusToProcessing[o.status],
    pdfUrl: o.pdf ?? '/samples/faktura-sluzby.pdf',
    prijateDna: daysAgo(o.receivedDaysAgo),
    zdroj: {
      typ: o.zdrojTyp ?? 'email',
      odosielatel: `fakturacia@${o.supplier.nazov
        .toLowerCase()
        .replace(/[^a-z]+/g, '')
        .slice(0, 12)}.sk`,
      prijemcaAlias: alias.address,
      predmet: `Faktúra ${o.cisloFaktury}`,
      povodnyNazovSuboru: `faktura-${o.cisloFaktury}.pdf`,
    },
    confidence: o.confidence ?? 0.95,
    fieldConfidence: o.fieldConfidence,
    extracted: {
      dodavatel: {
        nazov: o.supplier.nazov,
        ico: o.supplier.ico,
        dic: o.supplier.dic,
        icDph: o.supplier.icDph,
        iban: o.supplier.iban,
        adresa: o.supplier.adresa,
      },
      odberatel: {
        nazov: org.nazov,
        ico: o.odberatelIcoOverride ?? org.ico,
        dic: org.dic,
        icDph: org.icDph,
      },
      cisloFaktury: o.cisloFaktury,
      variabilnySymbol: o.missingVs ? undefined : (o.vs ?? o.cisloFaktury.replace(/\D/g, '')),
      datumVystavenia: dateOnly(issueDays),
      datumSplatnosti: o.dueDate ?? dateAhead(14 - o.receivedDaysAgo),
      datumDodania: o.missingDuzp ? undefined : dateOnly(issueDays),
      mena: 'EUR',
      rozpisDph: o.rows,
      sumaSpolu: suma,
      polozky: o.polozky,
      textPolozky: undefined,
    },
    ucto: o.ucto ?? {},
    history,
    comments: [],
    exportId: o.exportId,
    quarantineReason: o.quarantineReason,
    duplicateOfDocumentId: o.duplicateOfDocumentId,
    version: 1,
  };
}

const pk = (orgId: string, kod: string) => `${orgId}-pk-${kod}`;
const cd = (orgId: string, kod: string) => `${orgId}-cd-${kod}`;
const cr = (orgId: string, kod: string) => `${orgId}-cr-${kod}`;
const st = (orgId: string, kod: string) => `${orgId}-st-${kod}`;

function fullUcto(orgId: string, pkKod = '518/321', radKod = '26FP'): DocumentItem['ucto'] {
  return {
    predkontaciaId: pk(orgId, pkKod),
    clenenieDphId: cd(orgId, 'PD'),
    ciselnyRadId: cr(orgId, radKod),
    strediskoId: st(orgId, 'HLAVNE'),
  };
}

export function buildSeedDocuments(): DocumentItem[] {
  const docs: DocumentItem[] = [
    // ===== ALFA — FP =====
    mkDoc({
      id: 'doc-001', orgId: 'org-alfa', typ: 'FP', status: 'na_kontrole',
      supplier: SUPPLIERS.telekom, cisloFaktury: '8412345601', receivedDaysAgo: 2,
      rows: [vatRow(23, 45.9)], pdf: '/samples/faktura-telekom.pdf',
      polozky: [
        { id: 'li-001-1', popis: 'Magenta Office L — mesačný poplatok', mnozstvo: 1, jednotka: 'ks', jednotkovaCenaBezDph: 45.9, sadzbaDph: 23, sumaBezDph: 45.9, sumaDph: 10.56, sumaSpolu: 56.46 },
      ],
    }),
    mkDoc({
      id: 'doc-002', orgId: 'org-alfa', typ: 'FP', status: 'na_kontrole',
      supplier: SUPPLIERS.zse, cisloFaktury: '7300221144', receivedDaysAgo: 3,
      rows: [vatRow(23, 312.4)], pdf: '/samples/faktura-energia.pdf',
    }),
    // nízka istota — chýba VS aj DUZP (SPEC §9: 5 dokladov s confidence <0.7)
    mkDoc({
      id: 'doc-003', orgId: 'org-alfa', typ: 'FP', status: 'na_kontrole',
      supplier: SUPPLIERS.officeo, cisloFaktury: '20260455', receivedDaysAgo: 1,
      rows: [vatRow(23, 89.5)], confidence: 0.58, missingVs: true, missingDuzp: true,
      fieldConfidence: {
        'dodavatel.nazov': 0.91, 'dodavatel.ico': 0.62, cisloFaktury: 0.55,
        variabilnySymbol: 0.2, datumVystavenia: 0.88, datumDodania: 0.3, sumaSpolu: 0.74,
      },
      pdf: '/samples/faktura-kancelarske.pdf',
    }),
    mkDoc({
      id: 'doc-004', orgId: 'org-alfa', typ: 'FP', status: 'schvaleny',
      supplier: SUPPLIERS.alza, cisloFaktury: '2261004488', receivedDaysAgo: 6,
      rows: [vatRow(23, 1249.17)], ucto: fullUcto('org-alfa', '501/321'),
      pdf: '/samples/faktura-alza.pdf',
      polozky: [
        { id: 'li-004-1', popis: 'Notebook Lenovo ThinkPad E16', mnozstvo: 1, jednotka: 'ks', jednotkovaCenaBezDph: 1082.5, sadzbaDph: 23, sumaBezDph: 1082.5, sumaDph: 248.98, sumaSpolu: 1331.48 },
        { id: 'li-004-2', popis: 'Dokovacia stanica USB-C', mnozstvo: 1, jednotka: 'ks', jednotkovaCenaBezDph: 166.67, sadzbaDph: 23, sumaBezDph: 166.67, sumaDph: 38.33, sumaSpolu: 205.0 },
      ],
    }),
    mkDoc({
      id: 'doc-005', orgId: 'org-alfa', typ: 'FP', status: 'schvaleny',
      supplier: SUPPLIERS.telekom, cisloFaktury: '8412345001', receivedDaysAgo: 34,
      rows: [vatRow(23, 45.9)], ucto: fullUcto('org-alfa'),
      pdf: '/samples/faktura-telekom.pdf',
    }),
    // exportované (batch exp-1)
    mkDoc({
      id: 'doc-006', orgId: 'org-alfa', typ: 'FP', status: 'exportovany',
      supplier: SUPPLIERS.telekom, cisloFaktury: '8412344900', receivedDaysAgo: 64,
      rows: [vatRow(23, 45.9)], ucto: fullUcto('org-alfa'), exportId: 'exp-1',
      pdf: '/samples/faktura-telekom.pdf',
    }),
    mkDoc({
      id: 'doc-007', orgId: 'org-alfa', typ: 'FP', status: 'exportovany',
      supplier: SUPPLIERS.zse, cisloFaktury: '7300200001', receivedDaysAgo: 63,
      rows: [vatRow(23, 298.11)], ucto: fullUcto('org-alfa'), exportId: 'exp-1',
      pdf: '/samples/faktura-energia.pdf',
    }),
    // chyba — DPH schválne nesedí (SPEC §9)
    mkDoc({
      id: 'doc-008', orgId: 'org-alfa', typ: 'FP', status: 'chyba',
      supplier: SUPPLIERS.autoservis, cisloFaktury: '2026077', receivedDaysAgo: 4,
      rows: [vatRow(23, 350, 92.5)], // správne DPH by bolo 80,50 — nesedí
      sumaOverride: 430.5, confidence: 0.66, processingStatus: 'failed_permanent',
      fieldConfidence: { 'rozpisDph.0.dph': 0.41, sumaSpolu: 0.63 },
      pdf: '/samples/faktura-servis.pdf',
    }),
    // karanténa — IČO odberateľa patrí inej organizácii (org-beta)
    mkDoc({
      id: 'doc-009', orgId: 'org-alfa', typ: 'FP', status: 'karantena',
      supplier: SUPPLIERS.metro, cisloFaktury: '4426009911', receivedDaysAgo: 1,
      rows: [vatRow(23, 216.3), vatRow(19, 84.2)],
      odberatelIcoOverride: '47654321', quarantineReason: 'buyer_ico_mismatch',
      pdf: '/samples/faktura-metro.pdf',
    }),
    // duplicita — rovnaký dodávateľ + číslo ako doc-004
    mkDoc({
      id: 'doc-010', orgId: 'org-alfa', typ: 'FP', status: 'duplicita',
      supplier: SUPPLIERS.alza, cisloFaktury: '2261004488', receivedDaysAgo: 0,
      rows: [vatRow(23, 1249.17)], duplicateOfDocumentId: 'doc-004',
      pdf: '/samples/faktura-alza.pdf',
    }),
    // nové / extrahované
    mkDoc({
      id: 'doc-011', orgId: 'org-alfa', typ: 'FP', status: 'novy',
      supplier: SUPPLIERS.orange, cisloFaktury: '1152633447', receivedDaysAgo: 0,
      rows: [vatRow(23, 38.5)], processingStatus: 'extracting', confidence: 0,
      pdf: '/samples/faktura-telekom.pdf',
    }),
    mkDoc({
      id: 'doc-012', orgId: 'org-alfa', typ: 'FV', status: 'extrahovany',
      supplier: SUPPLIERS.metro, cisloFaktury: 'FV2026012', receivedDaysAgo: 1,
      rows: [vatRow(23, 1500)], zdrojTyp: 'upload',
      pdf: '/samples/faktura-sluzby.pdf',
    }),
    mkDoc({
      id: 'doc-013', orgId: 'org-alfa', typ: 'BV', status: 'extrahovany',
      supplier: { nazov: 'Tatra banka, a.s.', ico: '00686930', dic: '2020408522', icDph: 'SK2020408522', iban: 'SK2411000000002612345678', adresa: 'Hodžovo námestie 3, Bratislava' },
      cisloFaktury: 'VYPIS-2026-06', receivedDaysAgo: 8,
      rows: [vatRow(0, 0)], sumaOverride: 0,
      pdf: '/samples/vypis-banka.pdf',
    }),
    mkDoc({
      id: 'doc-014', orgId: 'org-alfa', typ: 'MZDY', status: 'na_kontrole',
      supplier: { nazov: 'Interné — mzdy 06/2026', ico: '36123456', dic: '2021234567', icDph: '', iban: '', adresa: '' },
      cisloFaktury: 'MZDY-2026-06', receivedDaysAgo: 5, zdrojTyp: 'upload',
      rows: [vatRow(0, 8450)],
      pdf: '/samples/mzdy-podklad.pdf',
    }),
    // ===== BETA — gastro =====
    mkDoc({
      id: 'doc-015', orgId: 'org-beta', typ: 'FP', status: 'na_kontrole',
      supplier: SUPPLIERS.metro, cisloFaktury: '4426008855', receivedDaysAgo: 2,
      // dve sadzby naraz (SPEC §9): 23 % a znížená 19 %
      rows: [vatRow(23, 420.8), vatRow(19, 130.45)],
      pdf: '/samples/faktura-metro.pdf',
      polozky: [
        { id: 'li-015-1', popis: 'Nápoje a alkohol', sadzbaDph: 23, sumaBezDph: 420.8, sumaDph: 96.78, sumaSpolu: 517.58 },
        { id: 'li-015-2', popis: 'Potraviny — znížená sadzba', sadzbaDph: 19, sumaBezDph: 130.45, sumaDph: 24.79, sumaSpolu: 155.24 },
      ],
    }),
    // nízka istota
    mkDoc({
      id: 'doc-016', orgId: 'org-beta', typ: 'FP', status: 'na_kontrole',
      supplier: SUPPLIERS.zse, cisloFaktury: '7300233355', receivedDaysAgo: 3,
      rows: [vatRow(23, 512.9)], confidence: 0.61, missingDuzp: true,
      fieldConfidence: {
        'dodavatel.ico': 0.83, cisloFaktury: 0.67, datumDodania: 0.25,
        'rozpisDph.0.zaklad': 0.6, sumaSpolu: 0.69,
      },
      pdf: '/samples/faktura-energia.pdf',
    }),
    mkDoc({
      id: 'doc-017', orgId: 'org-beta', typ: 'FP', status: 'schvaleny',
      supplier: SUPPLIERS.metro, cisloFaktury: '4426007700', receivedDaysAgo: 20,
      rows: [vatRow(23, 380.2), vatRow(5, 95.6)], ucto: fullUcto('org-beta', '501/321'),
      pdf: '/samples/faktura-metro.pdf',
    }),
    mkDoc({
      id: 'doc-018', orgId: 'org-beta', typ: 'FP', status: 'exportovany',
      supplier: SUPPLIERS.metro, cisloFaktury: '4426006600', receivedDaysAgo: 45,
      rows: [vatRow(23, 512.33)], ucto: fullUcto('org-beta', '501/321'), exportId: 'exp-2',
      pdf: '/samples/faktura-metro.pdf',
    }),
    mkDoc({
      id: 'doc-019', orgId: 'org-beta', typ: 'FP', status: 'exportovany',
      supplier: SUPPLIERS.telekom, cisloFaktury: '8412888777', receivedDaysAgo: 44,
      rows: [vatRow(23, 29.9)], ucto: fullUcto('org-beta'), exportId: 'exp-2',
      pdf: '/samples/faktura-telekom.pdf',
    }),
    mkDoc({
      id: 'doc-020', orgId: 'org-beta', typ: 'FV', status: 'na_kontrole',
      supplier: { nazov: 'Beta Gastro s.r.o. — odberateľ: Hotel Kriváň', ico: '31555666', dic: '2020555666', icDph: 'SK2020555666', iban: 'SK5909000000005098765432', adresa: 'Štúrova 12, Poprad' },
      cisloFaktury: 'FV2026058', receivedDaysAgo: 2, zdrojTyp: 'manual',
      rows: [vatRow(23, 2350)],
      pdf: '/samples/faktura-sluzby.pdf',
    }),
    mkDoc({
      id: 'doc-021', orgId: 'org-beta', typ: 'PD', status: 'extrahovany',
      supplier: SUPPLIERS.officeo, cisloFaktury: 'PD-2026-114', receivedDaysAgo: 1,
      rows: [vatRow(23, 24.9)], zdrojTyp: 'upload',
      pdf: '/samples/faktura-kancelarske.pdf',
    }),
    // nízka istota — supplier bez IČO (edge case §11.26)
    mkDoc({
      id: 'doc-022', orgId: 'org-beta', typ: 'OZ', status: 'na_kontrole',
      supplier: { nazov: 'Fyzická osoba — nájom priestorov', ico: '', dic: '', icDph: '', iban: 'SK2209000000005011122233', adresa: 'Obchodná 5, Bratislava' },
      cisloFaktury: 'NAJOM-07-2026', receivedDaysAgo: 2,
      rows: [vatRow(0, 850)], confidence: 0.52, missingVs: true,
      fieldConfidence: { 'dodavatel.nazov': 0.7, 'dodavatel.ico': 0.1, cisloFaktury: 0.45, sumaSpolu: 0.8 },
      pdf: '/samples/faktura-sluzby.pdf',
    }),
    mkDoc({
      id: 'doc-023', orgId: 'org-beta', typ: 'BV', status: 'novy',
      supplier: { nazov: 'Slovenská sporiteľňa, a.s.', ico: '00151653', dic: '2020411536', icDph: 'SK7020000262', iban: 'SK1109000000000011112222', adresa: 'Tomášikova 48, Bratislava' },
      cisloFaktury: 'VYPIS-2026-07', receivedDaysAgo: 0,
      rows: [vatRow(0, 0)], sumaOverride: 0, processingStatus: 'queued', confidence: 0,
      pdf: '/samples/vypis-banka.pdf',
    }),
    // ===== GAMA — servis =====
    mkDoc({
      id: 'doc-024', orgId: 'org-gama', typ: 'FP', status: 'na_kontrole',
      supplier: SUPPLIERS.autoservis, cisloFaktury: '2026101', receivedDaysAgo: 1,
      rows: [vatRow(23, 640)], pdf: '/samples/faktura-servis.pdf',
      polozky: [
        { id: 'li-024-1', popis: 'Servisné práce — motor', mnozstvo: 8, jednotka: 'hod', jednotkovaCenaBezDph: 55, sadzbaDph: 23, sumaBezDph: 440, sumaDph: 101.2, sumaSpolu: 541.2 },
        { id: 'li-024-2', popis: 'Náhradné diely', mnozstvo: 1, jednotka: 'ks', jednotkovaCenaBezDph: 200, sadzbaDph: 23, sumaBezDph: 200, sumaDph: 46, sumaSpolu: 246 },
      ],
    }),
    // nízka istota
    mkDoc({
      id: 'doc-025', orgId: 'org-gama', typ: 'FP', status: 'extrahovany',
      supplier: SUPPLIERS.orange, cisloFaktury: '1152699001', receivedDaysAgo: 1,
      rows: [vatRow(23, 65.83)], confidence: 0.64, missingVs: true,
      fieldConfidence: { variabilnySymbol: 0.15, cisloFaktury: 0.72, sumaSpolu: 0.66, 'dodavatel.iban': 0.58 },
      pdf: '/samples/faktura-telekom.pdf',
    }),
    mkDoc({
      id: 'doc-026', orgId: 'org-gama', typ: 'FP', status: 'schvaleny',
      supplier: SUPPLIERS.autoservis, cisloFaktury: '2026088', receivedDaysAgo: 15,
      rows: [vatRow(23, 890.4)], ucto: fullUcto('org-gama', '511/321'),
      pdf: '/samples/faktura-servis.pdf',
    }),
    mkDoc({
      id: 'doc-027', orgId: 'org-gama', typ: 'FV', status: 'schvaleny',
      supplier: { nazov: 'Gama Servis s.r.o. — odberateľ: Stavmont a.s.', ico: '31777888', dic: '2020777888', icDph: 'SK2020777888', iban: 'SK3209000000005055566677', adresa: 'Priemyselná 4, Žilina' },
      cisloFaktury: 'FV2026034', receivedDaysAgo: 9, zdrojTyp: 'manual',
      rows: [vatRow(23, 4200)], ucto: fullUcto('org-gama', '518/321', '26FV'),
      pdf: '/samples/faktura-sluzby.pdf',
    }),
    // chyba — extrakcia zlyhala (poškodený súbor)
    mkDoc({
      id: 'doc-028', orgId: 'org-gama', typ: 'FP', status: 'chyba',
      supplier: { nazov: 'Neznámy dodávateľ', ico: '', dic: '', icDph: '', iban: '', adresa: '' },
      cisloFaktury: '—', receivedDaysAgo: 2,
      rows: [], sumaOverride: 0, confidence: 0,
      processingStatus: 'failed_retryable', quarantineReason: 'corrupted_file',
      pdf: '/samples/faktura-sluzby.pdf',
    }),
    mkDoc({
      id: 'doc-029', orgId: 'org-gama', typ: 'MZDY', status: 'novy',
      supplier: { nazov: 'Interné — mzdy 06/2026', ico: '51987654', dic: '2029876543', icDph: '', iban: '', adresa: '' },
      cisloFaktury: 'MZDY-2026-06G', receivedDaysAgo: 0, zdrojTyp: 'upload',
      rows: [vatRow(0, 5230)], processingStatus: 'received', confidence: 0,
      pdf: '/samples/mzdy-podklad.pdf',
    }),
    mkDoc({
      id: 'doc-030', orgId: 'org-gama', typ: 'OZ', status: 'extrahovany',
      supplier: SUPPLIERS.zse, cisloFaktury: 'ZAL-2026-19', receivedDaysAgo: 3,
      rows: [vatRow(23, 150)],
      pdf: '/samples/faktura-energia.pdf',
    }),
    mkDoc({
      id: 'doc-031', orgId: 'org-gama', typ: 'PD', status: 'na_kontrole',
      supplier: SUPPLIERS.officeo, cisloFaktury: 'PD-2026-201', receivedDaysAgo: 6,
      rows: [vatRow(23, 18.2)], zdrojTyp: 'upload',
      pdf: '/samples/faktura-kancelarske.pdf',
    }),
    mkDoc({
      id: 'doc-032', orgId: 'org-alfa', typ: 'FV', status: 'schvaleny',
      supplier: { nazov: 'Alfa Trade s.r.o. — odberateľ: Delta Retail s.r.o.', ico: '36999888', dic: '2020999888', icDph: 'SK2020999888', iban: 'SK7111000000002612349876', adresa: 'Hlavná 1, Košice' },
      cisloFaktury: 'FV2026021', receivedDaysAgo: 7, zdrojTyp: 'manual',
      rows: [vatRow(23, 3100)], ucto: fullUcto('org-alfa', '518/321', '26FV'),
      pdf: '/samples/faktura-sluzby.pdf',
    }),
    mkDoc({
      id: 'doc-033', orgId: 'org-gama', typ: 'BV', status: 'extrahovany',
      supplier: { nazov: 'VÚB, a.s.', ico: '31320155', dic: '2020411811', icDph: 'SK7020000207', iban: 'SK6702000000001234567890', adresa: 'Mlynské nivy 1, Bratislava' },
      cisloFaktury: 'VYPIS-2026-06G', receivedDaysAgo: 9,
      rows: [vatRow(0, 0)], sumaOverride: 0,
      pdf: '/samples/vypis-banka.pdf',
    }),
  ];
  return docs.map((document) =>
    ['schvaleny', 'exportovany'].includes(document.status) && !document.approvedSnapshot
      ? {
          ...document,
          approvedVersion: document.version,
          approvedSnapshot: {
            version: document.version,
            approvedAt: document.history.find((item) => item.akcia === 'Doklad schválený')?.ts ?? document.prijateDna,
            typ: document.typ,
            extracted: structuredClone(document.extracted),
            ucto: structuredClone(document.ucto),
          },
        }
      : document,
  );
}

// ===== Export batches (SPEC §9: 4 exportované v 2 batchoch) =====
export const seedExportBatches: ExportBatch[] = [
  {
    id: 'exp-1',
    tenantId: MOCK_TENANT_ID,
    orgId: 'org-alfa',
    createdAt: daysAgo(60),
    user: 'Mária Účtovníčka',
    documentIds: ['doc-006', 'doc-007'],
    xmlFileName: 'pohoda-alfa-trade-20260511-0930.xml',
  },
  {
    id: 'exp-2',
    tenantId: MOCK_TENANT_ID,
    orgId: 'org-beta',
    createdAt: daysAgo(42),
    user: 'Mária Účtovníčka',
    documentIds: ['doc-018', 'doc-019'],
    xmlFileName: 'pohoda-beta-gastro-20260529-1415.xml',
  },
];

// ===== Inbound e-maily pre seed doklady prijaté e-mailom =====
export function buildSeedInboundEmails(): InboundEmail[] {
  return [
    {
      id: 'in-seed-1',
      tenantId: MOCK_TENANT_ID,
      organizationId: 'org-alfa',
      aliasId: seedAliases[0].id,
      provider: 'mock',
      providerMessageId: 'seed-msg-001',
      envelopeRecipients: [seedAliases[0].address],
      senderEmail: 'fakturacia@telekom.sk',
      senderName: 'Slovak Telekom',
      subject: 'Faktúra 8412345601',
      receivedAt: daysAgo(2),
      status: 'processed',
      attachmentCount: 1,
      correlationId: 'corr-seed-001',
      createdAt: daysAgo(2),
    },
    {
      id: 'in-seed-2',
      tenantId: MOCK_TENANT_ID,
      organizationId: 'org-beta',
      aliasId: seedAliases[1].id,
      provider: 'mock',
      providerMessageId: 'seed-msg-002',
      envelopeRecipients: [seedAliases[1].address],
      senderEmail: 'fakturacia@metro.sk',
      senderName: 'METRO Cash & Carry',
      subject: 'Faktúra 4426008855',
      receivedAt: daysAgo(2, 3),
      status: 'processed',
      attachmentCount: 1,
      correlationId: 'corr-seed-002',
      createdAt: daysAgo(2, 3),
    },
  ];
}

export function buildSeedState() {
  const documents = buildSeedDocuments();
  const codeLists = buildSeedCodeLists();
  const exportBatches = seedExportBatches.map((batch) => {
    const organization = seedOrganizations.find((item) => item.id === batch.orgId)!;
    const batchDocuments = documents.filter((item) => batch.documentIds.includes(item.id));
    return {
      ...batch,
      xmlSnapshot: buildDataPack(organization, batchDocuments, codeLists, batch.id),
    };
  });
  return {
    role: 'uctovnik' as const,
    currentOrgId: 'all',
    organizations: seedOrganizations.map((o) => ({ ...o })),
    queues: seedQueues.map((queue) => structuredClone(queue)),
    bankAccounts: seedBankAccounts.map((account) => ({ ...account })),
    aliases: seedAliases.map((a) => ({ ...a })),
    documents,
    inboundEmails: buildSeedInboundEmails(),
    inboundAttachments: [],
    extractionRuns: [],
    suggestions: [],
    codeLists,
    users: [
      {
        id: 'user-1',
        tenantId: MOCK_TENANT_ID,
        meno: 'Mária Účtovníčka',
        email: 'maria@kancelaria.sk',
        rola: 'uctovnik' as const,
        jazyk: 'sk' as const,
        notifikacie: { email: true, inApp: true, comments: true, mentions: true },
      },
      {
        id: 'user-2',
        tenantId: MOCK_TENANT_ID,
        meno: 'Peter Schvaľovateľ',
        email: 'peter@kancelaria.sk',
        rola: 'schvalovatel' as const,
        jazyk: 'sk' as const,
        notifikacie: { email: true, inApp: true, comments: true, mentions: true },
      },
      {
        id: 'user-3',
        tenantId: MOCK_TENANT_ID,
        meno: 'Andrej Admin',
        email: 'andrej@kancelaria.sk',
        rola: 'admin' as const,
        jazyk: 'sk' as const,
        notifikacie: { email: true, inApp: true, comments: true, mentions: true },
      },
    ],
    exportBatches,
    mostikEnabled: false,
    agentInstallations: [],
    pohodaCompanyLinks: seedOrganizations.map((organization) => ({
      tenantId: organization.tenantId,
      organizationId: organization.id,
      ico: organization.ico,
      preferredYear: 'latest' as const,
    })),
    exportJobs: [],
    payments: [],
    approvalRules: [],
    dphProfiles: [],
  };
}
