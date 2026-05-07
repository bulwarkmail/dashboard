// Tiny semver subset: parse "X.Y.Z" or "X.Y.Z-pre". Anything else returns null.
// We deliberately do not pull in a dep; only equality and ordering are needed.

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parse(input: string): ParsedVersion | null {
  const m = RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ?? null,
  };
}

// Returns negative, zero, or positive — like String.localeCompare. Null pre
// outranks any pre-release, matching semver.org §11.
export function compare(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function gt(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  return compare(pa, pb) > 0;
}

// Strip a leading "v" if present so "v1.6.0" and "1.6.0" both parse.
export function normalize(input: string): string {
  return input.trim().replace(/^v/i, '');
}
