# omp-session-picker

An [fzf](https://github.com/junegunn/fzf)-backed session picker for [OMP](https://omp.sh). Browse persisted sessions, preview the latest user message, and prepare a prompt that asks the current agent to read the selected session's context.

<img width="1713" height="323" alt="Screenshot 2026-09-17 at 08 50 49" src="https://github.com/user-attachments/assets/bc2d08cd-afdf-44fe-91cd-0790107d132b" />

Selecting a session inserts the session_id or [agent-id](https://github.com/DerekStride/agent-id-cli) into the prompt editor.

## Requirements

- OMP 17.3 or newer
- `fzf` available on `PATH`
- Optional: [`agent-id`](https://github.com/DerekStride/agent-id-cli) available on `PATH` for human-readable session slugs and active-session filtering

## Install

```sh
omp install github:DerekStride/omp-session-picker
```

Restart any running OMP sessions after installation.

## Use

1. Run `/session-context` from an interactive OMP session, or press `Alt+S` while editing a prompt.
2. Type to fuzzy-search Herdr workspace/tab names, session slugs (when available), titles, and project paths. The current session is excluded.
3. Review the latest user message in the preview window.
4. Press Enter to select, or Escape to cancel.
5. Continue editing or submit the prompt.

`Alt+S` inserts the selected session's human-readable slug at the current cursor position, falling back to its session ID when no slug is available. `/session-context` appends `Read the context from session <slug-or-id>` to the draft. Neither submits the prompt; Escape leaves the draft unchanged.

For tools that require a session ID, `agent-id lookup <slug> --json` returns it in the `session_id` field.

When available, the first Herdr `workspace / tab` location leads each result, followed by the title and project path. Agent slugs and additional locations remain searchable, and the preview shows all labels. Duplicate pane locations are collapsed.

With `agent-id`, the picker opens in **Active** view. Press `Ctrl+A` to toggle between **Active** and **All** without clearing the search query, including when Active is empty.

Active follows `agent-id discover`: non-stopped registered sessions, limited to live Herdr sessions when that information is available. All includes stopped and unregistered sessions.

If `agent-id` is missing or active discovery fails, the picker opens in All with title and path search.

## Development

```sh
git clone https://github.com/DerekStride/omp-session-picker.git
cd omp-session-picker
bun install
omp plugin link . --scope user
```

Run the checks with:

```sh
bun test
bun run typecheck
```

The extension uses OMP's session listing API, reads session JSONL files backward to find the latest user message, and hands the terminal to the `fzf` executable while the picker is open.

## License

[MIT](LICENSE)
