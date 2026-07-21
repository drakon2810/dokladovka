// Zdieľaná detekcia MIME a bezpečné meno súboru pre intake príloh —
// e-mailový webhook aj ručné nahratie musia validovať bajty rovnako.
import { looksLikeXml } from './xmlClassifier.js';

export function detectedMimeType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 5 && Buffer.from(bytes.slice(0, 5)).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && Buffer.from(bytes.slice(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.slice(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  if (looksLikeXml(bytes)) return 'application/xml';
  return undefined;
}

// Deklarované MIME pre XML sa v e-mailových klientoch líši; obsahová detekcia rozhoduje.
const XML_DECLARED_MIME_TYPES = ['application/xml', 'text/xml', 'application/octet-stream'];

export function mimeMatchesDeclared(actualMime: string, declaredMime: string): boolean {
  if (actualMime === declaredMime) return true;
  return actualMime === 'application/xml' && XML_DECLARED_MIME_TYPES.includes(declaredMime);
}

export function safeName(value: string): string {
  const base = value.replaceAll('\\', '/').split('/').pop() ?? 'attachment';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'attachment';
}
