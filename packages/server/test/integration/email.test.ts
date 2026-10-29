import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendTestEmail } from '../../src/email/send-test.js';
import { invitationEmail } from '../../src/email/templates.js';
import { smtpTransport } from '../../src/email/transport.js';
import { MAILPIT_IMAGE } from '../helpers/images.js';

describe('SMTP transport against Mailpit', () => {
  let mailpit: StartedTestContainer;
  let api: string;
  let smtpHost: string;

  beforeAll(async () => {
    mailpit = await new GenericContainer(MAILPIT_IMAGE)
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/livez', 8025))
      .start();
    // getMappedPort() returns the binding for the first address getHost() resolves to (::1 or
    // 127.0.0.1), and Docker may map IPv4 and IPv6 to different host ports, so dial that same
    // address: a fixed 127.0.0.1, or "localhost" resolved again by a client, can land on another
    // container port (Mailpit's POP3 on a host where localhost is ::1 first).
    const { address, family } = await lookup(mailpit.getHost());
    smtpHost = address;
    const httpHost = family === 6 ? `[${address}]` : address;
    api = `http://${httpHost}:${mailpit.getMappedPort(8025)}/api/v1`;
  });
  afterAll(async () => {
    await mailpit?.stop();
  });

  it('delivers an escaped invitation', async () => {
    const transport = smtpTransport(
      {
        host: smtpHost,
        port: mailpit.getMappedPort(1025),
        secure: false,
        requireTls: false,
        user: undefined,
        password: undefined,
      },
      'OpenRows <no-reply@openrows.test>'
    );
    await transport.send({
      to: 'invitee@example.test',
      ...invitationEmail({
        inviterName: 'Eve <b>',
        workspaceName: 'Q4 <script>',
        acceptUrl: 'https://app.openrows.test/invitations/1',
      }),
    });

    const list = (await (await fetch(`${api}/messages`)).json()) as {
      messages: { ID: string; Subject: string; To: { Address: string }[] }[];
    };
    expect(list.messages).toHaveLength(1);
    const [msg] = list.messages;
    expect(msg?.To[0]?.Address).toBe('invitee@example.test');
    expect(msg?.Subject).toBe('Eve <b> invited you to Q4 <script> on OpenRows');
    const full = (await (await fetch(`${api}/message/${msg?.ID}`)).json()) as {
      HTML: string;
      Text: string;
    };
    expect(full.HTML).toContain('Q4 &lt;script&gt;');
    expect(full.HTML).not.toContain('<script>');
    expect(full.Text).toContain('https://app.openrows.test/invitations/1');
  });

  type Listed = {
    messages: {
      ID: string;
      Subject: string;
      From: { Address: string; Name: string };
      To: { Address: string }[];
    }[];
  };
  const messagesTo = async (address: string) =>
    ((await (await fetch(`${api}/messages`)).json()) as Listed).messages.filter(
      (m) => m.To[0]?.Address === address
    );
  const env = () => ({
    SMTP_HOST: smtpHost,
    SMTP_PORT: String(mailpit.getMappedPort(1025)),
    SMTP_FROM: 'OpenRows <noreply@openrows.test>',
    APP_URL: 'https://app.openrows.test',
  });

  it("sends the operator's test email and reports the relay's answer (#136)", async () => {
    const result = await sendTestEmail(env(), 'ops@example.test');
    expect(result).toMatchObject({
      to: 'ops@example.test',
      from: 'OpenRows <noreply@openrows.test>',
      host: smtpHost,
      tls: 'opportunistic',
      receipt: { accepted: ['ops@example.test'], rejected: [] },
    });
    expect(result.receipt.response).toMatch(/^250 /);
    const [msg, ...more] = await messagesTo('ops@example.test');
    expect(more).toEqual([]);
    expect(msg?.Subject).toMatch(/test email$/);
    expect(msg?.From).toEqual({ Address: 'noreply@openrows.test', Name: 'OpenRows' });
  });

  it('fails closed with SMTP_SECURE=starttls when the server offers no STARTTLS (#136)', async () => {
    await expect(
      sendTestEmail({ ...env(), SMTP_SECURE: 'starttls' }, 'tls-only@example.test')
    ).rejects.toThrow(/STARTTLS/i);
    expect(await messagesTo('tls-only@example.test')).toEqual([]);
  });

  it('the CLI prints the receipt, and exits 1 or 2 when nothing was sent (#136)', async () => {
    const cli = fileURLToPath(new URL('../../src/email/send-test-cli.ts', import.meta.url));
    const run = (args: string[], extra: Record<string, string> = {}) =>
      promisify(execFile)(process.execPath, ['--import', 'tsx', cli, ...args], {
        env: { PATH: process.env['PATH'] ?? '', ...extra },
      }).then(
        ({ stdout }) => ({ code: 0, stdout, stderr: '' }),
        (err: { code: number; stdout: string; stderr: string }) => err
      );

    const ok = await run(['cli@example.test'], env());
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ to: 'cli@example.test' });
    expect(await messagesTo('cli@example.test')).toHaveLength(1);

    const unset = await run(['cli@example.test']);
    expect(unset).toMatchObject({ code: 1, stderr: expect.stringContaining('SMTP_HOST: not set') });
    expect(await run([])).toMatchObject({ code: 2 });
  });
});
