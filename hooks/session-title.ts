// Where the session's name comes from. Claude Code keeps the title the tab
// shows in the session transcript: an `ai-title` row for the generated name and
// a `custom-title` row (or the sibling `custom-title.json`) for `/rename` and a
// SessionStart hook's `sessionTitle`. There is no `$.session.title()` in this
// build, so the transcript is read through $.fs.

// $.fs.read refuses a file over 4 MiB. The generated title is written near the
// start of the transcript, but a long resumed conversation can pass the limit;
// such a session keeps the first prompt (or its custom title) instead.
export const TRANSCRIPT_READ_LIMIT = 4 * 1024 * 1024

export type SessionTitle = {
  name: string
  source: 'custom' | 'ai'
}

type TranscriptRow = {
  type?: unknown
  customTitle?: unknown
  aiTitle?: unknown
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

// The last custom title wins over the generated one, as it does in the engine:
// a renamed session keeps its name after the title generator has run.
export function parseTranscriptTitles(text: string): SessionTitle | undefined {
  let custom: string | undefined
  let generated: string | undefined

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    let row: TranscriptRow
    try {
      row = JSON.parse(trimmed) as TranscriptRow
    } catch {
      continue
    }

    if (row.type === 'custom-title') {
      custom = nonEmpty(row.customTitle) ?? custom
    } else if (row.type === 'ai-title') {
      generated = nonEmpty(row.aiTitle) ?? generated
    }
  }

  if (custom !== undefined) return { name: custom, source: 'custom' }
  if (generated !== undefined) return { name: generated, source: 'ai' }
  return undefined
}

export function parseCustomTitleFile(text: string): string | undefined {
  let row: TranscriptRow
  try {
    row = JSON.parse(text) as TranscriptRow
  } catch {
    return undefined
  }
  return nonEmpty(row.customTitle)
}

// The transcript is `<project>/<session-id>.jsonl`; the engine writes
// `custom-title.json` in the sibling `<session-id>/` folder when a session is
// renamed. A path that does not look like a transcript has no such sibling.
export function customTitlePath(transcriptPath: string): string | undefined {
  if (!transcriptPath.endsWith('.jsonl')) return undefined
  return `${transcriptPath.slice(0, -'.jsonl'.length)}/custom-title.json`
}
