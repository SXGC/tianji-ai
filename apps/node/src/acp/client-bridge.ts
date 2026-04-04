/**
 * ACP Client implementation for node-side session updates.
 *
 * @module acp/client-bridge
 */

import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'

type SessionUpdateCallback = (update: SessionNotification) => void

export class AcpNodeClient implements Client {
  readonly #sessionUpdateCallbacks: SessionUpdateCallback[] = []

  onSessionUpdate(callback: SessionUpdateCallback): () => void {
    this.#sessionUpdateCallbacks.push(callback)

    return () => {
      const index = this.#sessionUpdateCallbacks.indexOf(callback)
      if (index >= 0) {
        this.#sessionUpdateCallbacks.splice(index, 1)
      }
    }
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    for (const callback of this.#sessionUpdateCallbacks) {
      callback(params)
    }
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const allowOption = params.options.find(
      (option) => option.kind === 'allow_once' || option.kind === 'allow_always'
    )

    return {
      outcome: {
        outcome: 'selected',
        optionId: allowOption?.optionId ?? params.options[0]!.optionId, // NOSONAR
      },
    }
  }
}
