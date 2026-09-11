# omp-session-picker

An [fzf](https://github.com/junegunn/fzf)-backed session picker for [OMP](https://omp.sh). Browse persisted sessions, preview the latest user message, and prepare a prompt that asks the current agent to read the selected session's context.

![FZF session picker showing session metadata and the latest user message](assets/session-picker.webp)

Selecting a session restores OMP and prepares the prompt without submitting it, so it can be edited first.

![OMP editor populated with the selected session ID](assets/session-context-prompt.webp)

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
2. Type to fuzzy-search session slugs (when available), titles, and project paths. The current session is excluded.
3. Review the latest user message in the preview window.
4. Press Enter to select, or Escape to cancel.
5. Continue editing or submit the prompt.

`Alt+S` inserts only the selected session ID at the current cursor position, preserving surrounding text. `/session-context` appends `Read the context from session <session-id>` to the draft. Neither submits the prompt; Escape leaves the draft unchanged.

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
