# claude-terminal-title

A Claude Code plugin that writes the terminal title itself: the session's name with a spinner while the session is working, and a marker when it waits for you.

| State | Terminal title |
| --- | --- |
| A main reply's last non-empty line started with `needs input:`, and you have not sent a prompt since | `◍ Fix auth` |
| A permission request or an `AskUserQuestion` dialog is pending, including in subagents | `◍ Fix auth` |
| The main turn is running, any subagent is running (foreground or `run_in_background`), or a `run_in_background` shell is running | `◐ Fix auth` (animated) |
| Idle | `Fix auth` |

The rows are in priority order: a waiting session shows `◍` even while its subagents or background shells keep working.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install terminal-title --marketplace kerbyfc/claude-terminal-title
```

Answer `y` to add the marketplace, then choose a scope. From a shell, the same install is:

```sh
claude plugin install terminal-title --marketplace kerbyfc/claude-terminal-title
```

The plugin writes the title itself, so the built-in one must be off. Add this to `~/.claude/settings.json` and restart Claude Code:

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"
  }
}
```

An `env` value in a settings file is applied before the terminal interface starts; this was checked on Claude Code 2.1.310 with a settings file passed by `--settings` and a pseudo-terminal. The plugin warns once in the transcript if the variable is missing or `0`.

## Settings

The options are read from `pluginConfigs` in `~/.claude/settings.json`, keyed by the plugin id. The installed plugin's key is `terminal-title@claude-terminal-title`; a plugin loaded with `--plugin-dir` uses `terminal-title` or `terminal-title@inline`.

```json
{
  "env": {
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"
  },
  "pluginConfigs": {
    "terminal-title@claude-terminal-title": {
      "options": {
        "strip": "",
        "marker": "◍",
        "spinner": ["◐", "◓", "◑", "◒"],
        "spinnerInterval": 150
      }
    }
  }
}
```

An installed plugin's settings key is `<name>@<marketplace>`: here `terminal-title@claude-terminal-title`, the id `claude plugin list` shows. The short `terminal-title` is not the installed id — `claude plugin configure terminal-title` reports no such installed plugin (or, in the menu, shows every option unset) and does not read these values; `claude plugin configure terminal-title@claude-terminal-title` reads them. A `--plugin-dir` plugin is the other case: its key is `terminal-title` or `terminal-title@inline`.

- `strip` — a JavaScript regular expression source. Its first match is removed from the session name **in the terminal title only**; the session's own name is not changed. Default: empty, so nothing is stripped. Use it to cut what another session-naming automation adds — status tags such as `[ ]`/`[x]`, task prefixes, ticket numbers — so the title keeps only the name. Example: `"strip": "^\\[[ xX]\\]\\s*"` turns `[ ] Fix auth` and `[x] Fix auth` into `Fix auth`. Claude Code's configure command trims trailing whitespace from a value: an input ending in a space is stored without it, so write the required whitespace as `\s` or a character class; the example uses `\s*`. An invalid expression is logged once in the transcript and nothing is stripped; the plugin keeps running.
- `marker` — the symbol prepended when the session is waiting. One space is added after it; set it to `""` to disable the marker. Default: `◍`.
- `spinner` — frames of the working animation. One space is added after each frame; set it to `[]` to disable the animation. Default: `["◐", "◓", "◑", "◒"]`. Claude Code's config menu edits single-valued options only, so set this list in `pluginConfigs` as shown. The OpenCode plugin's `spinner: false` has the same effect as `[]`.
- `spinnerInterval` — milliseconds between spinner frames. Default: `150`.

Names are reduced to one printable line, stripped of control characters (including `ESC` and `BEL`, which would otherwise end the terminal's title sequence), and cut to 100 characters; `strip` is applied after that, while the title is composed.

### Compared with the OpenCode plugin

In the OpenCode plugin these are `plugins[].options` in `cli.json`; here they are `pluginConfigs`, keyed by `terminal-title@claude-terminal-title` for an installed plugin or `terminal-title`/`terminal-title@inline` for a `--plugin-dir` plugin, with the single-valued fields also in `/config`.

| Option | OpenCode plugin | This plugin | Set through | Difference |
| --- | --- | --- | --- | --- |
| `strip` | JavaScript regular expression string; its first match is removed from the host title; default `^OC \| ` | JavaScript regular expression string; its first match is removed from the session name in the title only; default empty | `pluginConfigs`, `/config` | Claude Code has no `OC \| ` prefix, so the default is empty; the option remains for other naming automation. An invalid expression fails the OpenCode plugin's load; this plugin logs it and leaves the name unstripped, as requested here. The configure command trims trailing whitespace, so the example writes the tag separator as `\s*`. |
| `marker` | string; one space is added; default `◉` | string; one space is added; default `◍` | `pluginConfigs`, `/config` | The default symbol differs: OpenCode uses `◉`, this plugin `◍`; the shape is the same. |
| `spinner` | list of strings, or `false`; default the OpenCode Braille set | `type: "string", multiple: true`; default the four frames above; `[]` disables | `pluginConfigs` only; Claude Code's config menu skips list fields | Claude Code's `userConfig` has no array-valued type (a list is `type: "string"` with `multiple: true`) and no boolean form for this field, so `spinner: false` cannot be stored; `[]` is the equivalent. The rule function accepts `false`; the manifest path cannot. |
| `spinnerInterval` | number of milliseconds; default `100` | number of milliseconds; default `150` | `pluginConfigs`, `/config` | The option shape is the same; the default is 150 here and 100 in the OpenCode plugin. |

### Why the default spinner is not the OpenCode one

The default frames are `◐ ◓ ◑ ◒`, not the Braille set `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`. These symbols and the `◍` marker render at the same height in a line, so the marker and the spinner frames do not jump. The author uses the Braille set in [opencode-terminal-title](https://github.com/kerbyfc/opencode-terminal-title); a different set also lets you tell a Claude Code tab from an OpenCode tab at a glance.

## Where the name comes from

Claude Code has no `$.session.title()` in 2.1.310. The name is taken, in this order:

1. A custom session title: one set by `/rename`, or by a `SessionStart`/`UserPromptSubmit` hook's `sessionTitle`. The hook input's `session_title` field carries it.
2. The generated title (`ai-title`) in the session transcript. The plugin reads the transcript through `$.fs.read`; the row is written by Claude Code's title generator shortly after the first prompt.
3. The first prompt, which is what the session has before either title exists. Claude Code returns at most 4096 messages to a plugin, so in a very long resumed session this is the first user message of those 4096, not necessarily the original first prompt.

A terminal title is not the only consumer of this name. The transcript read is bounded by `$.fs.read`'s 4 MiB limit. A long resumed conversation can be larger; such a session keeps its custom title or first prompt, and `/rename` shows the new name immediately. An AI-generated title for a session already past 4 MiB is not read.

## How it works

- `turn.start` and `turn.complete` count the main turn and any subagent turn that reaches the hooks.
- A subagent is also counted from `agent.spawn` until `classic.SubagentStop`, because a background subagent's turn does not reach the turn hooks.
- `tool.call` counts an `AskUserQuestion` dialog from its start until its answer, and recognizes a `Bash` call's `backgroundTaskId`. The matching `<task-id>` in a background task notification clears it.
- A main reply ending in `needs input:` sets a waiting flag that stays until your next `UserPromptSubmit`. Later turns started by a background task notification do not clear it, and a prompt starting with `<` (a notification) is not counted as your answer.
- `classic.PermissionRequest` marks a pending permission request and the same tool call clears it after the tool returns. The permission and `AskUserQuestion` hooks write the marker and wait for it to reach `/dev/tty` before they let the dialog open. A marker write still in flight when the dialog opens is too late: the dialog takes the screen and the waiting state has already stopped the spinner, so the last frame stays. Waiting for the write first keeps the marker on screen for the whole dialog. The wait is bounded at 250 ms: a stalled write logs a line and lets the dialog open without the marker.
- `session.append` notices a `/rename` command or a "user named this session" note and refreshes the title from the transcript.
- The title is written as an OSC 0 sequence to `/dev/tty`. If that write fails, the plugin stops writing and says why in the transcript instead of failing silently.

## Test

```sh
claude plugin validate .
claude plugin test .
npx tsc -p .
```

The type declarations under `.claude-plugin/types/` are written by Claude Code when it loads the plugin from this folder; they are not checked in. Load the plugin once (for example, an interactive `claude --plugin-dir .` session) before `npx tsc -p .` on a fresh checkout.

## Limitations

- The marker stays from a permission request until the permissioned tool returns. Claude Code reports the request and the tool's end but not the answer in between, so a long approved tool keeps the marker while it runs.
- A background task that was already running when the plugin loaded is not known; it is picked up when its next notification arrives.
- The title is written only when the session started on the `terminal` surface. A `-p` run, the SDK and the desktop app have no terminal title to write.
- `/dev/tty` is the verified transport on macOS. Windows has no such terminal path, so the plugin refuses there with a transcript line instead of writing a file; another transport is not implemented.
- The name and the title are computed from events. A session resumed with a transcript over 4 MiB has no generated title to read, as described above.
- `$.session.messages()` returns the newest 4096 messages. In a long resumed session with no readable title, the first prompt used as the name can be a later user message.

## License

MIT
