import {
  BARCODE_TYPES,
  type BarcodeType,
  type BarcodeValue,
  guessBarcodeType,
  isValidBarcode,
} from '@openrows/shared';
import { ScanBarcode, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import {
  cameraUnavailable,
  SCAN_PROBLEM_MESSAGES,
  type ScanProblem,
  type ScanRead,
  ScanSession,
} from './barcode-scan';
import { type CellEditorProps, type EditorMove, EditorPopover, tabMove, useOnce } from './editors';
import { BARCODE_TYPE_LABELS } from './model';

function readValue(value: unknown): BarcodeValue | null {
  if (typeof value !== 'object' || value === null || !('text' in value)) return null;
  const v = value as { text?: unknown; type?: unknown };
  return typeof v.text === 'string' && typeof v.type === 'string'
    ? { text: v.text, type: v.type as BarcodeType }
    : null;
}

type ScanStatus = 'idle' | 'starting' | 'live';

/**
 * A camera scan's state for the editor. The camera is asked for only by `start` (the Scan
 * click), and stopped by `stop`/`cancel`, after a read or a problem, and when the editor
 * unmounts.
 */
function useBarcodeScan(onRead: (read: ScanRead) => void) {
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [problem, setProblem] = useState<ScanProblem | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const session = useRef<ScanSession | null>(null);
  const readRef = useRef(onRead);
  useEffect(() => {
    readRef.current = onRead;
  });
  const stop = useCallback(() => {
    session.current?.close();
    session.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const start = () => {
    stop();
    setProblem(null);
    const unavailable = cameraUnavailable();
    const video = videoRef.current;
    if (unavailable || !video) {
      setProblem(unavailable ?? 'failed');
      return;
    }
    setStatus('starting');
    session.current = ScanSession.start(video, {
      onLive: () => setStatus('live'),
      onRead: (read) => {
        session.current = null;
        setStatus('idle');
        readRef.current(read);
      },
      onProblem: (p) => {
        session.current = null;
        setStatus('idle');
        setProblem(p);
      },
    });
  };
  const cancel = () => {
    stop();
    setStatus('idle');
  };
  return { status, problem, videoRef, start, cancel, stop };
}

/**
 * The barcode editor: the code's text and its symbology. "Detect" picks the type a scanner
 * would report; a value that isn't valid for the chosen type (a wrong check digit, say) says so
 * and isn't saved. "Scan" reads a code with the device's camera into the same fields, checked
 * the same way; the camera is only asked for then, and is off again once the scan ends.
 */
export function BarcodeEditor({ field, value, initialText, onCommit, onCancel }: CellEditorProps) {
  const current = readValue(value);
  const [text, setText] = useState(initialText ?? current?.text ?? '');
  const [type, setType] = useState<BarcodeType | 'auto'>(
    initialText !== undefined ? 'auto' : (current?.type ?? 'auto')
  );
  // The last scan, and what the fields held before it (Discard puts that back).
  const [scanned, setScanned] = useState<{
    read: ScanRead;
    before: { text: string; type: BarcodeType | 'auto' };
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelScanRef = useRef<HTMLButtonElement>(null);
  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const scan = useBarcodeScan((read) => {
    setScanned({ read, before: { text, type } });
    setText(read.text);
    setType(read.type ?? 'auto');
    inputRef.current?.focus();
  });
  const scanning = scan.status !== 'idle';
  // Focus follows the scan: Cancel scan while it runs; Scan (which the message describes) when
  // it ended on a problem. A read or a cancel focuses the text field itself.
  const problem = scan.problem;
  useEffect(() => {
    if (scanning) cancelScanRef.current?.focus();
    else if (problem) scanButtonRef.current?.focus();
  }, [scanning, problem]);

  const once = useOnce();
  const trimmed = text.trim();
  const resolved = type === 'auto' ? guessBarcodeType(trimmed) : type;
  const valid = trimmed === '' || (resolved !== null && isValidBarcode(trimmed, resolved));
  const commit = (move: EditorMove) =>
    once(() => {
      scan.stop();
      if (trimmed === '') return onCommit({ value: null }, move);
      if (!valid || !resolved) {
        return onCommit({ error: `"${trimmed}" isn't a valid barcode of this type` }, move);
      }
      onCommit({ value: { text: trimmed, type: resolved } }, move);
    });
  const cancelScan = () => {
    scan.cancel();
    inputRef.current?.focus();
  };
  const discardScan = () => {
    if (!scanned) return;
    setText(scanned.before.text);
    setType(scanned.before.type);
    setScanned(null);
    inputRef.current?.focus();
  };

  const errorId = `barcode-${field.id}-error`;
  const problemId = `barcode-${field.id}-camera`;
  const status =
    scan.status === 'starting'
      ? 'Starting the camera…'
      : scan.status === 'live'
        ? 'Point the camera at a barcode or QR code.'
        : scanned
          ? scanned.read.type
            ? `Scanned a code: ${BARCODE_TYPE_LABELS[scanned.read.type]}.`
            : 'Scanned a code. Its type is detected from the text.'
          : '';
  return (
    <EditorPopover
      label={field.name}
      width={300}
      onOutside={() => commit('away')}
      onEscape={() => (scanning ? cancelScan() : once(onCancel))}
    >
      <div className="flex flex-col gap-2">
        <input
          // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose
          autoFocus
          ref={inputRef}
          aria-label={field.name}
          aria-invalid={!valid || undefined}
          aria-describedby={valid ? undefined : errorId}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setScanned(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit('stay');
            } else if (e.key === 'Tab') {
              e.preventDefault();
              commit(tabMove(e));
            }
          }}
          className="h-8 w-full rounded-sm border border-border bg-surface px-2 font-mono outline-none focus:border-brand aria-[invalid]:border-danger"
        />
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 text-small text-text-2">
            Type
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value as BarcodeType | 'auto');
                setScanned(null);
              }}
              className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-surface px-1.5 text-body text-text"
            >
              <option value="auto">
                Detect{type === 'auto' && resolved ? ` (${BARCODE_TYPE_LABELS[resolved]})` : ''}
              </option>
              {BARCODE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BARCODE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          {!scanning && (
            <Button
              ref={scanButtonRef}
              type="button"
              size="sm"
              variant="secondary"
              aria-label="Scan with camera"
              aria-describedby={scan.problem ? problemId : undefined}
              onClick={scan.start}
            >
              <ScanBarcode aria-hidden />
              Scan
            </Button>
          )}
        </div>
        {/* Always in the document so a scan can attach the stream inside the Scan click. */}
        <div hidden={!scanning} className="relative overflow-hidden rounded-sm bg-black">
          <video
            ref={scan.videoRef}
            aria-label="Camera preview"
            muted
            playsInline
            autoPlay
            className="aspect-[4/3] w-full object-cover"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-6 inset-y-8 rounded-md border-2 border-white/70"
          />
        </div>
        {scanning && (
          <Button
            ref={cancelScanRef}
            type="button"
            size="sm"
            variant="secondary"
            onClick={cancelScan}
          >
            <X aria-hidden />
            Cancel scan
          </Button>
        )}
        <p role="status" className={cn('text-small text-text-2', !status && 'sr-only')}>
          {status}
        </p>
        {scanned && !scanning && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={discardScan}
          >
            Discard scan
          </Button>
        )}
        {scan.problem && !scanning && (
          <p id={problemId} role="alert" className="text-small text-danger">
            {SCAN_PROBLEM_MESSAGES[scan.problem]}
          </p>
        )}
        {!valid && (
          <p id={errorId} role="alert" className="text-small text-danger">
            Not a valid {resolved ? BARCODE_TYPE_LABELS[resolved] : 'barcode'} value
          </p>
        )}
      </div>
    </EditorPopover>
  );
}
