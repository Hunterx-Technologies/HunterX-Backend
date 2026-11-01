// src/utils/emailTemplates.js — The HunterX transactional email frame
// (same look as the verification-code and password-reset emails in
// authService.js), for the security emails added with the 2026-11 audit:
// email change, account deletion, "you already have an account".

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * heading / paragraphs are trusted template text (HTML allowed); anything
 * user-supplied must go through escapeHtml first. code: a one-time code
 * shown in the big box. cta: { text, url } button.
 */
export function brandedEmail({ heading, paragraphs = [], code, cta, note }) {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px;color:#888888;font-size:14px;line-height:1.6;">${p}</p>`)
    .join('');
  const codeBox = code
    ? `<div style="background-color:#000000;border:1px solid #333333;border-radius:8px;padding:24px;margin:8px 0 24px;">
         <p style="margin:0;color:#ffffff;font-size:44px;font-weight:bold;letter-spacing:14px;font-family:'Courier New',monospace;">${escapeHtml(code)}</p>
       </div>
       <p style="margin:0 0 16px;color:#E8A020;font-size:13px;font-weight:bold;">This code expires in 10 minutes</p>`
    : '';
  const button = cta
    ? `<p style="margin:8px 0 24px;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background-color:#FE5B01;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 28px;border-radius:8px;">${escapeHtml(cta.text)}</a></p>`
    : '';
  const footNote = note
    ? `<p style="margin:0;color:#555555;font-size:12px;">${note}</p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color:#111111;border-radius:8px;border:1px solid #222222;">
          <tr>
            <td style="background-color:#000000;padding:32px;text-align:center;border-bottom:1px solid #222222;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-style:italic;letter-spacing:4px;">HUNTERX</h1>
              <p style="margin:8px 0 0;color:#555555;font-size:12px;letter-spacing:2px;text-transform:uppercase;">The system awaits</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 32px;text-align:center;">
              <h2 style="margin:0 0 16px;color:#ffffff;font-size:22px;font-weight:bold;">${heading}</h2>
              ${body}${codeBox}${button}${footNote}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;text-align:center;border-top:1px solid #222222;">
              <p style="margin:0;color:#333333;font-size:11px;">HunterX by Gymgasm · Do not reply to this email</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
