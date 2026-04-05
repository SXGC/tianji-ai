import { describe, expectTypeOf, it } from 'vitest'
import type { Artifact, ArtifactType } from '../artifact.js'

describe('artifact type contracts', () => {
  it('ArtifactType is a string union of the four artifact kinds', () => {
    expectTypeOf<ArtifactType>().toEqualTypeOf<
      'code-snippet' | 'file-change' | 'image' | 'structured-result'
    >()
  })

  it('Artifact requires id, type, name, content, createdAt', () => {
    expectTypeOf<Artifact>().toHaveProperty('id')
    expectTypeOf<Artifact>().toHaveProperty('type')
    expectTypeOf<Artifact>().toHaveProperty('name')
    expectTypeOf<Artifact>().toHaveProperty('content')
    expectTypeOf<Artifact>().toHaveProperty('createdAt')
  })
})
