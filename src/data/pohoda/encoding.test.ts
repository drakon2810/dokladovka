import { describe, expect, it } from 'vitest';
import { decodePohodaXml, detectXmlEncoding } from './encoding';

function joinBytes(...parts: number[][]): ArrayBuffer {
  return Uint8Array.from(parts.flat()).buffer;
}

describe('decodePohodaXml', () => {
  it('dekóduje Windows-1250 vrátane slovenskej diakritiky', () => {
    const prefix = Array.from(
      new TextEncoder().encode('<?xml version="1.0" encoding="windows-1250"?><x>'),
    );
    const suffix = Array.from(new TextEncoder().encode('</x>'));
    const buffer = joinBytes(prefix, [0xe8, 0x20, 0xbe, 0x20, 0x9a, 0x20, 0x9d, 0x20, 0x9e], suffix);
    expect(detectXmlEncoding(buffer)).toBe('windows-1250');
    expect(decodePohodaXml(buffer)).toContain('<x>č ľ š ť ž</x>');
  });

  it('dekóduje UTF-8 podľa deklarácie', () => {
    const value = '<?xml version="1.0" encoding="UTF-8"?><x>č ľ š ť ž</x>';
    const buffer = new TextEncoder().encode(value).buffer;
    expect(decodePohodaXml(buffer)).toBe(value);
  });

  it('bez deklarácie použije Windows-1250 fallback', () => {
    const buffer = joinBytes(
      Array.from(new TextEncoder().encode('<x>')),
      [0xe8],
      Array.from(new TextEncoder().encode('</x>')),
    );
    expect(decodePohodaXml(buffer)).toBe('<x>č</x>');
  });
});
