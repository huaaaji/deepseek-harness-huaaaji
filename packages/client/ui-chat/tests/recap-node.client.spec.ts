import { describe, expect, it } from 'vitest'
import type { ChatConversationViewNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionLiveEventEntry, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  ConversationNodeAssembler,
  type ConversationNodeDefinition,
  type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionRecapEventData, SessionRecapProviderId } from '@deepseek-ai/dsh-session-recap/types'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { unknownFallbackDefinition } from '../src/client/conversation-nodes/fallback.ts'
import { recapDefinition } from '../src/client/conversation-nodes/recap.ts'

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return [recapDefinition]
  }

  fallbackEntry(): ConversationNodeDefinition {
    return unknownFallbackDefinition
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

function recapAt(seq: number, data: SessionRecapEventData): SessionLiveEventEntry {
  const event: SessionEvent = {
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq,
    type: 'session/recap',
    data,
  }
  return { type: 'event', event }
}

function assembler(entries: readonly SessionEventLikeEntry[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, false)
  value.activateTarget('chat')
  return value
}

function snapshot(value: ConversationNodeAssembler): ChatSnapshot {
  const current = value.snapshot('chat') as ChatSnapshot | undefined
  if (current === undefined) throw new Error('chat view was not registered')
  return current
}

function recapNodes(current: ChatSnapshot): ChatConversationViewNode[] {
  return current.order
    .map(key => current.nodes.get(key))
    .filter((node): node is ChatConversationViewNode => node?.kind === 'recap')
}

const provider = (id: string): SessionRecapProviderId => brandString<SessionRecapProviderId>(id)

const PROVIDER_ONLY: SessionRecapEventData = {
  text: 'Finished the parser rewrite.',
  source: { kind: 'provider', provider: provider('session-summarizer') },
  sourceSeqs: [SessionSeq(4)],
  turnRange: { first: 2, last: 2 },
}

const WITH_MODEL: SessionRecapEventData = {
  text: 'Shipped the export flow.',
  source: {
    kind: 'provider',
    provider: provider('session-summarizer'),
    model: { provider: 'deepseek', model: 'deepseek-chat' },
  },
  sourceSeqs: [SessionSeq(7), SessionSeq(8)],
  turnRange: { first: 3, last: 5 },
}

describe('session recap conversation node', () => {
  it('materializes one independent row per accepted recap, keyed by its seq', () => {
    const current = snapshot(assembler([recapAt(5, PROVIDER_ONLY), recapAt(9, WITH_MODEL)]))
    const recaps = recapNodes(current)

    expect(recaps).toHaveLength(2)
    expect(recaps.map(node => node.id)).toEqual(['5', '9'])
    expect(recaps.map(node => node.anchorSeq)).toEqual([5, 9])
    expect(recaps[0]?.data).toMatchObject({
      seq: 5,
      text: 'Finished the parser rewrite.',
      source: { kind: 'provider', provider: 'session-summarizer' },
      turnRange: { first: 2, last: 2 },
    })
    // The second recap keeps its own payload: neither row folds into the other.
    expect(recaps[1]?.data).toMatchObject({
      seq: 9,
      text: 'Shipped the export flow.',
      source: { model: { provider: 'deepseek', model: 'deepseek-chat' } },
      turnRange: { first: 3, last: 5 },
    })
  })

  it('drops a replay of the same recap event into the row that already exists', () => {
    const value = assembler([recapAt(5, PROVIDER_ONLY)])
    value.append(recapAt(5, PROVIDER_ONLY))
    value.flush()

    expect(recapNodes(snapshot(value))).toHaveLength(1)
  })
})
