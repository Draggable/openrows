import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script without types
import { checkBrandName } from './check-brand-name.mjs';

type Problem = { file: string; line: number; column: number; found: string; message: string };
const check = checkBrandName as (root: string) => Problem[];

const repo = resolve(import.meta.dirname, '..');
let root: string;

function write(path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function fixture() {
  root = mkdtempSync(join(tmpdir(), 'openrows-brand-'));
  write('README.md', '# OpenRows\n\nOpenRows runs at https://app.openrows.io.\n');
}

/** The problems of one file written into a fresh fixture. */
function problemsOf(path: string, text: string) {
  fixture();
  write(path, text);
  return check(root);
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('the brand name check (#141)', () => {
  it('passes on this repository', () => {
    expect(check(repo)).toEqual([]);
  });

  it('passes a fixture that writes "OpenRows"', () => {
    fixture();
    expect(check(root)).toEqual([]);
  });

  describe('Markdown prose', () => {
    it.each([
      ['# openrows\n', 1, 3],
      ['Self-host openrows on your server.\n', 1, 11],
      ['Sent by openrows.\n', 1, 9],
      ['openrows: the open-source Airtable alternative\n', 1, 1],
      ['Text\n\nWelcome to Openrows, OPENROWS and (openrows)\n', 3, 12],
      ['| Name | openrows |\n', 1, 10],
      ['```sh\nnpm ci\n```\n\nThen openrows starts.\n', 5, 6],
    ])('flags %j', (text, line, column) => {
      const problems = problemsOf('docs/guide/x.md', text);
      expect(problems[0]).toMatchObject({ file: 'docs/guide/x.md', line, column });
      expect(problems[0]?.message).toContain('"OpenRows"');
    });

    it('flags every misspelling on a line', () => {
      expect(
        problemsOf('docs/x.md', 'Welcome to Openrows, OPENROWS and (openrows)\n').map(
          (p) => p.found
        )
      ).toEqual(['Openrows', 'OPENROWS', 'openrows']);
    });

    it.each([
      ['identifiers', 'Go to openrows.io, app.openrows.io or www.openrows.io/docs.\n'],
      ['packages', 'Install @openrows/sdk, openrows-mcp-server and n8n-nodes-openrows.\n'],
      ['names in code', 'The role openrows_app, schema b_openrows, tag openrows:sha-1.\n'],
      ['env vars', 'Set OPENROWS_URL and OPENROWS_API_KEY.\n'],
      ['paths', 'See docker/keycloak/themes/openrows/login and /srv/openrows/.env.\n'],
      ['inline code', 'Realm `openrows`, client `openrows-app`, ``openrows`` too.\n'],
      ['wrapped inline code', 'Run `claude mcp add\nopenrows --env X` first.\n'],
      ['fenced code', '```sh\ndocker compose -p openrows up\n```\n\n~~~\nopenrows\n~~~\n'],
      [
        'link targets',
        'The [repository](https://github.com/Draggable/openrows) and <https://x/openrows>.\n',
      ],
      ['HTML comments', '<!-- openrows -->\n'],
    ])('allows %s', (_, text) => {
      expect(problemsOf('docs/x.md', text)).toEqual([]);
    });

    it('checks README.md anywhere and the root *.md, not other Markdown', () => {
      fixture();
      write('packages/sdk/README.md', 'The openrows SDK.\n');
      write('CONTRIBUTING.md', 'Welcome to openrows.\n');
      write('packages/sdk/CHANGELOG.md', 'openrows 1.0\n');
      write('legacy/README.md', 'openrows prototype\n');
      expect(check(root).map((p) => p.file)).toEqual(['CONTRIBUTING.md', 'packages/sdk/README.md']);
    });
  });

  describe('client components', () => {
    it.each([
      ['JSX text', '<p>Welcome to openrows</p>'],
      ['JSX text before an expression', '<p>Use openrows {name}</p>'],
      ['aria-label', '<a aria-label="openrows home" href="/" />'],
      ['alt', "<img alt={'openrows logo'} src={src} />"],
      ['title', '<Notice title={`About openrows`} />'],
      ['placeholder', '<input placeholder="Search openrows" />'],
      ['a toast', "toast.success('Copied to openrows');"],
      ['the page title', 'document.title = `Tasks · openrows`;'],
    ])('flags %s', (_, code) => {
      const problems = problemsOf(
        'packages/client/src/app/X.tsx',
        `export const x = 1;\n${code}\n`
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ file: 'packages/client/src/app/X.tsx', line: 2 });
    });

    it.each([
      ['storage keys', "const KEY = 'openrows-theme';\nconst E = 'openrows:airtable-watch';"],
      ['URLs', '<a href="https://openrows.io">OpenRows</a>'],
      ['code samples', '<Pre>{`const openrows = new OpenRows();\nclaude mcp add openrows`}</Pre>'],
      ['comments', '/** The "Made with openrows" credit. */\n{/* openrows */}'],
      ['the name itself', '<p>Made with OpenRows</p>'],
    ])('allows %s', (_, code) => {
      expect(problemsOf('packages/client/src/app/X.tsx', `${code}\n`)).toEqual([]);
    });

    it('skips tests', () => {
      expect(problemsOf('packages/client/src/app/X.dom.test.tsx', '<p>openrows</p>\n')).toEqual([]);
    });
  });

  it.each([
    ['packages/client/index.html', '<head>\n<title>openrows</title>\n</head>\n'],
    ['packages/client/index.html', '<meta property="og:title" content="openrows" />\n'],
    ['packages/client/public/site.webmanifest', '{ "name": "openrows" }\n'],
    ['packages/client/public/favicon.svg', '<svg><title>openrows</title></svg>\n'],
    ['docs/design/brand/logo-mark.svg', '<svg><title>openrows</title></svg>\n'],
    [
      'docker/keycloak/themes/openrows/login/messages/messages_en.properties',
      'loginTitle=openrows\n',
    ],
    ['docker/keycloak/themes/openrows/email/html/template.ftl', '<p>Sent by openrows.</p>\n'],
    ['packages/server/src/email/templates.ts', 'const subject = `Your openrows digest`;\n'],
    ['packages/server/src/workspaces/service.ts', "await send({ subject: 'Hi from openrows' });\n"],
    ['packages/server/src/docs/llms.ts', 'export const x = `# openrows`;\n'],
  ])('flags %s', (file, text) => {
    expect(problemsOf(file, text).map((p) => p.file)).toEqual([file]);
  });

  it.each([
    ['packages/client/index.html', '<link rel="icon" href="/openrows.svg" />\n'],
    ['packages/server/src/email/templates.ts', "import { BRAND } from '@openrows/shared';\n"],
    ['packages/server/src/auth/crypto.ts', "hkdfSync('sha256', secret, 'openrows', 'x', 32);\n"],
    ['packages/server/src/main.ts', "logger.info('openrows server listening');\n"],
    ['docker/keycloak/openrows-realm.json', '{ "realm": "openrows" }\n'],
    ['ee/site/src/page.ts', '<h1>openrows</h1>\n'],
    ['ee/site/README.md', 'The openrows site.\n'],
  ])('leaves %s alone', (file, text) => {
    expect(problemsOf(file, text)).toEqual([]);
  });

  it('runs on a tree without the hosted edition', () => {
    fixture();
    expect(check(root)).toEqual([]);
  });

  it('exits 1 with file:line:column on a problem, 0 when clean', () => {
    const script = join(import.meta.dirname, 'check-brand-name.mjs');
    fixture();
    expect(spawnSync(process.execPath, [script, root], { encoding: 'utf8' }).status).toBe(0);
    write('docs/x.md', 'Hello\nopenrows\n');
    const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('docs/x.md:2:1: "openrows"');
  });
});
