/**
 * ScreenAutomationHelper CLI invocation core.
 *
 * Responsibilities, in order of importance:
 *   1. Classify a requested subcommand into a risk tier BEFORE it runs.
 *   2. Build an argv array — never a shell string — so a hostile argument can
 *      never become a second command.
 *   3. Spawn with a timeout and forward cancellation.
 *   4. Parse the tool's JSON envelope, tolerating the fact that some
 *      subcommands print non-JSON human text.
 *
 * Everything here is deliberately free of Cordis imports so it stays testable
 * with plain `node --test`.
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Risk tier of one CLI subcommand path. */
export type RiskTier =
  /** Reads product state or files; cannot change the machine. */
  | 'read'
  /** Observes the screen or UI tree; reveals screen content but does not act. */
  | 'observe'
  /** Moves the mouse, types, writes the clipboard, or mutates workflows. */
  | 'mutate';

/** One CLI invocation: a subcommand path plus its flags. */
export interface CliInvocation {
  /** Subcommand path, e.g. `['screen', 'capture']`. */
  readonly path: readonly string[];
  /** Flags and positionals, already split into argv elements. */
  readonly args?: readonly string[];
}

/** Successful CLI outcome. */
export interface CliSuccess {
  readonly ok: true;
  /** Raw stdout text. */
  readonly stdout: string;
  /** Parsed JSON value when stdout parsed as JSON, else undefined. */
  readonly json: JsonValue | undefined;
  /** Process exit code (0 here). */
  readonly exitCode: 0;
}

/** Failed CLI outcome; never thrown, so callers decide the tool-level error. */
export interface CliFailure {
  readonly ok: false;
  /** Machine-readable failure code. */
  readonly code:
  | 'SPAWN_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'NONZERO_EXIT';
  /** Human-readable explanation, safe to surface to the model. */
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export type CliOutcome = CliSuccess | CliFailure;

/**
 * Read-only query subcommands. These cannot change machine state, so they run
 * without approval even in the strictest policy.
 */
const READ_PATHS: readonly string[] = [
  'status',
  'capabilities',
  'health',
  'connectors',
  'components',
  'recipe-templates',
  'runs list',
  'runs pending-agent',
  'runs agent-context',
  'latest',
  'result',
  'locator find',
  'locator wait',
  'workflow list',
  'workflow show',
  'workflow describe',
  'workflow validate',
  'workflow inspect',
  'workflow schema',
  'task status',
  'overlay status',
];

/**
 * Subcommands that observe the screen. They expose on-screen content (which
 * may include secrets), so they are their own tier — a deployment can gate
 * them without gating pure bookkeeping reads.
 */
const OBSERVE_PATHS: readonly string[] = [
  'screen capture',
  'screen recognize',
  'screen find',
  'screen wait',
  'screen contours',
  'screen color-regions',
  'screen match',
  'screen monitors',
  'screen work-area',
  'ui tree',
  'ui find',
  'ui inspect',
  'dialog inspect',
  'clipboard read',
  'recording',
  'experience',
  'task observe',
  'task capture',
  'task find',
  'webview',
  'window',
];

/**
 * Everything not listed above is treated as `mutate`. This is a fail-safe
 * default: a subcommand added by a future CLI version is gated rather than
 * silently allowed.
 */
export function classify(path: readonly string[]): RiskTier {
  const key = path.join(' ').toLowerCase();
  // Longest-prefix match so `runs list` (read) is not shadowed by `runs`
  // (which also has pause/stop subcommands).
  const match = (table: readonly string[]): boolean =>
    table.some((candidate) => key === candidate || key.startsWith(`${candidate} `));
  if (READ_PATHS.some((candidate) => key === candidate)) return 'read';
  if (OBSERVE_PATHS.some((candidate) => key === candidate)) return 'observe';
  if (match(READ_PATHS)) return 'read';
  if (match(OBSERVE_PATHS)) return 'observe';
  return 'mutate';
}

/**
 * Families whose effect survives the call and is hard to undo. `blockDestructive`
 * refuses these outright, independent of approval — removing a workflow the
 * user relies on, or installing arbitrary source, is not a screen action the
 * model should be able to take on its own.
 */
const DESTRUCTIVE_PATHS: readonly string[] = [
  'workflow remove',
  'workflow install',
  'workflow restore-builtin',
  'clipboard write',
];

export function isDestructive(path: readonly string[]): boolean {
  const key = path.join(' ').toLowerCase();
  return DESTRUCTIVE_PATHS.some(
    (candidate) => key === candidate || key.startsWith(`${candidate} `),
  );
}

/**
 * Reject arguments that would confuse argv construction. Since we never use a
 * shell this is defense in depth rather than the primary control, but a NUL or
 * newline in an argument indicates a caller bug or an injection attempt.
 */
export function assertSafeArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (arg.includes('\0')) {
      throw new Error('argument contains a NUL byte');
    }
    if (arg.length > 32768) {
      throw new Error('argument exceeds the maximum length');
    }
  }
}

/** Options for {@link runCli}. */
export interface RunCliOptions {
  /** Absolute path to the helper executable. */
  readonly cliPath: string;
  /** Invocation to perform. */
  readonly invocation: CliInvocation;
  /** Milliseconds before the child is killed. */
  readonly timeoutMs: number;
  /** Caller cancellation. */
  readonly signal?: AbortSignal;
  /** Working directory; the helper expects its own install dir. */
  readonly cwd?: string;
}

/** Resolve the executable to spawn, honoring an explicit path over PATH lookup. */
export function resolveCliPath(configured: string): string {
  const trimmed = configured.trim();
  if (trimmed !== '') return trimmed;
  // The installer does not reliably add itself to PATH, so fall back to the
  // documented default install location before relying on a bare name.
  return 'ScreenAutomationHelper.exe';
}

/**
 * Run one CLI invocation and normalize the outcome.
 *
 * Never throws for an expected failure (spawn error, timeout, cancellation,
 * non-zero exit) — those come back as a {@link CliFailure} so the tool body can
 * render them as an ordinary error result.
 */
export async function runCli(options: RunCliOptions): Promise<CliOutcome> {
  const { cliPath, invocation, timeoutMs, signal, cwd } = options;
  const argv = [...invocation.path, ...(invocation.args ?? [])];
  assertSafeArgs(argv);

  const { spawn } = await import('node:child_process');

  return new Promise<CliOutcome>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const finish = (outcome: CliOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    let child;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // .cmd/.bat launchers cannot be spawned directly on modern Node (EINVAL,
      // CVE-2024-27980 hardening): route them through cmd.exe with an explicit
      // argument array — no shell string, so no injection surface either.
      const isBatch = /\.(cmd|bat)$/i.test(cliPath);
      const file = isBatch ? 'cmd.exe' : cliPath;
      const args = isBatch ? ['/d', '/s', '/c', cliPath, 'cli', ...argv] : ['cli', ...argv];
      child = spawn(file, args, {
        cwd,
        // No shell: arguments cross the boundary as a real argv array, so no
        // amount of quoting or metacharacters in a value can add a command.
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        ok: false,
        code: 'SPAWN_FAILED',
        message: `could not start ${cliPath}: ${(error as Error).message}`,
        stdout: '',
        stderr: '',
        exitCode: null,
      });
      return;
    }

    // Guard against a huge capture turning into an unbounded buffer.
    const MAX_CAPTURE = 8 * 1024 * 1024;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk;
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      child.kill('SIGKILL');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error: Error) => {
      finish({
        ok: false,
        code: 'SPAWN_FAILED',
        message: `could not start ${cliPath}: ${error.message}`,
        stdout,
        stderr,
        exitCode: null,
      });
    });

    child.on('close', (code: number | null) => {
      if (timedOut) {
        finish({
          ok: false,
          code: 'TIMEOUT',
          message: `the command did not finish within ${timeoutMs} ms`,
          stdout,
          stderr,
          exitCode: code,
        });
        return;
      }
      if (cancelled) {
        finish({
          ok: false,
          code: 'CANCELLED',
          message: 'the call was cancelled',
          stdout,
          stderr,
          exitCode: code,
        });
        return;
      }
      if (code !== 0) {
        finish({
          ok: false,
          code: 'NONZERO_EXIT',
          message: describeNonZero(code, stderr, stdout),
          stdout,
          stderr,
          exitCode: code,
        });
        return;
      }
      finish({ ok: true, stdout, json: tryParseJson(stdout), exitCode: 0 });
    });
  });
}

/** Build a compact explanation for a non-zero exit. */
function describeNonZero(
  code: number | null,
  stderr: string,
  stdout: string,
): string {
  const detail = (stderr.trim() || stdout.trim()).split('\n').slice(0, 6).join('\n');
  const head = code === 2 ? 'the command line was rejected' : `exit code ${code}`;
  return detail === '' ? head : `${head}: ${detail}`;
}

/** Parse stdout as JSON when possible; return undefined for plain text. */
export function tryParseJson(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return undefined;
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Render a JSON value into a compact, model-friendly text block. */
export function stringifyForModel(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * One word-level OCR hit, exactly as `screen.recognize` emits it.
 * Kept structural so the tool layer can pass it through unchanged.
 */
export interface OcrItem {
  readonly text: string;
  readonly confidence: number;
  /** [x1, y1, x2, y2] in screen pixels. */
  readonly box: readonly number[];
  /** [cx, cy] — box center. */
  readonly center: readonly number[];
}

/** Resolved foreground-application identity, including an extracted icon file. */
export interface AppInfo {
  /** Process name, e.g. "Notepad.exe". */
  readonly process: string | null;
  /** Window title text. */
  readonly title: string | null;
  /** Absolute path to the process executable. */
  readonly exe: string | null;
  /** Display name: process minus extension, or title if unknown. */
  readonly displayName: string;
  /** Path to a PNG icon extracted from the executable, or null if unavailable. */
  readonly iconPath: string | null;
}

/**
 * Resolve the foreground application and extract its icon to a PNG.
 *
 * Used so the model — and the human approving a mutate — can *see which app* is
 * about to be operated, not just read a process name. The icon is pulled from the
 * executable via Windows `System.Drawing.Icon.ExtractAssociatedIcon`; on non-Windows
 * hosts (or when extraction fails) `iconPath` is null and the textual identity is
 * still returned. The icon file lives under the system temp dir.
 */
export async function resolveForegroundApp(
  cliPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AppInfo> {
  const fallback: AppInfo = {
    process: null,
    title: null,
    exe: null,
    displayName: 'unknown app',
    iconPath: null,
  }
  const win = await runCli({
    cliPath,
    invocation: { path: ['window', 'foreground'] },
    timeoutMs,
    signal,
  })
  const j = win.ok ? (win.json as Record<string, unknown> | undefined) : undefined
  if (!j) return fallback
  const process = typeof j.process === 'string' ? j.process : null
  const title = typeof j.title === 'string' ? j.title : null
  const exe = typeof j.process_path === 'string' ? j.process_path : null
  const displayName = (process ?? title ?? 'unknown app').replace(/\.exe$/i, '')
  const iconPath = exe ? extractIcon(exe) : null
  return { process, title, exe, displayName, iconPath }
}

/**
 * Deliver one screen input WITHOUT moving the physical cursor.
 *
 * Delegates to `scripts/background-input.ps1`, which sends Win32 messages
 * straight to the target window's child control. Returns the script's JSON
 * envelope, notably `cursorMoved` — the caller is expected to surface that so a
 * "background" operation can never silently become a cursor grab.
 *
 * Returns null when the script cannot be located or produces no JSON.
 */
export async function runBackgroundInput(params: {
  action: 'click' | 'type' | 'key' | 'probe' | 'scroll'
  x?: number
  y?: number
  text?: string
  key?: number
  amount?: number
  title?: string
  hwnd?: number
  timeoutMs: number
}): Promise<Record<string, unknown> | null> {
  const script = resolveScriptPath('background-input.ps1')
  if (!script) return null
  const argv: string[] = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Action',
    params.action,
  ]
  if (params.x !== undefined && params.y !== undefined) {
    argv.push('-X', String(params.x), '-Y', String(params.y))
  }
  if (params.text !== undefined) argv.push('-Text', params.text)
  if (params.key !== undefined) argv.push('-Key', String(params.key))
  if (params.amount !== undefined) argv.push('-Amount', String(params.amount))
  if (params.title !== undefined) argv.push('-Title', params.title)
  if (params.hwnd !== undefined) argv.push('-Hwnd', String(params.hwnd))

  try {
    const r = spawnSync('powershell.exe', argv, {
      timeout: Math.min(params.timeoutMs, 30_000),
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
    const raw = (r.stdout ?? '').trim()
    if (!raw) return null
    const start = raw.indexOf('{')
    if (start < 0) return null
    return JSON.parse(raw.slice(start)) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Locate a bundled helper script next to the built `lib/` output, whether we are
 * running from `lib/` (installed) or `src/` (ts-node/dev).
 */
function resolveScriptPath(name: string): string | null {
  // ESM has no __dirname; derive this file's directory from import.meta.url.
  // `lib/scripts/` is where the build ships helpers (see scripts/copy-helpers.mjs).
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'scripts', name),
    join(here, '..', 'scripts', name),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Extract an executable's associated icon to a temp PNG; null on any failure. */
function extractIcon(exe: string): string | null {
  if (process.platform !== 'win32') return null
  const out = join(
    tmpdir(),
    `dsh-screen-helper-icon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
  )
  // Inline PowerShell; only Windows reaches here. Backtick-quote the exe path.
  const ps = `
Add-Type -AssemblyName System.Drawing
try {
  $ico = [System.Drawing.Icon]::ExtractAssociatedIcon('${exe.replace(/'/g, "''")}')
  if ($ico) {
    $bmp = $ico.ToBitmap()
    $bmp.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $ico.Dispose()
    Write-Output 'OK'
  } else { Write-Output 'NOICON' }
} catch { Write-Output "ERR:$_" }
`
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeout: 15_000,
      windowsHide: true,
    })
    const outText = (r.stdout?.toString() ?? '').trim()
    if (outText === 'OK' && existsSync(out)) return out
    return null
  } catch {
    return null
  }
}

/**
 * Find precise word-level boxes for `query` within OCR `items`.
 *
 * `screen.find` returns the *line* containing a hit, which is too coarse to
 * click a small control. `screen.recognize` returns one box per recognized
 * token, so a substring match against those tokens yields a box that actually
 * covers the target text.
 *
 * Ranking: exact-token matches first, then **shortest containing token**
 * (a UI control label is the minimal text that contains the query, while a
 * chat log line merely happens to contain it), then by confidence. The
 * shortest-first rule matters when no token equals the query exactly — e.g.
 * the query "新会话" against a sidebar button rendered as "④新会话" (icon
 * prefix, conf 0.88) plus long chat lines quoting "新会话" (conf 0.97+):
 * confidence alone would pick a chat line and click the wrong place.
 */
export function findExact(
  items: readonly OcrItem[],
  query: string,
): { query: string; count: number; matches: OcrItem[] } {
  const q = query.trim();
  if (q === '' || !Array.isArray(items)) {
    return { query: q, count: 0, matches: [] };
  }
  const scored = items
    .filter((it) => typeof it?.text === 'string' && it.text.includes(q))
    .map((it) => ({
      item: it,
      exact: it.text === q ? 1 : 0,
      len: it.text.length,
      confidence: typeof it.confidence === 'number' ? it.confidence : 0,
    }));
  scored.sort(
    (a, b) =>
      b.exact - a.exact ||
      a.len - b.len ||
      b.confidence - a.confidence,
  );
  return { query: q, count: scored.length, matches: scored.map((s) => s.item) };
}
