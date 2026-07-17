// Klasifikácia XML príloh podľa root elementu a namespace — bez plného parsovania.
// PEPPOL BIS 3.0 je UBL 2.1 Invoice/CreditNote; SEPA výpis je ISO 20022 camt.053.

export type XmlKind = 'peppol_invoice' | 'peppol_credit_note' | 'sepa_camt053' | 'unknown_xml';

const UBL_INVOICE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const UBL_CREDIT_NOTE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2';

/** Rýchla detekcia, či bajty vyzerajú ako XML dokument (BOM/whitespace tolerantné). */
export function looksLikeXml(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.slice(0, 256)).toString('utf8').replace(/^﻿/, '').trimStart();
  return head.startsWith('<?xml') || head.startsWith('<');
}

export function classifyXml(bytes: Uint8Array): XmlKind {
  // Root element aj namespace sú vždy v úvode dokumentu; 8 KB stačí aj pri dlhých komentároch.
  const head = Buffer.from(bytes.slice(0, 8192)).toString('utf8').replace(/^﻿/, '');
  const rootMatch = head.replace(/<\?xml[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').match(/<\s*(?:([A-Za-z0-9_.-]+):)?([A-Za-z0-9_.-]+)[\s>]/);
  const rootName = rootMatch?.[2] ?? '';

  if (rootName === 'Invoice' && head.includes(UBL_INVOICE_NS)) return 'peppol_invoice';
  if (rootName === 'CreditNote' && head.includes(UBL_CREDIT_NOTE_NS)) return 'peppol_credit_note';
  if (rootName === 'Document' && /urn:iso:std:iso:20022:tech:xsd:camt\.053\./.test(head)) return 'sepa_camt053';
  return 'unknown_xml';
}
