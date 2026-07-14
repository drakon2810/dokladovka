import { format, parseISO } from 'date-fns';
import { sk } from 'date-fns/locale';

/** `1 234,56 €` — medzera ako oddeľovač tisícov, čiarka pre desatiny (SPEC §6.3). */
export function formatMoney(value: number, currency: 'EUR' | 'CZK' | 'USD' = 'EUR'): string {
  const formatted = new Intl.NumberFormat('sk-SK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  const symbol = currency === 'EUR' ? '€' : currency === 'CZK' ? 'Kč' : '$';
  return `${formatted} ${symbol}`;
}

export function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return format(parseISO(iso), 'd. M. yyyy', { locale: sk });
  } catch {
    return iso;
  }
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return format(parseISO(iso), 'd. M. yyyy HH:mm', { locale: sk });
  } catch {
    return iso;
  }
}
