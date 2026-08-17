#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"

import { run } from "./Cli.js"

run.pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
