# omp-session-picker repository guide

## Documentation boundaries

- `README.md` is for people installing and using the picker on OMP or Pi.
- `AGENTS.md` owns implementation details, host-compatibility rules, and contributor commands.

## Code map

| Path | Responsibility |
|---|---|
| `index.ts` | OMP entrypoint: `@oh-my-pi` imports, `SessionManager.listAll()`, one-argument `setLabel` |
| `index.pi.ts` | Pi entrypoint: `@earendil-works` imports, `SessionManager.listAll()`; no label call |
| `src/picker.ts` | Shared product behavior: command, shortcut, UI guards, editor updates |
| `src/fzf-picker.ts` | fzf row/preview layout, terminal handoff, process lifecycle |
| `src/session-data.ts` | Session listing normalization, JSONL tail reading, `agent-id` discovery |
| `types/pi-host.d.ts` | Structural declaration of the Pi host surface used by `index.pi.ts` |
| `test/*.test.ts` | OMP host suite (Bun) |
| `test/pi/*.test.ts` | Pi host suite (Node); `host-stub-hooks.mjs` stands in for Pi's module aliasing |
| `test/fixtures/` | Runtime-neutral fixtures shared by both suites |
| `.github/workflows/ci.yml` | Both host suites, typecheck, pinned fzf |

## Host adapter rules

Host selection is by entrypoint, never by environment. `AI_AGENT`, `PI_*`, and similar markers are inherited by nested agents and must not decide behavior. `package.json` declares both entrypoints explicitly: the `pi` block points at `index.pi.ts`, the `omp` block at `index.ts` (OMP reads `omp`, falling back to `pi`). Keep the manifests explicit so tests, fixtures, and helpers are never discovered as extensions.

Keep host-specific runtime imports in the entrypoints. `src/` imports only `node:` modules and uses structural types (`PickerHost`, `PickerContext`, `SessionInfoLike`), so the same code runs under Bun (OMP) and Node via jiti (Pi). Use explicit `.ts` extensions on relative imports; Node's ESM loader requires them.

Known host differences:

- `pi.setLabel`: OMP accepts one argument as the extension label. Pi's `setLabel(entryId, label)` labels a transcript entry and throws for unknown ids. Only `index.ts` calls it.
- Session titles: OMP `SessionInfo.title` is auto-generated; Pi `SessionInfo.name` is user-assigned. `sessionTitle()` prefers `name`, then `title`, then the first message.
- Zero-argument `SessionManager.listAll()` lists `<agent dir>/sessions` on both hosts (`PI_CODING_AGENT_DIR`), not the current session's `--session-dir`.
- `ctx.mode` exists on both hosts. The picker refuses when `mode` is present and not `"tui"` (RPC clients report `hasUI` but cannot host custom components); a missing `mode` never disables the picker.
- Host packages are `peerDependencies` marked optional. Never add a host runtime to `dependencies`; Pi warns about bundled copies and both hosts alias their own modules at load time.

`ctx.ui.custom` is called with `{ overlay: true }` and `done()` fires before the factory returns, so no component is ever mounted. Overlay mode matters on Pi: its non-overlay close path calls `editor.setText(savedText)`, which moves the cursor to the end before `pasteToEditor` runs; OMP only restores text when a component replaced the editor.

fzf owns the terminal between `tui.stop()` and `tui.start()`. Preserve: `start()` then `requestRender(true)` in `finally` (Pi's regular-mode TUI otherwise diffs against the pre-fzf frame), exit code 130/1 as cancel, other codes as errors surfaced through `ctx.ui.notify`, the stdin descriptor closed on success and failure, and the temporary directory removed.

## Tests

Run both host suites, with their own runtimes, plus the typecheck:

```sh
bun run test:omp     # Bun: test/*.test.ts
bun run test:pi      # Node 24+: test/pi/*.test.ts
bun run typecheck
```

CI (`.github/workflows/ci.yml`) runs exactly these with Bun 1.3.14 and Node 24, a frozen lockfile, and fzf 0.70.0, matching live E2E. Older fzf versions such as 0.65 accept `--accept-nth` but ignore it in the suites' non-interactive `--filter` mode; CI checks the projected output, not just flag acceptance. fzf-dependent tests skip locally when fzf is absent but fail in CI (`requireFzfInCI`), so live-fzf coverage cannot be silently lost.

Shared-behavior coverage must stay synchronized: when changing `src/`, add matching assertions to `test/picker.test.ts` and `test/pi/picker.test.ts` (and to the session-data suites where relevant). Duplicated assertions across suites are intentional; only the fixtures under `test/fixtures/` are shared. Tests isolate `PATH` to a fixture directory plus fzf so the machine's `agent-id` and live sessions never leak into a run; fzf-dependent tests skip when fzf is absent.

Unit suites do not prove host compatibility on their own. After changing an entrypoint or manifest, load the checkout through each real host loader (Pi `discoverAndLoadExtensions`/`loadExtensions`; OMP `loadExtensions`) and exercise the picker in a live interactive session of each host with an isolated `PI_CODING_AGENT_DIR` before considering the change done.

## Development

```sh
bun install
omp plugin link . --scope user   # OMP
pi install "$PWD"                # Pi (loads in place)
```

Reload the host after changing the extension. `pi -e "$PWD/index.pi.ts"` and `omp -e "$PWD/index.ts"` load an entrypoint for one invocation without touching settings.
