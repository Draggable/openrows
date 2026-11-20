import { BarcodeDetector, type BarcodeFormat, prepareZXingModule } from 'barcode-detector/ponyfill';
import zxingReaderWasm from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type { Detector } from './barcode-scan';

// The decoder for browsers without a BarcodeDetector: ZXing compiled to WebAssembly behind the
// same API (barcode-detector's ponyfill, MIT). This module is its own chunk, loaded only when
// someone scans in such a browser. The .wasm file is one of the app's assets, served from its
// own origin like the rest of the app (the library would otherwise fetch it from a CDN), and
// every frame is decoded on the device.

const overrides = {
  locateFile: (path: string, prefix: string) =>
    path.endsWith('.wasm') ? zxingReaderWasm : prefix + path,
};

/** A detector for `formats`, once the decoder is compiled (a failure rejects: "couldn't start"). */
export async function fallbackDetector(formats: BarcodeFormat[]): Promise<Detector> {
  await prepareZXingModule({ overrides, fireImmediately: true });
  return new BarcodeDetector({ formats });
}
