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
import { randomBytes } from 'node:crypto'

import {
  classify,
  findExact,
  isDestructive,
  resolveCliPath,
  resolveDsboxPath,
  resolveForegroundApp,
  runBackgroundInput,
  runCli,
  stringifyForModel,
  type OcrItem,
  type RiskTier,
} from './cli.js'

export const name = 'screen-helper'
export const inject = ['tools']

/** Plugin configuration, validated and defaulted by Cordis via the schema. */
/**
 * How much of the surface requires user approval before running.
 *
 * - `always`   —every call, including read-only ones, asks first.
 * - `mutating` —only actions that can move the mouse, type, or change state ask.
 * - `never`    —nothing asks; the model runs everything.
 */
export type ApprovalMode = 'always' | 'mutating' | 'never'

/**
 * How the plugin itself gates screen-mutating actions when dsh's native
 * approval popup is unavailable (e.g. in sessions where approval prompts are
 * disabled and fail closed). The plugin renders its own confirmation card
 * instead of relying on the host's popup.
 *
 * - `popup` —every mutate shows a confirmation card (with the target app's
 *   icon + name) before running; the real action executes only after the user
 *   approves the returned token.
 * - `off`    —the plugin runs mutate actions directly (no plugin-side gate).
 */
export type ConfirmMode = 'popup' | 'off'

/**
 * How screen input is delivered to the target application.
 *
 * - `background` (default) —input is sent as Win32 messages to the target
 *   window's child control. The physical cursor never moves and keyboard focus
 *   is never stolen, so the operator keeps using their own mouse while the
 *   model drives another window. Only works on applications that handle
 *   standard window messages; self-drawn UIs (Electron/Chrome/Qt) may ignore
 *   them, and the plugin reports that honestly instead of silently
 *   falling back to the real cursor.
 * - `real` —moves the physical cursor via ScreenAutomationHelper (works
 *   everywhere, but does take over the mouse).
 */
export type InputMode = 'background' | 'real'

export interface Config {
  cliPath: string
  timeoutMs: number
  approval: ApprovalMode
  confirm: ConfirmMode
  inputMode: InputMode
  autoFallback: boolean
  blockDestructive: boolean
}

export const Config: z<Config> = z.object({
  cliPath: z.string().default(''),
  timeoutMs: z.number().default(60_000),
  approval: z
    .union([z.const('always'), z.const('mutating'), z.const('never')])
    .default('never'),
  confirm: z.union([z.const('popup'), z.const('off')]).default('popup'),
  inputMode: z.union([z.const('background'), z.const('real')]).default('background'),
  // When true and the target window cannot receive background input at all (no
  // child HWNDs — self-drawn UI), retry once with the real cursor instead of
  // returning a click that will be ignored. Off by default: moving the user's
  // mouse is exactly what background mode promises not to do, so it must be an
  // explicit choice.
  autoFallback: z.boolean().default(false),
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
    'probe',
    'panel.begin',
    'panel.step',
    'panel.finish',
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
    'window.confirm',
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
 * result to the precise token boxes matching the query —something the CLI's
 * own `screen.find` cannot do, because it returns the whole line box.
 */
const COMPUTED_ACTIONS: Record<string, string[]> = {
  find_exact: ['screen', 'recognize'],
  // `window.app` resolves the foreground application (window foreground) and
  // extracts its icon to a PNG so the operator can see which app a pending
  // action will touch. Note: `ui.click` is intentionally NOT here —it must
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
 * value type, and every member —including absent ones —must be assignable to
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

/**
 * Plugin-enforced confirmation gate.
 *
 * dsh's native approval popup fails closed in sessions where approval prompts
 * are disabled, so it can never ask. To still let the operator veto a screen
 * action, the plugin gates mutate calls itself: the first call does not run —
 * it stashes the intended action under a one-time token and returns
 * `blockedReason: 'awaiting confirmation'` with the token + target app info in
 * `data`. The model then surfaces a confirmation card, and the real action
 * executes only when `window.confirm --approve <token>` is called.
 */
interface PendingAction {
  action: string
  argv: readonly string[]
  cliPath: string
  config: Config
  tier: RiskTier
  appName: string
  appTitle: string | null
  iconPath: string | null
  createdAt: number
}
const pendingActions = new Map<string, PendingAction>()
const PENDING_TTL_MS = 10 * 60_000

function makeToken(): string {
  return randomBytes(6).toString('hex')
}

function prunePending(): void {
  const now = Date.now()
  for (const [tok, p] of pendingActions) {
    if (now - p.createdAt > PENDING_TTL_MS) pendingActions.delete(tok)
  }
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

        // 1b. Plugin-enforced confirmation gate. When `confirm: popup` and this is
        // a mutate call that is NOT itself the approval-resolving `window.confirm`
        // action and does not carry an `--token`, stash the intended action and
        // hand back a token so the model can surface a confirmation card. The
        // real action runs only through `window.confirm --approve <token>`.
        if (
          config.confirm === 'popup' &&
          tier === 'mutate' &&
          args.action !== 'window.confirm' &&
          !argv.includes('--token')
        ) {
          prunePending()
          const app = await resolveForegroundApp(cliPath, config.timeoutMs, exec.signal)
          const token = makeToken()
          pendingActions.set(token, {
            action: args.action,
            argv,
            cliPath,
            config,
            tier,
            appName: app.displayName,
            appTitle: app.title,
            iconPath: app.iconPath,
            createdAt: Date.now(),
          })
          return {
            action: args.action,
            tier,
            executed: false,
            blockedReason: 'awaiting confirmation',
            exitCode: null,
            data: {
              confirmToken: token,
              pendingAction: args.action,
              pendingArgs: argv,
              appName: app.displayName,
              appTitle: app.title,
              iconPath: app.iconPath,
            } as unknown as JsonValue,
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

        if (args.action === 'window.confirm') {
          return runWindowConfirm({ argv, exec })
        }

        // 3. Run it (shared with the approve path so policies cannot diverge).
        return dispatch({ action: args.action, argv, cliPath, config, exec })
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
 * return value" —all of which must deny. The comparison is against the allow
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
  // the human approving sees *which application* is about to be operated —not
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
  // --hwnd/--title: SAH's ui.find rejects them outright, but dsbox's
  // implementation scopes the UIA scan to that window's subtree —far fewer
  // false matches from unrelated apps— so they are kept when dsbox is present.
  const dsboxActive = resolveDsboxPath() !== null
  const uiFindArgs: string[] = []
  {
    let skip = false
    for (const a of argv) {
      if (skip) { skip = false; continue }
      if (a === '--verify' || a === '--button') continue
      if ((a === '--hwnd' || a === '--title') && !dsboxActive) { skip = true; continue }
      uiFindArgs.push(a as string)
    }
  }
  // When dsbox is present it owns the whole ui.click pipeline (identity via
  // scoped UIA, OCR fallback, click delivery), so route every step to it —
  // not just the delivery. `params.cliPath` may still point at SAH.
  const enginePath = (dsboxActive ? resolveDsboxPath() : null) ?? params.cliPath
  let findOutcome = await runCli({
    cliPath: enginePath,
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
        cliPath: enginePath,
        invocation: { path: ['ui', 'find'], args: cleaned },
        timeoutMs: params.config.timeoutMs,
        signal: params.exec.signal,
      })
    }
  }
  const findJson = findOutcome.ok ? (findOutcome.json as Record<string, unknown> | undefined) : undefined
  const status = typeof findJson?.status === 'string' ? findJson.status : 'not_found'
  const count = typeof findJson?.count === 'number' ? findJson.count : 0

  // dsbox's ui.find returns element geometry (box/center); SAH's does not.
  // When exactly one UIA element matches, clicking its own coordinates is
  // strictly more accurate than OCR-guessing the label's pixel position —and
  // it works for labels OCR misreads (low contrast, overlapping text).
  const uiMatches = Array.isArray(findJson?.matches)
    ? (findJson.matches as Array<{ name?: string; role?: string; box?: number[]; center?: number[] }>)
    : []
  const uiaTarget =
    status === 'matched' && uiMatches.length === 1 && Array.isArray(uiMatches[0]?.center)
      ? uiMatches[0]
      : null

  // The UI tree is often empty or unhelpful: desktop icons, Electron and other
  // self-drawn apps expose little to no UIA. A silent tree therefore does not
  // mean the control is absent, so fall through to the OCR step below and let
  // the label itself decide —flagging that identity was never confirmed.
  // Only bail here when there is no text to look for at all.
  const identityConfirmed = status === 'matched' && count >= 1
  if (!identityConfirmed && !name && !role) {
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

  // Step 2: locate on screen. With a unique UIA hit the element's own box is
  // the target —no OCR round-trip needed. Otherwise fall back to word-level
  // OCR and reuse find_exact's ranking.
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
  // Resolve the delivery-target window BEFORE OCR: when it is known, OCR can be
  // region-limited to that window (a small region runs ~5x faster than a full
  // screen scan — 2.8s vs 16s measured) and the result is scoped in the same
  // stroke. Otherwise the whole screen is scanned.
  const scopeRect = await resolveTargetRect({
    cliPath: enginePath,
    hwnd: numericFlag(argv, '--hwnd'),
    title: flagValue(argv, '--title'),
    timeoutMs: params.config.timeoutMs,
    signal: params.exec.signal,
  })

  // UIA fast path: the unique element match already carries a pixel-accurate
  // box/center in screen coordinates. Skip OCR entirely.
  let target: OcrItem | null = null
  let items: OcrItem[] = []
  let recArgs: string[] = []
  if (uiaTarget && Array.isArray(uiaTarget.box) && uiaTarget.box.length === 4) {
    target = {
      text: uiaTarget.name ?? query,
      confidence: 1,
      box: uiaTarget.box,
      center: uiaTarget.center as number[],
    }
  } else {
    recArgs = ['--target', pickTarget(argv) ?? 'virtual-screen']
    if (scopeRect) recArgs.push('--region', scopeRect.join(','))
    const rec = await runCli({
      cliPath: enginePath,
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
        data: { step: 'screen.recognize', error: 'OCR failed', identityConfirmed } as unknown as JsonValue,
        text: rec.message,
        stderr: rec.stderr,
      }
    }
    items = ((rec.json as { items?: unknown } | undefined)?.items ?? []) as OcrItem[]
  }

  // When the caller scoped the click to a window, only accept text inside it.
  // Otherwise the whole screen is searched and the first match may sit outside
  // the target —which the out-of-bounds guard then rightly refuses.
  let scopedOut = 0
  let ranked: { query: string; count: number; matches: OcrItem[] } = { query, count: 0, matches: [] }
  if (uiaTarget) {
    ranked = { query, count: 1, matches: [target as { text: string; confidence: number; box: number[]; center: number[] }] }
  } else {
    ranked = findExact(items, query)
    if (scopeRect) {
      const [x1, y1, x2, y2] = scopeRect
      const before = ranked.matches.length
      // Score by overlap, not by whether the centre point is inside: a token whose
      // box straddles the window border has its centre just outside and would be
      // rejected by the bounds guard after being chosen. Prefer tokens fully
      // inside, then fall back to the most-overlapping one.
      const overlaps = ranked.matches.map((m) => {
        const b = m.box ?? []
        const bx1 = b[0] ?? m.center[0] ?? 0
        const by1 = b[1] ?? m.center[1] ?? 0
        const bx2 = b[2] ?? bx1
        const by2 = b[3] ?? by1
        const ix1 = Math.max(bx1, x1)
        const iy1 = Math.max(by1, y1)
        const ix2 = Math.min(bx2, x2)
        const iy2 = Math.min(by2, y2)
        const area = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
        const boxArea = Math.max(1, (bx2 - bx1) * (by2 - by1))
        const cx = m.center[0] ?? 0
        const cy = m.center[1] ?? 0
        return { m, area, frac: area / boxArea, inside: cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2 }
      })
      const contained = overlaps.filter((o) => o.inside && o.area > 0).map((o) => o.m)
      if (contained.length > 0) {
        scopedOut = before - contained.length
        ranked = { query: ranked.query, count: contained.length, matches: contained }
      } else {
        const partial = overlaps.filter((o) => o.frac > 0)
        scopedOut = before - partial.length
        if (partial.length > 0) {
          partial.sort((a, b) => b.frac - a.frac)
          const best = partial.map((o) => o.m)
          ranked = { query: ranked.query, count: best.length, matches: best }
        }
      }
    }
  }
  target = ranked.matches[0] ?? null
  // With no UI-tree confirmation the click is only a guess from OCR. If several
  // on-screen tokens matched, silently taking the first one can hit the wrong
  // element —report the count and the alternatives so the caller knows.
  // (A unique UIA hit bypasses this: its own coordinates are exact.)
  const uiaLocated = uiaTarget !== null
  const ocrMatchCount = ranked.matches.length
  const ocrAmbiguous = !identityConfirmed && ocrMatchCount > 1
  const ocrAlternatives = ocrAmbiguous
    ? ranked.matches.slice(0, 5).map((m) => ({ text: m.text, center: m.center }))
    : []
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
        error: identityConfirmed
          ? `UI control "${query}" confirmed in tree, but no on-screen text matched it for clicking`
          : `UI control "${query}" was not found in the UI tree, and no on-screen text matched it either`,
        identityConfirmed,
      } as unknown as JsonValue,
      text: null,
      stderr: null,
    }
  }

  // A token whose box straddles the window border has its centre just outside,
  // which the bounds guard would reject. Clamp into the window instead so the
  // click lands on the part of the token that is actually visible.
  let center = target.center
  if (scopeRect) {
    const [x1, y1, x2, y2] = scopeRect
    const cx = center[0] ?? 0
    const cy = center[1] ?? 0
    const nx = Math.min(Math.max(cx, x1), x2)
    const ny = Math.min(Math.max(cy, y1), y2)
    if (nx !== cx || ny !== cy) center = [nx, ny]
  }

  // Step 3: click the pixel box of the located token.
  const buttonIdx = argv.indexOf('--button')
  const button =
    buttonIdx >= 0 && buttonIdx + 1 < argv.length ? (argv[buttonIdx + 1] ?? 'left') : 'left'
  const clickArgs = ['--point', `${center[0]},${center[1]}`, '--button', button]

  // Background delivery: `ui.click` is the most accurate click path (UIA
  // identity + OCR + optional verify), so it is the one callers reach for by
  // default. Routing only `mouse.click` would leave the primary path still
  // grabbing the cursor. Same message-based delivery, cursor untouched.
  if (params.config.inputMode === 'background') {
    // dsbox UIA-invoke fast path: when the located target is a real UIA element
    // that supports InvokePattern, the app clicks ITSELF through the
    // accessibility channel —no cursor movement AND no window messages, so it
    // also works on UWP/self-drawn apps where SendMessage is ignored.

    const baseBg = {
      uiStatus: status,
      uiCount: count,
      locatedText: target.text,
      box: target.box,
      center,
      button,
      inputMode: 'background',
      identityConfirmed,
      ...(scopeRect ? { scopedToRect: scopeRect, scopedOut } : {}),
      ...(ocrAmbiguous ? { ocrAmbiguous: true, ocrMatchCount, ocrAlternatives } : {}),
    } as Record<string, unknown>
    if (dsboxActive && uiaLocated && uiaTarget?.name) {
      const inv = await runCli({
        cliPath: enginePath,
        invocation: {
          path: ['ui', 'invoke'],
          args: ['--name', uiaTarget.name, ...(numericFlag(argv, '--hwnd') !== undefined ? ['--hwnd', String(numericFlag(argv, '--hwnd'))] : [])],
        },
        timeoutMs: params.config.timeoutMs,
        signal: params.exec.signal,
      })
      const invJson = inv.ok ? (inv.json as Record<string, unknown> | undefined) : undefined
      if (invJson?.status === 'invoked') {
        return {
          action: params.action, tier: params.tier, executed: true,
          blockedReason: null, exitCode: 0,
          data: {
            step: 'clicked',
            ...baseBg,
            deliveryMethod: 'uia-invoke',
            invokedElement: invJson.element,
            backgroundCaveat: null,
          } as unknown as JsonValue,
          text: null, stderr: null,
        }
      }
      // invoke failed (no pattern / not found) — fall through to message click
    }
    // Save the foreground BEFORE delivery: the target app may activate itself
    // in response (async, ~600ms later) and steal it.
    const preFg = await runCli({
      cliPath: enginePath,
      invocation: { path: ['window', 'foreground'], args: [] },
      timeoutMs: params.config.timeoutMs,
      signal: params.exec.signal,
    })
    const preFgJson = preFg.ok ? (preFg.json as Record<string, unknown> | undefined) : undefined
    const preFgHandle = preFgJson?.handle
    const savedFgHwnd = typeof preFgHandle === 'number' ? preFgHandle : undefined
    const bgClick = await runBackgroundInput({
      action: 'click',
      x: center[0],
      y: center[1],
      title: flagValue(argv, '--title'),
      hwnd: numericFlag(argv, '--hwnd'),
      timeoutMs: params.config.timeoutMs,
    })
    if (!bgClick) {
      return {
        action: params.action, tier: params.tier, executed: false,
        blockedReason: 'background input helper unavailable; refusing to fall back to the real cursor while inputMode is "background"',
        exitCode: null, data: { step: 'clicked', ...baseBg } as unknown as JsonValue,
        text: null, stderr: null,
      }
    }
    if (bgClick.ok === false) {
      return {
        action: params.action, tier: params.tier, executed: true,
        blockedReason: typeof bgClick.error === 'string' ? bgClick.error : 'background input was not delivered',
        exitCode: 1, data: { step: 'clicked', ...baseBg, ...bgClick } as unknown as JsonValue,
        text: null, stderr: null,
      }
    }
    // `--verify` in background mode: when dsbox is present, ui.inspect --point
    // reads the element identity at the clicked point from the UIA tree —no
    // cursor movement involved. That is a direct role/name check, far stronger
    // than the OCR-diff fallback (which only says "something changed").
    const verifyRequested = argv.includes('--verify')
    let verify: Record<string, unknown> = {}
    if (verifyRequested && dsboxActive) {
      const inspect = await runCli({
        cliPath: enginePath,
        invocation: {
          path: ['ui', 'inspect'],
          args: ['--point', `${center[0]},${center[1]}`],
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
      const nameMatch = name ? (landedName.includes(name) || name.includes(landedName)) : true
      const verified = roleMatch && nameMatch && landedRole !== ''
      verify = {
        verifyMethod: 'uia-point',
        verified,
        landedRole,
        landedName: landedName.slice(0, 80),
        ...(!verified ? { verifyNote: 'the element now under the clicked point does not match the requested control; the UI may have changed under the click, or the control reports no accessible identity' } : {}),
      }
    } else if (verifyRequested) {
      const after = await runCli({
        cliPath: enginePath,
        invocation: { path: ['screen', 'recognize'], args: recArgs },
        timeoutMs: params.config.timeoutMs,
        signal: params.exec.signal,
      })
      if (after.ok) {
        const afterItems = (after.json as { items?: unknown } | undefined)?.items
        const afterTexts = new Set(
          (Array.isArray(afterItems) ? (afterItems as Array<{ text: string }>) : []).map(
            (i) => i.text,
          ),
        )
        const beforeTexts = new Set(
          (Array.isArray(items) ? (items as Array<{ text: string }>) : []).map((i) => i.text),
        )
        const added = [...afterTexts].filter((t) => !beforeTexts.has(t))
        const removed = [...beforeTexts].filter((t) => !afterTexts.has(t))
        verify = {
          verifyMethod: 'ocr-diff',
          verifySkipped: false,
          changesDetected: added.length + removed.length,
          added: added.slice(0, 5),
          removed: removed.slice(0, 5),
          verifyNote:
            'Verified by re-reading the screen and diffing OCR text (ui.inspect cannot be used ' +
            'in background mode). A change means the click did something; it does NOT confirm ' +
            'the right control was hit, and an unchanged screen does not prove failure.',
        }
      } else {
        verify = {
          verifyMethod: 'ocr-diff',
          verifySkipped: true,
          verifyNote: 'Could not re-read the screen to verify; the click was still delivered.',
        }
      }
    }
    // Structural check on top of the class-name heuristic: a window with no
    // child HWNDs can only receive the click on its top level, which self-drawn
    // apps usually ignore. Better to say that than report a clean click that
    // silently did nothing.
    const clickHwnd = numericFlag(argv, '--hwnd')
    const structProbe =
      clickHwnd !== undefined
        ? await runBackgroundInput({
            action: 'probe',
            x: center[0],
            y: center[1],
            hwnd: clickHwnd,
            timeoutMs: params.config.timeoutMs,
          })
        : null
    const noChildWindows = structProbe !== null && structProbe.childCount === 0
    const structNote: Record<string, unknown> = noChildWindows
      ? {
          noChildWindows: true,
          structuralCaveat:
            'This window exposes no child HWNDs, so the click could only be sent to its ' +
            'top-level window; self-drawn apps usually ignore that, so it may have had no ' +
            'effect. To drive this window, retry the same call with --input-mode real ' +
            '(which moves the physical cursor), or run `probe --hwnd <handle>` first.',
        }
      : {}

    // Opt-in rescue: the background click above was delivered but will almost
    // certainly be ignored. Retry once with the real cursor so the call actually
    // does something — but only when autoFallback is on, because moving the
    // user's mouse without being asked is what background mode exists to avoid.
    const clickArgsBg = clickArgs
    if (noChildWindows && params.config.autoFallback) {
      const realClick = await runCli({
        cliPath: enginePath,
        invocation: { path: ['mouse', 'click'], args: clickArgsBg },
        timeoutMs: params.config.timeoutMs,
        signal: params.exec.signal,
      })
      return {
        action: params.action, tier: params.tier, executed: true,
        blockedReason: null, exitCode: realClick.ok ? 0 : realClick.exitCode,
        data: {
          step: 'clicked',
          ...baseBg,
          inputMode: 'real',
          autoFallbackUsed: true,
          fallbackReason:
            'background delivery cannot work here (no child HWNDs) and autoFallback is ' +
            'enabled, so the click was repeated with the physical cursor. The cursor moved.',
          ...structNote,
          ...(realClick.ok && realClick.json !== null && typeof realClick.json === 'object'
            ? realClick.json
            : {}),
          ...verify,
        } as unknown as JsonValue,
        text: realClick.ok ? null : realClick.message,
        stderr: realClick.ok ? null : realClick.stderr,
      }
    }

    // Foreground protection: hand the foreground back to the window that was
    // in front BEFORE the click, if the target app stole it.
    const fgRestored = await autoForegroundRestore(savedFgHwnd)
    return {
      action: params.action, tier: params.tier, executed: true,
      blockedReason: null, exitCode: 0,
      data: {
        step: 'clicked', ...baseBg, ...bgClick, ...backgroundCaveat(bgClick), ...structNote, ...verify,
        ...(savedFgHwnd !== undefined ? { foregroundRestored: fgRestored, originalForeground: savedFgHwnd } : {}),
      } as unknown as JsonValue,
      text: null, stderr: null,
    }
  }

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
    identityConfirmed,
    ...(ocrAmbiguous ? { ocrAmbiguous: true, ocrMatchCount, ocrAlternatives } : {}),
  }

  // Step 4 (optional): verify the click landed on the intended control.
  // ui.inspect at the clicked point returns the element actually under the
  // cursor —its role/name —which we compare against the ui.find expectation.
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
    cliPath: enginePath,
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
 * touch —a visual aid for the approval step. dsh's approval popup renders only a
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

/**
 * `window.confirm` action: resolve a stashed, token-gated mutate.
 *
 * `--approve <token>` runs the pending action (the only path through which a
 * `confirm: popup` mutate ever reaches the CLI) and returns its result.
 * `--deny <token>` drops the pending action and reports it denied. A missing or
 * unknown token is reported as already-expired so the model can re-request.
 */
async function runWindowConfirm(params: {
  argv: readonly string[]
  exec: { signal: AbortSignal }
}): Promise<ToolValue> {
  const mode = params.argv.includes('--deny') ? 'deny' : 'approve'
  const ti = params.argv.indexOf(mode === 'deny' ? '--deny' : '--approve')
  const token =
    ti >= 0 && ti + 1 < params.argv.length ? (params.argv[ti + 1] as string) : ''
  prunePending()
  const pending = token ? pendingActions.get(token) : undefined
  if (!pending) {
    return {
      action: 'window.confirm',
      tier: 'observe',
      executed: false,
      blockedReason: 'unknown or expired confirmation token',
      exitCode: null,
      data: { resolved: false, mode, token } as unknown as JsonValue,
      text: null,
      stderr: null,
    }
  }
  if (mode === 'deny') {
    pendingActions.delete(token)
    return {
      action: 'window.confirm',
      tier: 'observe',
      executed: false,
      blockedReason: `the user denied "${pending.action}" on ${pending.appName}`,
      exitCode: null,
      data: { resolved: true, mode: 'deny', action: pending.action } as unknown as JsonValue,
      text: null,
      stderr: null,
    }
  }
  // approve: run the real action now.
  pendingActions.delete(token)
  return dispatch({
    action: pending.action,
    argv: pending.argv,
    cliPath: pending.cliPath,
    config: pending.config,
    exec: params.exec,
  })
}

/**
 * Decide whether an action can be delivered as window messages, and how.
 *
 * Only plain input synthesis is eligible. Drag and scroll are deliberately
 * excluded: they are defined by real cursor motion, so a message-based
 * equivalent does not exist and pretending otherwise would be a silent
 * no-op that looks like success.
 */
type BackgroundPlan =
  | { kind: 'click'; x: number; y: number; title?: string; hwnd?: number }
  | { kind: 'type'; text: string; title?: string; hwnd?: number }
  | { kind: 'key'; key: number; title?: string; hwnd?: number }
  | { kind: 'scroll'; x?: number; y?: number; amount: number; title?: string; hwnd?: number }

function backgroundPlan(action: string, argv: readonly string[]): BackgroundPlan | null {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  // `--title` / `--hwnd` name WHICH window to drive. Without one, the helper
  // falls back to the foreground window - fine for "operate what I'm looking
  // at", but parallel operation (drive app B while I use app A) needs it.
  const title = flag('--title')
  const hwndRaw = flag('--hwnd')
  const hwnd = hwndRaw !== undefined && /^\d+$/.test(hwndRaw) ? Number(hwndRaw) : undefined
  const target = { title, hwnd }

  if (action === 'mouse.click') {
    const pt = parsePoint(flag('--point'))
    if (!pt) return null
    return { kind: 'click', x: pt[0], y: pt[1], ...target }
  }
  if (action === 'keyboard.write') {
    const text = flag('--text')
    if (text === undefined) return null
    return { kind: 'type', text, ...target }
  }
  if (action === 'mouse.scroll') {
    // SAH's --amount is "wheel clicks"; WM_MOUSEWHEEL wants a delta of ±120 per
    // click. Negative = scroll down, matching real-wheel behaviour.
    const raw = flag('--amount')
    const amount = raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : 0
    if (amount === 0) return null
    // UIA scrolling (dsbox) needs no point — the app scrolls itself. A point is
    // only required for the message path (wheel goes to the child under it).
    const pt = parsePoint(flag('--point'))
    if (!pt && target.title === undefined && target.hwnd === undefined) return null
    return { kind: 'scroll', ...(pt ? { x: pt[0], y: pt[1] } : {}), amount, ...target }
  }
  if (action === 'keyboard.hotkey') return null
  return null
}

/**
 * Actions that physically move the mouse or synthesise keystrokes, and which
 * cannot be delivered as window messages. Under `inputMode: background` these
 * still take the cursor / keyboard, so the result must say so.
 */
const PHYSICAL_INPUT_ACTIONS = new Set([
  'mouse.move',
  'mouse.down',
  'mouse.up',
  'mouse.long-press',
  'mouse.drag',
  'keyboard.hotkey',
  'task.click',
  'task.write',
  'task.hotkey',
  'task.drag',
  'task.scroll',
  'task.long-press',
])

/** Merge extra keys into a CLI JSON payload, wrapping it when it is not an object. */
function withNote(data: unknown, note: Record<string, unknown>): JsonValue {
  if (Object.keys(note).length === 0) return data as JsonValue
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), ...note } as unknown as JsonValue
  }
  return { value: data ?? null, ...note } as unknown as JsonValue
}

/**
 * Resolve the on-screen rect of the window named by --hwnd/--title, so OCR can
 * be limited to it. Without this, a target-scoped click still searched the whole
 * screen and could match text outside the window —producing a point the
 * out-of-bounds guard then refused.
 */
async function resolveTargetRect(params: {
  cliPath: string
  hwnd?: number
  title?: string
  timeoutMs: number
  signal: AbortSignal
}): Promise<[number, number, number, number] | null> {
  if (params.hwnd === undefined && params.title === undefined) return null
  const list = await runCli({
    cliPath: params.cliPath,
    invocation: { path: ['window', 'list-visible'], args: [] },
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  })
  const windows = (list.ok ? (list.json as { windows?: unknown } | undefined)?.windows : undefined)
  if (!Array.isArray(windows)) return null
  type Win = { handle?: number; title?: string; window_region?: number[] }
  const hit = (windows as Win[]).find((w) => {
    if (params.hwnd !== undefined) return w.handle === params.hwnd
    return typeof w.title === 'string' && params.title !== undefined &&
      w.title.toLowerCase().includes(params.title.toLowerCase())
  })
  const r = hit?.window_region
  return Array.isArray(r) && r.length === 4 ? (r as [number, number, number, number]) : null
}

/**
 * `probe` —read-only diagnosis of whether a window can be driven in the
 * background. It enumerates child HWNDs and reports the deepest one at a point;
 * an app with no child windows (Chromium/Electron self-drawn surfaces) can only
 * receive messages on its top-level window, which is the main reason background
 * input silently fails. Run this before clicking an unfamiliar window instead of
 * discovering it after the click does nothing.
 */
async function runProbe(params: {
  cliPath: string
  config: Config
  tier: RiskTier
  exec: { signal: AbortSignal }
  action: string
  argv: readonly string[]
}): Promise<ToolValue> {
  const { argv } = params
  const hwnd = numericFlag(argv, '--hwnd')
  const title = flagValue(argv, '--title')
  const point = parsePoint(flagValue(argv, '--point') ?? '')
  if (hwnd === undefined && title === undefined) {
    return {
      action: params.action,
      tier: params.tier,
      executed: false,
      blockedReason:
        'probe needs a target: pass --hwnd <handle> or --title <window title>. ' +
        'Optionally --point "x,y" to see which child window sits at that coordinate.',
      exitCode: null,
      data: null,
      text: null,
      stderr: null,
    }
  }
  const out = await runBackgroundInput({
    action: 'probe',
    ...(point ? { x: point[0], y: point[1] } : {}),
    title,
    hwnd,
    timeoutMs: params.config.timeoutMs,
  })
  if (!out) {
    return {
      action: params.action,
      tier: params.tier,
      executed: false,
      blockedReason: 'background input helper unavailable; cannot probe',
      exitCode: null,
      data: null,
      text: null,
      stderr: null,
    }
  }
  const childCount = typeof out.childCount === 'number' ? out.childCount : 0
  const topLevelOnly = out.deepChildIsTopLevel === true
  return {
    action: params.action,
    tier: params.tier,
    executed: true,
    blockedReason: null,
    exitCode: 0,
    data: {
      ...out,
      backgroundCapable: !topLevelOnly && childCount > 0,
      diagnosis:
        childCount === 0
          ? 'This window exposes no child HWNDs —typical of self-drawn UI (Chromium/Electron/Qt). ' +
            'Background messages can only reach its top-level window and may be ignored. ' +
            'Prefer inputMode: real for this window, or verify the effect before trusting it.'
          : topLevelOnly
            ? 'A point was given but the deepest window there is the top level itself; ' +
              'the click may land on the wrong layer.'
            : 'This window has real child windows, so background message delivery can target them.',
    } as unknown as JsonValue,
    text: null,
    stderr: null,
  }
}

/** Read `--name <value>` from argv, or undefined. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

/** Read `--name <digits>` as a number, or undefined when absent/non-numeric. */
function numericFlag(argv: readonly string[], name: string): number | undefined {
  const raw = flagValue(argv, name)
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined
}

/** Parse a "x,y" point string; null when malformed. */
function parsePoint(raw: string | undefined): [number, number] | null {
  if (!raw) return null
  const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(raw)
  if (!m) return null
  return [Number(m[1]), Number(m[2])]
}

/**
 * Deliver input as window messages instead of moving the real cursor.
 *
 * The result carries `cursorMoved` from the helper so the model and the operator
 * can see that the physical mouse was left alone. When the helper is
 * unavailable, the call fails loudly rather than quietly grabbing the cursor —
 * a background-mode deployment must never silently become a real-mouse one.
 */
async function runBackground(params: {
  plan: BackgroundPlan
  config: Config
  tier: RiskTier
  exec: { signal: AbortSignal }
  action: string
}): Promise<ToolValue> {
  const p = params.plan
  // Typing without an explicit target resolves to the foreground window —which
  // is whatever the user is actively using, so text would land in the document
  // or chat they are currently typing in. That is exactly the interference
  // background mode exists to avoid, so require --title/--hwnd for typing.
  // (A click is different: it targets a point, and refusing it would break the
  // common "click what I'm looking at" case.)
  if (p.kind === 'type' && p.title === undefined && p.hwnd === undefined) {
    return {
      action: params.action,
      tier: params.tier,
      executed: false,
      blockedReason:
        'background typing needs an explicit target: pass --title <window title> or --hwnd <handle>. ' +
        'Without one it would type into the foreground window — the app you are using right now.',
      exitCode: null,
      data: { inputMode: 'background' } as unknown as JsonValue,
      text: null,
      stderr: null,
    }
  }

  // UIA ValuePattern fast path for typing (dsbox only): when dsbox is present
  // and an explicit target window is known, try putting the text straight into
  // the window's edit field via the accessibility channel —no keystrokes, no
  // cursor, works where WM_CHAR is ignored. Falls back to WM_CHAR typing when
  // the window has no settable edit element.
  if (p.kind === 'type' && resolveDsboxPath() !== null) {
    // Save the foreground BEFORE the write: some apps activate themselves
    // asynchronously after receiving text.
    const preFgSv = await runCli({
      cliPath: resolveDsboxPath()!,
      invocation: { path: ['window', 'foreground'], args: [] },
      timeoutMs: params.config.timeoutMs,
      signal: params.exec.signal,
    })
    const preFgSvJson = preFgSv.ok ? (preFgSv.json as Record<string, unknown> | undefined) : undefined
    const preFgSvHandle = preFgSvJson?.handle
    const savedFgSvHwnd = typeof preFgSvHandle === 'number' ? preFgSvHandle : undefined
    const sv = await runCli({
      cliPath: resolveDsboxPath()!,
      invocation: {
        path: ['keyboard', 'setvalue'],
        args: [
          '--text', p.text,
          ...(p.hwnd !== undefined ? ['--hwnd', String(p.hwnd)] : []),
          ...(p.title !== undefined ? ['--title', p.title] : []),
        ],
      },
      timeoutMs: params.config.timeoutMs,
      signal: params.exec.signal,
    })
    const svJson = sv.ok ? (sv.json as Record<string, unknown> | undefined) : undefined
    if (svJson?.status === 'set') {
      const fgRestoredSv = await autoForegroundRestore(savedFgSvHwnd)
      return {
        action: params.action,
        tier: params.tier,
        executed: true,
        blockedReason: null,
        exitCode: 0,
        data: {
          inputMode: 'background',
          deliveryMethod: 'uia-setvalue',
          element: svJson.element,
          valueAfter: svJson.valueAfter,
          cursorMoved: false,
          ...(savedFgSvHwnd !== undefined ? { foregroundRestored: fgRestoredSv, originalForeground: savedFgSvHwnd } : {}),
        } as unknown as JsonValue,
        text: null,
        stderr: null,
      }
    }
    // not_found / no_value_pattern → fall through to WM_CHAR typing
  }

  const out = await runBackgroundInput({
    action: p.kind,
    ...(p.kind === 'click' || p.kind === 'scroll' ? { x: p.x, y: p.y } : {}),
    ...(p.kind === 'scroll' ? { amount: p.amount } : {}),
    ...(p.kind === 'type' ? { text: p.text } : {}),
    ...(p.kind === 'key' ? { key: p.key } : {}),
    title: p.title,
    hwnd: p.hwnd,
    timeoutMs: params.config.timeoutMs,
  })

  if (!out) {
    return {
      action: params.action,
      tier: params.tier,
      executed: false,
      blockedReason:
        'background input helper unavailable; refusing to fall back to the real cursor while inputMode is "background"',
      exitCode: null,
      data: null,
      text: null,
      stderr: null,
    }
  }

  // The helper reports ok:false when it deliberately sent nothing (e.g. the
  // point falls outside the target window). Surface that as a failure with the
  // reason —a "delivered nothing" result must not read as a successful click.
  if (out.ok === false) {
    return {
      action: params.action,
      tier: params.tier,
      executed: true,
      blockedReason: typeof out.error === 'string' ? out.error : 'background input was not delivered',
      exitCode: 1,
      data: { inputMode: 'background', ...out } as unknown as JsonValue,
      text: null,
      stderr: null,
    }
  }

  return {
    action: params.action,
    tier: params.tier,
    executed: true,
    blockedReason: null,
    exitCode: 0,
    data: {
      inputMode: 'background',
      ...out,
      // Honesty about reach: a window message can be "delivered" and still be
      // ignored. Self-drawn UIs (Chromium / Electron / Qt) often listen for raw
      // input instead of WM_*, so a background click there can silently do
      // nothing. Say so rather than letting `ok: true` read as proof it worked.
      ...backgroundCaveat(out),
    } as unknown as JsonValue,
    text: null,
    stderr: null,
  }
}

/**
 * Window classes that paint themselves and commonly ignore WM_* input.
 *
 * These are Chromium/Electron/Qt rendering surfaces: the message reaches the
 * HWND, but the app's own event loop listens for raw input (or synthesizes
 * clicks elsewhere), so nothing happens.
 */
const SELF_DRAWN_CLASS_PATTERNS = [
  'Chrome_RenderWidgetHostHWND', // Chromium / Electron renderer
  'Chrome_WidgetWin_', // Chromium / Electron top-level
  'Qt5', // Qt 5
  'Qt6', // Qt 6
  'CEF', // Chromium Embedded Framework (瀵邦喕淇?QQ 缁涘鍞村畵灞剧セ鐟欏牆娅?
  'Intermediate D3D Window', // WPF 閼奉亞绮?
]

/**
 * Flag a background delivery that may not have had an effect.
 *
 * Returns {} for ordinary message-driven windows, so the common success result
 * stays clean and only genuinely risky targets carry the caveat.
 */
function backgroundCaveat(out: Record<string, unknown>): Record<string, unknown> {
  const classes = [out.childClass, out.hwndClass].filter((c): c is string => typeof c === 'string')
  const hit = SELF_DRAWN_CLASS_PATTERNS.find((p) => classes.some((c) => c.includes(p)))
  if (!hit) return {}
  return {
    effectUnverified: true,
    caveat:
      `target window class "${hit}" is a self-drawn UI (Chromium/Electron/Qt). ` +
      'Background window messages are often ignored by these apps, so this input may have had no effect. ' +
      'Verify with a read (screen.recognize / ui.tree) before assuming it worked, ' +
      'or use inputMode: real for this app (which moves the physical cursor).',
  }
}

/**
 * Run one (already authorized) action.
 *
 * Shared by the direct path and by `window.confirm --approve`, so a stashed
 * action is delivered exactly the way it would have been had it run inline —
 * including honoring `inputMode`. The single entry point is what keeps the
 * approval token from becoming a way around the background-input policy.
 */
// ---- Foreground protection: hand back focus after app-steals ----
async function autoForegroundRestore(savedHwnd: number | undefined): Promise<boolean> {
  if (!savedHwnd || !(resolveDsboxPath())) return false
  try {
    // wait a beat for the app's async activation to land
    await new Promise((r) => setTimeout(r, 600))
    const fg = await runCli({
      cliPath: resolveDsboxPath()!,
      invocation: { path: ['window', 'foreground'], args: [] },
      timeoutMs: 15_000,
    })
    const fgJson = fg.ok ? (fg.json as Record<string, unknown> | undefined) : undefined
    const fgHwnd = typeof fgJson?.handle === 'number' ? fgJson.handle : 0
    if (fgHwnd === savedHwnd) return true // foreground never stolen
    const r = await runCli({
      cliPath: resolveDsboxPath()!,
      invocation: { path: ['foreground', 'restore'], args: ['--hwnd', String(savedHwnd)] },
      timeoutMs: 15_000,
    })
    const rj = r.ok ? (r.json as Record<string, unknown> | undefined) : undefined
    return rj?.restored === true
  } catch {
    return false
  }
}
// ---- Codex-style task panel auto-management (dsbox panel commands) ----
const panelState = {
  active: false,
  done: 0,
  steps: [] as string[],
  stopTimer: null as ReturnType<typeof setTimeout> | null,
}
function panelDescribe(action: string, argv: readonly string[]): string {
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const name = flag('--name')
  const text = flag('--text')
  const point = flag('--point')
  if (action === 'ui.click') return `点击「${name ?? '目标'}」`
  if (action === 'keyboard.write') return `输入「${(text ?? '').slice(0, 12)}」`
  if (action === 'mouse.click') return `点击 (${point ?? '?'})`
  if (action === 'mouse.scroll') return `滚动 ${flag('--amount') ?? ''}`
  return action
}
async function panelTouch(action: string, argv: readonly string[]): Promise<void> {
  const step = panelDescribe(action, argv)
  try {
    if (!panelState.active) {
      await runCli({
        cliPath: resolveDsboxPath() ?? 'dsbox.cmd',
        invocation: { path: ['panel', 'start'], args: ['--title', 'DSH 自动化任务'] },
        timeoutMs: 15_000,
      })
      panelState.active = true
      panelState.done = 0
      panelState.steps = []
    }
    panelState.done += 1
    panelState.steps.push(step)
    await runCli({
      cliPath: resolveDsboxPath() ?? 'dsbox.cmd',
      invocation: {
        path: ['panel', 'update'],
        args: ['--step', step, '--done', String(panelState.done), '--total', String(panelState.done + 1)],
      },
      timeoutMs: 15_000,
    })
    if (panelState.stopTimer) clearTimeout(panelState.stopTimer)
    panelState.stopTimer = setTimeout(() => {
      void runCli({
        cliPath: resolveDsboxPath() ?? 'dsbox.cmd',
        invocation: { path: ['panel', 'stop'], args: [] },
        timeoutMs: 15_000,
      }).then(() => {
        panelState.active = false
        panelState.done = 0
        panelState.steps = []
      })
    }, 6_000)
  } catch { }
}
async function dispatch(params: {
  action: string
  argv: readonly string[]
  cliPath: string
  config: Config
  exec: { signal: AbortSignal }
}): Promise<ToolValue> {
  const { action, argv, cliPath, config, exec } = params
  const path = resolvePath(action)
  const tier = classify(path)

  // Per-call mode override: `--input-mode real|background`. A window that cannot
  // be driven by messages (self-drawn UI) would otherwise force a global config
  // change just to click it once. The flag is stripped before the argv reaches
  // the CLI.
  const modeIdx = argv.indexOf('--input-mode')
  let mode = config.inputMode
  let restArgv = argv
  if (modeIdx >= 0 && modeIdx + 1 < argv.length) {
    const raw = (argv[modeIdx + 1] ?? '').toLowerCase()
    if (raw === 'real' || raw === 'background') mode = raw
    restArgv = argv.filter((_, i) => i !== modeIdx && i !== modeIdx + 1)
  }
  const effConfig: Config = { ...config, inputMode: mode }

  if (action === 'panel.begin' || action === 'panel.step' || action === 'panel.finish') {
    const flag = (n: string): string | undefined => {
      const i = restArgv.indexOf(n)
      return i >= 0 && i + 1 < restArgv.length ? restArgv[i + 1] : undefined
    }
    const title = flag('--title') ?? 'AI 任务'
    const plannedTotal = flag('--total')
    const stepText = flag('--text') ?? flag('--step') ?? ''
    const summary = flag('--summary') ?? ''
    if (!panelState.active && action !== 'panel.finish') {
      await runCli({
        cliPath: resolveDsboxPath() ?? cliPath,
        invocation: { path: ['panel', 'start'], args: ['--title', title, ...(plannedTotal ? ['--total', plannedTotal] : [])] },
        timeoutMs: 15_000,
        signal: exec.signal,
      })
      panelState.active = true
      panelState.done = 0
      panelState.steps = []
    }
    if (action === 'panel.finish') {
      const finSummary = summary || panelState.steps.slice(-5).join('，')
      await runCli({
        cliPath: resolveDsboxPath() ?? cliPath,
        invocation: {
          path: ['panel', 'stop'],
          args: finSummary ? ['--summary', finSummary] : [],
        },
        timeoutMs: 15_000,
        signal: exec.signal,
      })
      panelState.active = false
      panelState.done = 0
      panelState.steps = []
      return {
        action, tier, executed: true, blockedReason: null, exitCode: 0,
        data: { panel: 'finished', summary: finSummary } as unknown as JsonValue,
        text: null, stderr: null,
      }
    }
    panelState.done += 1
    panelState.steps.push(stepText)
    const history = panelState.steps.map((s, i) => ({
      text: s,
      state: i === panelState.steps.length - 1 ? 'active' : 'done',
    }))
    await runCli({
      cliPath: resolveDsboxPath() ?? cliPath,
      invocation: {
        path: ['panel', 'update'],
        args: [
          '--step', stepText,
          '--done', String(panelState.done),
          '--total', String(panelState.done + 1),
          '--history', JSON.stringify(history),
        ],
      },
      timeoutMs: 15_000,
      signal: exec.signal,
    })
    if (panelState.stopTimer) clearTimeout(panelState.stopTimer)
    panelState.stopTimer = setTimeout(() => {
      const finSummary = panelState.steps.slice(-5).join('，')
      void runCli({
        cliPath: resolveDsboxPath() ?? 'dsbox.cmd',
        invocation: {
          path: ['panel', 'stop'],
          args: finSummary ? ['--summary', finSummary] : [],
        },
        timeoutMs: 15_000,
      }).then(() => {
        panelState.active = false
        panelState.done = 0
        panelState.steps = []
      })
    }, 120_000)
    return {
      action, tier, executed: true, blockedReason: null, exitCode: 0,
      data: { panel: 'updated', step: stepText, done: panelState.done } as unknown as JsonValue,
      text: null, stderr: null,
    }
  }
  if (action === 'find_exact') {
    return runFindExact({ cliPath, argv: restArgv, config: effConfig, tier, exec, action })
  }
  if (action === 'ui.click') {
    void panelTouch(action, restArgv)
    return runUiClick({ cliPath, argv: restArgv, config: effConfig, tier, exec, action })
  }
  if (action === 'window.app') {
    return runWindowApp({ cliPath, config: effConfig, tier, exec, action })
  }
  if (action === 'probe') {
    return runProbe({ cliPath, config: effConfig, tier, exec, action, argv: restArgv })
  }

  const bg = backgroundPlan(action, restArgv)
  if (bg && effConfig.inputMode === 'background') {
    void panelTouch(action, restArgv)
    return runBackground({ plan: bg, config: effConfig, tier, exec, action })
  }

  const usingBackground = bg !== null && effConfig.inputMode === 'background'

  // `--hwnd`/`--title` are plugin-only: they tell background delivery WHICH
  // window to target. The CLI does not understand them, so strip them whenever
  // we are not the one consuming them.
  const cliArgv = usingBackground
    ? restArgv
    : (() => {
        const out: string[] = []
        for (let i = 0; i < restArgv.length; i++) {
          const a = restArgv[i]
          if (a === '--hwnd' || a === '--title') { i++ ; continue } // drop flag + value
          out.push(a as string)
        }
        return out
      })()

  const outcome = await runCli({
    cliPath,
    invocation: { path, args: cliArgv },
    timeoutMs: config.timeoutMs,
    signal: exec.signal,
  })

  // `inputMode: background` promises the cursor is left alone, but only some
  // actions can be delivered as messages. These ones cannot —they drive the
  // physical mouse/keyboard. Say so on the result instead of letting a
  // background deployment assume nothing moved.
  const grabbedRealInput =
    effConfig.inputMode === 'background' && PHYSICAL_INPUT_ACTIONS.has(action)
  const note = grabbedRealInput
    ? {
        inputMode: 'background',
        usedPhysicalInput: true,
        caveat:
          `"${action}" cannot be delivered as window messages, so this call moved the physical ` +
          'mouse/keyboard despite inputMode: background. Only mouse.click and keyboard.write ' +
          '(with --title/--hwnd) are background-capable. Expect your cursor to have moved.',
      }
    : {}

  if (outcome.ok) {
    return {
      action,
      tier,
      executed: true,
      blockedReason: null,
      exitCode: outcome.exitCode,
      data: withNote(outcome.json ?? null, note),
      text: outcome.json === undefined ? outcome.stdout : null,
      stderr: null,
    }
  }
  return {
    action,
    tier,
    executed: true,
    blockedReason: null,
    exitCode: outcome.exitCode,
    data: Object.keys(note).length > 0 ? (note as unknown as JsonValue) : null,
    text: outcome.message,
    stderr: outcome.stderr,
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
      'Every call —including read-only ones —requires the user to approve it in the UI before the helper runs. A call the user does not approve returns without executing.',
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
    'Before clicking a window you have not driven before, run `probe --hwnd <handle>` (read-only, sends no input). It reports backgroundCapable and a diagnosis: self-drawn UI (Chromium/Electron/Qt) exposes no child windows, so background messages may be ignored there.',
    'Any input action accepts `--input-mode real|background` to override the configured mode for one call — use it to drive a self-drawn window without changing global config. In background mode the cursor is never moved; in real mode it is.',
    '',
    `CONFIRMATION GATE: this deployment sets confirm: ${config.confirm}. When "popup", every mutate action (mouse/keyboard/clipboard/workflow) is held until the operator approves it: the first call returns blockedReason "awaiting confirmation" with a confirmToken and the foreground app name in data. Surface a confirmation card (with the app icon) and call window.confirm --approve <token> to actually run it, or window.confirm --deny <token> to cancel. The real action never runs without that approve step. (dsh's own approval popup is disabled in sessions where approval prompts fail closed, so the plugin provides this gate itself.)`,
    '',
    policy,
    'The helper must be installed locally; if calls fail, run action "health" to diagnose.',
  ].join('\n')
}
