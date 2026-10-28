import { expect, mock, test } from 'claude-code/testing'

import {
  composeTitle,
  intervalRule,
  markerRule,
  spinnerRule,
  stripRule,
  waitsForInput,
} from '../hooks/title'
import {
  customTitlePath,
  parseCustomTitleFile,
  parseTranscriptTitles,
} from '../hooks/session-title'

const OSC = /\x1b\]0;([^\x07]*)\x07/
const HOME = '/home/test'
const RECORDS = `${HOME}/.claude/sessions`

function record(fields: Record<string, unknown>): string {
  return JSON.stringify({ pid: 1, cwd: '/tmp/terminal-title', kind: 'interactive', ...fields })
}

type Harness = {
  writes: string[]
  attempts: number
  logs: string[]
  titles: () => string[]
  last: () => string | undefined
  setTranscript: (text: string) => void
  setCustom: (text: string) => void
  setMessages: (rows: unknown[]) => void
  setGate: (gate: Promise<void> | undefined) => void
  setResult: (result: unknown) => void
  setEnv: (value: string | undefined) => void
  setOs: (value: string | undefined) => void
  setWriteGate: (gate: Promise<void> | undefined) => void
  setFile: (path: string, text: string | undefined) => void
  reads: string[]
  files: Map<string, string>
  atPermission?: string
  atToolCall?: string
  denyWrite: boolean
}

function harness(on: any): Harness {
  let transcript = ''
  let custom: string | undefined
  let messages: unknown[] = []
  let gate: Promise<void> | undefined
  let result: unknown = {}
  let env: string | undefined = '1'
  let os: string | undefined
  let writeGate: Promise<void> | undefined
  const files = new Map<string, string>()
  const reads: string[] = []

  const writes: string[] = []
  const logs: string[] = []
  const state: Harness = {
    writes,
    attempts: 0,
    logs,
    titles: () => writes.map(text => OSC.exec(text)?.[1] ?? `unreadable: ${text}`),
    last: () => state.titles().at(-1),
    setTranscript: text => {
      transcript = text
    },
    setCustom: text => {
      custom = text
    },
    setMessages: rows => {
      messages = rows
    },
    setGate: next => {
      gate = next
    },
    setResult: next => {
      result = next
    },
    setEnv: value => {
      env = value
    },
    setOs: value => {
      os = value
    },
    setWriteGate: gate => {
      writeGate = gate
    },
    setFile: (path, text) => {
      if (text === undefined) files.delete(path)
      else files.set(path, text)
    },
    reads,
    files,
    denyWrite: false,
  }

  on('fs.write', async (_: any, e: any) => {
    if (e.path === '/dev/tty') state.attempts += 1
    if (writeGate !== undefined) await writeGate
    if (e.path !== '/dev/tty') {
      files.set(e.path, e.text)
      return { value: undefined }
    }
    if (state.denyWrite) return { deny: 'no tty in the test' }
    writes.push(e.text)
    return { value: undefined }
  })
  on('fs.read', (_: any, e: any) => {
    reads.push(e.path)
    const file = files.get(e.path)
    if (file !== undefined) return { value: file }
    if (e.path.startsWith(`${HOME}/`)) return { deny: 'ENOENT' }
    if (e.path.endsWith('custom-title.json')) {
      return custom === undefined ? { deny: 'ENOENT' } : { value: custom }
    }
    return { value: transcript }
  })
  on('fs.stat', () => ({
    value: {
      kind: 'file',
      size: transcript.length,
      mtimeMs: transcript.length,
      isLink: false,
    },
  }))
  on('fs.list', (_: any, e: any) => {
    reads.push(`list ${e.path}`)
    const prefix = `${e.path}/`
    return {
      value: [...files.keys()]
        .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(path => ({ name: path.slice(prefix.length), kind: 'file', size: 1, mtimeMs: 1 })),
    }
  })
  on('env.get', (_: any, e: any) => ({
    value:
      e.name === 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE'
        ? env
        : e.name === 'OS'
          ? os
          : e.name === 'HOME'
            ? HOME
            : undefined,
  }))
  on('session.id', () => ({ value: 'ses' }))
  on('session.messages', () => ({ value: messages }))
  on('ui.log', (_: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PermissionRequest', () => {
    state.atPermission = state.last()
    return {}
  })
  on('classic.SubagentStop', () => ({}))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('tool.call', async () => {
    state.atToolCall = state.last()
    if (gate !== undefined) await gate
    return { result }
  })
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-1' }))

  return state
}

async function start($: any, h: Harness, clock: any): Promise<void> {
  await $.classic.SessionStart({
    source: 'startup',
    transcript_path: '/tmp/terminal-title/ses.jsonl',
  })
  await $.session.start({
    cwd: '/tmp/terminal-title',
    surface: 'terminal',
    isInteractive: true,
  })
  await clock.settle()
}

test('waitsForInput looks at the last non-empty line', () => {
  expect(waitsForInput('done\nneeds input: [question](obsidian://x)')).toBe(true)
  expect(waitsForInput('done\nthen more text')).toBe(false)
  expect(waitsForInput('**needs input:** link')).toBe(true)
  expect(waitsForInput('')).toBe(false)
  expect(waitsForInput('needs input: x\n\n')).toBe(true)
})

test('options are validated instead of silently corrected', () => {
  expect(markerRule(undefined)).toBe('◍ ')
  expect(markerRule('▲')).toBe('▲ ')
  expect(markerRule('')).toBe('')
  expect(spinnerRule(undefined)).toEqual(['◐ ', '◓ ', '◑ ', '◒ '])
  expect(spinnerRule(false)).toEqual([])
  expect(spinnerRule(['a', 'b'])).toEqual(['a ', 'b '])
  expect(intervalRule(undefined)).toBe(150)
  expect(intervalRule(5)).toBe(5)

  expect(() => markerRule(42)).toThrow('"marker" must be a string')
  expect(() => spinnerRule([1])).toThrow('array of strings')
  expect(() => spinnerRule('a')).toThrow('array of strings')
  expect(() => intervalRule(0)).toThrow('positive number')
  expect(() => intervalRule(Number.NaN)).toThrow('positive number')
})

test('strip is a JavaScript regular expression source', () => {
  expect(stripRule(undefined).regex).toBeUndefined()
  expect(stripRule('').regex).toBeUndefined()
  expect(stripRule('^\\[[ xX]\\] ').regex?.test('[ ] Fix auth')).toBe(true)
  expect(stripRule('(').error).toContain('invalid "strip" regular expression')
  expect(stripRule(42).error).toContain('must be a regular expression string')
})

test('the transcript title rows are read with custom title first', () => {
  const text = [
    'not json',
    '{"type":"ai-title","aiTitle":"Generated"}',
    '{"type":"custom-title","customTitle":"Renamed"}',
    '{"type":"ai-title","aiTitle":"Later generated"}',
  ].join('\n')

  expect(parseTranscriptTitles(text)).toEqual({ name: 'Renamed', source: 'custom' })
  expect(parseTranscriptTitles('{"type":"ai-title","aiTitle":"Only generated"}')).toEqual({
    name: 'Only generated',
    source: 'ai',
  })
  expect(parseTranscriptTitles('garbage')).toBeUndefined()
  expect(parseCustomTitleFile('{"customTitle":"From file"}')).toBe('From file')
  expect(parseCustomTitleFile('garbage')).toBeUndefined()
  expect(customTitlePath('/a/b/ses.jsonl')).toBe('/a/b/ses/custom-title.json')
  expect(customTitlePath('/a/b/ses.txt')).toBeUndefined()
})

test('idle, working, needs input, and the spinner', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  await start($, h, clock)

  await $.turn.start({ text: 'Fix auth', turnId: 't1' })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  await clock.advance(150)
  expect(h.last()).toBe('◓ Fix auth')

  await $.turn.complete({
    answer: 'Done.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()
  expect(h.last()).toBe('Fix auth')

  await $.turn.start({ text: 'Continue', turnId: 't2' })
  await $.turn.complete({
    answer: 'Ready.\nneeds input: [question](obsidian://x)',
    durationMs: 1,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
  })
  await clock.settle()
  expect(h.last()).toBe('◍ Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a session name from the transcript and from a custom title', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript(
    ['{"type":"ai-title","aiTitle":"Generated name"}', '{"type":"user"}'].join('\n'),
  )
  await start($, h, clock)
  expect(h.last()).toBe('Generated name')

  await $.classic.UserPromptSubmit({
    prompt: 'hello',
    session_title: 'Hook name',
  })
  await clock.settle()
  expect(h.last()).toBe('Hook name')

  h.setCustom('{"customTitle":"Renamed"}')
  await $.classic.SessionStart({
    source: 'resume',
    transcript_path: '/tmp/terminal-title/ses.jsonl',
  })
  await clock.settle()
  expect(h.last()).toBe('Renamed')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a rename command refreshes the title without waiting for the next prompt', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"Old name"}')
  await start($, h, clock)
  expect(h.last()).toBe('Old name')

  h.setCustom('{"customTitle":"New name"}')
  await $.session.append({
    door: 'command',
    origin: { kind: 'engine' },
    uuid: '00000000-0000-4000-8000-000000000001',
    message: {
      type: 'system',
      name: 'local_command',
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<command-name>/rename</command-name><command-args>New name</command-args>',
        },
      ],
    },
  })
  await clock.advance(100)
  expect(h.last()).toBe('New name')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('the first prompt stands in until a session title exists', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setMessages([
    { role: 'user', text: 'Fix the login', toolUses: [] },
    { role: 'assistant', text: 'Done', toolUses: [] },
  ])
  await start($, h, clock)
  expect(h.last()).toBe('Fix the login')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test(
  'strip removes the first match from the title name only',
  { options: { strip: '^\\[[ xX]\\] ' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const h = harness(on)
    h.setCustom('{"customTitle":"[ ] Fix auth"}')
    await start($, h, clock)

    await $.turn.start({ text: 'First', turnId: 't1' })
    await clock.settle()
    expect(h.last()).toBe('◐ Fix auth')

    await $.turn.complete({
      answer: 'Done.',
      durationMs: 1,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
    })
    await $.classic.UserPromptSubmit({
      prompt: 'next',
      session_title: '[x] Fix auth',
    })
    await $.turn.start({ text: 'Second', turnId: 't2' })
    await clock.settle()
    expect(h.last()).toBe('◐ Fix auth')

    await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
  },
)

test(
  'an invalid strip regular expression is logged and strips nothing',
  { options: { strip: '(' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const h = harness(on)
    h.setCustom('{"customTitle":"[ ] Fix auth"}')
    await start($, h, clock)

    expect(h.logs.some(line => line.includes('invalid "strip" regular expression'))).toBe(
      true,
    )

    await $.turn.start({ text: 'First', turnId: 't1' })
    await clock.settle()
    expect(h.last()).toBe('◐ [ ] Fix auth')

    await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
  },
)

test('a permission request marks the tool call as waiting', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"Fix auth"}')
  await start($, h, clock)

  await $.turn.start({ text: 'Run the permissioned tool', turnId: 'main' })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  let release!: () => void
  h.setGate(new Promise<void>(resolve => {
    release = resolve
  }))
  const call = $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  await clock.settle()
  expect(h.atPermission).toBe('◍ Fix auth')
  expect(h.last()).toBe('◍ Fix auth')

  // The waiting marker must not be overwritten by a spinner frame while the
  // dialog is open; the timer is stopped when the mode turns waiting.
  await clock.advance(300)
  expect(h.last()).toBe('◍ Fix auth')

  release()
  await call
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  await $.turn.complete({
    answer: 'Done.',
    durationMs: 1,
    isAborted: false,
    turnId: 'main',
    reason: 'answer',
  })
  await clock.settle()
  expect(h.last()).toBe('Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('an AskUserQuestion dialog marks the session as waiting', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"Fix auth"}')
  await start($, h, clock)

  await $.turn.start({ text: 'Ask a question', turnId: 'main' })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  let release!: () => void
  h.setGate(new Promise<void>(resolve => {
    release = resolve
  }))
  const call = $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which colour?',
        header: 'Colour',
        options: [
          { label: 'Red', description: 'Red' },
          { label: 'Blue', description: 'Blue' },
        ],
        multiSelect: false,
      },
    ],
  })
  await clock.settle()
  expect(h.atToolCall).toBe('◍ Fix auth')
  expect(h.last()).toBe('◍ Fix auth')

  await clock.advance(300)
  expect(h.last()).toBe('◍ Fix auth')

  release()
  await call
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  await $.turn.complete({
    answer: 'Done.',
    durationMs: 1,
    isAborted: false,
    turnId: 'main',
    reason: 'answer',
  })
  await clock.settle()
  expect(h.last()).toBe('Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a background subagent keeps the title busy after the main turn', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"Fix auth"}')
  await start($, h, clock)

  await $.turn.start({ text: 'Spawn work', turnId: 'main' })
  await $.agent.spawn({
    tool_use_id: 'toolu-test',
    prompt: 'Run the tests',
    description: 'Run the tests',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test-model',
    background: true,
    fork: false,
  })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  await $.turn.complete({
    answer: 'Spawned.',
    durationMs: 1,
    isAborted: false,
    turnId: 'main',
    reason: 'answer',
  })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  await $.classic.SubagentStop({
    agent_id: 'agent-1',
    agent_type: 'general-purpose',
    stop_hook_active: false,
    agent_transcript_path: '',
  })
  await clock.settle()
  expect(h.last()).toBe('Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('needs input outlasts running work and later turns until the user answers', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"Fix auth"}')
  await start($, h, clock)

  await $.turn.start({ text: 'Spawn work', turnId: 'main' })
  await $.agent.spawn({
    tool_use_id: 'toolu-test',
    prompt: 'Run the tests',
    description: 'Run the tests',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test-model',
    background: true,
    fork: false,
  })
  await $.turn.complete({
    answer: 'Spawned.\nneeds input: [question](obsidian://x)',
    durationMs: 1,
    isAborted: false,
    turnId: 'main',
    reason: 'answer',
  })
  await clock.settle()
  expect(h.last()).toBe('◍ Fix auth')

  await $.classic.UserPromptSubmit({
    prompt: '<task-notification>\n<task-id>agent-1</task-id>\n</task-notification>',
  })
  await $.turn.start({ text: '<task-notification>', turnId: 'note' })
  await $.turn.complete({
    answer: 'One agent is done.',
    durationMs: 1,
    isAborted: false,
    turnId: 'note',
    reason: 'answer',
  })
  await clock.settle()
  expect(h.last()).toBe('◍ Fix auth')

  await $.classic.UserPromptSubmit({ prompt: 'Option b' })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a background shell keeps the title busy until its notification', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setCustom('{"customTitle":"Fix auth"}')
  await start($, h, clock)
  expect(h.last()).toBe('Fix auth')

  h.setResult({ backgroundTaskId: 'task-1' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  await $.session.append({
    door: 'prompt',
    origin: { kind: 'task-notification' },
    uuid: '00000000-0000-4000-8000-000000000002',
    message: {
      type: 'user',
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<task-notification>\n<task-id>task-1</task-id>\n<status>completed</status>\n</task-notification>',
        },
      ],
    },
  })
  await clock.settle()
  expect(h.last()).toBe('Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a background shell stopped with TaskStop leaves the title idle', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setCustom('{"customTitle":"Fix auth"}')
  await start($, h, clock)

  h.setResult({ backgroundTaskId: 'task-1' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 300', run_in_background: true })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  // A stopped task sends no notification: the stop's own result is the only signal.
  h.setResult({ message: 'Successfully stopped task: task-1', task_id: 'task-1', task_type: 'local_bash' })
  await $.tool.call({ tool: 'TaskStop', task_id: 'task-1' })
  await clock.settle()
  expect(h.last()).toBe('Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a background subagent stopped with TaskStop leaves the title idle', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setCustom('{"customTitle":"Fix auth"}')
  await start($, h, clock)

  await $.agent.spawn({
    tool_use_id: 'toolu-test',
    prompt: 'Run the tests',
    description: 'Run the tests',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test-model',
    background: true,
    fork: false,
  })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  h.setResult({ message: 'Successfully stopped task: agent-1', task_id: 'agent-1', task_type: 'local_agent' })
  await $.tool.call({ tool: 'TaskStop', task_id: 'agent-1' })
  await clock.settle()
  expect(h.last()).toBe('Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a conversation moved to a background session leaves this process silent', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setCustom('{"customTitle":"Fix auth"}')
  h.setFile(`${RECORDS}/41.json`, record({ pid: 41, sessionId: 'other', parkedJobId: 'other123' }))
  h.setFile(`${RECORDS}/42.json`, record({ pid: 42, sessionId: 'ses', status: 'busy' }))
  await start($, h, clock)

  // The turn and a background shell move with the conversation; neither end
  // ever reaches this process.
  await $.turn.start({ text: 'Configure passwords', turnId: 'main' })
  h.setResult({ backgroundTaskId: 'task-1' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 90', run_in_background: true })
  await clock.settle()
  expect(h.last()).toBe('◐ Fix auth')

  // Another process's parked record is not this one's.
  await clock.advance(1000)
  expect(h.last()).not.toBe('Fix auth')

  h.setFile(`${RECORDS}/42.json`, record({ pid: 42, sessionId: 'ses', status: 'busy', parkedJobId: '5d52bd41' }))
  await clock.advance(1000)
  expect(h.last()).toBe('Fix auth')

  const count = h.writes.length
  await clock.advance(5000)
  await $.turn.complete({
    answer: 'Done.\nneeds input: x',
    durationMs: 1,
    isAborted: true,
    turnId: 'main',
    reason: 'aborted',
  })
  await $.turn.start({ text: 'late', turnId: 'late' })
  await clock.advance(5000)
  expect(h.writes.length).toBe(count)

  // Once parked the record is not read any more.
  const reads = h.reads.length
  await clock.advance(5000)
  expect(h.reads.length).toBe(reads)

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('an idle session does not read the session records', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setCustom('{"customTitle":"Fix auth"}')
  h.setFile(`${RECORDS}/42.json`, record({ pid: 42, sessionId: 'ses' }))
  await start($, h, clock)
  await clock.advance(5000)
  expect(h.reads.filter(path => path.includes('/sessions'))).toEqual([])

  await $.turn.start({ text: 'Work', turnId: 'main' })
  await clock.advance(2000)
  expect(h.reads.filter(path => path.includes('/sessions')).length).toBeGreaterThan(0)

  await $.turn.complete({
    answer: 'Done.',
    durationMs: 1,
    isAborted: false,
    turnId: 'main',
    reason: 'answer',
  })
  await clock.settle()
  const reads = h.reads.length
  await clock.advance(5000)
  expect(h.reads.length).toBe(reads)

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a new conversation after the move draws the title again', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setCustom('{"customTitle":"Fix auth"}')
  h.setFile(`${RECORDS}/42.json`, record({ pid: 42, sessionId: 'ses', parkedJobId: '5d52bd41' }))
  await start($, h, clock)
  await $.turn.start({ text: 'Configure passwords', turnId: 'main' })
  await clock.advance(1000)
  expect(h.last()).toBe('Fix auth')

  h.setCustom('{"customTitle":"Next task"}')
  await $.classic.SessionStart({ source: 'startup', transcript_path: '/tmp/terminal-title/next.jsonl' })
  await clock.settle()
  expect(h.last()).toBe('Next task')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

const NAMES = `${HOME}/.claude/plugins/data/terminal-title/names`

async function startFork($: any, h: Harness, clock: any): Promise<void> {
  await $.classic.SessionStart({
    source: 'fork',
    transcript_path: '/tmp/terminal-title/ses.jsonl',
    session_title: 'configure-passwords-prompt',
  })
  await $.session.start({
    cwd: '/tmp/terminal-title',
    surface: 'terminal',
    isInteractive: true,
  })
  await $.turn.start({ text: '', turnId: 'resumed' })
  await clock.settle()
}

function renameCommand(name: string): any {
  return {
    door: 'command',
    origin: { kind: 'engine' },
    uuid: '00000000-0000-4000-8000-000000000003',
    message: {
      type: 'system',
      name: 'local_command',
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<command-name>/rename</command-name><command-args>${name}</command-args>`,
        },
      ],
    },
  }
}

test('the shown name is kept for a background session that continues the conversation', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setMessages([{ role: 'user', text: 'Create a cmd to pull master' }])
  await start($, h, clock)
  expect(h.last()).toBe('Create a cmd to pull master')
  expect(JSON.parse(h.files.get(`${NAMES}/ses.json`) ?? '{}')).toEqual({ name: 'Create a cmd to pull master' })

  h.setCustom('{"customTitle":"Fix auth"}')
  await $.session.append(renameCommand('Fix auth'))
  await clock.advance(100)
  expect(h.last()).toBe('Fix auth')
  expect(JSON.parse(h.files.get(`${NAMES}/ses.json`) ?? '{}')).toEqual({ name: 'Fix auth' })

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a background session shows the name its parent showed, not its generated one', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"configure-passwords-prompt"}')
  h.setCustom('{"customTitle":"[ ] configure-passwords-prompt"}')
  h.setMessages([{ role: 'user', text: 'Create a cmd to pull master' }])
  h.setFile(`${RECORDS}/45801.json`, record({ pid: 45801, sessionId: 'ses', kind: 'bg', jobId: 'job1' }))
  await startFork($, h, clock)
  // The parent marks its record a moment after the background session starts.
  await clock.advance(1000)
  expect(h.titles()).toEqual([])
  h.setFile(`${NAMES}/parent.json`, JSON.stringify({ name: 'Create a cmd for pulling master' }))
  h.setFile(`${RECORDS}/61144.json`, record({ pid: 61144, sessionId: 'parent', parkedJobId: 'job1' }))
  await clock.advance(500)
  expect(h.last()).toBe('◐ Create a cmd for pulling master')

  // A hook's rename and the end of the turn keep it.
  await $.classic.UserPromptSubmit({ prompt: '<task-notification>', session_title: '[x] configure-passwords-prompt' })
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 'resumed', reason: 'answer' })
  await clock.advance(2000)
  expect(h.last()).toBe('Create a cmd for pulling master')
  expect(h.titles().some(title => title.includes('configure-passwords-prompt'))).toBe(false)

  // The user's own rename wins.
  h.setCustom('{"customTitle":"Owner name"}')
  await $.session.append(renameCommand('Owner name'))
  await clock.advance(100)
  expect(h.last()).toBe('Owner name')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a background session with no parent found shows its first prompt and says why', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"configure-passwords-prompt"}')
  h.setMessages([{ role: 'user', text: 'Create a cmd to pull master' }])
  h.setFile(`${RECORDS}/45801.json`, record({ pid: 45801, sessionId: 'ses', kind: 'bg', jobId: 'job1' }))
  await startFork($, h, clock)
  await clock.advance(4000)
  expect(h.titles()).toEqual([])

  await clock.advance(2000)
  expect(h.last()).toMatch(/^[◐◓◑◒] Create a cmd to pull master$/)
  expect(h.logs.some(line => line.includes('a session moved to background job job1'))).toBe(true)
  expect(h.titles().some(title => title.includes('configure-passwords-prompt'))).toBe(false)

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test(
  'a custom marker, spinner list, and interval',
  { options: { marker: '▲', spinner: ['a', 'b'], spinnerInterval: 5 } },
  async ($, on) => {
    const clock = mock.clock(on)
    const h = harness(on)
    h.setTranscript('{"type":"ai-title","aiTitle":"Demo"}')
    await start($, h, clock)

    await $.turn.start({ text: 'Continue', turnId: 't1' })
    await clock.settle()
    expect(h.last()).toBe('a Demo')

    await clock.advance(5)
    expect(h.last()).toBe('b Demo')

    await $.turn.complete({
      answer: 'Ready.\nneeds input: x',
      durationMs: 1,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
    })
    await clock.settle()
    expect(h.last()).toBe('▲ Demo')

    await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
  },
)

test(
  'an empty marker disables the sign',
  { options: { marker: '' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const h = harness(on)
    h.setTranscript('{"type":"ai-title","aiTitle":"Demo"}')
    await start($, h, clock)

    await $.turn.complete({
      answer: 'Ready.\nneeds input: x',
      durationMs: 1,
      isAborted: false,
      turnId: 'not-started',
      reason: 'answer',
    })
    await clock.settle()
    expect(h.last()).toBe('Demo')

    await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
  },
)

test(
  'an empty spinner list disables the animation',
  { options: { spinner: [] } },
  async ($, on) => {
    const clock = mock.clock(on)
    const h = harness(on)
    h.setTranscript('{"type":"ai-title","aiTitle":"Demo"}')
    await start($, h, clock)

    await $.turn.start({ text: 'Continue', turnId: 't1' })
    await clock.settle()
    expect(h.last()).toBe('Demo')

    await clock.advance(100)
    expect(h.last()).toBe('Demo')

    await $.turn.complete({
      answer: 'Done.',
      durationMs: 1,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
    })
    await clock.settle()
    expect(h.last()).toBe('Demo')

    await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
  },
)

test('a resumed reply ending in needs input shows the marker', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setCustom('{"customTitle":"Fix auth"}')
  h.setMessages([
    { role: 'assistant', text: 'Done.\nneeds input: [question](obsidian://x)', toolUses: [] },
  ])
  await start($, h, clock)
  expect(h.last()).toBe('◍ Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test(
  'the generated title replaces the first prompt when it appears',
  { options: { spinner: [] } },
  async ($, on) => {
    const clock = mock.clock(on)
    const h = harness(on)
    h.setMessages([{ role: 'user', text: 'Say hi', toolUses: [] }])
    await start($, h, clock)
    expect(h.last()).toBe('Say hi')

    await $.turn.start({ text: 'Say hi', turnId: 't1' })
    await clock.settle()
    expect(h.last()).toBe('Say hi')

    h.setTranscript('{"type":"ai-title","aiTitle":"Greeting"}')
    await clock.advance(1000)
    expect(h.last()).toBe('Greeting')

    await $.turn.complete({
      answer: 'Hi!',
      durationMs: 1,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
    })
    await clock.settle()
    expect(h.last()).toBe('Greeting')

    await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
  },
)

test('session end clears the title', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setCustom('{"customTitle":"Fix auth"}')
  await start($, h, clock)
  expect(h.last()).toBe('Fix auth')

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
  await clock.settle()
  expect(h.last()).toBe('')

  await clock.advance(1000)
  expect(h.last()).toBe('')
})

test('a stuck title write does not hold the permission dialog', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"Fix auth"}')
  await start($, h, clock)

  await $.turn.start({ text: 'Run the permissioned tool', turnId: 'main' })
  await clock.settle()

  let releaseTool!: () => void
  h.setGate(new Promise<void>(resolve => {
    releaseTool = resolve
  }))
  const call = $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()

  let releaseWrite!: () => void
  h.setWriteGate(new Promise<void>(resolve => {
    releaseWrite = resolve
  }))

  const permission = $.classic.PermissionRequest({
    tool_name: 'Bash',
    tool_input: {},
  })
  await clock.advance(250)
  await permission
  expect(h.logs.some(line => line.includes('did not finish within 250ms'))).toBe(true)

  releaseWrite()
  await clock.settle()
  releaseTool()
  await call
  await clock.settle()

  await $.turn.complete({
    answer: 'Done.',
    durationMs: 1,
    isAborted: false,
    turnId: 'main',
    reason: 'answer',
  })
  await clock.settle()

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a Windows session refuses the /dev/tty transport', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setOs('Windows_NT')
  h.setTranscript('{"type":"ai-title","aiTitle":"Demo"}')
  await start($, h, clock)

  expect(h.attempts).toBe(0)
  expect(h.logs.some(line => line.includes('not available on Windows'))).toBe(true)

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a no-op session surface writes no title', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"Demo"}')
  await $.session.start({
    cwd: '/tmp/terminal-title',
    surface: null,
    isInteractive: false,
  })
  await clock.settle()

  await $.turn.start({ text: 'Fix auth', turnId: 't1' })
  await clock.settle()
  expect(h.attempts).toBe(0)
  expect(h.last()).toBeUndefined()

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a missing native-title switch is reported once', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setEnv(undefined)
  await start($, h, clock)

  expect(h.logs.some(line => line.includes('CLAUDE_CODE_DISABLE_TERMINAL_TITLE'))).toBe(
    true,
  )

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})

test('a failed /dev/tty write is reported and not retried', async ($, on) => {
  const clock = mock.clock(on)
  const h = harness(on)
  h.setTranscript('{"type":"ai-title","aiTitle":"Demo"}')
  h.denyWrite = true
  await start($, h, clock)

  await $.turn.start({ text: 'Continue', turnId: 't1' })
  await clock.settle()
  expect(h.attempts).toBe(1)
  expect(h.logs.some(line => line.includes('cannot write the terminal title'))).toBe(true)

  await $.turn.complete({
    answer: 'Done.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await clock.settle()
  expect(h.attempts).toBe(1)

  await $.session.end({ reason: 'other', sessionId: 'ses', resume: { id: 'ses' } })
})
