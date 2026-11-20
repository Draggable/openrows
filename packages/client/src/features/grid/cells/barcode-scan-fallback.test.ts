import { BarcodeDetector, prepareZXingModule, purgeZXingModule } from 'barcode-detector/ponyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';
import zxingReaderWasm from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { fallbackDetector } from './barcode-scan-fallback';

// The fallback decoder's loading, with the library faked: no WebAssembly is compiled here.
vi.mock('barcode-detector/ponyfill', () => ({
  BarcodeDetector: vi.fn(function (this: { formats?: unknown }, options: { formats: unknown }) {
    this.formats = options.formats;
  }),
  prepareZXingModule: vi.fn(),
  purgeZXingModule: vi.fn(),
}));

type Overrides = { locateFile: (path: string, prefix: string) => string };

afterEach(() => {
  vi.mocked(prepareZXingModule).mockReset();
  vi.mocked(purgeZXingModule).mockReset();
  vi.mocked(BarcodeDetector).mockClear();
});

describe('fallbackDetector', () => {
  it('compiles the decoder from the app’s own .wasm, never a CDN, then makes a detector', async () => {
    vi.mocked(prepareZXingModule).mockResolvedValue({} as never);
    const detector = await fallbackDetector(['qr_code', 'ean_13']);
    expect(detector).toBeInstanceOf(BarcodeDetector);
    expect(BarcodeDetector).toHaveBeenCalledWith({ formats: ['qr_code', 'ean_13'] });

    const [options] = vi.mocked(prepareZXingModule).mock.calls[0] ?? [];
    expect(options).toMatchObject({ fireImmediately: true });
    const { locateFile } = (options as { overrides: Overrides }).overrides;
    const cdn = 'https://cdn.example/zxing/';
    const url = locateFile('zxing_reader.wasm', cdn);
    expect(url).toBe(zxingReaderWasm);
    // A path on the app's origin: not absolute to another host, nothing from the prefix.
    expect(url.startsWith('/')).toBe(true);
    expect(url.startsWith('//')).toBe(false);
    expect(url).not.toContain('cdn.example');
  });

  it('forgets a decoder that failed to load, so the next scan tries again', async () => {
    vi.mocked(prepareZXingModule)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({} as never);
    await expect(fallbackDetector(['qr_code'])).rejects.toThrow('offline');
    expect(purgeZXingModule).toHaveBeenCalledTimes(1);
    expect(BarcodeDetector).not.toHaveBeenCalled();

    await expect(fallbackDetector(['qr_code'])).resolves.toBeInstanceOf(BarcodeDetector);
    expect(prepareZXingModule).toHaveBeenCalledTimes(2);
    expect(purgeZXingModule).toHaveBeenCalledTimes(1);
  });
});
