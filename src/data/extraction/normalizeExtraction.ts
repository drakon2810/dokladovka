import type {
  DocumentExtractedData,
  DocumentType,
  ExtractionResult,
  VatBreakdownRow,
  VatRate,
} from '../types';
import { round2 } from '../../lib/validate';
import { parseDecimalString } from '../validation/documentValidation';
import {
  aggregateConfidence,
  mapDocumentType,
  mapFieldConfidenceToDocument,
} from './extractionProvider';

function vatRows(result: ExtractionResult): VatBreakdownRow[] {
  return result.vatBreakdown.flatMap((row) => {
    const rate = Number(row.vatRate);
    const base = parseDecimalString(row.base);
    const vat = parseDecimalString(row.vat);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || base === undefined || vat === undefined) return [];
    return [{ sadzba: rate as VatRate, zaklad: round2(base), dph: round2(vat) }];
  });
}

export interface NormalizedExtraction {
  typ: DocumentType;
  extracted: DocumentExtractedData;
  fieldConfidence: Record<string, number>;
  confidence: number;
}

export function normalizeExtractionResult(
  result: ExtractionResult,
  documentId: string,
  fallbackDate: string,
): NormalizedExtraction {
  return {
    typ: mapDocumentType(result.documentType),
    extracted: {
      dodavatel: {
        nazov: result.supplier.nazov ?? '',
        ico: result.supplier.ico,
        dic: result.supplier.dic,
        icDph: result.supplier.icDph,
        adresa: result.supplier.adresa,
        iban: result.supplier.iban,
      },
      odberatel: { ...result.buyer },
      cisloFaktury: result.invoiceNumber ?? '',
      variabilnySymbol: result.variableSymbol,
      konstantnySymbol: result.constantSymbol,
      specifickySymbol: result.specificSymbol,
      datumVystavenia: result.issueDate ?? fallbackDate,
      datumSplatnosti: result.dueDate,
      datumDodania: result.taxDate,
      mena: (result.currency as DocumentExtractedData['mena']) ?? 'EUR',
      rozpisDph: vatRows(result),
      sumaSpolu: round2(parseDecimalString(result.totalAmount) ?? 0),
      polozky: result.lineItems.map((item, index) => ({
        id: `${documentId}-li-${index}`,
        popis: item.description ?? '',
        mnozstvo: parseDecimalString(item.quantity),
        jednotka: item.unit,
        jednotkovaCenaBezDph: parseDecimalString(item.unitPriceWithoutVat),
        sadzbaDph:
          item.vatRate && Number.isFinite(Number(item.vatRate)) && Number(item.vatRate) >= 0 && Number(item.vatRate) <= 100
            ? (Number(item.vatRate) as VatRate)
            : undefined,
        sumaBezDph: parseDecimalString(item.amountWithoutVat),
        sumaDph: parseDecimalString(item.vatAmount),
        sumaSpolu: parseDecimalString(item.amountTotal),
      })),
    },
    fieldConfidence: mapFieldConfidenceToDocument(result.fieldConfidence),
    confidence: aggregateConfidence(result.fieldConfidence),
  };
}
