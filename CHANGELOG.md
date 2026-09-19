# Changelog

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
