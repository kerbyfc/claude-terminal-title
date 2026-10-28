// Claude Code keeps one record per running process in
// `<config dir>/sessions/<pid>.json`. When the conversation of an interactive
// process moves to a background session (the left arrow, or "Backgrounding
// after the current tool finishes"), the engine sets `parkedJobId` on that
// record and the process turns into the background-session list. No engine
// event tells a plugin; the record is the only signal.

export type SessionRecord = {
  sessionId: string
  kind: string
  parkedJobId?: string
}

export function parseSessionRecord(text: string): SessionRecord | undefined {
  let row: { sessionId?: unknown; kind?: unknown; parkedJobId?: unknown }
  try {
    row = JSON.parse(text) as typeof row
  } catch {
    return undefined
  }
  if (typeof row !== 'object' || row === null) return undefined
  if (typeof row.sessionId !== 'string' || typeof row.kind !== 'string') return undefined
  const record: SessionRecord = { sessionId: row.sessionId, kind: row.kind }
  if (typeof row.parkedJobId === 'string' && row.parkedJobId !== '') {
    record.parkedJobId = row.parkedJobId
  }
  return record
}

// The configuration directory is CLAUDE_CONFIG_DIR when set, else ~/.claude.
export function sessionRecordsDir(configDir: string | undefined, home: string | undefined): string | undefined {
  if (configDir !== undefined && configDir !== '') return `${configDir.replace(/\/+$/, '')}/sessions`
  if (home !== undefined && home !== '') return `${home.replace(/\/+$/, '')}/.claude/sessions`
  return undefined
}
