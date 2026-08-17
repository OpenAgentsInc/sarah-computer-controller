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

export interface ChannelHandlers {
  readonly onProbe: (requestId: string) => Promise<unknown>
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

    const finish = (reason: string): void => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.close()
      }
      resolve(reason)
    }

    socket.on("open", () => {
      socket.send(JSON.stringify([joinRef, joinRef, topic, "phx_join", {}]))
      heartbeat = setInterval(
        () => push("phoenix", "heartbeat", {}, false),
        options.heartbeatMillis ?? 30_000
      )
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

      if (event === "probe") {
        const requestId = record(payload)["request_id"]
        if (typeof requestId !== "string") {
          return
        }
        handlers.onEvent(`probe requested (${requestId.slice(0, 8)})`)
        handlers.onProbe(requestId).then(
          (report) => push(topic, "probe_result", { request_id: requestId, probe: report }, true),
          () => push(topic, "probe_refused", { request_id: requestId }, true)
        )
      }
    })

    socket.on("error", (cause: Error) => finish(`error:${cause.message}`))
    socket.on("close", () => finish("closed"))
  })
