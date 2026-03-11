/**
 * @tianji/contracts - Zero-dependency contract definitions
 *
 * This package contains pure TypeScript interfaces and type definitions
 * that establish the contracts between different parts of the system.
 */

// Tool types
export type { JSONSchema, ToolSpec, ToolInvocation, ToolResult } from './tool.js'
export { ToolError } from './tool.js'

// Error types
export type { ErrorCategory, ErrorPlainObject } from './errors.js'
export {
  TianjiError,
  ProviderError,
  PolicyError,
  TimeoutError,
  CancelledError,
  StateError,
  InternalError,
  isTianjiError,
  isErrorCategory,
  fromPlainObject,
} from './errors.js'
