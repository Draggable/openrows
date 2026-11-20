import type { BarcodeType } from '@openrows/shared';

// Scanning a barcode with the device camera, for the barcode editor. Frames are decoded in the
// browser (the BarcodeDetector API, or the WebAssembly fallback of barcode-scan-fallback.ts);
// nothing leaves the device and nothing read is logged.

/** What the camera read: the code's text and its symbology, when it's one a cell can name. */
export interface ScanRead {
  text: string;
  type: BarcodeType | null;
}

/** Why the camera can't be used right now. */
export type ScanProblem = 'insecure' | 'unsupported' | 'denied' | 'noCamera' | 'busy' | 'failed';

export const SCAN_PROBLEM_MESSAGES: Record<ScanProblem, string> = {
  insecure:
    'The camera can only be used on a secure (HTTPS) connection. Type or paste the code instead.',
  unsupported: "This browser can't use a camera here. Type or paste the code instead.",
  denied:
    "Camera access is blocked. Allow it in the browser's site settings to scan, or type or paste the code.",
  noCamera: 'No camera was found. Type or paste the code instead.',
  busy: 'The camera is in use by another app. Close it and scan again, or type or paste the code.',
  failed: "The scanner couldn't start. Type or paste the code instead.",
};

/** The formats a scan looks for (BarcodeDetector's names), one per symbology a cell can name. */
export const SCAN_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
  'qr_code',
  'data_matrix',
] as const;

/** Detector formats → symbologies (variants a decoder may report included). */
const FORMAT_TYPES: Record<string, BarcodeType> = {
  ean_13: 'ean13',
  isbn: 'ean13',
  ean_8: 'ean8',
  upc_a: 'upca',
  upc_e: 'upce',
  code_128: 'code128',
  code_39: 'code39',
  code_39_standard: 'code39',
  code_39_extended: 'code39',
  itf: 'itf',
  itf_14: 'itf',
  qr_code: 'qr',
  qr_code_model_1: 'qr',
  qr_code_model_2: 'qr',
  data_matrix: 'dataMatrix',
};

/** The symbology of a detected format, or null for one a cell can't name (Detect then guesses). */
export function barcodeTypeOfFormat(format: string): BarcodeType | null {
  return Object.hasOwn(FORMAT_TYPES, format) ? (FORMAT_TYPES[format] ?? null) : null;
}

/**
 * Why the camera can't be asked for at all, before trying: browsers only offer getUserMedia in
 * a secure context (HTTPS or localhost), and some have no camera API.
 */
export function cameraUnavailable(): ScanProblem | null {
  if (typeof window === 'undefined' || window.isSecureContext === false) return 'insecure';
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return 'unsupported';
  return null;
}

/** The problem behind a getUserMedia refusal, by the DOMException's name. */
export function scanProblemOf(error: unknown): ScanProblem {
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'noCamera';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'busy';
    default:
      return 'failed';
  }
}

/** What a scan needs of a detector: BarcodeDetector's `detect`. */
export interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string; format: string }[]>;
}

interface NativeDetectorClass {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
}

/**
 * The browser's BarcodeDetector when it reads any of the formats, else the WebAssembly
 * fallback, loaded only now (a separate chunk and file, from the app's own origin).
 */
export async function createDetector(): Promise<Detector> {
  const Native = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
  if (typeof Native === 'function') {
    try {
      const supported = await Native.getSupportedFormats();
      const formats = SCAN_FORMATS.filter((f) => supported.includes(f));
      if (formats.length > 0) return new Native({ formats });
    } catch {
      // A BarcodeDetector that can't list its formats: use the fallback.
    }
  }
  const { fallbackDetector } = await import('./barcode-scan-fallback');
  return fallbackDetector([...SCAN_FORMATS]);
}

/** The back camera when there is one (phones), any camera otherwise; never the microphone. */
function requestCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' } },
  });
}

function stopTracks(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

/** How often a frame of the preview is read. */
export const SCAN_INTERVAL_MS = 150;

export interface ScanHandlers {
  /** The preview shows the camera and frames are being read. */
  onLive(): void;
  /** A code was read; the camera is already off. */
  onRead(read: ScanRead): void;
  /** The scan can't go on; the camera is already off. */
  onProblem(problem: ScanProblem): void;
}

/**
 * One scan: the camera's stream shown in a video element and read until a code comes up. Start
 * it from the Scan click itself, since some mobile browsers only grant the camera to a user
 * gesture. `close()` stops every track and drops the detector at any point; a stream that
 * arrives after it (the permission prompt was still open) is stopped at once. No handler is
 * called once closed.
 */
export class ScanSession {
  #handlers: ScanHandlers;
  #closed = false;
  #stream: MediaStream | null = null;
  #video: HTMLVideoElement | null = null;
  #detector: Detector | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(handlers: ScanHandlers) {
    this.#handlers = handlers;
  }

  /** Asks for the camera now (call it in the click handler) and loads the detector alongside. */
  static start(video: HTMLVideoElement, handlers: ScanHandlers): ScanSession {
    const session = new ScanSession(handlers);
    let camera: Promise<MediaStream>;
    try {
      camera = requestCamera();
    } catch (error) {
      camera = Promise.reject(error);
    }
    const detector = createDetector();
    // Settled in run(); this keeps an early camera refusal from leaving it unhandled.
    detector.catch(() => {});
    void session.#run(video, camera, detector);
    return session;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #run(video: HTMLVideoElement, camera: Promise<MediaStream>, detector: Promise<Detector>) {
    let stream: MediaStream;
    try {
      stream = await camera;
    } catch (error) {
      return this.#fail(scanProblemOf(error));
    }
    if (this.#closed) return stopTracks(stream);
    this.#stream = stream;
    try {
      this.#detector = await detector;
    } catch {
      return this.#fail('failed');
    }
    if (this.#closed) return;
    this.#video = video;
    video.srcObject = stream;
    // Muted inline video may autoplay; frames are read once it has one (readyState).
    video.play()?.catch(() => {});
    this.#handlers.onLive();
    void this.#tick();
  }

  async #tick() {
    const video = this.#video;
    const detector = this.#detector;
    if (this.#closed || !video || !detector) return;
    // HAVE_CURRENT_DATA: there is a frame to read.
    if (video.readyState >= 2) {
      let read: ScanRead | null = null;
      try {
        const code = (await detector.detect(video)).find((c) => c.rawValue !== '');
        if (code) read = { text: code.rawValue, type: barcodeTypeOfFormat(code.format) };
      } catch {
        // A frame that couldn't be read: try the next one.
      }
      if (this.#closed) return;
      if (read) {
        this.close();
        this.#handlers.onRead(read);
        return;
      }
    }
    this.#timer = setTimeout(() => void this.#tick(), SCAN_INTERVAL_MS);
  }

  #fail(problem: ScanProblem) {
    if (this.#closed) return;
    this.close();
    this.#handlers.onProblem(problem);
  }

  /** Stops the camera (every track) and the reading; safe to call more than once. */
  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    if (this.#stream) stopTracks(this.#stream);
    this.#stream = null;
    if (this.#video) {
      this.#video.pause();
      this.#video.srcObject = null;
    }
    this.#video = null;
    this.#detector = null;
  }
}
