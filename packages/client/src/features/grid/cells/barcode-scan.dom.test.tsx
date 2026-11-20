import type { FieldMeta } from '@openrows/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCAN_PROBLEM_MESSAGES } from './barcode-scan';
import { fallbackDetector } from './barcode-scan-fallback';
import { CellEditor } from './editors';

// Scanning in the barcode editor, with the camera and the detector faked: no real camera, no
// WebAssembly. The fallback decoder module is replaced so a test can see it was chosen.
vi.mock('./barcode-scan-fallback', () => ({ fallbackDetector: vi.fn() }));

const field: FieldMeta = {
  id: '0190a000-0000-7000-8000-000000000b01',
  tableId: '0190a000-0000-7000-8000-000000000999',
  name: 'Code',
  description: null,
  type: 'barcode',
  options: {},
  isPrimary: false,
  position: 1,
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  deletedAt: null,
};

type Code = { rawValue: string; format: string };

/** A camera whose stream has one video track; `pending` holds getUserMedia until `grant`. */
function fakeCamera({ pending = false } = {}) {
  const track = { kind: 'video', stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  let grant: () => void = () => {};
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        grant = () => resolve(stream);
        if (!pending) grant();
      })
  );
  setMediaDevices({ getUserMedia });
  return { getUserMedia, track, grant: () => act(async () => grant()) };
}

function refusingCamera(name: string) {
  const getUserMedia = vi.fn(() => Promise.reject(Object.assign(new Error('refused'), { name })));
  setMediaDevices({ getUserMedia });
  return getUserMedia;
}

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true });
}

/** A detector reading `reads` in turn, one per frame, then nothing. */
function fakeDetector(reads: Code[][]) {
  const queue = [...reads];
  return { detect: vi.fn(async () => queue.shift() ?? []) };
}

/** The browser's BarcodeDetector, made from a fake detector. */
function nativeDetector(detector: ReturnType<typeof fakeDetector>, supported?: string[]) {
  const Native = vi.fn(function (this: unknown) {
    return detector;
  });
  Object.assign(Native, {
    getSupportedFormats: vi.fn(
      async () =>
        supported ?? ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code']
    ),
  });
  Object.defineProperty(globalThis, 'BarcodeDetector', { value: Native, configurable: true });
  return Native;
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no media playback: a video "plays" at once and always has a frame.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    value: () => Promise.resolve(),
    configurable: true,
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    value: () => {},
    configurable: true,
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    get: () => 4,
    configurable: true,
  });
});

beforeEach(() => {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
  Reflect.deleteProperty(globalThis, 'BarcodeDetector');
  vi.mocked(fallbackDetector).mockReset();
});

function edit(value: unknown = null) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <div style={{ position: 'relative', width: 200, height: 34 }}>
      <CellEditor
        field={field}
        value={value}
        align="left"
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
  return { onCommit, onCancel, unmount: view.unmount, user: userEvent.setup() };
}

const input = () => screen.getByRole('textbox', { name: 'Code' }) as HTMLInputElement;
const typeSelect = () => screen.getByRole('combobox') as HTMLSelectElement;
const scanButton = () => screen.getByRole('button', { name: 'Scan with camera' });
const status = () => screen.getByRole('status');

describe('scanning a barcode with the camera', () => {
  it('asks for the camera only on Scan, fills the code and its type, and turns the camera off', async () => {
    const camera = fakeCamera();
    const detector = fakeDetector([[], [{ rawValue: '4006381333931', format: 'ean_13' }]]);
    nativeDetector(detector);
    const { user, onCommit } = edit();

    // Opening the editor doesn't touch the camera.
    expect(camera.getUserMedia).not.toHaveBeenCalled();
    expect(scanButton()).toBeTruthy();

    await user.click(scanButton());
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
    expect(camera.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    });
    await waitFor(() => expect(status().textContent).toBe('Scanned a code: EAN-13.'));
    expect(input().value).toBe('4006381333931');
    expect(typeSelect().value).toBe('ean13');
    expect(screen.queryByRole('alert')).toBeNull();
    // The read ended the scan: every track stopped, the preview gone, the field focused.
    expect(camera.track.stop).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Cancel scan' })).toBeNull();
    expect(document.activeElement).toBe(input());

    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(
      { value: { text: '4006381333931', type: 'ean13' } },
      'stay'
    );
  });

  it('shows the preview and a Cancel scan control while scanning', async () => {
    const camera = fakeCamera();
    nativeDetector(fakeDetector([]));
    const { user, onCancel } = edit();
    await user.click(scanButton());
    const cancel = await screen.findByRole('button', { name: 'Cancel scan' });
    expect(document.activeElement).toBe(cancel);
    await waitFor(() =>
      expect(status().textContent).toBe('Point the camera at a barcode or QR code.')
    );
    const video = screen.getByLabelText('Camera preview') as HTMLVideoElement;
    expect(video.closest('[hidden]')).toBeNull();
    expect(video.muted).toBe(true);

    await user.click(cancel);
    expect(camera.track.stop).toHaveBeenCalled();
    expect(video.closest('[hidden]')).not.toBeNull();
    expect(video.srcObject).toBeNull();
    expect(document.activeElement).toBe(input());
    // Back to typing, the editor still open.
    expect(onCancel).not.toHaveBeenCalled();
    await user.type(input(), '96385074');
    expect(typeSelect().selectedOptions[0]?.textContent).toBe('Detect (EAN-8)');
  });

  it('shows an invalid read like an invalid typed value, and lets the user scan again', async () => {
    const camera = fakeCamera();
    nativeDetector(
      fakeDetector([
        [{ rawValue: '4006381333932', format: 'ean_13' }],
        [{ rawValue: 'ABC-123', format: 'code_39' }],
      ])
    );
    const { user, onCommit } = edit();
    await user.click(scanButton());
    await waitFor(() => expect(input().value).toBe('4006381333932'));
    expect(typeSelect().value).toBe('ean13');
    expect(screen.getByRole('alert').textContent).toBe('Not a valid EAN-13 value');
    expect(input().getAttribute('aria-invalid')).toBe('true');

    // Scan again, in the same editor: a new camera request, a valid read.
    await user.click(scanButton());
    await waitFor(() => expect(input().value).toBe('ABC-123'));
    expect(camera.getUserMedia).toHaveBeenCalledTimes(2);
    expect(typeSelect().value).toBe('code39');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith({ value: { text: 'ABC-123', type: 'code39' } }, 'stay');
  });

  it('refuses to save an invalid read, like a typed one', async () => {
    fakeCamera();
    nativeDetector(fakeDetector([[{ rawValue: '4006381333932', format: 'ean_13' }]]));
    const { user, onCommit } = edit();
    await user.click(scanButton());
    await waitFor(() => expect(input().value).toBe('4006381333932'));
    await user.keyboard('{Enter}');
    expect(onCommit.mock.calls[0]?.[0]).toHaveProperty('error');
  });

  it('discards a read, putting back what was there, and allows editing the text by hand', async () => {
    fakeCamera();
    nativeDetector(
      fakeDetector([
        [{ rawValue: '0123456789', format: 'itf' }],
        [{ rawValue: '01234567', format: 'other' }],
      ])
    );
    const { user, onCommit } = edit({ text: '96385074', type: 'ean8' });
    await user.click(scanButton());
    await waitFor(() => expect(input().value).toBe('0123456789'));
    expect(typeSelect().value).toBe('itf');
    await user.click(screen.getByRole('button', { name: 'Discard scan' }));
    expect(input().value).toBe('96385074');
    expect(typeSelect().value).toBe('ean8');

    // A format a cell can't name: Detect picks the type from the text, which can be edited.
    await user.click(scanButton());
    await waitFor(() => expect(input().value).toBe('01234567'));
    expect(typeSelect().value).toBe('auto');
    expect(status().textContent).toBe('Scanned a code. Its type is detected from the text.');
    await user.clear(input());
    await user.type(input(), '4006381333931{Enter}');
    expect(screen.queryByRole('button', { name: 'Discard scan' })).toBeNull();
    expect(onCommit).toHaveBeenCalledWith(
      { value: { text: '4006381333931', type: 'ean13' } },
      'stay'
    );
  });

  it('discards a second scan back to the value from before the first', async () => {
    fakeCamera();
    nativeDetector(
      fakeDetector([
        [{ rawValue: '4006381333932', format: 'ean_13' }],
        [{ rawValue: 'ABC-123', format: 'code_39' }],
      ])
    );
    const { user, onCommit } = edit({ text: '96385074', type: 'ean8' });
    await user.click(scanButton());
    await waitFor(() => expect(input().value).toBe('4006381333932'));
    await user.click(scanButton());
    await waitFor(() => expect(input().value).toBe('ABC-123'));
    await user.click(screen.getByRole('button', { name: 'Discard scan' }));
    expect(input().value).toBe('96385074');
    expect(typeSelect().value).toBe('ean8');
    expect(screen.queryByRole('button', { name: 'Discard scan' })).toBeNull();
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith({ value: { text: '96385074', type: 'ean8' } }, 'stay');
  });

  it('uses the fallback decoder where the browser has no BarcodeDetector', async () => {
    fakeCamera();
    const detector = fakeDetector([
      [{ rawValue: 'https://example.org/item/42', format: 'qr_code' }],
    ]);
    vi.mocked(fallbackDetector).mockResolvedValue(detector);
    const { user } = edit();
    await user.click(scanButton());
    await waitFor(() => expect(input().value).toBe('https://example.org/item/42'));
    expect(typeSelect().value).toBe('qr');
    expect(fallbackDetector).toHaveBeenCalledWith([
      'ean_13',
      'ean_8',
      'upc_a',
      'upc_e',
      'code_128',
      'code_39',
      'itf',
      'qr_code',
      'data_matrix',
    ]);
  });

  it('uses the fallback when the BarcodeDetector reads none of the formats', async () => {
    fakeCamera();
    const native = nativeDetector(fakeDetector([]), ['aztec']);
    vi.mocked(fallbackDetector).mockResolvedValue(
      fakeDetector([[{ rawValue: '96385074', format: 'ean_8' }]])
    );
    const { user } = edit();
    await user.click(scanButton());
    await waitFor(() => expect(typeSelect().value).toBe('ean8'));
    expect(native).not.toHaveBeenCalled();
  });

  it('asks the native detector only for the formats it supports', async () => {
    fakeCamera();
    const native = nativeDetector(
      fakeDetector([[{ rawValue: '4006381333931', format: 'ean_13' }]]),
      ['qr_code', 'ean_13', 'pdf417']
    );
    const { user } = edit();
    await user.click(scanButton());
    await waitFor(() => expect(typeSelect().value).toBe('ean13'));
    expect(native).toHaveBeenCalledWith({ formats: ['ean_13', 'qr_code'] });
    expect(fallbackDetector).not.toHaveBeenCalled();
  });
});

describe('when the camera cannot be used', () => {
  it('says the camera was blocked (NotAllowedError) and keeps typing available', async () => {
    const getUserMedia = refusingCamera('NotAllowedError');
    nativeDetector(fakeDetector([]));
    const { user, onCommit } = edit();
    await user.click(scanButton());
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(SCAN_PROBLEM_MESSAGES.denied);
    expect(scanButton().getAttribute('aria-describedby')).toBe(alert.id);
    expect(screen.queryByRole('button', { name: 'Cancel scan' })).toBeNull();

    await user.type(input(), '4006381333931{Enter}');
    expect(onCommit).toHaveBeenCalledWith(
      { value: { text: '4006381333931', type: 'ean13' } },
      'stay'
    );
  });

  it('keeps focus on Scan when scanning again is refused again', async () => {
    const getUserMedia = refusingCamera('NotAllowedError');
    nativeDetector(fakeDetector([]));
    const { user } = edit();
    await user.click(scanButton());
    await screen.findByRole('alert');
    expect(document.activeElement).toBe(scanButton());
    await user.click(scanButton());
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.activeElement).toBe(scanButton()));
    expect(screen.getByRole('alert').textContent).toBe(SCAN_PROBLEM_MESSAGES.denied);
  });

  it('says there is no camera (NotFoundError)', async () => {
    refusingCamera('NotFoundError');
    nativeDetector(fakeDetector([]));
    const { user } = edit();
    await user.click(scanButton());
    expect((await screen.findByRole('alert')).textContent).toBe(SCAN_PROBLEM_MESSAGES.noCamera);
    expect(input().disabled).toBe(false);
  });

  it('says the browser has no camera API, without asking for anything', async () => {
    setMediaDevices(undefined);
    const { user, onCommit } = edit();
    await user.click(scanButton());
    expect(screen.getByRole('alert').textContent).toBe(SCAN_PROBLEM_MESSAGES.unsupported);
    await user.type(input(), '96385074{Enter}');
    expect(onCommit).toHaveBeenCalledWith({ value: { text: '96385074', type: 'ean8' } }, 'stay');
  });

  it('says the page needs a secure connection, without asking for the camera', async () => {
    const camera = fakeCamera();
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const { user } = edit();
    await user.click(scanButton());
    expect(screen.getByRole('alert').textContent).toBe(SCAN_PROBLEM_MESSAGES.insecure);
    expect(camera.getUserMedia).not.toHaveBeenCalled();
    await user.type(input(), 'ABC');
    expect(input().value).toBe('ABC');
  });

  it("says the scanner couldn't start when the decoder doesn't load, and turns the camera off", async () => {
    const camera = fakeCamera();
    vi.mocked(fallbackDetector).mockRejectedValue(new Error('no decoder'));
    const { user } = edit();
    await user.click(scanButton());
    expect((await screen.findByRole('alert')).textContent).toBe(SCAN_PROBLEM_MESSAGES.failed);
    expect(camera.track.stop).toHaveBeenCalled();
    expect(document.activeElement).toBe(scanButton());
  });
});

describe('closing the editor turns the camera off', () => {
  async function scanning() {
    const camera = fakeCamera();
    const detector = fakeDetector([]);
    nativeDetector(detector);
    const editor = edit();
    await editor.user.click(scanButton());
    await waitFor(() => expect(detector.detect).toHaveBeenCalled());
    expect(camera.track.stop).not.toHaveBeenCalled();
    return { ...editor, camera, detector };
  }

  it('on Enter (commit)', async () => {
    const { user, camera, onCommit } = await scanning();
    input().focus();
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith({ value: null }, 'stay');
    expect(camera.track.stop).toHaveBeenCalled();
  });

  it('on Escape: the first ends the scan, the second closes the editor', async () => {
    const { user, camera, onCancel } = await scanning();
    await user.keyboard('{Escape}');
    expect(camera.track.stop).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });

  it('on a click outside', async () => {
    const { user, camera, onCommit } = await scanning();
    await user.click(document.body);
    expect(onCommit).toHaveBeenCalledWith({ value: null }, 'away');
    expect(camera.track.stop).toHaveBeenCalled();
  });

  it('on unmount, and stops reading frames', async () => {
    const { camera, detector, unmount } = await scanning();
    unmount();
    expect(camera.track.stop).toHaveBeenCalled();
    const reads = detector.detect.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(detector.detect.mock.calls.length).toBe(reads);
  });

  it('when Scan is cancelled before the camera answers: the late stream is stopped at once', async () => {
    const camera = fakeCamera({ pending: true });
    const detector = fakeDetector([]);
    nativeDetector(detector);
    const { user } = edit();
    await user.click(scanButton());
    await user.click(screen.getByRole('button', { name: 'Cancel scan' }));
    await camera.grant();
    expect(camera.track.stop).toHaveBeenCalled();
    expect(detector.detect).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Camera preview') as HTMLVideoElement).srcObject ?? null).toBe(
      null
    );
  });

  it('when the editor closes before the camera answers', async () => {
    const camera = fakeCamera({ pending: true });
    nativeDetector(fakeDetector([]));
    const { user, unmount } = edit();
    await user.click(scanButton());
    unmount();
    await camera.grant();
    expect(camera.track.stop).toHaveBeenCalled();
  });
});
