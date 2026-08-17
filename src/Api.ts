/**
 * Pairing against the Sarah API. Device-style: this machine registers a
 * pending pairing, prints a short code the account owner approves in the
 * browser, then claims the machine token exactly once with a poll secret.
 */

import { Data, Effect } from "effect"

import type { Tier } from "./Policy.js"

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly reason: string
}> {}

export interface PairingStart {
  readonly pairingId: string
  readonly code: string
  readonly pollSecret: string
  readonly verifyUrl: string
  readonly intervalSeconds: number
}

export interface PairingClaim {
  readonly token: string
  readonly machineId: string
  readonly name: string
}

export interface PairingRequest {
  readonly endpoint: string
  readonly name: string
  readonly tier: Tier
  readonly platform: string
  readonly agentVersion: string
  readonly roots: ReadonlyArray<string>
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {}

const text = (value: unknown, fallback: string): string => typeof value === "string" ? value : fallback

const request = (
  url: string,
  init: RequestInit
): Effect.Effect<Record<string, unknown>, ApiError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, init)
      const body: unknown = await response.json().catch(() => ({}))
      if (response.status === 404) {
        return { ...record(body), __status: "not_found" }
      }
      if (response.status === 410) {
        return { ...record(body), status: "expired" }
      }
      if (!response.ok) {
        throw new Error(text(record(body)["error"], `http_${response.status}`))
      }
      return record(body)
    },
    catch: (cause) => new ApiError({ reason: cause instanceof Error ? cause.message : "network_error" })
  })

export const startPairing = (
  pairing: PairingRequest
): Effect.Effect<PairingStart, ApiError> =>
  Effect.gen(function*() {
    const body = yield* request(`${pairing.endpoint}/controller/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: pairing.name,
        tier: pairing.tier,
        platform: pairing.platform,
        agent_version: pairing.agentVersion,
        roots: pairing.roots
      })
    })
    if (body["__status"] === "not_found") {
      return yield* Effect.fail(new ApiError({ reason: "computer_controller_disabled" }))
    }
    const pairingId = body["pairing_id"]
    const code = body["code"]
    const pollSecret = body["poll_secret"]
    if (typeof pairingId !== "string" || typeof code !== "string" || typeof pollSecret !== "string") {
      return yield* Effect.fail(new ApiError({ reason: "invalid_pairing_response" }))
    }
    const interval = body["interval_seconds"]
    return {
      pairingId,
      code,
      pollSecret,
      verifyUrl: text(body["verify_url"], `${pairing.endpoint}/machines`),
      intervalSeconds: typeof interval === "number" ? interval : 3
    }
  })

export type PollOutcome =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Expired" }
  | { readonly _tag: "Approved"; readonly claim: PairingClaim }

export const pollPairing = (
  endpoint: string,
  pairingId: string,
  pollSecret: string
): Effect.Effect<PollOutcome, ApiError> =>
  Effect.gen(function*() {
    const body = yield* request(`${endpoint}/controller/pairings/${pairingId}`, {
      method: "GET",
      headers: { "x-pairing-secret": pollSecret }
    })
    if (body["status"] === "pending") {
      return { _tag: "Pending" } as const
    }
    if (body["status"] === "expired") {
      return { _tag: "Expired" } as const
    }
    const token = body["token"]
    const machineId = body["machine_id"]
    if (typeof token !== "string" || typeof machineId !== "string") {
      return yield* Effect.fail(new ApiError({ reason: "pairing_not_found" }))
    }
    return {
      _tag: "Approved",
      claim: { token, machineId, name: text(body["name"], "this machine") }
    } as const
  })
