# Changelog

## 0.1.31

- **mouse.scroll background mode now auto-routes through UIA ScrollPattern**:
  with dsbox present and an explicit `--hwnd`/`--title`, scrolling goes
  `scrolluia` first (the app scrolls itself — no messages, no cursor) and only
  falls back to WM_MOUSEWHEEL when the window exposes no scrollable element.
  `--point` is no longer required for targeted scrolling (UIA needs no
  coordinates); it stays required for the message path.
- Refactor: dsbox spawn/JSON-parse logic consolidated into `spawnDsboxJson`
  (was inline in one closure; the scroll fast path needed to reuse it).

## 0.1.30

- **UIA ScrollPattern scrolling: dsbox `mouse scrolluia`** — the app scrolls
  itself through its accessibility channel. No window messages, no cursor,
  works on UWP/self-drawn apps that ignore WM_MOUSEWHEEL. Absolute position
  (`--percent 50`) or relative steps (`--amount -3`), auto-targets the
  scrollable pane with content, requires explicit `--hwnd`/`--title` like
  every dsbox input command. Verified live on the Settings app (0% → 50% →
  back to 0%, cursor untouched).

## 0.1.29

- **keyboard.write now types through UIA ValuePattern automatically** (dsbox
  present + explicit target): text lands in the window's edit field via the
  accessibility channel —no keystrokes, no cursor, no focus change, works on
  UWP apps where WM_CHAR is ignored. Falls back to WM_CHAR typing when the
  window exposes no settable edit element. Result tagged
  `deliveryMethod: 'uia-setvalue'`. Measured e2e: **1.3s** (Settings search
  box, write → read-back verified).
- Combined with 0.1.27's InvokePattern click, the full background operation
  set (click buttons, type text, scroll) now runs without ever touching the
  user's cursor or keyboard on the vast majority of windows.

## 0.1.28

- **"AI 自己的键盘"：dsbox `keyboard setvalue`** — puts text straight into an
  element's value via UIA ValuePattern (the app's own accessibility channel).
  No keystrokes, no cursor, no focus change, and it works where WM_CHAR is
  ignored. Verified live against the Settings app search box (write "蓝牙" →
  read back → clear). Supports `--name` element matching, scoped by
  `--hwnd`/`--title`.
- **Fixed: the structural pre-probe was silently dead.** `runBackgroundInput`
  mapped the `probe` action to null, so `ui.click`'s no-child-windows caveat
  (and its whole structProbe path) never ran with dsbox present. Probe now
  routes to `dsbox probe` and returns real child/UIA counts — the
  `backgroundCapable` diagnosis finally reaches callers.

## 0.1.27

- **"AI 自己的鼠标"来了：UIA InvokePattern delivery.** New `dsbox ui invoke
  --name N [--hwnd H]` invokes an element through the app's own accessibility
  channel (InvokePattern → TogglePattern → SelectionItem fallback chain). No
  cursor movement, no synthetic window messages — and unlike SendMessage, it
  WORKS on UWP/self-drawn apps: calculator end-to-end (加→五→等于 → display
  "10", then 七 → "7") with the physical cursor untouched the whole time.
- `ui.click` (background mode) now uses it automatically: when the located
  target is a UIA element, delivery goes `uia-invoke` first and only falls
  back to the message click when the element exposes no invocable pattern.
  Result is tagged `deliveryMethod: 'uia-invoke'` so callers can tell them
  apart. Measured e2e: 2.9s.
- Fixed `ui find` role names leaking the `ControlType.` prefix in output.
- Internals: the `ui` dispatch branch was rebuilt cleanly (find / inspect /
  invoke / tree) after repeated incremental patches left broken if/else
  structure and duplicate cases.

## 0.1.26

- **dsbox `ui inspect --point`**: which UIA element sits at a screen point —
  name/role/class/box/hwnd in one call. This closes the click-verify loop in
  background mode: the plugin now verifies a `--verify` click by reading the
  element identity at the clicked point from the UIA tree (no cursor
  movement), instead of the weaker "did the screen change" OCR-diff. The
  result is a hard `verified: true/false` with the landed element's role and
  name.
- **ClickablePoint-aware targeting**: dsbox's `ui find` now prefers the
  element's own clickable point over the bounding-rect centre. Title-bar
  elements' centres often sit on overlapping caption buttons — the exact
  failure the verify loop then (correctly) flags. Fixed by construction.
- **Fixed: mojibake through the cmd.exe spawn chain.** powershell.exe emitted
  stdout in the console code page (GBK on zh-CN), which Node decoded as UTF-8
  and turned every non-ASCII element name into U+FFFD garbage — silently
  breaking name-match verification. dsbox now forces UTF-8 stdout and ships
  with a BOM so its own string literals parse correctly on PS 5.1.
- ui.click real-mode `--verify` (ui.inspect) now also routes through dsbox.
- Measured e2e with verify: **3.6s**, `verified: true`, cursor untouched.

## 0.1.25

- **dsbox gains a real UIA tree** (`System.Windows.Automation`): `ui find` now
  searches live accessibility trees (~200ms window scan, ~800ms per few
  thousand elements) with `--name` substring/exact matching, `--role`, and
  `--hwnd`/`--title` subtree scoping; multi-match reports SAH-compatible
  `ambiguous` status. New `probe` command: child-HWND census + UIA element
  count + `backgroundCapable` verdict + a plain-language diagnosis — the
  driveability precheck SAH never made fast enough to be worth calling.
- **ui.click precision upgrade — UIA fast path**: when exactly one UIA element
  matches the query, the plugin clicks the element's own pixel-accurate box
  (confidence 1.0) and skips OCR entirely — no more label-guessing, and it
  works for text OCR misreads. Measured e2e: 6.1s → 2.7s with
  `identityConfirmed: true`. When the tree is silent, the OCR path still runs
  exactly as before.
- **ui.click now runs its whole pipeline through dsbox when present** (identity
  + OCR + delivery), not just delivery; SAH remains the fallback engine.
- `ui find --hwnd/--title` are kept in argv when dsbox is active (scoped UIA
  lookup — far fewer false matches from unrelated apps); they stay stripped
  for SAH, which rejects them.
- Probe's child census fixed (value-type mutations inside the EnumWindows
  callback were silently discarded — counted via list append now).

## 0.1.24

- **dsbox covers the full background-input surface.** New `mouse scroll`
  (WM_MOUSEWHEEL ±120/click), `keyboard write` (WM_CHAR with per-char timeout
  accounting and a frame highlight so the user sees where typing goes), both
  requiring an explicit `--hwnd`/`--title` like every dsbox input command.
- **The plugin now routes background delivery through dsbox when present**
  (looked up next to the bundled script, at `G:\dsbox\dsbox.cmd`, with the old
  PowerShell script as automatic fallback). Measured: a background click that
  took ~2.5s via the old script path now completes in **1.2s** end to end, with
  the window frame highlight as a bonus.
- **Uniform refusal envelope**: dsbox input refusals (out-of-bounds point, dead
  handle, no explicit target) always carry `cursorMoved: false`, matching the
  old script, so a refusal can never read as a delivery.
- Dead-handle handling aligned with the old engine: a hwnd that resolves to an
  empty rect is refused with the same out-of-bounds message instead of a
  different error text.

## 0.1.23

- **New companion CLI: dsbox** (`G:\dsbox\dsbox.cmd` + `dsbox.ps1`) — a from-scratch,
  zero-dependency replacement for ScreenAutomationHelper's slow paths, built on
  Windows' own WinRT OCR + GDI+. Full-screen OCR: **~1.0s vs SAH's 16–20s**
  (roughly 15x). Region OCR ~0.7s. Supports `screen recognize` (--region),
  `find_exact` (ranked), `window list-visible|foreground`, `mouse click`
  (background message delivery, cursor untouched), `health`, plus a `ui find`
  shim that reports structured not-found so the plugin's identity step falls
  through to OCR instead of dying.
- **Window frame highlight**: when dsbox delivers a click it first draws a bright
  cyan rounded frame around the target window (click-through, never activates,
  fades out ~1.6s) so the user can SEE which window is being operated. Requested
  feature; enabled on every dsbox click.
- **dsbox requires an explicit `--hwnd`/`--title`** for clicks — it never
  resolves the user's foreground window (defense-in-depth by design).
- **Fixed: plugin could not spawn .cmd helper launchers** (Node ≥20 EINVAL,
  CVE-2024-27980 hardening). Batch `cliPath` values are now routed through
  `cmd.exe /d /s /c` with an explicit argument array (no shell string, no
  injection surface). Also fixed a TDZ crash (`clearTimeout(timer)` before
  declaration) when spawn failed synchronously.
- **Measured end-to-end**: `ui.click` (identity → OCR locate → background click)
  via dsbox in **5.9s** where the SAH path took 19–25s.

## 0.1.22

- **`ui.click` OCR is region-limited to the target window when `--hwnd`/`--title`
  is given.** SAH's full-screen OCR costs 15–20s per call; OCR of a window-sized
  region runs 3–6x faster (measured 2.8s for a 300×100 strip vs 15.9s full
  screen). The scope rect (0.1.14) is now resolved *before* OCR and passed as
  `--region`, so locating and scoping share one call. No change for calls
  without a target window (still full-screen), and a full-screen window rect
  (e.g. the desktop) naturally still scans everything.
- **Fixed: `ui.click` passed `--hwnd`/`--title` through to `ui.find`, which
  rejects them (exit 1).** Any `ui.click --name X --hwnd H` died at the identity
  step with a CLI usage error before reaching OCR. Those flags are now stripped
  from the `ui.find` invocation; they belong to delivery targeting only.

## 0.1.21

- **Defense-in-depth: the background script now refuses target-less typing/keys.**
  The plugin has refused typing without `--title`/`--hwnd` since 0.1.11, but the
  shipped PowerShell script itself fell back to the foreground window — so a
  direct script call (or a future code path that skips the plugin guard) could
  have typed into whatever the user is working in. The guard now lives in the
  script too, and the `key` branch sends to the resolved target instead of
  `GetForegroundWindow()`.
- **Fixed mojibake in model-visible text.** The tool description and the typing
  guard message contained corrupted em-dashes (`閳?`) and a corrupted helper
  name; they are restored to readable text.

## 0.1.20

- **`mouse.scroll` is now background-deliverable.** Scrolling used to grab the
  physical wheel (moving is not needed, but the OS wheel event goes to whatever
  is under the cursor — usually the user's own window). It is now delivered as
  `WM_MOUSEWHEEL` to the child window under the target point, with the amount
  mapped to ±120 per wheel click. The cursor never moves and the user's own
  window does not receive the scroll. `mouse.scroll` is removed from
  `PHYSICAL_INPUT_ACTIONS`, so results no longer carry the physical-input caveat.
  Verified live: scroll into an explorer window hits `ShellTabWindowClass` with
  `cursorMoved: false`.

## 0.1.19

- **New opt-in `autoFallback` config.** When the target window cannot receive
  background input at all (no child HWNDs — self-drawn UI), `ui.click` now retries
  once with the real cursor and reports `autoFallbackUsed` plus `fallbackReason`,
  instead of returning a delivery that will be silently ignored. **Off by
  default**: moving the user's mouse is exactly what background mode promises not
  to do, so this must be an explicit choice. Without it, the existing
  `noChildWindows` + `structuralCaveat` warning (naming `--input-mode real`) is
  still returned.

## 0.1.18

- **Background input no longer blocks forever on a hung window.** Click/type/key
  delivery used plain `SendMessageW`, which blocks until the target's message loop
  responds — a hung target would wedge the call until the plugin timeout. All
  sends now use `SendMessageTimeout` with `SMTO_ABORTIFHUNG` (2s) and report a
  clear failure (`target window did not respond ... no input was delivered`)
  instead of stalling. Pattern borrowed from the local computer-use installer
  reference; the difference is that this plugin still never touches the cursor
  (that reference drives `SetCursorPos` + `mouse_event` throughout).

## 0.1.17

- **New: `--input-mode real|background` overrides the configured mode for a single
  call.** A self-drawn window needs the physical cursor, and that used to require
  editing global config and reloading the profile. Now one call can opt in, and
  the `noChildWindows` warning names this exact flag as the retry.
- **Fixed: `--hwnd`/`--title` leaked to the CLI.** They are plugin-only flags that
  tell background delivery which window to target; the CLI rejects them
  (exit code 2), so any real-mode click passing `--hwnd` failed. They are now
  stripped along with `--input-mode` when the plugin is not consuming them.

## 0.1.16

- **Fixed: a token straddling the window border made the click fail.** Window
  scoping (0.1.14) selected tokens by centre point, but a token whose box
  straddles the border has its centre just outside — it was chosen and then
  rejected by the out-of-bounds guard. `ui.click --name 编辑 --hwnd 723022` failed
  with "point 1724,238 is outside ... (619,214,1721,760)" for exactly this
  reason. Selection now scores by overlap (preferring fully-contained tokens) and
  the click point is clamped into the window, so it lands on the visible part.
- **`ui.click` now warns when the target window has no child HWNDs.** On top of
  the existing class-name heuristic, it checks the structure: self-drawn UI can
  only receive the click on its top level, which is usually ignored. Reports
  `noChildWindows` plus a `structuralCaveat` instead of a clean-looking click
  that silently did nothing.
- The tool description now tells the model to run `probe` before clicking a window
  it has not driven before.

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
