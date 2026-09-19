# Changelog

## 0.1.0

Initial release.

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
