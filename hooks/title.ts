// The title's vocabulary: the marker, the working frames, and the rules that
// read them from the plugin's options. Kept apart from the hooks module so the
// behaviour is testable without an engine.

export const DEFAULT_MARKER = '◉'
export const DEFAULT_SPINNER = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
]
export const DEFAULT_SPINNER_INTERVAL = 100
export const NEEDS_INPUT = 'needs input:'

// A terminal title is a single line; this keeps a pasted prompt from putting
// the whole message into the tab.
export const MAX_NAME_LENGTH = 100

export type Mode = 'idle' | 'waiting' | 'busy'

// C0 and C1 controls, including ESC and BEL: a title must not carry a sequence
// that ends the OSC string or writes another one.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

function withoutControls(value: string): string {
  return value.replace(CONTROL, '')
}

function nameLine(value: string): string {
  const line = value
    .split(/\r?\n/)
    .find(candidate => candidate.trim() !== '')
    ?.replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (line === undefined || line === '') return ''
  if (line.length <= MAX_NAME_LENGTH) return line
  return `${line.slice(0, MAX_NAME_LENGTH - 1)}…`
}

// The session title as it belongs in a terminal title: one printable line, no
// controls, and bounded. The empty string means there is nothing to show.
export function cleanName(value: string): string {
  return nameLine(value)
}

// A marker or a frame is followed by exactly one space; an empty value turns
// the sign off instead of leaving a stray space.
export function markText(value: string): string {
  const text = withoutControls(value).trimEnd()
  return text === '' ? '' : `${text} `
}

export function markerRule(value: unknown): string {
  if (value === undefined) return markText(DEFAULT_MARKER)
  if (typeof value !== 'string') {
    throw new Error('terminal-title: "marker" must be a string')
  }
  return markText(value)
}

// `false` and `[]` both turn the animation off. The manifest cannot hold
// `false` (its list option is a list of strings), but keeping the shape makes
// the option mean what it means in the OpenCode plugin.
export function spinnerRule(value: unknown): readonly string[] {
  if (value === undefined) return DEFAULT_SPINNER.map(markText)
  if (value === false) return []
  if (!Array.isArray(value) || !value.every(frame => typeof frame === 'string')) {
    throw new Error('terminal-title: "spinner" must be an array of strings or false')
  }
  return value.map(frame => markText(frame))
}

export function intervalRule(value: unknown): number {
  if (value === undefined) return DEFAULT_SPINNER_INTERVAL
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('terminal-title: "spinnerInterval" must be a positive number')
  }
  return value
}

// `needs input:` is the last non-empty line of the reply, not any line in it.
// A leading `**` is allowed because assistant replies often bold the phrase.
export function waitsForInput(text: string): boolean {
  const lines = text.trimEnd().split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trimStart() ?? ''
    if (line === '') continue
    return line.replace(/^\*\*/, '').startsWith(NEEDS_INPUT)
  }
  return false
}

export function composeTitle(
  mode: Mode,
  name: string,
  marker: string,
  frames: readonly string[],
  frame: number,
): string {
  const mark =
    mode === 'waiting'
      ? marker
      : mode === 'busy' && frames.length > 0
        ? frames[frame % frames.length] ?? ''
        : ''
  return mark + name
}
