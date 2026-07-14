const XML_HEADER_BYTES = 200;

/** Zistí deklarované kódovanie bez predčasného dekódovania celého XML. */
export function detectXmlEncoding(buffer: ArrayBuffer): string | undefined {
  const header = new TextDecoder('iso-8859-1').decode(
    new Uint8Array(buffer, 0, Math.min(buffer.byteLength, XML_HEADER_BYTES)),
  );
  return header.match(/<\?xml\b[^>]*\bencoding\s*=\s*["']\s*([^"']+?)\s*["']/i)?.[1];
}

function normalizeEncoding(label: string): string {
  const normalized = label.trim().toLowerCase().replace(/_/g, '-');
  if (['windows-1250', 'cp1250', 'x-cp1250'].includes(normalized)) {
    return 'windows-1250';
  }
  if (['utf-8', 'utf8'].includes(normalized)) return 'utf-8';
  return normalized;
}

/**
 * Dekóduje response načítaný cez File.arrayBuffer(). Poradie fallbackov je
 * deklarované kódovanie -> Windows-1250 -> UTF-8, ako vyžaduje špecifikácia.
 */
export function decodePohodaXml(buffer: ArrayBuffer): string {
  const declared = detectXmlEncoding(buffer);
  const candidates = [declared, 'windows-1250', 'utf-8']
    .filter((value): value is string => Boolean(value))
    .map(normalizeEncoding)
    .filter((value, index, all) => all.indexOf(value) === index);
  const errors: string[] = [];

  for (const encoding of candidates) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch (error) {
      errors.push(`${encoding}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `XML súbor sa nepodarilo dekódovať (${errors.join('; ') || 'neznáme kódovanie'}).`,
  );
}
