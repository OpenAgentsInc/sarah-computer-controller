/**
 * `sarah.computer.v1` transport: an outbound-only Phoenix channel connection.
 *
 * Nothing listens on this machine — the controller dials out, joins its own
 * machine topic, and answers bounded requests. The server mints every
 * `request_id`; local policy decides whether a request is answered at all.
 */

import WebSocket from "ws"

/** Phoenix's v2 serializer frame: [join_ref, ref, topic, event, payload]. */
type Frame = [string | null, string | null, string, string, unknown]

/** Push-side of one in-flight request: streamed chunks and one terminal event. */
export interface Responder {
  readonly chunk: (text: string) => void
  readonly exit: (payload: Record<string, unknown>) => void
  readonly refused: (reason: string, detail: string) => void
}

export interface ChannelHandlers {
  readonly onProbe: (requestId: string) => Promise<unknown>
  readonly onRun: (requestId: string, payload: Record<string, unknown>, respond: Responder) => void
  /**
   * ACP delegation. Dispatched for the `agent` event (agent_id from the
   * body) and, for one release of legacy compatibility, the `devin` event
   * mapped to agent_id "devin".
   */
  readonly onAgent: (requestId: string, agentId: string, payload: Record<string, unknown>, respond: Responder) => void
  readonly onCancel: (requestId: string) => void
  readonly onClosed: () => void
  readonly onJoined: () => void
  readonly onEvent: (message: string) => void
}

export interface ChannelOptions {
  readonly endpoint: string
  readonly token: string
  readonly machineId: string
  readonly hello: unknown
  readonly heartbeatMillis?: number
}

export const socketUrl = (endpoint: string, token: string): string => {
  const base = endpoint.replace(/^http/, "ws").replace(/\/$/, "")
  return `${base}/controller/socket/websocket?vsn=2.0.0&token=${encodeURIComponent(token)}`
}

const isFrame = (value: unknown): value is Frame =>
  Array.isArray(value) && value.length === 5 && typeof value[2] === "string" && typeof value[3] === "string"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {}

/**
 * Serve requests until the connection closes or the server stops the channel
 * (a revoked machine is dropped immediately). Resolves with the reason so the
 * caller decides whether to reconnect.
 */
export const serve = (options: ChannelOptions, handlers: ChannelHandlers): Promise<string> =>
  new Promise((resolve) => {
    const topic = `computer:${options.machineId}`
    const joinRef = "1"
    let ref = 1
    let heartbeat: NodeJS.Timeout | undefined
    // Half-open detection: a heartbeat is pushed on a fixed ref; the server's
    // phx_reply on that ref clears the pending flag. If the next interval fires
    // while the previous heartbeat is still unacknowledged, the connection is
    // dead (a Cloud Run instance drained without a clean close) and we finish
    // so the process exits and its supervisor relaunches a fresh connection to
    // the live instance.
    const heartbeatRef = "heartbeat"
    let heartbeatPending = false
    const socket = new WebSocket(socketUrl(options.endpoint, options.token))

    const nextRef = (): string => {
      ref = ref + 1
      return String(ref)
    }

    const push = (pushTopic: string, event: string, payload: unknown, useJoinRef: boolean): void => {
      if (socket.readyState !== WebSocket.OPEN) {
        return
      }
      const frame: Frame = [useJoinRef ? joinRef : null, nextRef(), pushTopic, event, payload]
      socket.send(JSON.stringify(frame))
    }

    let finished = false
    const finish = (reason: string): void => {
      if (finished) {
        return
      }
      finished = true
      handlers.onClosed()
      if (heartbeat !== undefined) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.close()
      }
      resolve(reason)
    }

    const responder = (requestId: string): Responder => ({
      chunk: (t) => push(topic, "chunk", { request_id: requestId, text: t }, true),
      exit: (body) => push(topic, "exit", { request_id: requestId, ...body }, true),
      refused: (reason, detail) => push(topic, "refused", { request_id: requestId, reason, detail }, true)
    })

    socket.on("open", () => {
      socket.send(JSON.stringify([joinRef, joinRef, topic, "phx_join", {}]))
      heartbeat = setInterval(() => {
        if (heartbeatPending) {
          // The previous heartbeat was never answered: the connection is dead.
          finish("heartbeat_timeout")
          return
        }
        if (socket.readyState !== WebSocket.OPEN) {
          finish("socket_not_open")
          return
        }
        heartbeatPending = true
        socket.send(JSON.stringify([null, heartbeatRef, "phoenix", "heartbeat", {}]))
      }, options.heartbeatMillis ?? 30_000)
    })

    socket.on("message", (data) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return
      }
      if (!isFrame(parsed)) {
        return
      }
      const [, frameRef, frameTopic, event, payload] = parsed
      // The server's heartbeat acknowledgement arrives on the "phoenix" topic;
      // clear the pending flag before the computer-topic filter drops it.
      if (frameTopic === "phoenix" && event === "phx_reply" && frameRef === heartbeatRef) {
        heartbeatPending = false
        return
      }
      if (frameTopic !== topic) {
        return
      }

      if (event === "phx_reply") {
        if (frameRef !== joinRef) {
          return
        }
        const body = record(payload)
        if (body["status"] === "ok") {
          handlers.onJoined()
          push(topic, "hello", options.hello, true)
        } else {
          finish(`join_refused:${JSON.stringify(body["response"] ?? {})}`)
        }
        return
      }

      if (event === "phx_close" || event === "phx_error") {
        finish(event)
        return
      }

      const body = record(payload)
      const requestId = body["request_id"]
      if (typeof requestId !== "string") {
        return
      }

      if (event === "probe") {
        handlers.onEvent(`probe requested (${requestId.slice(0, 8)})`)
        handlers.onProbe(requestId).then(
          (report) => push(topic, "probe_result", { request_id: requestId, probe: report }, true),
          () => push(topic, "probe_refused", { request_id: requestId }, true)
        )
        return
      }

      if (event === "run") {
        handlers.onEvent(`command requested (${requestId.slice(0, 8)})`)
        handlers.onRun(requestId, body, responder(requestId))
        return
      }

      if (event === "agent") {
        const agentId = typeof body["agent_id"] === "string" ? body["agent_id"] : ""
        handlers.onEvent(`agent delegation requested (${agentId || "?"}, ${requestId.slice(0, 8)})`)
        handlers.onAgent(requestId, agentId, body, responder(requestId))
        return
      }

      // Legacy event name, kept for one release: maps to agent_id "devin".
      if (event === "devin") {
        handlers.onEvent(`devin delegation requested (${requestId.slice(0, 8)})`)
        handlers.onAgent(requestId, "devin", body, responder(requestId))
        return
      }

      if (event === "cancel") {
        handlers.onEvent(`cancel requested (${requestId.slice(0, 8)})`)
        handlers.onCancel(requestId)
      }
    })

    socket.on("error", (cause: Error) => finish(`error:${cause.message}`))
    socket.on("close", () => finish("closed"))
  })
