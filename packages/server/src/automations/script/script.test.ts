import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { dockerRunArgs } from './local-container.js';
import { RUNNER_SOURCE } from './runner.js';
import { exitReason, type ScriptProcess, superviseScript } from './supervise.js';
import {
  type ScriptBridge,
  ScriptCallError,
  type ScriptLimits,
  type ScriptRequest,
} from './types.js';

const LIMITS: ScriptLimits = { timeoutSeconds: 10, cpuSeconds: 5, memoryMb: 128 };
const BASE = {
  id: 'b1',
  name: 'Ops',
  tables: [
    {
      id: '01a17db5-dd06-713a-bc40-74cc8eb80a47',
      name: 'Tasks',
      fields: [{ id: 'f1', name: 'Name', type: 'singleLineText' }],
    },
  ],
};
const request = (script: string, limits = LIMITS): ScriptRequest => ({
  script,
  config: { who: 'Ada' },
  base: BASE,
  limits,
});

/**
 * The runner in a plain local `node` child, for the API's behaviour only: tests here aren't
 * sandboxed (the escape suite runs the real container: automation-scripts.test.ts).
 */
function localRunner(): ScriptProcess {
  const child = spawn(
    process.execPath,
    ['--disallow-code-generation-from-strings', '-e', RUNNER_SOURCE],
    { stdio: ['pipe', 'pipe', 'pipe'], env: {} }
  );
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    stderr += c.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal }))
  );
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    exited,
    stderr: () => stderr,
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

/** A sandbox that prints what the test says and exits when told. */
function fakeProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let exit: (e: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    exit = r;
  });
  let killed = false;
  const proc: ScriptProcess = {
    stdin,
    stdout,
    exited,
    stderr: () => '',
    kill: async () => {
      killed = true;
      stdout.end();
      exit({ code: 137, signal: null });
    },
  };
  return {
    proc,
    print: (line: string) => stdout.write(`${line}\n`),
    exit: (code: number) => {
      stdout.end();
      exit({ code, signal: null });
    },
    killed: () => killed,
  };
}

describe('docker run arguments (#112)', () => {
  const args = dockerRunArgs({
    image: 'node:22@sha256:abc',
    runtime: 'runsc',
    name: 'openrows-script-1',
    limits: LIMITS,
    runnerSource: 'RUNNER',
  });
  const joined = args.join(' ');

  it('locks the container down', () => {
    for (const flag of [
      '--rm',
      '--network none',
      '--ipc none',
      '--read-only',
      '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=8m',
      '--user 65534:65534',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--runtime runsc',
      '--memory 128m',
      '--memory-swap 128m',
      '--cpus 1',
      '--pids-limit 32',
      '--ulimit cpu=5:6',
      '--ulimit nofile=64:64',
      '--ulimit core=0:0',
      '--pull never',
      '--log-driver none',
      '--disallow-code-generation-from-strings',
    ]) {
      expect(joined).toContain(flag);
    }
    expect(args.at(-2)).toBe('-e');
    expect(args.at(-1)).toBe('RUNNER');
  });

  it('passes nothing of the server: no env, mounts, devices or privileges', () => {
    for (const flag of [
      '-e ',
      '--env',
      '-v',
      '--volume',
      '--mount',
      '--device',
      '--privileged',
      'unconfined',
      '--cap-add',
      '--network host',
    ]) {
      expect(args.slice(0, -2).join(' ')).not.toContain(flag);
    }
  });
});

describe('the runner and its supervisor (#112)', () => {
  const answers: ScriptBridge = async (method, args) => {
    if (method === 'select') {
      return {
        records: [
          { id: 'r1', createdAt: 'c', updatedAt: 'u', fields: { Name: 'One', Tags: ['a'] } },
        ],
      };
    }
    if (method === 'create') return { ids: ['r2'] };
    if (method === 'fetch') {
      return {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ echo: args }),
      };
    }
    if (method === 'delete') throw new ScriptCallError('No such record.');
    return null;
  };

  it('runs the API: input, base, records, fetch, output and console', async () => {
    const calls: [string, unknown][] = [];
    const r = await superviseScript(
      localRunner(),
      request(`
        const { who } = input.config();
        const table = base.getTable('Tasks');
        const q = await table.selectRecordsAsync({ maxRecords: 5 });
        const first = q.records[0];
        const id = await table.createRecordAsync({ Name: 'Hi ' + who });
        await table.updateRecordAsync(first, { Name: 'Changed' });
        let refused = null;
        try { await table.deleteRecordAsync('r9'); } catch (e) { refused = e instanceof Error && e.message; }
        const res = await fetch('https://example.com/x', { method: 'POST', body: 'b' });
        console.warn('done', { id });
        output.set('first', first.getCellValue('Name'));
        output.set('tags', first.getCellValueAsString('Tags'));
        output.set('missing', first.getCellValue('Nope'));
        output.set('id', id);
        output.set('refused', refused);
        output.set('fetched', [res.ok, res.status, res.headers.get('Content-Type'), (await res.json()).echo.method]);
        output.set('field', table.getField('Name').type);
      `),
      async (method, args) => {
        calls.push([method, args]);
        return answers(method, args);
      }
    );
    expect(r.error).toBeNull();
    expect(r.output).toEqual({
      first: 'One',
      tags: '["a"]',
      missing: null,
      id: 'r2',
      refused: 'No such record.',
      fetched: [true, 201, 'application/json', 'POST'],
      field: 'singleLineText',
    });
    expect(r.logs).toEqual([{ level: 'warn', text: 'done {"id":"r2"}' }]);
    const tableId = BASE.tables[0]?.id;
    expect(calls.map(([m]) => m)).toEqual(['select', 'create', 'update', 'delete', 'fetch']);
    expect(calls[2]?.[1]).toEqual({
      tableId,
      records: [{ id: 'r1', fields: { Name: 'Changed' } }],
    });
  });

  it("fails with the script's own errors and its line", async () => {
    const r = await superviseScript(localRunner(), request("\n\nbase.getTable('Nope');"), answers);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('Error: No table "Nope" in this base. (line 3)');
    const syntax = await superviseScript(localRunner(), request('const = 1;'), answers);
    expect(syntax.error).toMatch(/^SyntaxError/);
  });

  it('stops at the wall clock', async () => {
    const r = await superviseScript(
      localRunner(),
      request('await new Promise(() => {});', { ...LIMITS, timeoutSeconds: 1 }),
      answers
    );
    expect(r.error).toBe('The script ran longer than 1 s.');
  });

  it('stops a sandbox that prints anything but the protocol, or too much', async () => {
    const junk = fakeProcess();
    const pending = superviseScript(junk.proc, request(''), answers);
    junk.print('hello');
    expect((await pending).error).toBe('The script wrote to the output stream directly.');
    expect(junk.killed()).toBe(true);

    const bad = fakeProcess();
    const p2 = superviseScript(bad.proc, request(''), answers);
    bad.print(JSON.stringify({ type: 'call', id: 1, method: 'shell', args: {} }));
    expect((await p2).error).toBe('The script sent a message the server could not read.');

    const flood = fakeProcess();
    const p3 = superviseScript(flood.proc, request(''), answers);
    const line = JSON.stringify({ type: 'log', level: 'log', text: 'x'.repeat(3000) });
    for (let i = 0; i < 3000 && !flood.killed(); i++) flood.print(line);
    expect((await p3).error).toBe('The script printed too much.');
  });

  it("rethrows the bridge's unexpected errors after stopping the sandbox", async () => {
    const f = fakeProcess();
    const pending = superviseScript(f.proc, request(''), async () => {
      throw new Error('database down');
    });
    f.print(JSON.stringify({ type: 'call', id: 1, method: 'select', args: {} }));
    await expect(pending).rejects.toThrow('database down');
    expect(f.killed()).toBe(true);
  });

  it('explains how a sandbox ended without a result', () => {
    const req = request('');
    expect(exitReason({ code: 134, signal: null }, 'FATAL ERROR: heap out of memory', req)).toBe(
      'The script used more than 128 MB of memory.'
    );
    expect(exitReason({ code: 152, signal: null }, '', req)).toBe(
      'The script used more than 5 s of CPU time.'
    );
    expect(exitReason({ code: 137, signal: null }, '', req)).toMatch(/128 MB of memory or 5 s/);
    expect(exitReason({ code: 1, signal: null }, '', req)).toBe(
      'The script stopped unexpectedly (exit code 1).'
    );
  });
});
