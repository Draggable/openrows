import { BRAND, BRAND_COLOR, type NoticeKind } from '@openrows/shared';
import { html, type SafeHtml, safeUrl } from './html.js';
import { markdownEmailHtml } from './markdown.js';

/** A rendered message: subject, HTML and a plain-text alternative. */
export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

/** The Content-ID of the rose mark the transport attaches inline (email/logo.ts). */
export const EMAIL_LOGO_CID = 'logo@openrows';

/** The rose (#E22651) for buttons, a darker shade for links on white (WCAG AA). */
const ROSE = BRAND_COLOR;
const LINK = '#C91143';

/** Every email's frame: a rose top bar, the mark and wordmark, the body and a footer. */
function layout(title: string, body: SafeHtml): string {
  return html`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body style="font-family: Inter, system-ui, sans-serif; color: #1C1719; background: #FAF7F5; margin: 0; padding: 24px 12px;">
    <div style="max-width: 560px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E8E2DD; border-top: 3px solid ${ROSE}; border-radius: 8px; padding: 24px;">
      <p style="margin: 0 0 20px; font-size: 17px; font-weight: 700; letter-spacing: -0.01em;"><img src="cid:${EMAIL_LOGO_CID}" width="24" height="24" alt="" style="vertical-align: -5px; margin-right: 8px; border: 0;">${BRAND}</p>
      ${body}
    </div>
    <p style="max-width: 560px; margin: 16px auto 0; color: #6E6468; font-size: 12px;">Sent by ${BRAND}.</p>
  </body>
</html>`.value;
}

function button(href: string, label: string) {
  const url = safeUrl(href);
  if (!url) throw new Error('email link must be an http(s) URL');
  return html`<p><a href="${url}" style="display: inline-block; padding: 10px 16px; background: ${ROSE}; color: #FFFFFF; border-radius: 6px; font-weight: 600; text-decoration: none;">${label}</a></p>`;
}

/** Invitation to a workspace; the link is `${APP_URL}/invite/<token>`. */
export function invitationEmail(p: {
  inviterName: string;
  workspaceName: string;
  /** A base invitation: the invitee joins this base only. */
  baseName?: string | undefined;
  /** An interface invitation: the invitee gets this interface only. */
  interfaceName?: string | undefined;
  acceptUrl: string;
}): EmailContent {
  const target = p.interfaceName ?? p.baseName ?? p.workspaceName;
  const subject = `${p.inviterName} invited you to ${target} on ${BRAND}`;
  const what =
    p.interfaceName !== undefined
      ? html`the interface <strong>${p.interfaceName}</strong> in ${p.workspaceName}`
      : p.baseName !== undefined
        ? html`the base <strong>${p.baseName}</strong> in ${p.workspaceName}`
        : html`the workspace <strong>${p.workspaceName}</strong>`;
  const whatText =
    p.interfaceName !== undefined
      ? `the interface "${p.interfaceName}" in ${p.workspaceName}`
      : p.baseName !== undefined
        ? `the base "${p.baseName}" in ${p.workspaceName}`
        : `the workspace "${p.workspaceName}"`;
  return {
    subject,
    html: layout(
      subject,
      html`<h1 style="font-size: 20px;">You're invited</h1>
    <p>${p.inviterName} invited you to ${what}.</p>
    ${button(p.acceptUrl, 'Accept invitation')}`
    ),
    text: `${p.inviterName} invited you to ${whatText} on ${BRAND}.\n\nAccept: ${p.acceptUrl}\n`,
  };
}

/** One notification in a notification email. */
export interface NotificationEmailItem {
  kind: 'mention' | 'reply' | 'assigned';
  actorName: string;
  /** The comment's plain-text excerpt (mentions and replies). */
  excerpt: string | null;
  /** The user field (assignments). */
  fieldName: string | null;
}

/** Most notifications one email lists; the rest are "and N more". */
export const NOTIFICATION_EMAIL_MAX_ITEMS = 10;

function itemLine(item: NotificationEmailItem): string {
  if (item.kind === 'mention') return `${item.actorName} mentioned you`;
  if (item.kind === 'reply') return `${item.actorName} replied`;
  return item.fieldName
    ? `${item.actorName} added you to ${item.fieldName}`
    : `${item.actorName} assigned you`;
}

/**
 * Notifications about one record, coalesced. Holds nothing from the record but its name and
 * the comment excerpts; every value is escaped. The footer links to the preferences and to a
 * one-click unsubscribe (signed token).
 */
export function notificationEmail(p: {
  recordName: string;
  baseName: string;
  items: readonly NotificationEmailItem[];
  recordUrl: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
}): EmailContent {
  const record = p.recordName.trim() || 'Unnamed record';
  const first = p.items[0];
  if (!first) throw new Error('notification email without notifications');
  const subject =
    p.items.length === 1
      ? `${itemLine(first)} on ${record}`
      : `${p.items.length} new notifications on ${record}`;
  const shown = p.items.slice(0, NOTIFICATION_EMAIL_MAX_ITEMS);
  const more = p.items.length - shown.length;
  const unsubscribe = safeUrl(p.unsubscribeUrl);
  const preferences = safeUrl(p.preferencesUrl);
  if (!unsubscribe || !preferences) throw new Error('email link must be an http(s) URL');
  const rows = shown.map(
    (item) =>
      html`<li style="margin: 0 0 12px;"><strong>${itemLine(item)}</strong>${
        item.excerpt ? html`<br><span style="color: #4A4245;">“${item.excerpt}”</span>` : html``
      }</li>`
  );
  const textItems = shown
    .map((item) => `- ${itemLine(item)}${item.excerpt ? `: "${item.excerpt}"` : ''}`)
    .join('\n');
  return {
    subject,
    html: layout(
      subject,
      html`<h1 style="font-size: 18px;">${record}</h1>
    <p style="color: #6E6468;">in ${p.baseName}</p>
    <ul style="padding-left: 18px;">${rows}</ul>
    ${more > 0 ? html`<p>and ${more} more</p>` : html``}
    ${button(p.recordUrl, 'Open record')}
    <p style="color: #6E6468; font-size: 12px;">
      <a href="${preferences}" style="color: #6E6468;">Notification settings</a> ·
      <a href="${unsubscribe}" style="color: #6E6468;">Unsubscribe</a>
    </p>`
    ),
    text: `${record} (in ${p.baseName})\n\n${textItems}${more > 0 ? `\nand ${more} more` : ''}\n\nOpen: ${p.recordUrl}\n\nNotification settings: ${p.preferencesUrl}\nUnsubscribe: ${p.unsubscribeUrl}\n`,
  };
}

/** One record in a digest: its names, link and what happened there. */
export interface NotificationDigestRecord {
  recordName: string;
  tableName: string;
  baseName: string;
  recordUrl: string;
  items: readonly NotificationEmailItem[];
}

/** Most records one digest lists, and notifications per record; the rest are "and N more". */
export const DIGEST_MAX_RECORDS = 25;
export const DIGEST_MAX_ITEMS_PER_RECORD = 5;

/**
 * An hourly or daily digest: the recipient's notifications since the last one, grouped by
 * record (newest activity first). Like `notificationEmail`, only names and comment excerpts,
 * every value escaped, and the preferences and one-click unsubscribe links in the footer.
 */
export function notificationDigestEmail(p: {
  frequency: 'hourly' | 'daily';
  records: readonly NotificationDigestRecord[];
  unsubscribeUrl: string;
  preferencesUrl: string;
}): EmailContent {
  const total = p.records.reduce((n, r) => n + r.items.length, 0);
  if (total === 0) throw new Error('digest without notifications');
  const unsubscribe = safeUrl(p.unsubscribeUrl);
  const preferences = safeUrl(p.preferencesUrl);
  if (!unsubscribe || !preferences) throw new Error('email link must be an http(s) URL');
  const subject = `Your ${p.frequency} ${BRAND} digest: ${total} new notification${total === 1 ? '' : 's'}`;
  const shown = p.records.slice(0, DIGEST_MAX_RECORDS);
  const moreRecords = p.records.length - shown.length;
  const sections = shown.map((r) => {
    const url = safeUrl(r.recordUrl);
    if (!url) throw new Error('email link must be an http(s) URL');
    const items = r.items.slice(0, DIGEST_MAX_ITEMS_PER_RECORD);
    const more = r.items.length - items.length;
    return html`<div style="margin: 0 0 20px;">
      <h2 style="font-size: 15px; margin: 0;"><a href="${url}" style="color: ${LINK};">${r.recordName.trim() || 'Unnamed record'}</a></h2>
      <p style="color: #6E6468; margin: 2px 0 6px; font-size: 12px;">${r.baseName} · ${r.tableName}</p>
      <ul style="padding-left: 18px; margin: 0;">${items.map(
        (item) =>
          html`<li style="margin: 0 0 6px;">${itemLine(item)}${
            item.excerpt ? html`<br><span style="color: #4A4245;">“${item.excerpt}”</span>` : html``
          }</li>`
      )}${more > 0 ? html`<li style="color: #6E6468;">and ${String(more)} more</li>` : html``}</ul>
    </div>`;
  });
  const text = shown
    .map((r) => {
      const items = r.items.slice(0, DIGEST_MAX_ITEMS_PER_RECORD);
      const more = r.items.length - items.length;
      const lines = items.map(
        (item) => `- ${itemLine(item)}${item.excerpt ? `: "${item.excerpt}"` : ''}`
      );
      if (more > 0) lines.push(`- and ${more} more`);
      return `${r.recordName.trim() || 'Unnamed record'} (${r.baseName} · ${r.tableName})\n${lines.join('\n')}\nOpen: ${r.recordUrl}`;
    })
    .join('\n\n');
  return {
    subject,
    html: layout(
      subject,
      html`<h1 style="font-size: 18px;">${total === 1 ? '1 new notification' : `${total} new notifications`}</h1>
    ${sections}
    ${moreRecords > 0 ? html`<p>and ${String(moreRecords)} more records with news</p>` : html``}
    <p style="color: #6E6468; font-size: 12px;">
      <a href="${preferences}" style="color: #6E6468;">Notification settings</a> ·
      <a href="${unsubscribe}" style="color: #6E6468;">Unsubscribe</a>
    </p>`
    ),
    text: `${subject}\n\n${text}${moreRecords > 0 ? `\n\nand ${moreRecords} more records with news` : ''}\n\nNotification settings: ${p.preferencesUrl}\nUnsubscribe: ${p.unsubscribeUrl}\n`,
  };
}

/** A webhook the server turned off, to its creator. Never includes the secret. */
export function webhookDisabledEmail(p: {
  baseName: string;
  /** The URL shown without its query string (it may carry a token). */
  url: string;
  failures: number;
  lastError: string;
  baseUrl: string;
}): EmailContent {
  const subject = `A webhook of ${p.baseName} was turned off`;
  return {
    subject,
    html: layout(
      subject,
      html`<h1 style="font-size: 18px;">Webhook turned off</h1>
    <p>The webhook to <strong>${p.url}</strong> in <strong>${p.baseName}</strong> failed
    ${String(p.failures)} deliveries in a row for over a day, so ${BRAND} stopped sending to it.</p>
    <p style="color: #4A4245;">Last error: ${p.lastError}</p>
    <p>Fix the receiver, then turn the webhook on again under Webhooks in the base menu.</p>
    ${button(p.baseUrl, 'Open base')}`
    ),
    text: `The webhook to ${p.url} in ${p.baseName} failed ${p.failures} deliveries in a row for over a day, so ${BRAND} stopped sending to it.\n\nLast error: ${p.lastError}\n\nFix the receiver, then turn the webhook on again under Webhooks in the base menu: ${p.baseUrl}\n`,
  };
}

/**
 * A file the malware scanner quarantined, to whoever uploaded it (or, for a public
 * form's submitter, the form link's creator). The signature name comes from ClamAV.
 */
export function attachmentQuarantinedEmail(p: {
  filename: string;
  baseName: string;
  signature: string;
  /** A public form's upload: the form's name (its view's). */
  formName?: string | undefined;
  baseUrl: string;
}): EmailContent {
  const subject = `A file in ${p.baseName} was quarantined`;
  const how = p.formName ? `submitted through the form ${p.formName} in` : 'you uploaded to';
  return {
    subject,
    html: layout(
      subject,
      html`<h1 style="font-size: 18px;">File quarantined</h1>
    <p>The file <strong>${p.filename}</strong> ${how} <strong>${p.baseName}</strong> contains
    malware (${p.signature}), so ${BRAND} quarantined it: nobody can open or download it.</p>
    <p>If you think this is a mistake, scan the file on your computer, then upload a clean copy.</p>
    ${button(p.baseUrl, 'Open base')}`
    ),
    text: `The file ${p.filename} ${how} ${p.baseName} contains malware (${p.signature}), so ${BRAND} quarantined it: nobody can open or download it.\n\nIf you think this is a mistake, scan the file on your computer, then upload a clean copy: ${p.baseUrl}\n`,
  };
}

/**
 * An automation's "send email" step: the author's subject and Markdown body (rendered by
 * the shared parser, escaped, links http(s)/mailto only), from the server's own address, with a
 * footer naming the base and the automation so a recipient knows where it came from.
 */
export function automationEmail(p: {
  subject: string;
  /** Markdown. */
  body: string;
  baseName: string;
  automationName: string;
}): EmailContent {
  // One line, no control characters (nodemailer folds headers; this keeps them honest).
  const subject = [...p.subject]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, 500);
  const footer = `Sent by the automation "${p.automationName}" in ${p.baseName}.`;
  return {
    subject,
    html: layout(
      subject,
      html`${markdownEmailHtml(p.body)}
    <p style="color: #6E6468; font-size: 12px;">${footer}</p>`
    ),
    // The Markdown as written is the plain-text part (it reads as text, and keeps link URLs).
    text: `${p.body}\n\n${footer}\n`,
  };
}

/**
 * Plan-limit warnings, to a workspace's owners: the limits that newly reached 80% or 100%,
 * as `usageWarningText` says them, and a link to the workspace's Usage page (its upgrade button).
 */
export function usageWarningEmail(p: {
  workspaceName: string;
  planName: string;
  /** At least one limit is reached (not only near). */
  full: boolean;
  lines: string[];
  usageUrl: string;
}): EmailContent {
  const subject = p.full
    ? `${p.workspaceName} reached a limit of its ${p.planName} plan`
    : `${p.workspaceName} is close to a limit of its ${p.planName} plan`;
  const items = p.lines.map((line) => html`<li style="margin: 4px 0;">${line}</li>`);
  return {
    subject,
    html: layout(
      subject,
      html`<h1 style="font-size: 18px;">${subject}</h1>
    <ul style="padding-left: 20px;">${items}</ul>
    <p>Nothing is deleted at a limit: everything can still be read and edited. See the workspace's usage, or upgrade the plan for more.</p>
    ${button(p.usageUrl, 'See usage')}`
    ),
    text: `${subject}\n\n${p.lines.map((l) => `- ${l}`).join('\n')}\n\nNothing is deleted at a limit: everything can still be read and edited. See the workspace's usage, or upgrade the plan for more: ${p.usageUrl}\n`,
  };
}

/**
 * Dunning, to a workspace's owners: the subscription's payment failed (`failed`), the
 * grace period ends in a few days (`reminder`), or it ended and the workspace is on the default
 * plan's limits (`ended`). Links to the workspace's Billing page (update the payment there).
 */
export function paymentFailedEmail(p: {
  stage: 'failed' | 'reminder' | 'ended';
  workspaceName: string;
  planName: string;
  fallbackPlanName: string;
  /** "November 12, 2026". */
  graceEnds: string;
  billingUrl: string;
}): EmailContent {
  const subject = {
    failed: `Payment failed for ${p.workspaceName}`,
    reminder: `${p.workspaceName} keeps its ${p.planName} plan until ${p.graceEnds}`,
    ended: `${p.workspaceName} is on ${p.fallbackPlanName} limits until the payment goes through`,
  }[p.stage];
  const body = {
    failed: `We couldn't take the payment for the ${p.planName} plan. The workspace keeps the plan until ${p.graceEnds} while the payment is retried. Update the payment method to keep it.`,
    reminder: `The payment for the ${p.planName} plan still hasn't gone through. Update the payment method before ${p.graceEnds}, or the workspace falls back to ${p.fallbackPlanName} limits.`,
    ended: `The payment for the ${p.planName} plan didn't go through by ${p.graceEnds}, so the workspace now has ${p.fallbackPlanName} limits. Nothing is deleted: everything can still be read and edited. Update the payment method and the plan comes back.`,
  }[p.stage];
  return {
    subject,
    html: layout(
      subject,
      html`<h1 style="font-size: 18px;">${subject}</h1>
    <p>${body}</p>
    ${button(p.billingUrl, 'Update payment')}`
    ),
    text: `${subject}\n\n${body}\n\nUpdate payment: ${p.billingUrl}\n`,
  };
}

/** The operator's send test (`node dist/email/send-test-cli.js <to>`). */
export function testEmail(p: { appUrl: string; sentAt: Date }): EmailContent {
  const subject = `${BRAND} test email`;
  const at = p.sentAt.toISOString();
  return {
    subject,
    html: layout(
      subject,
      html`<h1 style="font-size: 18px;">Mail from ${BRAND} works</h1>
    <p>This test was sent from <strong>${p.appUrl}</strong> at ${at} through the server's SMTP
    settings. Notification emails, digests and notices use the same path.</p>
    ${button(p.appUrl, `Open ${BRAND}`)}`
    ),
    text: `Mail from ${BRAND} works.\n\nThis test was sent from ${p.appUrl} at ${at} through the server's SMTP settings. Notification emails, digests and notices use the same path.\n\n${p.appUrl}\n`,
  };
}

/** What a notice adds after its summary, per kind. */
const NOTICE_FOOTNOTES: Record<NoticeKind, string> = {
  terms: 'If you keep using the Service after that date, the updated terms apply to you.',
  privacy: 'The updated policy applies from that date.',
  price:
    'Your subscription renews at the new price from that date. You can change or cancel your plan on the Billing page of your workspace before then.',
  plan: 'Nothing is deleted when a limit changes: everything stays readable and editable, and you can export your data at any time.',
  service: '',
};

/**
 * A service notice, sent by the `notices` command to every account (or every workspace
 * owner): the operator's title and plain-text summary, when the change takes effect, and a link
 * to the page with the details. Transactional (legal and essential service notices), so no
 * unsubscribe link.
 */
export function legalNoticeEmail(p: {
  kind: NoticeKind;
  title: string;
  summary: string;
  url: string;
  /** "December 1, 2026". */
  effective: string;
  appUrl: string;
}): EmailContent {
  const when = `This takes effect on ${p.effective}.`;
  const footnote = NOTICE_FOOTNOTES[p.kind];
  const paragraphs = p.summary
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const why = `You're receiving this service notice because you have a ${BRAND} account. It is sent to every account it concerns, whatever your notification settings.`;
  return {
    subject: p.title,
    html: layout(
      p.title,
      html`<h1 style="font-size: 18px;">${p.title}</h1>
    ${paragraphs.map((s) => html`<p>${s}</p>`)}
    <p><strong>${when}</strong>${footnote ? html` ${footnote}` : ''}</p>
    ${button(p.url, 'Read the details')}
    <p style="color: #6E6468; font-size: 12px;">${why} The notice is also shown in <a href="${safeUrl(p.appUrl) ?? ''}" style="color: ${LINK};">${BRAND}</a>.</p>`
    ),
    text: `${p.title}\n\n${paragraphs.join('\n\n')}\n\n${when}${footnote ? ` ${footnote}` : ''}\n\nRead the details: ${p.url}\n\n${why} The notice is also shown in ${BRAND}: ${p.appUrl}\n`,
  };
}
