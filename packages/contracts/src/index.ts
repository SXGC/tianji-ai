/**
 * @tianji/contracts - Public domain contracts for tianji-ai
 *
 * This package defines all public type contracts used across the tianji-ai system.
 * It has ZERO dependencies (no internal packages, no external packages).
 *
 * Contracts defined here:
 * - Identifiers (SessionId, ThreadId, RunId)
 * - Message types (AppMessage, MessagePart)
 * - Runtime events (RuntimeEvent)
 * - Tool types (ToolSpec, ToolInvocation, ToolResult)
 * - Error types (TianjiError, ProviderError, etc.)
 * - Execution policy types
 * - Delta types and aggregation
 * - Artifact types
 * - Snapshot types
 *
 * @packageDocumentation
 */

// Identifiers - Branded types for session, thread, and run IDs
export {
  createRunId,
  createSessionId,
  createThreadId,
  isRunId,
  isSessionId,
  isThreadId,
  type RunId,
  type SessionId,
  type ThreadId,
} from './identifiers.js'

// Error types - Custom error classes with serialization support
export {
  type ErrorCategory,
  type ErrorPlainObject,
  TianjiError,
  ProviderError,
  ToolError,
  PolicyError,
  TimeoutError,
  CancelledError,
} from './errors.js'

// Execution Policy types - Control retry, tool execution, and path restrictions
export {
  type RetryPolicy,
  type ToolPolicy,
  type PathPolicy,
  type ExecutionPolicy,
  DEFAULT_EXECUTION_POLICY,
} from './policy.js'

// Tool types - Tool specification, invocation, and result contracts
export type {
  JSONSchema,
  ToolSpec,
  ToolInvocation,
  ToolResult,
} from './tool.js'

// Message types - App-level message structure with multi-part content
export type {
  MessageRole,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  MessagePart,
  AppMessage,
} from './message.js'

// Runtime Events - Streaming events for run, message, and tool lifecycles
export type {
  RuntimeEventType,
  RunStartedEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunCancelledEvent,
  MessageStartedEvent,
  MessageDeltaEvent,
  MessageDeltaChannel,
  MessageDeltaPayload,
  MessageCompletedEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  RuntimeEvent,
} from './events.js'

// Delta types - Incremental updates for streaming message and tool content
export type {
  DeltaOp,
  MessageDelta,
  ToolProgressChannel,
  ToolProgressDelta,
  Delta,
} from './delta.js'

export {
  applyMessageDelta,
  isComplete,
  type AggregatedMessageDeltaState,
} from './delta-aggregator.js'

// Artifact types - Domain objects produced during AI interactions
export type {
  ArtifactType,
  Artifact,
} from './artifact.js'

// Snapshot types - Session and run state persistence for cancellation/resume semantics
export type {
  RunStatus,
  PendingOperationStatus,
  ResumeHint,
  PendingOperation,
  SessionSnapshot,
  RunSnapshot,
} from './snapshot.js'
