// Test helpers: the real scan in a process of its own (scan-once.ts), so that every scan can have its own
// environment (the limits are read once, when env.ts is loaded) and can be stopped like the collector.
// Linux only. Does not import the collector itself.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-process-'));
export const remote = path.join(work, 'remote');
export const reposDir = path.join(work, 'repos');
export const tmp = path.join(work, 'tmp');
export const bin = path.join(work, 'bin');
export const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
export const realTar = execFileSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).trim();
fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(work, 'gitconfig'), `[url "file://${remote}/"]\n\tinsteadOf = https://github.com/\n`);

export function rawGit(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'init.defaultBranch=main', ...args], {
    cwd, stdio: 'pipe', encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
}

/** A bare repository at remote/<owner>/<name>.git with the files `build` writes, one commit on main. */
export function makeRemote(name: string, build: (src: string) => void, owner = 'acme'): string {
  const src = path.join(work, 'src', owner, name);
  fs.mkdirSync(src, { recursive: true });
  rawGit(src, 'init', '-q');
  build(src);
  rawGit(src, 'add', '-A', '.');
  rawGit(src, 'commit', '-q', '--allow-empty', '-m', 'content');
  fs.mkdirSync(path.join(remote, owner), { recursive: true });
  const bare = path.join(remote, owner, `${name}.git`);
  execFileSync(realGit, ['clone', '-q', '--bare', src, bare], { stdio: 'pipe' });
  return bare;
}

/** A program on the scan's PATH in front of the real one. `body` is a POSIX shell script. */
export function shim(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
export function unshim(name: string): void {
  fs.rmSync(path.join(bin, name), { force: true });
}

export interface Row { id: string; owner: string; name: string; default_branch: string | null; [extra: string]: unknown }
export function row(name: string, over: Partial<Row> = {}): Row {
  return { id: `acme/${name}`, owner: 'acme', name, default_branch: 'main', ...over };
}

export interface Result {
  ok: number; err: number; error: string | null;
  failed: Array<{ repo: string; err: string }>;
  lines: Record<string, number>; commits: Record<string, unknown[]>; ms: number; log: string;
  /** What the scan process wrote besides its result (warnings of Node, for example). */
  stderr: string;
  exit: number | null; signal: string | null;
}

export interface Started { child: ChildProcess; done: Promise<Result>; ready: string }

/** Starts one scan in a process of its own. `extra` is added to its environment (the limits, for example). */
export function startScan(rows: Row[], extra: Record<string, string | undefined> = {}): Started {
  const ready = path.join(work, `ready-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: tmp,
    SCAN_WORK: work,
    SCAN_REPOS: reposDir,
    SCAN_ROWS: JSON.stringify(rows),
    SCAN_READY: ready,
    REAL_GIT: realGit,
    REAL_TAR: realTar,
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'scan-once.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
  const done = new Promise<Result>((resolve) => {
    child.on('close', (exit, signal) => {
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      const parsed = line ? JSON.parse(line.slice(7)) as Omit<Result, 'stderr' | 'exit' | 'signal'> : { ok: NaN, err: NaN, error: null, failed: [], lines: {}, commits: {}, ms: NaN, log: '' };
      resolve({ ...parsed, stderr: err, exit, signal });
    });
  });
  return { child, done, ready };
}

export async function scan(rows: Row[], extra: Record<string, string | undefined> = {}): Promise<Result> {
  return startScan(rows, extra).done;
}

/** Every process in the container: pid, parent, group, state, command line. */
export function processes(): Array<{ pid: number; ppid: number; pgid: number; stat: string; args: string }> {
  return execFileSync('ps', ['-eo', 'pid,ppid,pgid,stat,args'], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l)!;
    return { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], args: m[5] };
  });
}

/** Processes whose command line holds `marker` (a word the test put into a shim). */
export function running(marker: string): string[] {
  return processes().filter((p) => p.args.includes(marker) && !p.args.startsWith('ps ')).map((p) => `${p.pid} pgid ${p.pgid} ${p.stat} ${p.args}`);
}

export function killAll(marker: string): void {
  for (const p of processes()) if (p.args.includes(marker)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
}

export function tempFolders(): string[] {
  return fs.readdirSync(tmp).filter((n) => n.startsWith('loc-'));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cleanup(): void {
  fs.rmSync(work, { recursive: true, force: true });
}
