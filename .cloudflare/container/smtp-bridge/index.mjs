// Local SMTP server that relays every message to the Mail Mario HTTP API.
// AFFiNE only speaks SMTP; this lets it send through Mail Mario unchanged.
//
// Env:
//   MAILMARIO_API_KEY    required, `Authorization: Bearer` key
//   MAILMARIO_API_URL    default https://app.mailmario.com/api/v1
//   SMTP_BRIDGE_PORT     default 2525 (listens on 127.0.0.1 only)
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

const API_URL = (
  process.env.MAILMARIO_API_URL || 'https://app.mailmario.com/api/v1'
).replace(/\/$/, '');
const API_KEY = process.env.MAILMARIO_API_KEY;
const PORT = Number(process.env.SMTP_BRIDGE_PORT || 2525);
const TIMEOUT_MS = 20_000;
const MAX_SIZE = 10 * 1024 * 1024;

if (!API_KEY) {
  console.error('[smtp-bridge] MAILMARIO_API_KEY is not set');
  process.exit(1);
}

class SmtpError extends Error {
  constructor(message, responseCode) {
    super(message);
    this.responseCode = responseCode;
  }
}

function addresses(field) {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list.flatMap(item =>
    item.value.flatMap(entry =>
      entry.group
        ? entry.group.map(member => member.address)
        : [entry.address]
    )
  ).filter(Boolean).map(address => address.toLowerCase());
}

function addressText(value) {
  const first = value?.value?.[0];
  if (!first?.address) return undefined;
  return first.name ? `${first.name} <${first.address}>` : first.address;
}

// Mail Mario attachments have no inline/cid support, so inline images are
// embedded into the html as data URIs instead.
function inlineCidImages(html, attachments) {
  const inline = new Map();
  for (const attachment of attachments) {
    if (attachment.cid) inline.set(attachment.cid, attachment);
  }
  if (!html || inline.size === 0) return { html, inline };
  const replaced = html.replace(/cid:([^"'\s)>]+)/g, (match, cid) => {
    const attachment = inline.get(cid);
    if (!attachment) return match;
    return `data:${attachment.contentType};base64,${attachment.content.toString('base64')}`;
  });
  return { html: replaced, inline };
}

async function toMailMario(raw, envelope) {
  const mail = await simpleParser(raw);
  const attachments = mail.attachments ?? [];
  const { html, inline } = inlineCidImages(
    typeof mail.html === 'string' ? mail.html : undefined,
    attachments
  );

  // Envelope recipients missing from the To/Cc headers were Bcc'd.
  const envelopeTo = envelope.rcptTo.map(rcpt => rcpt.address.toLowerCase());
  const headerTo = addresses(mail.to).filter(a => envelopeTo.includes(a));
  const headerCc = addresses(mail.cc).filter(a => envelopeTo.includes(a));
  const bcc = envelopeTo.filter(
    a => !headerTo.includes(a) && !headerCc.includes(a)
  );
  const to = headerTo.length ? headerTo : bcc.splice(0, 1);

  const body = {
    from: addressText(mail.from) ?? envelope.mailFrom?.address,
    to,
    subject: mail.subject ?? '',
  };
  if (headerCc.length) body.cc = headerCc;
  if (bcc.length) body.bcc = bcc;
  if (html) body.html = html;
  if (mail.text) body.text = mail.text;
  const replyTo = mail.replyTo?.value?.[0]?.address;
  if (replyTo) body.reply_to = replyTo;
  const files = attachments
    .filter(attachment => !inline.has(attachment.cid))
    .map(attachment => ({
      filename: attachment.filename || 'attachment',
      content_type: attachment.contentType,
      content: attachment.content.toString('base64'),
    }));
  if (files.length) body.attachments = files;

  return { body, messageId: mail.messageId };
}

async function send(body, messageId) {
  let response;
  try {
    response = await fetch(`${API_URL}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
        ...(messageId ? { 'idempotency-key': messageId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new SmtpError(`Mail Mario unreachable: ${error.message}`, 451);
  }

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (response.ok) return json;

  const detail = json?.error
    ? `${json.error.code}: ${json.error.message}`
    : `HTTP ${response.status}`;
  // Rate limits and server errors are temporary, so AFFiNE retries them.
  const temporary =
    response.status === 429 ||
    response.status >= 500 ||
    json?.error?.code === 'rate_limited';
  throw new SmtpError(`Mail Mario rejected the message: ${detail}`, temporary ? 451 : 550);
}

const server = new SMTPServer({
  name: 'smtp-bridge.local',
  banner: 'AFFiNE to Mail Mario bridge',
  secure: false,
  disabledCommands: ['STARTTLS'],
  // Bound to localhost, so any credentials are accepted.
  authOptional: true,
  allowInsecureAuth: true,
  onAuth(auth, session, callback) {
    callback(null, { user: auth.username || 'affine' });
  },
  size: MAX_SIZE,
  onData(stream, session, callback) {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', callback);
    stream.on('end', async () => {
      if (stream.sizeExceeded) {
        callback(new SmtpError('Message exceeds 10 MB', 552));
        return;
      }
      try {
        const { body, messageId } = await toMailMario(
          Buffer.concat(chunks),
          session.envelope
        );
        const result = await send(body, messageId);
        console.log(
          `[smtp-bridge] sent "${body.subject}" to ${session.envelope.rcptTo.length} recipient(s): ${result?.id ?? 'ok'} ${result?.status ?? ''}`
        );
        callback(null, `Queued as ${result?.id ?? 'unknown'}`);
      } catch (error) {
        console.error(`[smtp-bridge] ${error.message}`);
        callback(error.responseCode ? error : new SmtpError(error.message, 451));
      }
    });
  },
});

server.on('error', error => console.error('[smtp-bridge] server error', error));
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[smtp-bridge] listening on 127.0.0.1:${PORT} -> ${API_URL}/emails`);
});
