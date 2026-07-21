import { describe, expect, it } from 'vitest';
import { detectDocumentMime } from './localDocumentFileStore';

const pdf = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])]);
const peppol =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:...">…</Invoice>';

describe('detectDocumentMime', () => {
  it('rozpozná PEPPOL BIS XML s deklaráciou', async () => {
    expect(await detectDocumentMime(new Blob([peppol]))).toBe('application/xml');
  });

  it('rozpozná XML bez deklarácie podľa koreňového elementu', async () => {
    expect(await detectDocumentMime(new Blob(['﻿  <Invoice/>']))).toBe('application/xml');
  });

  it('odmietne HTML zamaskované ako XML', async () => {
    expect(await detectDocumentMime(new Blob(['<!DOCTYPE html><html></html>']))).toBeUndefined();
  });

  it('ponechá detekciu PDF podľa magic bytes', async () => {
    expect(await detectDocumentMime(pdf)).toBe('application/pdf');
  });
});
