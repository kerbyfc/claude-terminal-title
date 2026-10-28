// Claude Code keeps one record per running process in
// `<config dir>/sessions/<pid>.json`. When the conversation of an interactive
// process moves to a background session (the left arrow, or "Backgrounding
// after the current tool finishes"), the engine sets `parkedJobId` on that
// record and the process turns into the background-session list. No engine
// event tells a plugin; the record is the only signal. The background
// session's own record carries that job id as `jobId`, which is how it finds
// the process it continues.

export type SessionRecord = {
  sessionId: string
  kind: string
  jobId?: string
  parkedJobId?: string
}

export function parseSessionRecord(text: string): SessionRecord | undefined {
  let row: { sessionId?: unknown; kind?: unknown; jobId?: unknown; parkedJobId?: unknown }
  try {
    row = JSON.parse(text) as typeof row
  } catch {
    return undefined
  }
  if (typeof row !== 'object' || row === null) return undefined
  if (typeof row.sessionId !== 'string' || typeof row.kind !== 'string') return undefined
  const record: SessionRecord = { sessionId: row.sessionId, kind: row.kind }
  if (typeof row.jobId === 'string' && row.jobId !== '') record.jobId = row.jobId
  if (typeof row.parkedJobId === 'string' && row.parkedJobId !== '') {
    record.parkedJobId = row.parkedJobId
  }
  return record
}

// The name a session's title shows, kept by this plugin for the background
// session that may continue it: `{ "name": "..." }`.
export function parseShownName(text: string): string | undefined {
  let row: { name?: unknown }
  try {
    row = JSON.parse(text) as typeof row
  } catch {
    return undefined
  }
  if (typeof row !== 'object' || row === null) return undefined
  return typeof row.name === 'string' && row.name.trim() !== '' ? row.name : undefined
}

// The configuration directory is CLAUDE_CONFIG_DIR when set, else ~/.claude.
export function claudeConfigDir(configDir: string | undefined, home: string | undefined): string | undefined {
  if (configDir !== undefined && configDir !== '') return configDir.replace(/\/+$/, '')
  if (home !== undefined && home !== '') return `${home.replace(/\/+$/, '')}/.claude`
  return undefined
}

export const sessionRecordsDir = (config: string): string => `${config}/sessions`

export const shownNamesDir = (config: string): string => `${config}/plugins/data/terminal-title/names`
