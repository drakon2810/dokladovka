/**
 * Hlavička Content-Disposition s názvom súboru.
 *
 * Hlavičky HTTP unesú len latin-1. Node na znaku mimo nej rovno hodí
 * ERR_INVALID_CHAR, takže faktúra s „€" v názve neskončila zlým názvom, ale
 * chybou celej odpovede — prehliadač napísal iba „PDF sa nepodarilo načítať".
 * Diakritika preto ide v RFC 5987 `filename*`, ASCII variant je len záloha.
 */
export function contentDisposition(dispozicia: 'inline' | 'attachment', nazov: string): string {
  const bezpecny = nazov.replace(/[\r\n"\\]/g, '_').slice(0, 180);
  const ascii = bezpecny.replace(/[^\x20-\x7e]/g, '_') || 'subor';
  // encodeURIComponent nechá !'()* nedotknuté, RFC 5987 ich medzi attr-char nemá.
  const utf8 = encodeURIComponent(bezpecny).replace(/['()!*]/g, (znak) =>
    `%${znak.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${dispozicia}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
