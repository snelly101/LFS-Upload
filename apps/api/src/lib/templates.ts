import { formatBytes, formatDateTimeLong } from '@securesend/shared';

export interface TemplateContext {
  productName: string;
  organisationName: string;
  supportEmail: string | null;
  accentColour: string;
  publicUrl: string;
  timeZone: string;
}

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Split "Together Housing Secure File Send" into the organisation and the service name. */
function lockup(ctx: TemplateContext): { org: string; name: string } {
  const p = ctx.productName.trim();
  const o = ctx.organisationName.trim();
  if (o && p.toLowerCase().startsWith(o.toLowerCase()) && p.length > o.length + 1) return { org: o, name: p.slice(o.length).trim() };
  return { org: o && o.toLowerCase() !== p.toLowerCase() ? o : '', name: p || o };
}

/** White or near-black text, whichever is more readable on the accent colour. */
function onAccent(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#FFFFFF';
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return 1.05 / (L + 0.05) >= 4.5 ? '#FFFFFF' : '#11181A';
}

const SERIF = "Georgia,'Times New Roman',Times,serif";
const SANS = "'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * One layout for every message: table-based with inline styles so it survives Outlook, no remote
 * images or web fonts, and a small dark-mode block for clients that honour it. The organisation's
 * name leads; the service name sits beneath it.
 */
export function layout(ctx: TemplateContext, title: string, bodyHtml: string, footerNote?: string): string {
  const { org, name } = lockup(ctx);
  const accent = /^#[0-9a-f]{6}$/i.test(ctx.accentColour) ? ctx.accentColour : '#11665C';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(title)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .ss-page { background: #16191A !important; }
  .ss-card { background: #1F2324 !important; border-color: #353B3C !important; }
  .ss-text, .ss-text p, .ss-name { color: #ECE7DC !important; }
  .ss-muted, .ss-muted p, .ss-org { color: #A9A59B !important; }
  .ss-rule { border-color: #353B3C !important; }
  .ss-code { background: #272C2D !important; color: #ECE7DC !important; border-color: #525A5B !important; }
}
</style></head>
<body class="ss-page" style="margin:0;padding:0;background:#F4F0E8;">
<table role="presentation" class="ss-page" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F4F0E8" style="background:#F4F0E8;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="ss-card" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#FFFDF8" style="max-width:580px;background:#FFFDF8;border:1px solid #DCD5C6;">
<tr><td height="4" bgcolor="${esc(accent)}" style="height:4px;line-height:4px;font-size:0;background:${esc(accent)};">&nbsp;</td></tr>
<tr><td class="ss-rule" style="padding:22px 30px 18px;border-bottom:1px solid #DCD5C6;">
${org ? `<div class="ss-org" style="font-family:${SANS};font-size:11px;line-height:16px;font-weight:bold;letter-spacing:1.6px;text-transform:uppercase;color:#636B66;">${esc(org)}</div>` : ''}
<div class="ss-name" style="font-family:${SERIF};font-size:20px;line-height:26px;font-weight:bold;color:#1D2A2E;">${esc(name)}</div>
</td></tr>
<tr><td class="ss-text" style="padding:26px 30px 24px;font-family:${SANS};font-size:16px;line-height:25px;color:#1D2A2E;">${bodyHtml}</td></tr>
<tr><td class="ss-muted ss-rule" style="padding:16px 30px 20px;border-top:1px solid #DCD5C6;font-family:${SANS};font-size:12px;line-height:18px;color:#636B66;">${esc(ctx.organisationName)}${ctx.supportEmail ? ` &middot; Help: <a href="mailto:${esc(ctx.supportEmail)}" style="color:#636B66;">${esc(ctx.supportEmail)}</a>` : ''}${footerNote ? `<br>${esc(footerNote)}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

/** A real button (table cell, so Outlook draws it) followed by the plain link for anyone who cannot click it. */
export function button(ctx: TemplateContext, href: string, label: string): string {
  const accent = /^#[0-9a-f]{6}$/i.test(ctx.accentColour) ? ctx.accentColour : '#11665C';
  const fg = onAccent(accent);
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0 18px;"><tr><td bgcolor="${esc(accent)}" style="background:${esc(accent)};border-radius:3px;"><a href="${esc(href)}" style="display:inline-block;padding:13px 24px;font-family:${SANS};font-size:16px;line-height:20px;font-weight:bold;color:${fg};text-decoration:none;">${esc(label)}</a></td></tr></table>
<p class="ss-muted" style="margin:0 0 6px;font-size:13px;line-height:19px;color:#636B66;">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all;">${esc(href)}</span></p>`;
}

export const templates = {
  transfer_available(ctx: TemplateContext, d: { senderName: string; senderEmail: string; link: string; expiresAt: string; fileCount: number; totalBytes: number; verificationRequired: boolean }): Rendered {
    const when = formatDateTimeLong(d.expiresAt, ctx.timeZone);
    const subject = `${d.senderName} has sent you files via ${ctx.productName}`;
    const verify = d.verificationRequired
      ? 'To open the files you will be asked for a one-time code, which we will email to this address when you request it.'
      : 'Anyone holding this link can download the files, so please do not forward it.';
    const text = `${d.senderName} (${d.senderEmail}) has sent you ${d.fileCount} file${d.fileCount === 1 ? '' : 's'} (${formatBytes(d.totalBytes)}) using ${ctx.productName}.

Open the transfer: ${d.link}

${verify}

The files are available until ${when}. After that they are deleted.

${ctx.organisationName}`;
    const html = layout(
      ctx,
      subject,
      `<p><strong>${esc(d.senderName)}</strong> (${esc(d.senderEmail)}) has sent you ${d.fileCount} file${d.fileCount === 1 ? '' : 's'} (${esc(formatBytes(d.totalBytes))}).</p>
       ${button(ctx, d.link, 'Open transfer')}
       <p>${esc(verify)}</p>
       <p>Available until <strong>${esc(when)}</strong>. The files are deleted after that.</p>`,
      'This message was sent because a member of staff addressed a transfer to this email address.',
    );
    return { subject, text, html };
  },

  verification_code(ctx: TemplateContext, d: { code: string; ttlMinutes: number; senderName: string }): Rendered {
    const subject = `${ctx.productName} verification code`;
    const text = `Your verification code is: ${d.code}

It expires in ${d.ttlMinutes} minutes and can only be used once, on the page where you requested it.

If you did not request this code, you can ignore this message. Someone may have opened a transfer link that ${d.senderName} addressed to you; the code is only useful to a person who can read this mailbox.`;
    const html = layout(
      ctx,
      subject,
      `<p>Your verification code is:</p>
       <p class="ss-code" style="margin:12px 0 20px;padding:14px 18px;display:inline-block;background:#EFEADF;border:1px dashed #B4AA96;font-family:'Courier New',Courier,monospace;font-size:30px;line-height:36px;letter-spacing:6px;font-weight:bold;color:#1D2A2E;">${esc(d.code)}</p>
       <p>It expires in ${d.ttlMinutes} minutes and can only be used once, on the page where you requested it.</p>
       <p class="ss-muted" style="color:#636B66;font-size:13px;line-height:19px;">If you did not request this code you can ignore this message.</p>`,
    );
    return { subject, text, html };
  },

  sender_activity(ctx: TemplateContext, d: { kind: string; transferTitle: string; recipientEmail: string | null; link: string; detail: string }): Rendered {
    const subject = `${ctx.productName}: ${d.detail}`;
    const who = d.recipientEmail ? d.recipientEmail : 'a link holder (unverified)';
    const text = `${d.detail}\n\nTransfer: ${d.transferTitle}\nRecipient: ${who}\n\nView activity: ${d.link}`;
    const html = layout(ctx, subject, `<p>${esc(d.detail)}</p><p>Transfer: <strong>${esc(d.transferTitle)}</strong><br>Recipient: ${esc(who)}</p>${button(ctx, d.link, 'View activity')}`);
    return { subject, text, html };
  },

  expiring_soon_recipient(ctx: TemplateContext, d: { senderName: string; link: string; expiresAt: string }): Rendered {
    const when = formatDateTimeLong(d.expiresAt, ctx.timeZone);
    const subject = `Reminder: files from ${d.senderName} expire ${when}`;
    const text = `The files ${d.senderName} sent you via ${ctx.productName} are available until ${when}.\n\nOpen the transfer: ${d.link}`;
    const html = layout(ctx, subject, `<p>The files <strong>${esc(d.senderName)}</strong> sent you are available until <strong>${esc(when)}</strong>.</p>${button(ctx, d.link, 'Open transfer')}`);
    return { subject, text, html };
  },

  account_invite(ctx: TemplateContext, d: { link: string; inviterName: string; ttlHours: number }): Rendered {
    const subject = `You have been invited to ${ctx.productName}`;
    const text = `${d.inviterName} has invited you to use ${ctx.productName} at ${ctx.organisationName}.\n\nSet up your account: ${d.link}\n\nThis link expires in ${d.ttlHours} hours. You will be asked to choose a password and set up a passkey or authenticator app.`;
    const html = layout(ctx, subject, `<p><strong>${esc(d.inviterName)}</strong> has invited you to use ${esc(ctx.productName)}.</p>${button(ctx, d.link, 'Set up your account')}<p class="ss-muted" style="font-size:13px;line-height:19px;color:#636B66;">This link expires in ${d.ttlHours} hours. You will be asked to choose a password and set up a passkey or authenticator app.</p>`);
    return { subject, text, html };
  },

  password_reset(ctx: TemplateContext, d: { link: string; ttlMinutes: number }): Rendered {
    const subject = `${ctx.productName} password reset`;
    const text = `A password reset was requested for your ${ctx.productName} account.\n\nReset your password: ${d.link}\n\nThe link expires in ${d.ttlMinutes} minutes. Your second factor is still required to sign in afterwards. If you did not request this, ignore this message.`;
    const html = layout(ctx, subject, `<p>A password reset was requested for your account.</p>${button(ctx, d.link, 'Reset password')}<p class="ss-muted" style="font-size:13px;line-height:19px;color:#636B66;">The link expires in ${d.ttlMinutes} minutes. Your second factor is still required to sign in afterwards. If you did not request this, ignore this message.</p>`);
    return { subject, text, html };
  },

  security_notice(ctx: TemplateContext, d: { what: string; when: string; link: string }): Rendered {
    const subject = `${ctx.productName} security notice: ${d.what}`;
    const text = `${d.what}\n\nWhen: ${formatDateTimeLong(d.when, ctx.timeZone)}\n\nIf this was not you, sign in and review your security settings immediately, or contact ${ctx.supportEmail ?? 'your administrator'}.\n\n${d.link}`;
    const html = layout(ctx, subject, `<p><strong>${esc(d.what)}</strong></p><p>When: ${esc(formatDateTimeLong(d.when, ctx.timeZone))}</p><p>If this was not you, sign in and review your security settings immediately, or contact ${esc(ctx.supportEmail ?? 'your administrator')}.</p>${button(ctx, d.link, 'Review account security')}`);
    return { subject, text, html };
  },

  admin_alert(ctx: TemplateContext, d: { severity: string; message: string; link: string }): Rendered {
    const subject = `[${ctx.productName}] ${d.severity.toUpperCase()}: ${d.message}`;
    const text = `${d.message}\n\nSystem health: ${d.link}`;
    const html = layout(ctx, subject, `<p><strong>${esc(d.severity.toUpperCase())}</strong>: ${esc(d.message)}</p>${button(ctx, d.link, 'Open system health')}`);
    return { subject, text, html };
  },

  test_message(ctx: TemplateContext, d: { requestedBy: string }): Rendered {
    const subject = `${ctx.productName} test message`;
    const text = `This is a test message from ${ctx.productName}, requested by ${d.requestedBy}. If you can read this, outbound email is working.`;
    const html = layout(ctx, subject, `<p>This is a test message from ${esc(ctx.productName)}, requested by ${esc(d.requestedBy)}.</p><p>If you can read this, outbound email is working.</p>`);
    return { subject, text, html };
  },
};

export type TemplateKey = keyof typeof templates;
