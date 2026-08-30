/**
 * The extension hub: owns the single live extension socket, routes tool calls
 * to it, and matches answers back to their waiting callers by `requestId` — a
 * port of the Rust daemon's `hub.rs`.
 *
 * Exactly one extension may be attached at a time. A newer connection wins,
 * because the common cause of a second connection is Chrome resurrecting the
 * MV3 service worker after the old socket died silently; refusing the new one
 * would strand the server on a dead peer.
 *
 * @module dsh-chrome/hub
 */

import type { Json, ServerFrame } from './protocol.ts'

/** Why a dispatched tool call did not produce a result. */
export type DispatchFailureKind = 'not-connected' | 'tool' | 'timeout' | 'disconnected'

/** A dispatch failure carrying a message written for the model. */
export class DispatchError extends Error {
  override readonly name = 'DispatchError'
  constructor(
    readonly kind: DispatchFailureKind,
    message: string,
  ) {
    super(message)
  }
}

/** Messages naming the concrete recovery step, verbatim from the Rust daemon. */
const FAILURE_MESSAGES: Record<Exclude<DispatchFailureKind, 'tool'>, string> = {
  'not-connected':
    'No Chrome extension is attached. Ask the user to open Chrome, load the DSH Chrome Bridge extension at chrome://extensions (Developer mode -> Load unpacked), and make sure its popup toggle is enabled.',
  timeout:
    'The Chrome extension did not answer in time. The page may be busy or the tab may have been closed; retry with a narrower selector or a fresh navigate.',
  disconnected:
    'The Chrome extension disconnected while this call was running. Ask the user to check that Chrome is still open, then retry.',
}

function failure(kind: Exclude<DispatchFailureKind, 'tool'>): DispatchError {
  return new DispatchError(kind, FAILURE_MESSAGES[kind])
}

/** Delivery function for one attached socket; returns false when send failed. */
export type Outbound = (frame: ServerFrame) => boolean

/** State describing the currently attached extension, if any. */
export interface ExtensionState {
  connected: boolean
  version: string
}

interface Waiter {
  settle: (answer: Json | DispatchError) => void
}

/** Routes tool calls to the one live extension socket and answers back. */
export class Hub {
  private outbound: Outbound | undefined
  private readonly waiters = new Map<string, Waiter>()
  private state: ExtensionState = { connected: false, version: '' }
  private nextId = 1

  /**
   * @param timeoutMs - how long one dispatched call may wait for its answer.
   */
  constructor(private readonly timeoutMs: number) {}

  /** Snapshot of the attached extension, for `/chrome/status`. */
  extensionState(): ExtensionState {
    return { ...this.state }
  }

  /** Attach a new socket, replacing and failing over any previous one. */
  attach(outbound: Outbound): void {
    const previous = this.outbound
    this.outbound = outbound
    if (previous !== undefined) this.failAll(failure('disconnected'))
    this.state.connected = true
  }

  /** Record the extension's version from its `hello` frame. */
  recordHello(version: string): void {
    this.state = { connected: true, version }
  }

  /**
   * Detach `outbound`'s socket if it is still the live one, failing every call
   * that was waiting on it. A stale socket's detach leaves the live one alone.
   */
  detach(outbound: Outbound): void {
    if (this.outbound !== outbound) return
    this.outbound = undefined
    this.state = { connected: false, version: '' }
    this.failAll(failure('disconnected'))
  }

  /** Deliver an answer to whoever is waiting for `requestId`. */
  resolve(requestId: string, answer: Json | DispatchError): void {
    const waiter = this.waiters.get(requestId)
    if (waiter === undefined) return
    this.waiters.delete(requestId)
    waiter.settle(answer)
  }

  /**
   * Send one tool call to the extension and await its answer.
   * @param name - raw tool name the extension implements.
   * @param args - the call's JSON arguments.
   * @returns the extension's data answer.
   * @throws DispatchError naming the failure and its recovery step.
   */
  async dispatch(name: string, args: Json): Promise<Json> {
    const outbound = this.outbound
    if (outbound === undefined) throw failure('not-connected')

    const requestId = `r${this.nextId++}`
    const answer = new Promise<Json | DispatchError>(settle => {
      this.waiters.set(requestId, { settle })
    })
    const sent = outbound({ type: 'tool_call', requestId, payload: { name, args } })
    if (!sent) {
      this.waiters.delete(requestId)
      throw failure('not-connected')
    }

    const timer = setTimeout(() => {
      this.resolve(requestId, failure('timeout'))
    }, this.timeoutMs)
    try {
      const settled = await answer
      if (settled instanceof DispatchError) throw settled
      return settled
    } finally {
      clearTimeout(timer)
    }
  }

  /** Ask the live socket to send a liveness probe. */
  ping(): void {
    this.outbound?.({ type: 'ping' })
  }

  private failAll(error: DispatchError): void {
    const pending = [...this.waiters.values()]
    this.waiters.clear()
    for (const waiter of pending) waiter.settle(error)
  }
}
