// Fáza 1 object-storage adaptér pre ručne nahrané dokumenty.
// Blob sa ukladá do IndexedDB, nie do Zustand/localStorage. Vo Fáze 2 túto
// implementáciu nahradí upload na backend bez zmeny DocumentItem kontraktu.

export const MAX_DOCUMENT_FILE_SIZE = 20 * 1024 * 1024;

export type SupportedDocumentMime =
  | 'application/pdf'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'application/xml';

export interface StoredDocumentFile {
  key: string;
  blob: Blob;
  name: string;
  mimeType: SupportedDocumentMime;
  size: number;
  storedAt: string;
}

const DB_NAME = 'dokladovka-local-files';
const STORE_NAME = 'documents';
const DB_VERSION = 1;
const memoryFallback = new Map<string, StoredDocumentFile>();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB sa nepodarilo otvoriť'));
  });
}

function bytesStartWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/** Rozpozná PEPPOL BIS / UBL e-faktúru podľa začiatku obsahu (XML deklarácia
 *  alebo koreňový element). HTML (`<!DOCTYPE`, `<!--`) sa vylučuje. */
function looksLikeXml(bytes: Uint8Array): boolean {
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(start))
    .replace(/^\s+/, '');
  return head.startsWith('<?xml') || /^<[A-Za-z]/.test(head);
}

/** MIME sa určuje podľa magic bytes; browserom deklarovaný typ nie je autorita. */
export async function detectDocumentMime(file: Blob): Promise<SupportedDocumentMime | undefined> {
  const bytes = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  if (bytesStartWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (looksLikeXml(bytes)) return 'application/xml';
  return undefined;
}

export async function inspectDocumentFile(file: File): Promise<SupportedDocumentMime> {
  if (file.size === 0 || file.size > MAX_DOCUMENT_FILE_SIZE) {
    throw new Error('invalid_file_size');
  }
  const mimeType = await detectDocumentMime(file);
  if (!mimeType) throw new Error('unsupported_file_type');
  return mimeType;
}

export async function saveLocalDocumentFile(
  key: string,
  file: File,
  mimeType: SupportedDocumentMime,
): Promise<void> {
  const value: StoredDocumentFile = {
    key,
    blob: file,
    name: file.name,
    mimeType,
    size: file.size,
    storedAt: new Date().toISOString(),
  };
  if (typeof indexedDB === 'undefined') {
    memoryFallback.set(key, value);
    return;
  }
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Súbor sa nepodarilo uložiť'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Ukladanie súboru bolo prerušené'));
  });
  database.close();
}

export async function getLocalDocumentFile(key: string): Promise<StoredDocumentFile | undefined> {
  if (typeof indexedDB === 'undefined') return memoryFallback.get(key);
  const database = await openDatabase();
  const value = await new Promise<StoredDocumentFile | undefined>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as StoredDocumentFile | undefined);
    request.onerror = () => reject(request.error ?? new Error('Súbor sa nepodarilo načítať'));
  });
  database.close();
  return value;
}

export async function deleteLocalDocumentFile(key: string): Promise<void> {
  memoryFallback.delete(key);
  if (typeof indexedDB === 'undefined') return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Súbor sa nepodarilo odstrániť'));
  });
  database.close();
}

export async function clearLocalDocumentFiles(): Promise<void> {
  memoryFallback.clear();
  if (typeof indexedDB === 'undefined') return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Súbory sa nepodarilo vyčistiť'));
  });
  database.close();
}
