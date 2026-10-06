import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-session-recap/types'
import type { RecapChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** One durable account of a completed stretch of work. */
    recap: RecapChatData
  }
}

/**
 * One independent recap row per accepted event: each carries its complete text
 * and coverage, so its Context starts at the event's own seq.
 */
export const recapDefinition: ConversationNodeDefinition<RecapChatData> = {
  kind: 'recap',
  target: 'chat',
  match: event => (event.type === 'session/recap'
    ? { id: String(event.seq), role: 'start' }
    : null),
  start: (_context, match) => {
    if (match.event.type !== 'session/recap') throw new Error('recap start requires a session/recap event')
    const { text, source, turnRange } = match.event.data
    return { seq: match.event.seq, time: match.event.time, text, source, turnRange }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    return state === undefined ? null : chatNode(context, 'recap', state.seq, state)
  },
}

/**
 * Register the session-recap business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerRecapConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(recapDefinition)
}
