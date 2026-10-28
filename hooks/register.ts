import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  cleanName,
  composeTitle,
  intervalRule,
  markerRule,
  spinnerRule,
  stripRule,
  waitsForInput,
  type Mode,
} from './title'
import {
  TRANSCRIPT_READ_LIMIT,
  customTitlePath,
  parseCustomTitleFile,
  parseTranscriptTitles,
} from './session-title'
import { parseSessionRecord, sessionRecordsDir } from './session-record'

const TTY = '/dev/tty'
const TITLE_POLL_MS = 1000
// The title generator answers within a few seconds of the first prompt. The
// poll is a safety net, not a permanent read of the transcript.
const TITLE_POLL_TICKS = 30
const RENAME_REFRESH_MS = [100, 800] as const
// While work runs, the process's session record is read this often to notice
// the conversation moving to a background session.
const PARK_POLL_MS = 1000

type NameKind = 'none' | 'prompt' | 'session'

type ActiveCall = {
  tool: string
  permission: boolean
}

type Controller = {
  sessionStart: (e: { surface: string | null }) => Promise<void>
  classicSessionStart: (e: {
    transcript_path?: string
    source?: string
    session_title?: string
  }) => Promise<void>
  classicPromptSubmit: (e: {
    prompt?: string
    transcript_path?: string
    session_title?: string
  }) => void
  turnStart: (e: { text: string; turnId: string; agentId?: string }) => void
  turnComplete: (e: { answer: string; turnId: string; agentId?: string }) => void
  permissionAsked: (toolName: string) => Promise<void>
  callStarted: (tool: string, id: string) => Promise<void>
  callFinished: (tool: string, id: string, result: unknown) => void
  agentStarted: (agentId: string | undefined) => void
  agentStopped: (agentId: string | undefined) => void
  appended: (e: { door: string; message: { content?: unknown } }) => void
  end: () => void
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 240 ? `${text.slice(0, 239)}…` : text
}

function textOf(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

function taskIdOf(text: string): string | undefined {
  const match = /<task-id>([^<]+)<\/task-id>/.exec(text)
  const id = match?.[1]?.trim()
  return id === undefined || id === '' ? undefined : id
}

function backgroundTaskOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const value = (result as { result?: unknown }).result
  if (typeof value !== 'object' || value === null) return undefined
  const bash = value as {
    backgroundTaskId?: unknown
    backgroundEndsWithFinalResponse?: unknown
  }
  // A command cut off with its caller's final response has no completion
  // notification; keeping it would leave the title busy forever.
  if (bash.backgroundEndsWithFinalResponse === true) return undefined
  return typeof bash.backgroundTaskId === 'string' && bash.backgroundTaskId !== ''
    ? bash.backgroundTaskId
    : undefined
}

// A task stopped with TaskStop sends no completion notification: the stop's
// own result names the shell or agent that is gone.
function stoppedTaskOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const value = (result as { result?: unknown }).result
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { task_id?: unknown }).task_id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function createController(
  $: EngineInterface,
  rules: {
    marker: string
    frames: readonly string[]
    interval: number
    strip?: RegExp
    stripError?: string
  },
): Controller {
  const { marker, frames, interval, strip, stripError } = rules

  let generation = 0
  let hasSurface = false
  let envChecked = false
  let platformChecked = false
  let transcriptPath: string | undefined
  let name = ''
  let nameKind: NameKind = 'none'
  // Set by a main reply ending in `needs input:`; only the user's own prompt
  // clears it, so later notification turns and running work cannot hide it.
  let awaitingInput = false
  let painted = ''
  let frame = 0
  let spinner: Timer | undefined
  let poll: Timer | undefined
  let pollTicks = 0
  let lastStat: { size: number; mtimeMs: number } | undefined
  let writing = false
  let pending: string | undefined
  let writeFailed = false
  const waiters: Array<() => void> = []
  let largeTranscriptReported = false
  let titleReadFailureReported = false
  let statFailureReported = false
  let customReadFailureReported = false
  // The conversation moved to a background session: that session's own
  // process draws the title now, and this one writes nothing until it starts
  // a conversation of its own.
  let parked = false
  let parkPoll: Timer | undefined
  let parkChecking = false
  let recordPath: string | undefined
  let recordsDir: string | undefined
  let registryFailureReported = false

  const oneShots: Timer[] = []
  const activeCalls = new Map<string, ActiveCall>()
  const questions = new Set<string>()
  const permissions = new Set<string>()
  const mainTurns = new Set<string>()
  const agents = new Set<string>()
  const backgroundTasks = new Set<string>()

  const report = (text: string): void => {
    try {
      $.ui.log(text)
    } catch {
      // A log line is the error channel; losing it must not break a hook.
    }
  }

  if (stripError !== undefined) report(stripError)

  const writeTitle = (title: string, silent = false): void => {
    if (!hasSurface || parked) return
    if (writeFailed && !silent) return
    pending = title
    if (writing) return
    writing = true
    void (async () => {
      try {
        while (pending !== undefined) {
          const text = pending
          pending = undefined
          await $.fs.write(TTY, `\x1b]0;${text}\x07`)
        }
      } catch (error) {
        if (!silent) {
          writeFailed = true
          report(`cannot write the terminal title to ${TTY}: ${reasonOf(error)}`)
        }
      } finally {
        writing = false
        for (const resolve of waiters.splice(0)) resolve()
      }
    })()
  }

  // A dialog is drawn in front of the tty, and a title write started after it
  // opens is held until it closes. The permission and question hooks wait for
  // the marker to reach the tty before they let the dialog open.
  const flushTitle = (): Promise<void> => {
    if (!writing) return Promise.resolve()
    return new Promise(resolve => waiters.push(resolve))
  }

  // The dialog is the important thing. A terminal write that never returns
  // must not keep it off the screen; the marker loses, and the transcript says
  // why.
  const waitForTitle = async (before: string): Promise<void> => {
    if (!writing) return
    let timer: Timer | undefined
    const outcome = await Promise.race([
      flushTitle().then(() => 'written' as const),
      new Promise<'timeout'>(resolve => {
        timer = $.clock.after(250, () => resolve('timeout'))
      }),
    ])
    timer?.cancel()
    if (outcome === 'timeout') {
      report(`the title write did not finish within 250ms before the ${before}; opening it without the marker`)
    }
  }

  const hasRunningWork = (): boolean =>
    mainTurns.size > 0 || agents.size > 0 || backgroundTasks.size > 0

  const currentMode = (): Mode => {
    if (questions.size > 0 || permissions.size > 0 || awaitingInput) return 'waiting'
    if (hasRunningWork()) return 'busy'
    return 'idle'
  }

  const stopSpinner = (): void => {
    spinner?.cancel()
    spinner = undefined
  }

  const syncSpinner = (mode: Mode): void => {
    if (mode !== 'busy' || frames.length <= 1 || !hasSurface || parked) {
      stopSpinner()
      return
    }
    if (spinner !== undefined) return
    frame = 0
    spinner = $.clock.every(interval, () => {
      frame = (frame + 1) % frames.length
      paint()
    })
  }

  const titleName = (): string =>
    strip === undefined ? name : name.replace(strip, '').trimStart()

  const paint = (): void => {
    if (parked) return
    const mode = currentMode()
    syncSpinner(mode)
    syncParkPoll()
    const title = composeTitle(mode, titleName(), marker, frames, frame)
    if (title === painted) return
    painted = title
    writeTitle(title)
  }

  const stopParkPoll = (): void => {
    parkPoll?.cancel()
    parkPoll = undefined
  }

  const syncParkPoll = (): void => {
    if (!hasSurface || parked || !hasRunningWork()) {
      stopParkPoll()
      return
    }
    if (parkPoll !== undefined) return
    parkPoll = $.clock.every(PARK_POLL_MS, () => {
      void checkParked()
    })
  }

  const reportRegistry = (text: string): void => {
    if (registryFailureReported) return
    registryFailureReported = true
    report(text)
  }

  const resolveRecordsDir = async (): Promise<string | undefined> => {
    if (recordsDir !== undefined) return recordsDir
    const dir = sessionRecordsDir(
      await $.env.get('CLAUDE_CONFIG_DIR'),
      await $.env.get('HOME'),
    )
    if (dir === undefined) {
      reportRegistry('cannot find the session records: neither CLAUDE_CONFIG_DIR nor HOME is set')
      return undefined
    }
    recordsDir = dir
    return dir
  }

  // The record's file is named after the process id, which a plugin does not
  // know: the first check finds it by session id, later checks read it alone.
  const findRecord = async (dir: string, sessionId: string): Promise<string | undefined> => {
    for (const entry of await $.fs.list(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const path = `${dir}/${entry.name}`
      let text: string
      try {
        text = await $.fs.read(path)
      } catch {
        // A process that just exited takes its record with it.
        continue
      }
      const record = parseSessionRecord(text)
      if (record?.sessionId === sessionId && record.kind === 'interactive') return path
    }
    return undefined
  }

  const checkParked = async (): Promise<void> => {
    if (parkChecking || parked) return
    parkChecking = true
    const current = generation
    try {
      const dir = await resolveRecordsDir()
      if (dir === undefined) return
      const sessionId = await $.session.id()
      if (current !== generation) return
      recordPath ??= await findRecord(dir, sessionId)
      if (current !== generation || recordPath === undefined) return
      let text: string
      try {
        text = await $.fs.read(recordPath)
      } catch {
        recordPath = undefined
        return
      }
      if (current !== generation) return
      const record = parseSessionRecord(text)
      if (record === undefined || record.sessionId !== sessionId) {
        recordPath = undefined
        return
      }
      if (record.parkedJobId !== undefined) park()
    } catch (error) {
      if (current === generation) {
        reportRegistry(`cannot read the session records: ${reasonOf(error)}`)
      }
    } finally {
      parkChecking = false
    }
  }

  // The turn and the tasks went with the conversation; their ends reach the
  // background session, not this process. The title loses its spinner once
  // and is left to the background session.
  const park = (): void => {
    stopSpinner()
    stopPoll()
    stopParkPoll()
    for (const timer of oneShots) timer.cancel()
    oneShots.length = 0
    activeCalls.clear()
    questions.clear()
    permissions.clear()
    mainTurns.clear()
    agents.clear()
    backgroundTasks.clear()
    awaitingInput = false
    const title = composeTitle('idle', titleName(), marker, frames, frame)
    if (title !== painted) {
      painted = title
      writeTitle(title)
    }
    parked = true
  }

  const stopPoll = (): void => {
    poll?.cancel()
    poll = undefined
    pollTicks = 0
  }

  const setSessionName = (value: string): void => {
    const clean = cleanName(value)
    if (clean === '') return
    const changed = clean !== name || nameKind !== 'session'
    name = clean
    nameKind = 'session'
    stopPoll()
    if (changed) paint()
  }

  const setPromptName = (value: string): void => {
    if (nameKind !== 'none') return
    const trimmed = value.trimStart()
    if (trimmed === '' || trimmed.startsWith('<')) return
    const clean = cleanName(value)
    if (clean === '') return
    name = clean
    nameKind = 'prompt'
    paint()
  }

  const reset = (): void => {
    generation += 1
    stopSpinner()
    stopPoll()
    stopParkPoll()
    parked = false
    recordPath = undefined
    for (const timer of oneShots) timer.cancel()
    oneShots.length = 0
    activeCalls.clear()
    questions.clear()
    permissions.clear()
    mainTurns.clear()
    agents.clear()
    backgroundTasks.clear()
    awaitingInput = false
    name = ''
    nameKind = 'none'
    painted = ''
    lastStat = undefined
    pending = undefined
    transcriptPath = undefined
  }

  const startTitlePoll = (): void => {
    if (
      !hasSurface ||
      parked ||
      poll !== undefined ||
      nameKind === 'session' ||
      transcriptPath === undefined
    ) {
      return
    }
    pollTicks = 0
    poll = $.clock.every(TITLE_POLL_MS, () => {
      pollTicks += 1
      if (nameKind === 'session' || pollTicks > TITLE_POLL_TICKS) {
        stopPoll()
        return
      }
      void refreshTitle(false)
    })
  }

  const refreshTitle = async (explicit: boolean): Promise<void> => {
    if (!hasSurface) return
    const path = transcriptPath
    if (path === undefined) return
    const current = generation

    let stat: { kind: string; size: number; mtimeMs: number }
    try {
      stat = await $.fs.stat(path)
    } catch (error) {
      // A fresh session has no transcript yet; that is not a failure to report.
      if (current === generation && !statFailureReported && !String(error).includes('ENOENT')) {
        statFailureReported = true
        report(`cannot stat the session transcript ${path}: ${reasonOf(error)}`)
      }
      return
    }
    if (current !== generation) return
    if (stat.kind !== 'file') return
    if (
      !explicit &&
      lastStat !== undefined &&
      stat.size === lastStat.size &&
      stat.mtimeMs === lastStat.mtimeMs
    ) {
      return
    }
    lastStat = { size: stat.size, mtimeMs: stat.mtimeMs }

    const customPath = customTitlePath(path)
    if (customPath !== undefined) {
      try {
        const custom = parseCustomTitleFile(await $.fs.read(customPath))
        if (current !== generation) return
        if (custom !== undefined) {
          setSessionName(custom)
          return
        }
      } catch (error) {
        if (current !== generation) return
        // A session without a rename has no custom-title.json.
        if (!customReadFailureReported && !String(error).includes('ENOENT')) {
          customReadFailureReported = true
          report(`cannot read the custom session title ${customPath}: ${reasonOf(error)}`)
        }
      }
    }

    if (stat.size > TRANSCRIPT_READ_LIMIT) {
      if (!largeTranscriptReported) {
        largeTranscriptReported = true
        report(
          `the transcript is over ${TRANSCRIPT_READ_LIMIT} bytes; ` +
            'its generated title is not read (the first prompt stands in until /rename)',
        )
      }
      return
    }

    try {
      const text = await $.fs.read(path)
      if (current !== generation) return
      const found = parseTranscriptTitles(text)
      if (found !== undefined) setSessionName(found.name)
    } catch (error) {
      if (current !== generation) return
      if (!titleReadFailureReported) {
        titleReadFailureReported = true
        report(`cannot read the session title from ${path}: ${reasonOf(error)}`)
      }
    }
  }

  const checkPlatform = async (): Promise<boolean> => {
    if (platformChecked) return true
    platformChecked = true
    let os: string | undefined
    try {
      os = await $.env.get('OS')
    } catch (error) {
      report(`cannot read OS: ${reasonOf(error)}`)
      return true
    }
    if (os === 'Windows_NT') {
      report('the terminal title transport /dev/tty is not available on Windows')
      return false
    }
    return true
  }

  const checkNativeTitle = async (): Promise<void> => {
    if (envChecked) return
    envChecked = true
    let value: string | undefined
    try {
      value = await $.env.get('CLAUDE_CODE_DISABLE_TERMINAL_TITLE')
    } catch (error) {
      report(`cannot read CLAUDE_CODE_DISABLE_TERMINAL_TITLE: ${reasonOf(error)}`)
      return
    }
    if (
      value !== undefined &&
      value !== '' &&
      value !== '0' &&
      value.toLowerCase() !== 'false'
    ) {
      return
    }
    report(
      'the built-in terminal title is still on; ' +
        'set CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 in ~/.claude/settings.json env',
    )
  }

  // A resumed session has no turn to tell the title its last answer: read the
  // newest messages so a reply ending in `needs input:` keeps its marker.
  const readSessionMessages = async (): Promise<void> => {
    const current = generation
    try {
      const messages = await $.session.messages()
      if (current !== generation) return
      if (!Array.isArray(messages)) return
      let firstPrompt: string | undefined
      let lastAssistant: string | undefined
      for (const message of messages) {
        const text = typeof message.text === 'string' ? message.text : ''
        if (message.role === 'user' && firstPrompt === undefined) {
          const trimmed = text.trimStart()
          if (trimmed !== '' && !trimmed.startsWith('<')) firstPrompt = text
        } else if (message.role === 'assistant' && text.trim() !== '') {
          lastAssistant = text
        }
      }
      if (firstPrompt !== undefined) setPromptName(firstPrompt)
      if (lastAssistant !== undefined) awaitingInput = waitsForInput(lastAssistant)
      paint()
    } catch (error) {
      if (current === generation) {
        report(`cannot read the session messages: ${reasonOf(error)}`)
      }
    }
  }

  const scheduleTitleRefresh = (): void => {
    for (const ms of RENAME_REFRESH_MS) {
      const timer = $.clock.after(ms, () => {
        const index = oneShots.indexOf(timer)
        if (index >= 0) oneShots.splice(index, 1)
        void refreshTitle(true)
      })
      oneShots.push(timer)
    }
  }

  const sessionStart = async (e: { surface: string | null }): Promise<void> => {
    const current = generation
    hasSurface = e.surface === 'terminal'
    if (!hasSurface) {
      stopSpinner()
      stopPoll()
      return
    }
    if (!(await checkPlatform())) {
      hasSurface = false
      stopSpinner()
      stopPoll()
      return
    }
    if (current !== generation) return
    await checkNativeTitle()
    if (current !== generation) return
    // The name first, so a resumed session's last answer paints with it rather
    // than with a marker and an empty name.
    if (transcriptPath !== undefined) await refreshTitle(true)
    if (current !== generation) return
    await readSessionMessages()
    if (current !== generation) return
    paint()
  }

  return {
    sessionStart,

    classicSessionStart: async e => {
      // A conversation this process starts after its last one moved to the
      // background is its own again.
      if (e.source === 'clear' || parked) reset()
      const current = generation
      if (typeof e.transcript_path === 'string' && e.transcript_path !== '') {
        transcriptPath = e.transcript_path
      }
      if (typeof e.session_title === 'string') setSessionName(e.session_title)
      else if (transcriptPath !== undefined) await refreshTitle(true)
      if (current === generation) paint()
    },

    classicPromptSubmit: e => {
      if (typeof e.transcript_path === 'string' && e.transcript_path !== '') {
        transcriptPath = e.transcript_path
      }
      if (typeof e.session_title === 'string') setSessionName(e.session_title)
      // A task notification arrives as a prompt too; it is not the user's answer.
      if (typeof e.prompt === 'string' && !e.prompt.trimStart().startsWith('<')) {
        awaitingInput = false
      }
      paint()
    },

    turnStart: e => {
      if (e.agentId !== undefined) {
        agents.add(e.agentId)
      } else {
        mainTurns.add(e.turnId)
        if (nameKind === 'none') setPromptName(e.text)
        startTitlePoll()
      }
      paint()
    },

    turnComplete: e => {
      if (e.agentId !== undefined) {
        agents.delete(e.agentId)
      } else {
        mainTurns.delete(e.turnId)
        if (waitsForInput(e.answer)) awaitingInput = true
        if (nameKind !== 'session' && transcriptPath !== undefined) {
          void refreshTitle(true)
        }
      }
      paint()
    },

    permissionAsked: async toolName => {
      let match: string | undefined
      for (const [id, call] of activeCalls) {
        if (call.tool === toolName && !call.permission) match = id
      }
      if (match === undefined) return
      const call = activeCalls.get(match)
      if (call === undefined) return
      call.permission = true
      permissions.add(match)
      paint()
      await waitForTitle('permission dialog')
    },

    callStarted: async (tool, id) => {
      activeCalls.set(id, { tool, permission: false })
      if (tool === 'AskUserQuestion') {
        questions.add(id)
        paint()
        await waitForTitle('question dialog')
      }
    },

    callFinished: (tool, id, result) => {
      activeCalls.delete(id)
      if (questions.delete(id) || permissions.delete(id)) paint()
      if (tool === 'TaskStop') {
        const stopped = stoppedTaskOf(result)
        if (stopped !== undefined) {
          const shell = backgroundTasks.delete(stopped)
          const agent = agents.delete(stopped)
          if (shell || agent) paint()
        }
        return
      }
      const task = backgroundTaskOf(result)
      if (task !== undefined) {
        backgroundTasks.add(task)
        paint()
      }
    },

    agentStarted: agentId => {
      if (agentId === undefined || agentId === '') return
      agents.add(agentId)
      paint()
    },

    agentStopped: agentId => {
      if (agentId === undefined || agentId === '') return
      if (agents.delete(agentId)) paint()
    },

    appended: e => {
      // Tool results and attachments can be huge; only the doors that carry a
      // task notification or a rename command are read as text.
      if (e.door !== 'command' && e.door !== 'note' && e.door !== 'prompt' && e.door !== 'queue') {
        return
      }
      const text = textOf(e.message)
      if (text.includes('<task-notification>')) {
        const task = taskIdOf(text)
        if (task !== undefined) {
          const shell = backgroundTasks.delete(task)
          const agent = agents.delete(task)
          if (shell || agent) paint()
        }
      }
      if (e.door === 'command' && text.includes('<command-name>/rename</command-name>')) {
        scheduleTitleRefresh()
      } else if (e.door === 'note' && text.includes('The user named this session')) {
        scheduleTitleRefresh()
      }
    },

    end: () => {
      reset()
      if (!writeFailed) writeTitle('', true)
    },
  }
}

type ControllerHolder = {
  rules: {
    marker: string
    frames: readonly string[]
    interval: number
    strip?: RegExp
    stripError?: string
  }
  controller?: Controller
}

function control($: EngineInterface, holder: ControllerHolder): Controller {
  holder.controller ??= createController($, holder.rules)
  return holder.controller
}

export const register: Register = (on, options) => {
  const marker = markerRule(options.marker)
  const frames = spinnerRule(options.spinner)
  const interval = intervalRule(options.spinnerInterval)
  const strip = stripRule(options.strip)
  const holder: ControllerHolder = {
    rules: {
      marker,
      frames,
      interval,
      strip: strip.regex,
      stripError: strip.error,
    },
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await control($, holder).sessionStart(e)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    await control($, holder).classicSessionStart(e)
    return next(e)
  })

  on('classic.UserPromptSubmit', ($, e, next) => {
    control($, holder).classicPromptSubmit(e)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    control($, holder).turnStart(e)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    control($, holder).turnComplete(e)
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await control($, holder).permissionAsked(e.tool_name)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const c = control($, holder)
    await c.callStarted(e.tool, e.tool_use_id)
    try {
      const result = await next(e)
      c.callFinished(e.tool, e.tool_use_id, result)
      return result
    } catch (error) {
      c.callFinished(e.tool, e.tool_use_id, undefined)
      throw error
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    control($, holder).agentStarted(result.agentId)
    return result
  })

  on('classic.SubagentStop', ($, e, next) => {
    control($, holder).agentStopped(e.agent_id)
    return next(e)
  })

  on('session.append', ($, e, next) => {
    control($, holder).appended(e)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    control($, holder).end()
    return next(e)
  })
}
