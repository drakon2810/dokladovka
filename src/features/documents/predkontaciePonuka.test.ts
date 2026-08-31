import { describe, expect, it } from 'vitest';
import { predkontaciePreTyp } from '../../data/pohoda/agendas';

// POHODA znacka agendy hovori, kde bola predkontacia ZALOZENA, nie kde sa smie
// pouzit. „PHM" je oznacena ako internalDocument a ALPINA ju ma na 229 prijatych
// fakturach. Filter ju z ponuky vyhodil, pole ukazalo „—" a spravny navrh AI sa
// nedal ani vybrat rucne.
const ponuka = (
  vsetky: Array<{ id: string; agenda?: string }>,
  typ: 'FP',
  navrh?: string,
  zvolene?: string,
) => {
  const podlaAgendy = predkontaciePreTyp(vsetky, typ);
  const chybajuce = [navrh, zvolene]
    .filter((id): id is string => Boolean(id) && !podlaAgendy.some((item) => item.id === id))
    .map((id) => vsetky.find((item) => item.id === id))
    .filter((item): item is { id: string; agenda?: string } => Boolean(item));
  return chybajuce.length > 0 ? [...chybajuce, ...podlaAgendy] : podlaAgendy;
};

const VSETKY = [
  { id: 'fp1', agenda: 'receivedInvoice' },
  { id: 'phm', agenda: 'internalDocument' },
  { id: 'fv1', agenda: 'issuedInvoice' },
];

describe('ponuka predkontácií v karte dokladu', () => {
  it('bez návrhu ostáva filter podľa agendy nedotknutý', () => {
    expect(ponuka(VSETKY, 'FP').map((i) => i.id)).toEqual(['fp1']);
  });

  it('navrhnutá predkontácia z inej agendy sa do ponuky doplní', () => {
    expect(ponuka(VSETKY, 'FP', 'phm').map((i) => i.id)).toEqual(['phm', 'fp1']);
  });

  it('už zvolená hodnota sa nestratí', () => {
    expect(ponuka(VSETKY, 'FP', undefined, 'phm').map((i) => i.id)).toEqual(['phm', 'fp1']);
  });

  it('nič sa nezduplikuje, keď návrh do agendy patrí', () => {
    expect(ponuka(VSETKY, 'FP', 'fp1').map((i) => i.id)).toEqual(['fp1']);
  });
});
