/**
 * Human-facing `/recap` command over the session-recap seam.
 * @module @deepseek-ai/dsh-command-recap
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { registerDrainedCommand } from '@deepseek-ai/dsh-commands'
import { SessionRecapError } from '@deepseek-ai/dsh-session-recap'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'command-recap'
export const inject = ['commands', 'sessionRecap']

const USAGE = 'Usage: /recap (no arguments)'

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown session recap error code: ${String(value)}`)
}
/* v8 ignore stop */

/** Convert expected recap failures into concise human-only outcomes. */
function expectedFailure(error: SessionRecapError): CommandResult {
  switch (error.code) {
    case 'unavailable':
      return { kind: 'error', text: 'Recap is unavailable because no recap generator is configured.' }
    case 'empty':
      return { kind: 'error', text: 'Nothing new to recap yet.' }
    case 'generation':
      return { kind: 'error', text: 'The recap could not be generated.' }
    /* v8 ignore next 2 -- SessionRecapErrorCode is closed and every member is handled above */
    default: return assertNever(error.code)
  }
}

/** Execute one argument-free recap request against the invoking agent's session. */
async function executeRecap(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  try {
    const recap = await ctx.sessionRecap.generate(invocation.agent.session, invocation.signal)
    return { kind: 'success', text: recap.text, sourceEventSeq: recap.eventSeq }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Recap cancelled.' }
    if (error instanceof SessionRecapError) return expectedFailure(error)
    throw error
  }
}

/**
 * Register `/recap` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the session-recap seam.
 */
export function apply(ctx: Context): void {
  registerDrainedCommand(ctx, {
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-recap'),
    name: 'recap',
    description: 'Generate a recap of recent work',
    handler: invocation => executeRecap(ctx, invocation),
  })
}
