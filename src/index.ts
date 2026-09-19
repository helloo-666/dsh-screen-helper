/**
 * dsh-screen-helper — a DeepSeek Harness bundle that drives the
 * ScreenAutomationHelper CLI (屏幕自动化小助手) from the model.
 *
 * Design notes that matter:
 *
 *  - ONE tool, not forty. The CLI exposes ~42 capability families. Registering
 *    one tool per subcommand would flood the model's tool list. Instead a single
 *    `screen_automation` tool takes an `action` enum plus a free-form `args`
 *    array, and its description carries the usage manual. This keeps the tool
 *    namespace small while still reaching the whole CLI.
 *
 *  - Risk tiers are computed BEFORE execution (`classify`). Read-only and
 *    screen-observation calls run directly; anything that moves the mouse,
 *    types, or mutates workflows is `mutate` and can require approval.
 *
 *  - Approval is fail-closed by construction: `ctx.approval.request` resolves
 *    'unavailable' when nobody answers, so an unattended session cannot
 *    accidentally drive the screen.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'

import {
  classify,
  findExact,
  isDestructive,
  resolveCliPath,
  resolveForegroundApp,
  runCli,
  stringifyForModel,
  type RiskTier,
} from './cli.js'

export const name = 'screen-helper'
export const inject = ['tools']

/** Plugin configuration, validated and defaulted by Cordis via the schema. */
/**
 * How much of the surface requires user approval before running.
 *
 * - `always`   — every call, including read-only ones, asks first.
 * - `mutating` — only actions that can move the mouse, type, or change state ask.
 * - `never`    — nothing asks; the model runs everything.
 */
export type ApprovalMode = 'always' | 'mutating' | 'never'

export interface Config {
  cliPath: string
  timeoutMs: number
  approval: ApprovalMode
  blockDestructive: boolean
}

export const Config: z<Config> = z.object({
  cliPath: z.string().default(''),
  timeoutMs: z.number().default(60_000),
  approval: z
    .union([z.const('always'), z.const('mutating'), z.const('never')])
    .default('never'),
  blockDestructive: z.boolean().default(false),
})

/** Whether a tier must ask under the configured mode. */
function needsApproval(mode: ApprovalMode, tier: RiskTier): boolean {
  if (mode === 'always') return true
  if (mode === 'mutating') return tier === 'mutate'
  return false
}

/**
 * Action catalogue: the model-facing vocabulary, grouped by tier. Kept as data
 * so the description and the schema cannot drift apart.
 */
const ACTIONS: Record<RiskTier, readonly string[]> = {
  read: [
    'status',
    'capabilities',
    'health',
    'connectors',
    'components',
    'runs.list',
    'runs.pending-agent',
    'latest',
    'result',
    'workflow.list',
    'workflow.show',
    'workflow.describe',
    'workflow.validate',
    'workflow.schema',
    'locator.find',
    'locator.wait',
    'task.status',
  ],
  observe: [
    'screen.capture',
    'screen.recognize',
    'screen.find',
    'find_exact',
    'screen.wait',
    'screen.contours',
    'screen.color-regions',
    'screen.match',
    'screen.monitors',
    'screen.work-area',
    'ui.tree',
    'ui.find',
    'ui.inspect',
    'dialog.inspect',
    'clipboard.read',
    'window',
    'window.app',
  ],
  mutate: [
    'mouse.move',
    'mouse.click',
    'mouse.down',
    'mouse.up',
    'mouse.long-press',
    'mouse.drag',
    'mouse.scroll',
    'keyboard.write',
    'keyboard.hotkey',
    'clipboard.write',
    'task.begin',
    'task.end',
    'task.observe',
    'task.click',
    'task.write',
    'task.hotkey',
    'task.wait',
    'task.find',
    'task.drag',
    'task.scroll',
    'task.long-press',
    'ui.click',
    'runs.pause',
    'runs.resume',
    'runs.stop',
    'runs.pause-all',
    'runs.resume-all',
    'runs.stop-all',
    'start-workflow',
    'debug-next',
    'overlay',
    'webview',
    'workflow.install',
    'workflow.remove',
    'workflow.inspect',
  ],
}

/** Turn `mouse.click` into the CLI subcommand path `['mouse','click']`. */
function actionToPath(action: string): string[] {
  return action.split('.')
}

/**
 * Actions that are computed in the plugin rather than passed straight to the
 * CLI. `find_exact` reuses `screen.recognize`'s word-level OCR and narrows the
 * result to the precise token boxes matching the query — something the CLI's
 * own `screen.find` cannot do, because it returns the whole line box.
 */
const COMPUTED_ACTIONS: Record<string, string[]> = {
  find_exact: ['screen', 'recognize'],
  // `window.app` resolves the foreground application (window foreground) and
  // extracts its icon to a PNG so the operator can see which app a pending
  // action will touch. Note: `ui.click` is intentionally NOT here — it must
  // classify as mutate (see runUiClick), not as observe-tier ui.find.
  'window.app': ['window', 'foreground'],
}

/** Resolve an action to the CLI path it ultimately invokes (computed or direct). */
function resolvePath(action: string): string[] {
  return COMPUTED_ACTIONS[action] ?? actionToPath(action)
}

/**
 * Shape returned by the tool body; declared again in `output.schema`.
 *
 * The index signature is required, not decorative: `output.schema` is an open
 * object, so `defineTool` infers `Record<string, JsonValue>` as the canonical
 * value type, and every member — including absent ones — must be assignable to
 * `JsonValue`. Optional data is therefore modeled as `null` rather than an
 * omitted key, which keeps the type total and the rendered output explicit.
 */
interface ToolValue {
  action: string
  tier: RiskTier
  /** True when the call actually reached the CLI. */
  executed: boolean
  /** Why a call was not executed; `null` when it ran. */
  blockedReason: string | null
  exitCode: number | null
  /** Parsed JSON when the CLI printed JSON, else `null`. */
  data: JsonValue | null
  /** Raw text when the CLI printed something other than JSON, else `null`. */
  text: string | null
  stderr: string | null
  [key: string]: JsonValue
}

export function apply(ctx: Context, config: Config): void {
  const cliPath = resolveCliPath(config.cliPath)

  ctx.tools.register(
    defineTool({
      name: 'screen_automation',
      description: buildDescription(config),

      parameters: {
        action: {
          type: 'string',
          required: true,
          description:
            'Which helper operation to run, e.g. "screen.recognize" or "mouse.click". See the action list in the description.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'CLI flags for the chosen action, each as its own element, e.g. ["--point","100,200","--button","left"]. Never pass a whole shell command here.',
        },
      },

      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
        render: (_args, value) => {
          const v = value as unknown as ToolValue
          const lines: string[] = []
          lines.push(`action: ${v.action} (${v.tier})`)

          if (!v.executed) {
            lines.push(`NOT EXECUTED: ${v.blockedReason ?? 'blocked by policy'}`)
            return [{ type: 'text', text: lines.join('\n') }]
          }

          lines.push(`exit code: ${v.exitCode}`)
          if (v.data !== null && v.data !== undefined) {
            lines.push('--- result (JSON) ---')
            lines.push(stringifyForModel(v.data))
          } else if (v.text !== null && v.text !== undefined && v.text !== '') {
            lines.push('--- result ---')
            lines.push(v.text)
          }
          if (v.stderr !== null && v.stderr !== undefined && v.stderr !== '') {
            lines.push('--- stderr ---')
            lines.push(v.stderr)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
        presentationMeta: (_args, value) => {
          const v = value as unknown as ToolValue
          return {
            action: v.action,
            tier: v.tier,
            executed: v.executed,
          }
        },
      },

      timeoutMs: config.timeoutMs + 5_000,

      // Screen input synthesis is inherently serial: two concurrent clicks race
      // for one physical cursor. Only non-mutating calls may run in parallel.
      isConcurrencySafe: (args) => classify(resolvePath(args.action)) !== 'mutate',

      async execute(args, exec): Promise<ToolValue> {
        const path = resolvePath(args.action)
        const tier = classify(path)
        const argv = args.args ?? []

        // 1. Hard block for destructive families, if the deployment enabled it.
        if (config.blockDestructive && isDestructive(path)) {
          return {
            action: args.action,
            tier,
            executed: false,
            blockedReason:
              'this deployment disables workflow mutation and clipboard writes (blockDestructive: true)',
            exitCode: null,
            data: null,
            text: null,
            stderr: null,
          }
        }

        // 2. Approval gate. Under `always` this covers read-only calls too.
        if (needsApproval(config.approval, tier)) {
          const decision = await requestApproval(ctx, exec, cliPath, config, tier, args.action, argv)
          if (decision !== GRANT) {
            return {
              action: args.action,
              tier,
              executed: false,
              blockedReason: `the user did not approve this action (${decision})`,
              exitCode: null,
              data: null,
              text: null,
              stderr: null,
            }
          }
        }

        // 3. Run it.
        // 3. Computed actions: `find_exact` runs screen.recognize (already
        //    approved above as observe-tier) and narrows the word-level OCR to
        //    precise token boxes. Runs here so the approval gate is honored.
        if (args.action === 'find_exact') {
          return runFindExact({ cliPath, argv, config, tier, exec, action: args.action })
        }
        if (args.action === 'ui.click') {
          return runUiClick({ cliPath, argv, config, tier, exec, action: args.action })
        }
        if (args.action === 'window.app') {
          return runWindowApp({ cliPath, config, tier, exec, action: args.action })
        }

        const outcome = await runCli({
          cliPath,
          invocation: { path, args: argv },
          timeoutMs: config.timeoutMs,
          signal: exec.signal,
        })

        if (!outcome.ok) {
          return {
            action: args.action,
            tier,
            executed: true,
            blockedReason: null,
            exitCode: outcome.exitCode,
            data: null,
            text: outcome.message,
            stderr: outcome.stderr,
          }
        }

        return {
          action: args.action,
          tier,
          executed: true,
          blockedReason: null,
          exitCode: 0,
          data: outcome.json ?? null,
          text: outcome.json === undefined ? outcome.stdout : null,
          stderr: null,
        }
      },
    }),
  )
}

/**
 * The only approval outcome that grants permission. Every other value in dsh's
 * closed vocabulary (`'rejected'`, `'cancelled'`, `'unavailable'`) denies, and
 * so does any rogue value a third-party answerer might return.
 */
const GRANT = 'allowed-once'

/**
 * Ask the user, fail-closed, and normalize every non-grant outcome to a refusal.
 *
 * `unavailable` covers "no answerer composed", "the answerer threw", and "a rogue
 * return value" — all of which must deny. The comparison is against the allow
 * token rather than a list of denial tokens so that an unrecognized outcome
 * denies too.
 */
async function requestApproval(
  ctx: Context,
  exec: { agent?: unknown; callId?: unknown; signal: AbortSignal },
  cliPath: string,
  config: Config,
  tier: RiskTier,
  action: string,
  argv: readonly string[],
): Promise<string> {
  const approval = (ctx as unknown as { approval?: { request?: Function } }).approval
  if (approval?.request === undefined) return 'unavailable'

  // For actions that touch the screen, name the foreground app in the reason so
  // the human approving sees *which application* is about to be operated — not
  // just the tool action. The dsh popup renders `reason` text only (no icon
  // field), so the icon itself is surfaced separately via `window.app`.
  let appNote = ''
  if (tier === 'mutate') {
    const app = await resolveForegroundApp(cliPath, config.timeoutMs, exec.signal)
    if (app.process || app.title) {
      appNote = ` on ${app.displayName}`
    }
  }
  const preview = argv.length === 0 ? '(no arguments)' : argv.join(' ')
  const reason = `ScreenAutomationHelper is about to perform "${action}"${appNote} on your real screen: ${preview}`
  try {
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: 'screen_automation',
      callId: exec.callId,
      signal: exec.signal,
      reason,
    })
    return typeof outcome === 'string' ? outcome : 'unavailable'
  } catch {
    // A throwing asker must not become an allow.
    return 'unavailable'
  }
}

/**
 * `find_exact` action: precise word-level text location.
 *
 * `screen.find` returns the box of the whole *line* containing a hit, which is
 * too coarse to click a small control. We instead run `screen.recognize` (which
 * emits one box per token) and filter its `items` for tokens containing the
 * query, returning their exact boxes. The result is derived from the OCR items,
 * so this is an `observe`-tier action that still requires approval under
 * `always`. Pass `--text QUERY` and optionally `--region X,Y,W,H`.
 */
async function runFindExact(params: {
  cliPath: string
  argv: readonly string[]
  config: Config
  tier: RiskTier
  exec: { signal: AbortSignal }
  action: string
}): Promise<ToolValue> {
  // Derive the query from `--text QUERY`. `screen.recognize` has no `--text`
  // flag of its own, so strip both `--text` and `--text-only` before invoking
  // it; only region/target flags are forwarded. The query is used purely to
  // filter the recognized items.
  const argv = params.argv.filter((a) => a !== '--text-only')
  const ti = argv.indexOf('--text')
  const query = ti >= 0 && ti + 1 < argv.length ? (argv[ti + 1] ?? '') : ''
  const recArgs = ti >= 0
    ? [...argv.slice(0, ti), ...argv.slice(ti + 2)]
    : argv

  const outcome = await runCli({
    cliPath: params.cliPath,
    invocation: { path: ['screen', 'recognize'], args: recArgs },
    timeoutMs: params.config.timeoutMs,
    signal: params.exec.signal,
  })

  if (!outcome.ok) {
    return {
      action: params.action,
      tier: params.tier,
      executed: true,
      blockedReason: null,
      exitCode: outcome.exitCode,
      data: null,
      text: outcome.message,
      stderr: outcome.stderr,
    }
  }

  const items = (outcome.json as { items?: unknown } | undefined)?.items
  const result = findExact(
    Array.isArray(items)
      ? (items as Array<{ text: string; confidence: number; box: number[]; center: number[] }>)
      : [],
    query,
  )
  return {
    action: params.action,
    tier: params.tier,
    executed: true,
    blockedReason: null,
    exitCode: 0,
    data: result as unknown as JsonValue,
    text: null,
    stderr: null,
  }
}

/**
 * `ui.click` action: click a control identified by its UI-tree identity.
 *
 * SAH's `ui.find` returns element role/name (a semantic handle) but not geometry,
 * and there is no element-scoped click channel (`task.click` requires a pixel
 * `--point`). So we (1) confirm the control exists by role/name, then (2) locate
 * it on screen with word-level OCR (`find_exact`) and (3) click the resulting
 * pixel box. The `ui.find` step is the identity check: it fails loudly when the
 * named control is absent or ambiguous, instead of blindly trusting OCR.
 *
 * Args: forward `--name`, `--role`, `--match`, `--target`, `--limit`,
 * `--max-depth`, `--max-nodes` to `ui.find`; the located text is then matched by
 * `find_exact` using the same `--name` value. Pass `--button`/`--duration` to
 * tune the click. Pass `--verify` to close the loop: after clicking, `ui.inspect`
 * re-reads the element actually under the cursor and the action reports whether
 * its role/name matches the `ui.find` expectation (catches mis-clicks on the
 * wrong control).
 */
async function runUiClick(params: {
  cliPath: string
  argv: readonly string[]
  config: Config
  tier: RiskTier
  exec: { signal: AbortSignal }
  action: string
}): Promise<ToolValue> {
  const argv = params.argv
  const nameIdx = argv.indexOf('--name')
  const name =
    nameIdx >= 0 && nameIdx + 1 < argv.length ? (argv[nameIdx + 1] ?? '') : ''
  const roleIdx = argv.indexOf('--role')
  const role =
    roleIdx >= 0 && roleIdx + 1 < argv.length ? (argv[roleIdx + 1] ?? '') : ''

  // Step 1: confirm the control by UI-tree identity. A --role constraint can
  // miss a control that is present but not currently exposed under that exact
  // role (UIA visibility flakiness), so retry once without the role filter.
  // ui.click-only flags (--verify/--button) are stripped before reaching ui.find.
  const uiFindArgs = argv.filter((a) => a !== '--verify' && a !== '--button')
  let findOutcome = await runCli({
    cliPath: params.cliPath,
    invocation: { path: ['ui', 'find'], args: uiFindArgs },
    timeoutMs: params.config.timeoutMs,
    signal: params.exec.signal,
  })
  if (!findOutcome.ok || (findOutcome.json as Record<string, unknown> | undefined)?.status !== 'matched') {
    // Drop `--role` (and its following value), keep everything else.
    const cleaned: string[] = []
    for (let i = 0; i < uiFindArgs.length; i++) {
      if (uiFindArgs[i] === '--role') { i++; continue }
      cleaned.push(uiFindArgs[i] as string)
    }
    if (cleaned.length !== uiFindArgs.length) {
      findOutcome = await runCli({
        cliPath: params.cliPath,
        invocation: { path: ['ui', 'find'], args: cleaned },
        timeoutMs: params.config.timeoutMs,
        signal: params.exec.signal,
      })
    }
  }
  const findJson = findOutcome.ok ? (findOutcome.json as Record<string, unknown> | undefined) : undefined
  const status = typeof findJson?.status === 'string' ? findJson.status : 'not_found'
  const count = typeof findJson?.count === 'number' ? findJson.count : 0

  if (status !== 'matched' || count < 1) {
    return {
      action: params.action,
      tier: params.tier,
      executed: true,
      blockedReason: null,
      exitCode: findOutcome.ok ? 0 : findOutcome.exitCode,
      data: {
        step: 'ui.find',
        status,
        count,
        error: status === 'ambiguous' ? 'multiple controls match; narrow with --role or --match' : 'control not found in the UI tree',
      } as unknown as JsonValue,
      text: null,
      stderr: findOutcome.ok ? null : findOutcome.stderr,
    }
  }

  // Step 2: locate on screen via word-level OCR, reusing find_exact's ranking.
  const query = name || role
  if (!query) {
    return {
      action: params.action,
      tier: params.tier,
      executed: true,
      blockedReason: null,
      exitCode: 0,
      data: {
        step: 'ui.find',
        status,
        count,
        error: 'no --name or --role given; cannot resolve a pixel target without text to OCR',
      } as unknown as JsonValue,
      text: null,
      stderr: null,
    }
  }
  const recArgs = ['--target', (pickTarget(argv) ?? 'virtual-screen')]
  const rec = await runCli({
    cliPath: params.cliPath,
    invocation: { path: ['screen', 'recognize'], args: recArgs },
    timeoutMs: params.config.timeoutMs,
    signal: params.exec.signal,
  })
  if (!rec.ok) {
    return {
      action: params.action,
      tier: params.tier,
      executed: true,
      blockedReason: null,
      exitCode: rec.exitCode,
      data: { step: 'screen.recognize', error: 'OCR failed' } as unknown as JsonValue,
      text: rec.message,
      stderr: rec.stderr,
    }
  }
  const items = (rec.json as { items?: unknown } | undefined)?.items
  const ranked = findExact(
    Array.isArray(items)
      ? (items as Array<{ text: string; confidence: number; box: number[]; center: number[] }>)
      : [],
    query,
  )
  const target = ranked.matches[0]
  if (!target) {
    return {
      action: params.action,
      tier: params.tier,
      executed: true,
      blockedReason: null,
      exitCode: 0,
      data: {
        step: 'find_exact',
        status,
        count,
        error: `UI control "${query}" confirmed in tree, but no on-screen text matched it for clicking`,
      } as unknown as JsonValue,
      text: null,
      stderr: null,
    }
  }

  // Step 3: click the pixel box of the located token.
  const center = target.center
  const buttonIdx = argv.indexOf('--button')
  const button =
    buttonIdx >= 0 && buttonIdx + 1 < argv.length ? (argv[buttonIdx + 1] ?? 'left') : 'left'
  const clickArgs = ['--point', `${center[0]},${center[1]}`, '--button', button]
  const click = await runCli({
    cliPath: params.cliPath,
    invocation: { path: ['mouse', 'click'], args: clickArgs },
    timeoutMs: params.config.timeoutMs,
    signal: params.exec.signal,
  })
  const base = {
    uiStatus: status,
    uiCount: count,
    locatedText: target.text,
    box: target.box,
    center,
    button,
  }

  // Step 4 (optional): verify the click landed on the intended control.
  // ui.inspect at the clicked point returns the element actually under the
  // cursor — its role/name — which we compare against the ui.find expectation.
  // This closes the loop Codex/CUA-style agents use: OCR gives a pixel, but the
  // accessibility tree confirms the pixel maps to the right control, catching
  // the "right button, wrong screen" failure where a click lands mid-animation
  // or on an overlapping element.
  const verify = argv.includes('--verify')
  if (!verify) {
    return {
      action: params.action,
      tier: params.tier,
      executed: true,
      blockedReason: null,
      exitCode: click.ok ? 0 : click.exitCode,
      data: { step: 'clicked', ...base } as unknown as JsonValue,
      text: click.ok ? null : click.message,
      stderr: click.ok ? null : click.stderr,
    }
  }

  const target_ = pickTarget(argv) ?? 'virtual-screen'
  const inspect = await runCli({
    cliPath: params.cliPath,
    invocation: {
      path: ['ui', 'inspect'],
      args: ['--target', target_, '--point', `${center[0]},${center[1]}`],
    },
    timeoutMs: params.config.timeoutMs,
    signal: params.exec.signal,
  })
  const el = (inspect.ok ? (inspect.json as Record<string, unknown> | undefined)?.element : undefined) as
    | { role?: string; name?: string }
    | undefined
  const landedRole = el?.role ?? ''
  const landedName = el?.name ?? ''
  const roleMatch = role ? landedRole.toLowerCase() === role.toLowerCase() : true
  const nameMatch = name ? landedName.includes(name) || name.includes(landedName) : true
  const verified = roleMatch && nameMatch && landedRole !== ''

  return {
    action: params.action,
    tier: params.tier,
    executed: true,
    blockedReason: null,
    exitCode: click.ok ? 0 : click.exitCode,
    data: {
      step: verified ? 'clicked+verified' : 'clicked+verify-mismatch',
      ...base,
      verify: {
        inspectedRole: landedRole,
        inspectedName: landedName,
        roleMatch,
        nameMatch,
        verified,
        warning: verified
          ? undefined
          : `clicked point landed on role="${landedRole}" name="${landedName}", which does not match expected role="${role}" name="${name}"`,
      },
    } as unknown as JsonValue,
    text: click.ok ? null : click.message,
    stderr: inspect.ok ? null : inspect.stderr,
  }
}

/**
 * `window.app` action: identify the foreground application and extract its icon.
 *
 * Lets the operator (and the model) *see which app* a screen operation will
 * touch — a visual aid for the approval step. dsh's approval popup renders only a
 * text `reason`, so the icon is returned here as a PNG path the GUI can display,
 * while the textual identity (name/title/exe) goes in the normal result. Returns
 * the raw `window foreground` JSON plus `displayName` and `iconPath`.
 */
async function runWindowApp(params: {
  cliPath: string
  config: Config
  tier: RiskTier
  exec: { signal: AbortSignal }
  action: string
}): Promise<ToolValue> {
  const app = await resolveForegroundApp(params.cliPath, params.config.timeoutMs, params.exec.signal)
  const outcome = await runCli({
    cliPath: params.cliPath,
    invocation: { path: ['window', 'foreground'], args: [] },
    timeoutMs: params.config.timeoutMs,
    signal: params.exec.signal,
  })
  const base = outcome.ok ? (outcome.json as Record<string, unknown> | undefined) : undefined
  return {
    action: params.action,
    tier: params.tier,
    executed: true,
    blockedReason: null,
    exitCode: outcome.ok ? 0 : outcome.exitCode,
    data: {
      ...(base ?? {}),
      displayName: app.displayName,
      iconPath: app.iconPath,
    } as unknown as JsonValue,
    text: outcome.ok ? null : outcome.message,
    stderr: outcome.ok ? null : outcome.stderr,
  }
}

/** Pull `--target` from argv if present, else undefined. */
function pickTarget(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--target')
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] as string | undefined) : undefined
}

/** Compose the model-facing manual from the action catalogue. */
function buildDescription(config: Config): string {
  const list = (tier: RiskTier): string => ACTIONS[tier].join(', ')
  const policy = {
    always:
      'Every call — including read-only ones — requires the user to approve it in the UI before the helper runs. A call the user does not approve returns without executing.',
    mutating:
      'Actions that move the mouse, type, or change state require user approval before running; read-only actions run without asking.',
    never: 'This deployment runs every action without asking (approval: never).',
  }[config.approval]

  return [
    'Control the local "屏幕自动化小助手" (ScreenAutomationHelper) to see and operate the Windows desktop: screenshot, OCR text recognition, locate on-screen text or images, read the UI element tree, and move the mouse / type / use the clipboard.',
    '',
    'Pass `action` plus a `args` array of CLI flags (one flag per element). This tool never runs a shell: each element is passed as a literal argument.',
    '',
    `READ (safe, no side effects): ${list('read')}`,
    `OBSERVE (captures screen content): ${list('observe')}`,
    `MUTATE (moves mouse / types / changes state): ${list('mutate')}`,
    '',
    'Typical flow: screen.recognize or ui.tree to see the current state, then either screen.find (line-level) or find_exact (precise token box) to get coordinates of a target, then mouse.click with --point "x,y".',
    'Call window.app before a sequence of mutate actions to identify the foreground application and extract its icon (displayName + iconPath); this lets the operator see which app is about to be touched.',
    'find_exact is preferred for clicking a specific label or button: it returns the exact box of the matching token, not the whole line.',
    'ui.click is the semantic path: pass --name (and optionally --role) to confirm a control exists in the UI tree by identity, then it auto-resolves the on-screen pixel via OCR and clicks it. Add --verify to re-inspect the clicked point and confirm it landed on the expected control (the same closed-loop check CUA/Codex-style agents use to avoid clicking the wrong element).',
    'ui.tree / ui.find / ui.inspect read the accessibility (UIA) tree: identity and hierarchy, not pixel geometry. SAH does not expose element bounding boxes via ui.find, so ui.click resolves a pixel via OCR; ui.inspect --point does return the element bounds/name under a cursor, which --verify relies on.',
    'Coordinates are absolute screen pixels; use screen.monitors to check the display layout first.',
    '',
    policy,
    'The helper must be installed locally; if calls fail, run action "health" to diagnose.',
  ].join('\n')
}
