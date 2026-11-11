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

/** Counts the characters errorText() reads. Tests pass one to check that its work grows with the text, not faster. */
export interface Reads { count: number }

/**
 * Error text for the log and the database: every value in `secrets`, user information in URLs,
 * Authorization, Bearer and Basic values, private key blocks and JWTs are replaced, and only then
 * is the text cut to `max` characters, so a credential is never cut in two before it is found.
 *
 * Each rule is one pass that reads every character a bounded number of times (the secrets: at most
 * their length), so whole lines can be passed in. In the regular-expression notation they replace:
 * - `-----BEGIN [^-\r\n]*PRIVATE KEY-----` up to `-----END [^-\r\n]*PRIVATE KEY-----` or the end;
 * - `\b([a-z][a-z0-9+.-]{0,31}://)[^\s/@'"]*@`, keeping the scheme (letters in any case);
 * - `\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)[^\r\n"']*`, keeping the name (any case);
 * - `\b(bearer|basic|token)(\s+)[A-Za-z0-9._~+/=-]{8,}`, keeping the word and the space (any case);
 * - `(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*`.
 */
export function errorText(e: unknown, secrets: readonly string[] = [], max = 300, reads: Reads = { count: 0 }): string {
  let text = e instanceof Error ? e.message : String(e);
  for (const secret of secrets) {
    if (secret) text = replaceSecret(new Text(text, reads), secret);
  }
  text = privateKeys(new Text(text, reads));
  text = urlUserInfo(new Text(text, reads));
  text = authorizationValues(new Text(text, reads));
  text = schemeTokens(new Text(text, reads));
  text = jwts(new Text(text, reads));
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** A text read one character at a time, every read counted. */
class Text {
  constructor(readonly s: string, private readonly reads: Reads) {}

  get length(): number { return this.s.length; }

  /** The character code at `i`, or -1 past the end. */
  at(i: number): number {
    this.reads.count++;
    return i >= 0 && i < this.s.length ? this.s.charCodeAt(i) : -1;
  }

  /** Whether `word` stands at `i`; with `fold`, ASCII letters in any case (`word` in lower case). */
  is(i: number, word: string, fold = false): boolean {
    for (let k = 0; k < word.length; k++) {
      let c = this.at(i + k);
      if (fold && c >= 65 && c <= 90) c += 32;
      if (c !== word.charCodeAt(k)) return false;
    }
    return true;
  }

  /** The first index from `i` whose character fails `keep`. */
  skip(i: number, keep: (c: number) => boolean): number {
    while (keep(this.at(i))) i++;
    return i;
  }
}

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number) => c >= 48 && c <= 57;
// \w of a regular expression without the u flag.
const isWord = (c: number) => isLetter(c) || isDigit(c) || c === 95;
// \s of a regular expression.
const isSpace = (c: number) => (c >= 9 && c <= 13) || c === 32 || c === 0xa0 || c === 0x1680
  || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f
  || c === 0x3000 || c === 0xfeff;
const isSchemeChar = (c: number) => isLetter(c) || isDigit(c) || c === 43 || c === 46 || c === 45;
const isBase64Url = (c: number) => isLetter(c) || isDigit(c) || c === 95 || c === 45;
const isTokenChar = (c: number) => isBase64Url(c) || c === 46 || c === 126 || c === 43 || c === 47 || c === 61;
const isQuote = (c: number) => c === 34 || c === 39;
// A word starts at i: \b in front of a word character.
const wordStart = (t: Text, i: number) => isWord(t.at(i)) && !isWord(t.at(i - 1));

function replaceSecret(t: Text, secret: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i + secret.length <= t.length;) {
    if (t.is(i, secret)) {
      out += `${t.s.slice(from, i)}<redacted>`;
      i += secret.length;
      from = i;
    } else {
      i++;
    }
  }
  return out + t.s.slice(from);
}

/** The end of `<prefix>[^-\r\n]*PRIVATE KEY-----` when it starts at i, or -1. */
function keyMarker(t: Text, i: number, prefix: string): number {
  if (!t.is(i, prefix)) return -1;
  const start = i + prefix.length;
  const stop = t.skip(start, (c) => c !== -1 && c !== 45 && c !== 10 && c !== 13);
  const tail = 'PRIVATE KEY';
  if (stop - start < tail.length || !t.is(stop - tail.length, tail) || !t.is(stop, '-----')) return -1;
  return stop + 5;
}

function privateKeys(t: Text): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < t.length;) {
    const head = t.at(i) === 45 ? keyMarker(t, i, '-----BEGIN ') : -1;
    if (head === -1) {
      i++;
      continue;
    }
    let end = t.length;
    for (let q = head; q < t.length; q++) {
      const close = t.at(q) === 45 ? keyMarker(t, q, '-----END ') : -1;
      if (close !== -1) {
        end = close;
        break;
      }
    }
    out += `${t.s.slice(from, i)}<redacted key>`;
    i = end;
    from = end;
  }
  return out + t.s.slice(from);
}

function urlUserInfo(t: Text): string {
  let out = '';
  let from = 0;
  // Several scheme starts can lead to the same "://"; its user part is looked at once.
  let seenAt = -1;
  let seenEnd = -1;
  for (let i = 0; i < t.length;) {
    if (!isLetter(t.at(i)) || isWord(t.at(i - 1))) {
      i++;
      continue;
    }
    let k = i + 1;
    while (k - i - 1 < 31 && isSchemeChar(t.at(k))) k++;
    if (!t.is(k, '://')) {
      i++;
      continue;
    }
    const user = k + 3;
    if (user !== seenAt) {
      seenAt = user;
      seenEnd = t.skip(user, (c) => c !== -1 && !isSpace(c) && c !== 47 && c !== 64 && !isQuote(c));
    }
    if (t.at(seenEnd) !== 64) {
      i++;
      continue;
    }
    out += t.s.slice(from, user);
    i = seenEnd + 1;
    from = i;
  }
  return out + t.s.slice(from);
}

function authorizationValues(t: Text): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < t.length;) {
    let name = -1;
    if (wordStart(t, i)) {
      if (t.is(i, 'proxy-authorization', true)) name = i + 19;
      else if (t.is(i, 'authorization', true)) name = i + 13;
    }
    let colon = -1;
    if (name !== -1) {
      const afterQuote = isQuote(t.at(name)) ? name + 1 : name;
      const c = t.skip(afterQuote, isSpace);
      if (t.at(c) === 58 || t.at(c) === 61) colon = c;
    }
    if (colon === -1) {
      i++;
      continue;
    }
    let value = t.skip(colon + 1, isSpace);
    if (isQuote(t.at(value))) value++;
    const end = t.skip(value, (c) => c !== -1 && c !== 10 && c !== 13 && !isQuote(c));
    out += `${t.s.slice(from, value)}<redacted>`;
    i = end;
    from = end;
  }
  return out + t.s.slice(from);
}

function schemeTokens(t: Text): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < t.length;) {
    let word = -1;
    if (wordStart(t, i)) {
      for (const w of ['bearer', 'basic', 'token']) {
        if (t.is(i, w, true)) {
          word = i + w.length;
          break;
        }
      }
    }
    const value = word === -1 ? -1 : t.skip(word, isSpace);
    const end = value > word ? t.skip(value, isTokenChar) : -1;
    if (word === -1 || value === word || end - value < 8) {
      i++;
      continue;
    }
    out += `${t.s.slice(from, value)}<redacted>`;
    i = end;
    from = end;
  }
  return out + t.s.slice(from);
}

function jwts(t: Text): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < t.length;) {
    let end = -1;
    if (t.at(i) === 101 && !isBase64Url(t.at(i - 1)) && t.is(i, 'eyJ')) {
      const first = t.skip(i + 3, isBase64Url);
      if (first - (i + 3) >= 4 && t.at(first) === 46) {
        const second = t.skip(first + 1, isBase64Url);
        if (second - (first + 1) >= 4 && t.at(second) === 46) end = t.skip(second + 1, isBase64Url);
      }
    }
    if (end === -1) {
      i++;
      continue;
    }
    out += `${t.s.slice(from, i)}<redacted jwt>`;
    i = end;
    from = end;
  }
  return out + t.s.slice(from);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
