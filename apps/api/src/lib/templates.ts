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

function layout(ctx: TemplateContext, title: string, bodyHtml: string, footerNote?: string): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#F5F6F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#172C36;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F5F6F3;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DDE3DF;border-radius:6px;">
<tr><td style="padding:20px 28px;border-bottom:1px solid #DDE3DF;font-size:14px;font-weight:600;letter-spacing:0.02em;color:${esc(ctx.accentColour)};">${esc(ctx.productName)}</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.55;">${bodyHtml}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #DDE3DF;font-size:12px;color:#5B6B72;line-height:1.5;">${esc(ctx.organisationName)}${ctx.supportEmail ? ` · Support: ${esc(ctx.supportEmail)}` : ''}${footerNote ? `<br>${esc(footerNote)}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

function button(ctx: TemplateContext, href: string, label: string): string {
  return `<p style="margin:24px 0;"><a href="${esc(href)}" style="display:inline-block;background:${esc(ctx.accentColour)};color:#FFFFFF;text-decoration:none;padding:12px 20px;border-radius:4px;font-weight:600;">${esc(label)}</a></p>
<p style="font-size:13px;color:#5B6B72;">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all;">${esc(href)}</span></p>`;
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
       <p style="font-size:28px;letter-spacing:0.18em;font-weight:700;font-variant-numeric:tabular-nums;margin:12px 0 20px;">${esc(d.code)}</p>
       <p>It expires in ${d.ttlMinutes} minutes and can only be used once, on the page where you requested it.</p>
       <p style="color:#5B6B72;font-size:13px;">If you did not request this code you can ignore this message.</p>`,
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
    const html = layout(ctx, subject, `<p><strong>${esc(d.inviterName)}</strong> has invited you to use ${esc(ctx.productName)}.</p>${button(ctx, d.link, 'Set up your account')}<p style="font-size:13px;color:#5B6B72;">This link expires in ${d.ttlHours} hours. You will be asked to choose a password and set up a passkey or authenticator app.</p>`);
    return { subject, text, html };
  },

  password_reset(ctx: TemplateContext, d: { link: string; ttlMinutes: number }): Rendered {
    const subject = `${ctx.productName} password reset`;
    const text = `A password reset was requested for your ${ctx.productName} account.\n\nReset your password: ${d.link}\n\nThe link expires in ${d.ttlMinutes} minutes. Your second factor is still required to sign in afterwards. If you did not request this, ignore this message.`;
    const html = layout(ctx, subject, `<p>A password reset was requested for your account.</p>${button(ctx, d.link, 'Reset password')}<p style="font-size:13px;color:#5B6B72;">The link expires in ${d.ttlMinutes} minutes. Your second factor is still required to sign in afterwards. If you did not request this, ignore this message.</p>`);
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
