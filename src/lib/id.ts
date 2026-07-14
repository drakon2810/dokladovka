/** Krátke unikátne ID pre mock entity (nie bezpečnostný token). */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
