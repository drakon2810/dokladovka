import { describe, expect, it } from 'vitest';
import { agendaRadu, radyPreTyp } from './agendas';

// Prijatá zálohová faktúra dostala rad „ZF260 Prijaté faktúry zahraničné",
// hoci firma má pre ňu vlastný rad 2618. Agenda radu musí vychádzať z DVOJICE:
// zálohová má v POHODE vlastnú agendu, dobropis a ťarchopis nie.
const RADY = [
  { id: 'zf260', agenda: 'prijate_faktury' },
  { id: '2618', agenda: 'prijate_zalohove_faktury' },
  { id: '2608', agenda: 'vydane_zalohove_faktury' },
];

describe('číselný rad zálohovej faktúry', () => {
  it('prijatá zálohová dostane zálohový rad, nie rad bežných faktúr', () => {
    expect(agendaRadu({ typ: 'FP', podtyp: 'zalohova' })).toBe('prijate_zalohove_faktury');
    expect(radyPreTyp(RADY, { typ: 'FP', podtyp: 'zalohova' }).map((r) => r.id)).toEqual(['2618']);
  });

  it('vydaná zálohová má vlastný rad tiež', () => {
    expect(radyPreTyp(RADY, { typ: 'FV', podtyp: 'zalohova' }).map((r) => r.id)).toEqual(['2608']);
  });

  it('bežná faktúra a dobropis zálohový rad nedostanú', () => {
    for (const podtyp of ['bezna', 'dobropis', 'tarchopis'] as const) {
      expect(radyPreTyp(RADY, { typ: 'FP', podtyp }).map((r) => r.id)).toEqual(['zf260']);
    }
  });
});
