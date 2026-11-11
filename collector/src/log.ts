type Level = 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + '\n');
}

/**
 * Error text for the log and the database: every value in `secrets`, user information in URLs,
 * Authorization, Bearer and Basic values, private key blocks and JWTs are replaced, and only then
 * is the text cut to `max` characters, so a credential is never cut in two before it is found.
 * The rules take time in proportion to the text's length, so whole lines can be passed in.
 */
export function errorText(e: unknown, secrets: readonly string[] = [], max = 300): string {
  let text = e instanceof Error ? e.message : String(e);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('<redacted>');
  }
  text = text
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '<redacted key>')
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@'"]*@/gi, '$1')
    .replace(/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)[^\r\n"']*/gi, '$1<redacted>')
    .replace(/\b(bearer|basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1$2<redacted>')
    .replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<redacted jwt>');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
