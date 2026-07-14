// Ľahký toast systém (UI stav — nie dátová operácia).
import { create } from 'zustand';

export interface ToastItem {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  tone?: 'success' | 'error' | 'info';
}

interface ToastState {
  toasts: ToastItem[];
}

let nextId = 1;

export const useToastStore = create<ToastState>(() => ({ toasts: [] }));

export function showToast(
  text: string,
  options: Omit<ToastItem, 'id' | 'text'> = {},
): void {
  const id = nextId++;
  useToastStore.setState((s) => ({ toasts: [...s.toasts, { id, text, ...options }] }));
  window.setTimeout(() => dismissToast(id), 6000);
}

export function dismissToast(id: number): void {
  useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
