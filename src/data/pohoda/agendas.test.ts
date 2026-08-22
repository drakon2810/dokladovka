import { describe, expect, it } from 'vitest';
import { bankovePredkontacie, predkontaciePreTyp } from './agendas';

const PONUKA = [
  { id: '1', agenda: 'receivedInvoice' },
  { id: '2', agenda: 'issuedInvoice' },
  { id: '3', agenda: 'bankReceived' },
  { id: '4' },
];

describe('predkontaciePreTyp', () => {
  it('vydanej faktúre neponúkne nákupnú predkontáciu', () => {
    expect(predkontaciePreTyp(PONUKA, 'FV').map((item) => item.id)).toEqual(['2', '4']);
  });

  it('prijatej faktúre neponúkne odbytovú predkontáciu', () => {
    expect(predkontaciePreTyp(PONUKA, 'FP').map((item) => item.id)).toEqual(['1', '4']);
  });

  it('bez zhody vráti celý číselník, aby sa doklad dal zaúčtovať', () => {
    const bezZhody = [{ id: '1', agenda: 'receivedInvoice' }];
    expect(predkontaciePreTyp(bezZhody, 'FV')).toEqual(bezZhody);
  });

  it('banka drží smer cez bankovePredkontacie', () => {
    expect(bankovePredkontacie(PONUKA, 'prijem').map((item) => item.id)).toEqual(['3', '4']);
    expect(predkontaciePreTyp(PONUKA, 'BV').map((item) => item.id)).toEqual(['3', '4']);
  });
});
