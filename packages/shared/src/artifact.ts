/**
 * Artifact types for tianji-ai
 *
 * Defines the contract for artifacts produced during AI interactions.
 * Artifacts are domain objects with stable identity that can be rendered,
 * stored, and aggregated from delta streams.
 *
 * @module artifact
 */

export type ArtifactType = 'code-snippet' | 'file-change' | 'image' | 'structured-result'

export interface Artifact {
  readonly id: string
  readonly type: ArtifactType
  readonly name: string
  readonly content: unknown
  readonly mimeType?: string
  readonly createdAt: number
  readonly metadata?: Record<string, unknown>
}
