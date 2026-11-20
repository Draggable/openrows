/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { BARCODE_TYPES } from '@openrows/shared';
import { ZXING_WASM_VERSION } from 'barcode-detector/ponyfill';
import { describe, expect, it } from 'vitest';
import { barcodeTypeOfFormat, SCAN_FORMATS, scanProblemOf } from './barcode-scan';

describe('barcodeTypeOfFormat', () => {
  it('names every symbology a cell has, from the formats a scan asks for', () => {
    expect(SCAN_FORMATS.map(barcodeTypeOfFormat)).toEqual([...BARCODE_TYPES]);
  });

  it('maps a decoder’s variants, and nothing else', () => {
    expect(barcodeTypeOfFormat('itf_14')).toBe('itf');
    expect(barcodeTypeOfFormat('code_39_extended')).toBe('code39');
    expect(barcodeTypeOfFormat('isbn')).toBe('ean13');
    expect(barcodeTypeOfFormat('pdf417')).toBeNull();
    expect(barcodeTypeOfFormat('unknown')).toBeNull();
    expect(barcodeTypeOfFormat('toString')).toBeNull();
  });
});

describe('scanProblemOf', () => {
  const error = (name: string) => Object.assign(new Error(name), { name });

  it('reads getUserMedia refusals by name', () => {
    expect(scanProblemOf(error('NotAllowedError'))).toBe('denied');
    expect(scanProblemOf(error('SecurityError'))).toBe('denied');
    expect(scanProblemOf(error('NotFoundError'))).toBe('noCamera');
    expect(scanProblemOf(error('OverconstrainedError'))).toBe('noCamera');
    expect(scanProblemOf(error('NotReadableError'))).toBe('busy');
    expect(scanProblemOf(error('TypeError'))).toBe('failed');
    expect(scanProblemOf('nope')).toBe('failed');
  });
});

describe('the fallback decoder', () => {
  it('ships the .wasm of the very version its glue code expects', () => {
    const pkg = JSON.parse(
      readFileSync(`${import.meta.dirname}/../../../../package.json`, 'utf8')
    ) as { dependencies: Record<string, string> };
    // The client imports zxing-wasm's .wasm itself (served from the app's origin), so its
    // pinned version must be the one barcode-detector runs.
    expect(pkg.dependencies['zxing-wasm']).toBe(ZXING_WASM_VERSION);
  });
});
