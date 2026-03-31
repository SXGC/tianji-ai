import type {
  ObserverLogEntry,
  ObserverLogLevel,
  ObserverLogScope,
  ObserverLogSink,
  ObserverLogger,
} from '../../index.js'

const level: ObserverLogLevel = 'info'
const scope: ObserverLogScope = ['cli', 'run']

declare const sink: ObserverLogSink
declare const logger: ObserverLogger

void logger.log(level, scope, 'message', { ok: true })
void logger.trace(scope, 'message', { ok: true })
void logger.debug(scope, 'message', { ok: true })
void logger.info(scope, 'message', { ok: true })
void logger.warn(scope, 'message', { ok: true })
void logger.error(scope, 'message', { ok: true })
void logger.fatal(scope, 'message', { ok: true })
void logger.child({ scope: ['child'], bindings: { agentName: 'default' } })

const entry: ObserverLogEntry = {
  timestamp: '2026-03-30T00:00:00.000Z',
  level,
  scope,
  message: 'message',
  data: { ok: true },
}

void sink.write(entry)
void entry
