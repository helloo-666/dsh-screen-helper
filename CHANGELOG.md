# Changelog

## 0.1.15

- **New read-only action `probe`: check whether a window can be driven in the
  background before clicking it.** It enumerates child HWNDs and reports the
  deepest window at an optional `--point`, then returns `backgroundCapable` plus a
  `diagnosis`. Probing a Chromium window returned `childCount: 0` — self-drawn UI
  (Chromium/Electron/Qt) exposes no child windows, so background messages can only
  reach its top-level window and may be ignored. A standard Win32 window returned
  15. Sends no input, so it is safe to run against anything; requires `--hwnd` or
  `--title`.

## 0.1.14

- **`ui.click --hwnd/--title` now searches only inside that window.** OCR used to
  scan the whole screen, so a target-scoped click could match text outside the
  window and then be refused by the out-of-bounds guard. In practice
  `ui.click --name 编辑 --hwnd 723022` picked a token at the top of the screen
  (178,16) for a window at (619,214,1721,760) and failed. Matches are now limited
  to the target rect; the result reports `scopedToRect` and how many matches were
  dropped (`scopedOut`).
- **Ambiguity is reported instead of silently guessed.** Without UI-tree
  confirmation the click is only an OCR guess, so when several tokens matched,
  taking the first one could hit the wrong element. The result now carries
  `ocrAmbiguous`, `ocrMatchCount` and `ocrAlternatives`.
- Fixed a mojibake character that had crept back into a source comment.

## 0.1.13

- **`--verify` works in background mode again, by observation instead of
  inspection.** It used to be reported as skipped, because `ui.inspect --point`
  reads the element under the physical cursor — which background mode never
  moves. Probing showed `ui.inspect --point` is unavailable here anyway, so
  skipping it left no feedback at all. Background `--verify` now re-reads the
  screen and diffs the OCR text, reporting `changesDetected` plus what was
  added/removed, under `verifyMethod: "ocr-diff"`.
- That verification is deliberately weaker than the real thing and says so: a
  change means the click did *something*, not that it hit the right control, and
  an unchanged screen does not prove failure.

## 0.1.12

- **Background mode now admits which actions still grab your mouse.**
  `inputMode: background` was honest for `mouse.click` and `keyboard.write`, but
  `mouse.scroll` / `mouse.drag` / `mouse.move` / `keyboard.hotkey` and the
  `task.*` input actions cannot be delivered as window messages — they drove the
  physical cursor while the deployment claimed otherwise. Those results now carry
  `usedPhysicalInput: true` plus a `caveat` naming the action, on both success and
  failure paths. 41 tests passing.

## 0.1.11

- **Background typing now requires an explicit target.** Without `--title` or
  `--hwnd` the helper resolves the *foreground* window — the app you are actively
  using — so text would be typed into the document or chat you are currently
  writing in. That is precisely the interference background mode exists to
  prevent, so it is refused with an explanation. Clicks are unaffected: they
  target a point, and "click what I'm looking at" is a legitimate default.
- 40 tests passing.

## 0.1.10

- **`ui.click` no longer aborts when the UI tree does not confirm the control.**
  It used to stop at the `ui.find` step, which made it unusable against desktop
  icons, Electron and other self-drawn apps — those expose little or no UIA, so
  a silent tree does not mean the control is missing. It now falls through to
  OCR and reports `identityConfirmed: false`, so a caller can tell a confirmed
  target from a best guess instead of getting a dead end.

## 0.1.9

- **`cursorMoved` no longer produces false alarms.** It was computed by comparing
  the cursor position before and after the call, so moving your own mouse during
  a background click reported `cursorMoved: true` — as if the plugin had grabbed
  the mouse, which it never did. `cursorMoved` is now a literal `false` (this
  helper contains no cursor-moving call at all), and the observation moved to a
  separate `cursorDisplaced` flag that means "the position changed between the
  two reads", which the user or another app can cause.
- Tests: the two cases that OCR the real screen are now opt-in via `SAH_E2E=1`.
  They took ~15-25s each and depended on whatever was displayed, which made the
  suite slow and flaky. Suite: 38 passing in ~5s.

## 0.1.8

- **`ui.click` no longer grabs the mouse.** It is the most accurate click path
  (UIA identity + OCR + optional verify) and therefore the default choice, but it
  still drove the physical cursor — so the main path kept taking your mouse. In
  `inputMode: background` it now uses the same message-based delivery as
  `mouse.click`.
- **`--verify` is honestly skipped in background mode.** It inspects the element
  under the *physical* cursor, which background mode never moves, so it would
  confirm nothing. The result now carries `verifySkipped: true` plus a
  `verifyNote` pointing at a read-based check instead of echoing a green tick.
- Self-drawn UI caveat and out-of-bounds refusal apply to `ui.click` too.
- Pinned `@deepseek-ai/schemastery` to `3.18.2`: `3.18.4` changed `SchemaOutput`
  typing and broke the build.

## 0.1.7

- **Out-of-bounds clicks are refused instead of silently succeeding.** A `--point` outside the
  target window's rect used to resolve to the top-level window and report `ok: true`, so a wrong
  coordinate looked like a successful click. The helper now rejects it with
  `blockedReason` explaining the miss, and returns `targetRect` so the caller can correct the
  coordinate. No input is sent, and the cursor still does not move.
- **Self-drawn UI warning (`effectUnverified`).** When the target's window class is Chromium /
  Electron / Qt (`Chrome_RenderWidgetHostHWND`, `Chrome_WidgetWin_`, `Qt5`/`Qt6`, `CEF`, …), the
  result now carries `effectUnverified: true` plus a `caveat`, because those apps commonly ignore
  `WM_` messages and a delivered message must not be read as proof the click worked. Ordinary
  Win32 controls (verified against `NotepadTextBox` / `RichEditD2DPT`) stay clean — no false
  positives.
- Helper `ok: false` is now reported as a real failure (`blockedReason` + `exitCode 1`) rather
  than `executed: true`.
- Tests: 38 passing in ~21s. The `find_exact` OCR case no longer fails when the searched text is
  simply not on screen, and a new case covers the out-of-bounds refusal (without opening windows).

## 0.1.6

- **Background input mode (`inputMode: background`, now the default) — the plugin no longer
  takes your mouse.** Mouse clicks and keyboard text are delivered as Win32 messages straight
  to the target window's deepest child control instead of driving the physical cursor, so the
  model can operate one window while you keep using your mouse and keep typing in the
  foreground window. The result carries `cursorBefore` / `cursorAfter` / `cursorMoved`, so a
  background operation can never silently become a cursor grab.
- **New `scripts/background-input.ps1` helper**, shipped into `lib/scripts/` by the build
  (`scripts/copy-helpers.mjs`) so installed copies keep it next to the JS that spawns it.
  Resolves the deepest child via `RealChildWindowFromPoint`, and for typing falls back to a
  heuristic edit-control search (`RichEdit` / `NotepadTextBox` / `TextBox`).
- **`--title` / `--hwnd` targeting** for `mouse.click` and `keyboard.write`: name *which*
  window to drive. Without one, the helper targets the foreground window — fine for
  "operate what I'm looking at", but parallel operation needs the explicit target.
- **`inputMode: 'background' | 'real'`.** `real` restores physical-cursor input for apps that
  ignore window messages.
- **Unified `dispatch()`** shared by the direct path and `window.confirm --approve`, so a
  stashed action is delivered exactly as it would have been inline — an approval token can
  no longer bypass `inputMode`.
- Honest failure: if the helper is unavailable the call fails instead of quietly falling back
  to the real cursor. `mouse.drag` and `scroll` are excluded from background mode (no message
  equivalent) rather than being silently turned into no-ops.
- Known boundary, documented in the README: background mode is reliable only for apps that
  handle standard Windows messages. Self-drawn UIs (Electron / Chromium / Qt — B站 client,
  微信, Chrome) often listen for raw input instead and may ignore `WM_` messages.

## 0.1.5

- **Plugin-enforced confirmation gate (`confirm: popup`, now the default).** dsh's native
  approval popup is fail-closed in sessions where approval prompts are disabled, so it can
  never ask. The plugin now gates mutate actions itself: the first call for a mouse/keyboard/
  clipboard/workflow action does not run — it returns `blockedReason: "awaiting confirmation"`
  with a one-time `confirmToken` plus the foreground app's name and extracted icon path in
  `data`. The real action executes only via `window.confirm --approve <token>`; `--deny`
  cancels. Tokens are single-use and expire after 10 minutes.
- **New `window.confirm` action** (`--approve <token>` / `--deny <token>`): the only path
  through which a gated mutate reaches the CLI.
- **Config: `confirm: 'popup' | 'off'`.** `off` lets mutate actions run straight through
  (for deployments that trust the model or rely on dsh's own approval).
- Icons are extracted from the target executable via `System.Drawing.Icon.ExtractAssociatedIcon`
  and surfaced for display in the confirmation card.

## 0.1.4

- **Added `window.app` — foreground app identification with icon extraction.** Calls
  `window.foreground` and enriches the result with `displayName` and an `iconPath`
  (PNG, extracted from the process executable via `System.Drawing.Icon.ExtractAssociatedIcon`).
  Lets the operator see *which application* is about to be touched before any mutate action.
- **Approval reason now names the target application.** When `approval` is set to `mutating`
  (or `always`), the dsh approval popup's reason text includes the foreground app name,
  e.g. `ScreenAutomationHelper is about to perform "mouse.click" on DSH Desktop on your real screen:`.
- **Documented the dsh popup limitation:** `dsh-client-ui-approval` only renders `toolName` +
  `reason` strings, with no icon field; the icon is therefore surfaced via `window.app`'
  `iconPath` result rather than inside the native approval dialog.

## 0.1.3

- **`ui.click --verify` — closed-loop click verification.** After clicking, `ui.inspect --point` re-reads the element actually under the cursor and the action reports whether its role/name matches the `ui.find` expectation (`clicked+verified` vs `clicked+verify-mismatch`). This mirrors the CUA/Codex-style "click then confirm" safety check that catches mis-clicks on the wrong control. Validated against Notepad: clicking 文件 reported `verified: true` with `inspectedRole: menu_item, inspectedName: 文件`.
- **Robust `ui.click` identity resolution.** A `--role` constraint that misses a transiently-hidden control is now retried without the role filter; `ui.click`-only flags (`--verify`, `--button`) are stripped before they reach `ui.find` (they were previously leaking into the UI-tree query and causing false `not_found`).
- **README design-tradeoffs section** documenting why `ui.click` composes AX-tree identity confirmation + OCR pixel resolution + reverse verification, referencing the OpenAI CUA / Codex Computer Use paradigm, and the SAH limitation that `ui.find` does not expose element geometry.

## 0.1.2

- **Added `ui.click` — semantic UI-tree click.** Confirms a control exists by its
  accessible identity (`ui.find` by `--name`/`--role`) and only then resolves an
  on-screen pixel via word-level OCR (`find_exact`) and clicks it. If the control
  is absent or ambiguous the action returns an explicit error and never clicks a
  guessed point. Classified `mutate` (requires approval, not concurrency-safe) —
  it is deliberately kept out of `COMPUTED_ACTIONS` so the real mouse click is not
  mis-tiered as an observe-only call. Validated end-to-end against Notepad: `ui.click
  --name 文件` confirms the menu item, locates it (`center [166,143]`), and clicks.
- **Exposed the UI-tree layer** (`ui.tree`, `ui.find`, `ui.inspect`) as first-class
  observe actions. These read the accessibility (UIA) tree — element identity and
  hierarchy — and are documented as identity-only: SAH does not expose element
  bounding boxes, so geometry still comes from OCR.

## 0.1.1

- **Fixed: `find_exact` ranking when no token equals the query exactly.** Previously the order was
  exact-token → confidence. When the on-screen control carries an icon prefix (e.g. a sidebar button
  recognized as `④新会话`, conf 0.88) and chat-log lines quote the same phrase at conf 0.97+, every
  candidate had `exact = 0` and the high-confidence chat lines won — the click landed in the middle
  of a paragraph instead of the button. Ranking is now exact-token → **shortest containing token** →
  confidence: the minimal text that contains the query is the control label, while a long line merely
  happens to contain it. Locked by a regression test built from the real mis-click.
- Added `docs/demo.gif` — a real five-frame capture of the model finding the 「新会话」 button via
  word-level OCR, moving the cursor, clicking it, and resetting. Built by `scripts/make-demo.mjs`
  (live actions through the tool) and `scripts/make-gif.py` (Pillow composition with annotation
  overlays); no ffmpeg required.
- README (zh-CN) now leads with the demo GIF.

## 0.1.0

Initial release.

- **Published to GitHub** at `helloo-666/dsh-screen-helper` with a `v0.1.0` release carrying the
  installable tarball, and a `install.ps1` script that downloads the release and writes `cliPath` /
  `approval` into the profile's `cordis.patch.yml`. README documents the Windows-only prerequisite
  (the plugin drives the Windows ScreenAutomationHelper CLI; there is no macOS/Linux equivalent) and
  gives a one-line `dsh plugin add <release-url>` install.

- **`find_exact` action — precise word-level text location.** `screen.find` returns the box of the
  whole *line* containing a hit, which is too coarse to click a small control. `find_exact` reuses
  `screen.recognize`'s word-level OCR (one box per token) and filters those tokens for ones
  containing the query, returning the exact token boxes. Exact-token matches rank above longer
  containing tokens, then by confidence, so a token equal to the query wins over a longer line that
  merely contains it. It is an `observe`-tier action (prompts under `always`) and routes through
  `screen.recognize` with the `--text`/`--text-only` flags stripped, since the helper's recognize
  takes no `--text` argument of its own.


- `screen_automation` tool driving the ScreenAutomationHelper CLI: read, observe, and mutate
  action tiers covering ~42 capability families.
- Shell-free invocation: arguments are passed as a real `argv` array, so shell metacharacters
  are inert.
- Risk-tier classification with fail-safe defaulting of unknown subcommands to `mutate`.
- Three approval modes: `always` (every call prompts), `mutating` (only state-changing calls
  prompt), and `never` (nothing prompts; the default).
- Approval via dsh's fail-closed approval service: a missing answerer, a cancellation, a
  throwing answerer, or an unrecognized return value all deny.
- Optional `blockDestructive` hard block for workflow mutation and clipboard writes.
- Per-invocation timeout with cancellation forwarding.
- 29 tests across classification, real-CLI behaviour, plugin registration, and the approval
  vocabulary.

### Fixed before first release

- **The approval gate never granted anything.** The gate compared the answerer's outcome against
  `'approved'`, but dsh's grant token is `'allowed-once'` (its closed vocabulary is
  `allowed-once | rejected | cancelled | unavailable`). Every approved action was therefore
  denied — the feature was inert. The comparison now targets the grant token, so an
  unrecognized outcome denies instead of being confused with a grant. A regression test pins the
  whole vocabulary, including the near-miss strings (`'approved'`, `'allowed'`,
  `'ALLOWED-ONCE'`) that must all deny.

  This was invisible to the original tests because those tests used the same wrong string the
  implementation did; the contract only surfaced when reading `dsh-user-approval`'s source.

- **The packaged tarball could ship stale compiled output.** `npm pack` alone was not enough:
  after adding the `always` approval mode to `src/index.ts`, the tarball rebuilt by `prepack` was
  correct on disk, but `dsh plugin add` reported "Already up to date" and kept serving the old
  `lib/index.js` from the pnpm store, so the profile failed to boot with:

  ```
  invalid config:
    - $.approval expected "mutating" | "never" but got "always" (at approval)
  ```

  Reinstalling requires `dsh plugin remove` before `add`; the two are not interchangeable because
  pnpm caches by tarball identity. Worth knowing because the failure presents as a *schema* error
  rather than as a stale-file error.

### Documented after live use

- The helper CLI has four silent traps that are absent from its `-h` output; all four are now
  recorded in both READMEs:
  1. **It cannot launch programs.** There is no `run`/`exec` subcommand. `task.begin` *binds* an
     existing window; it does not spawn a process.
  2. **Window control requires a confirmed task target.** `window.activate` fails on its own with
     `当前没有已确认的屏幕任务目标`. `task.begin` must establish one first — and because the
     target is persisted to `agent_screen_task.json`, the two commands work across separate
     processes.
  3. **`window.activate` does not accept `--handle`** (its signature is `activate [--target
     TARGET]`). An unknown flag is silently ignored and the call returns `null`; `window.select`
     state does not survive across separate CLI invocations.
  4. **Single-character OCR is unreliable.** A calculator's `7` was recognized as `⑧` and `=` as
     `二`, so `screen.find` is the wrong mechanism for single-character targets; keyboard synthesis
     avoids the recognition step entirely.

- `mouse.move --duration` animates the pointer. Reading `mouse.position` immediately after such a
  move samples a mid-flight coordinate and looks like an accuracy bug; measured across eight
  points with a settle delay the endpoint is exact (0 px).
