/**
 * Service notices, the operator's command, in the worker's container (its DATABASE_URL,
 * SMTP_* and APP_URL):
 *
 *   node dist/notices/cli.js create --kind terms --title <t> --summary <s> --url <page>
 *                                   --effective <date> [--audience everyone|owners]
 *   node dist/notices/cli.js send <id> [--dry-run]
 *   node dist/notices/cli.js list
 *   node dist/notices/cli.js withdraw <id>
 *
 * `create` publishes the notice (its in-app banner shows at once) and refuses less notice than
 * the Terms promise (14 days for Terms, 30 for prices, 14 for plan limits). `send` emails every
 * account it concerns that hasn't had it yet, logging each email with the run's id; `--dry-run`
 * only counts them. Prints JSON (user ids, never addresses); exits 1 on failure, 2 on bad usage.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ConfigError, DEV_DEFAULTS, loadWorkerConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { smtpTransport } from '../email/transport.js';
import {
  type CreateNoticeInput,
  createNotice,
  NoticeError,
  noticeStatus,
  sendNotice,
  withdrawNotice,
} from './service.js';

const USAGE = `Usage:
  notices create --kind terms|privacy|price|plan|service --title <title> --summary <text>
                 --url <https page> --effective <YYYY-MM-DD> [--audience everyone|owners]
  notices send <id> [--dry-run]
  notices list
  notices withdraw <id>`;

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

let parsed: ReturnType<typeof parse>;
function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: 'string' },
      audience: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      url: { type: 'string' },
      effective: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
}
try {
  parsed = parse();
} catch {
  usage();
}
const { values, positionals } = parsed;
const [command, id, ...extra] = positionals;
if (extra.length > 0 || (id !== undefined && !z.uuid().safeParse(id).success)) usage();
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const { db, close } = createDb(process.env['DATABASE_URL'] ?? DEV_DEFAULTS.DATABASE_URL);
try {
  if (command === 'create' && !id) {
    out(
      await createNotice(db, {
        kind: values.kind as CreateNoticeInput['kind'],
        audience: values.audience as CreateNoticeInput['audience'],
        title: values.title ?? '',
        summary: values.summary ?? '',
        url: values.url ?? '',
        effective: values.effective ?? '',
      })
    );
  } else if (command === 'send' && id) {
    const config = loadWorkerConfig(process.env);
    const dryRun = values['dry-run'] === true;
    if (!dryRun && !config.smtp) {
      throw new ConfigError(['SMTP_HOST: not set, so the notice would not go out']);
    }
    const email = config.smtp
      ? smtpTransport(config.smtp, config.mailFrom)
      : { send: async () => {}, delivers: false };
    const result = await sendNotice(
      { db, email, appUrl: config.appUrl, log: (e) => console.error(JSON.stringify(e)) },
      id,
      { dryRun }
    );
    out(result);
    if (result.failed > 0) process.exitCode = 1;
  } else if (command === 'list' && !id) {
    out(await noticeStatus(db));
  } else if (command === 'withdraw' && id) {
    if (!(await withdrawNotice(db, id))) throw new NoticeError(`no live notice ${id}`);
    out({ id, withdrawn: true });
  } else {
    usage();
  }
} catch (err) {
  if (err instanceof ConfigError) console.error(err.issues.join('\n'));
  else if (err instanceof NoticeError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await close();
}
