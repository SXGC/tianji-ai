/**
 * Artifact types for tianji-ai
 *
 * Defines the contract for artifacts produced during AI interactions.
 * Artifacts are domain objects with stable identity that can be rendered,
 * stored, and aggregated from delta streams.
 *
 * @module artifact
 */

// ============================================================================
// Artifact Type
// ============================================================================

/**
 * Type discriminator for different artifact kinds.
 *
 * Each artifact type represents a distinct category of content
 * that the AI can produce during execution.
 */
export type ArtifactType = 'code-snippet' | 'file-change' | 'image' | 'structured-result'

// ============================================================================
// Artifact
// ============================================================================

/**
 * A domain object representing a piece of content produced by the AI.
 *
 * Artifacts are the stable outputs of AI interactions that can be:
 * - Displayed to users (code, images, structured data)
 * - Persisted for later retrieval
 * - Aggregated from delta streams during streaming
 *
 * The `content` field uses `unknown` to allow flexible payload shapes
 * while maintaining type safety through the `type` discriminator.
 *
 * @example
 * ```typescript
 * const codeArtifact: Artifact = {
 *   id: 'artifact_001',
 *   type: 'code-snippet',
 *   name: 'hello-world.py',
 *   content: 'print("Hello, World!")',
 *   mimeType: 'text/x-python',
 *   createdAt: Date.now(),
 *   metadata: { language: 'python', lines: 1 }
 * }
 *
 * const imageArtifact: Artifact = {
 *   id: 'artifact_002',
 *   type: 'image',
 *   name: 'diagram.png',
 *   content: { url: 'https://example.com/diagram.png' },
 *   mimeType: 'image/png',
 *   createdAt: Date.now()
 * }
 *
 * const fileChange: Artifact = {
 *   id: 'artifact_003',
 *   type: 'file-change',
 *   name: 'src/index.ts',
 *   content: {
 *     path: '/src/index.ts',
 *     operation: 'create',
 *     diff: '--- /dev/null\n+++ b/src/index.ts\n...',
 *   },
 *   mimeType: 'text/plain',
 *   createdAt: Date.now()
 * }
 * ```
 */
export interface Artifact {
  /** Unique identifier for this artifact */
  readonly id: string
  /** Type discriminator determining how to interpret content */
  readonly type: ArtifactType
  /** Human-readable name or title for the artifact */
  readonly name: string
  /** The artifact content (shape depends on type) */
  readonly content: unknown
  /** MIME type for rendering purposes (e.g., 'text/plain', 'image/png') */
  readonly mimeType?: string
  /** Unix timestamp (milliseconds) when the artifact was created */
  readonly createdAt: number
  /** Optional metadata for additional context */
  readonly metadata?: Record<string, unknown>
}
