// A recap is a durable, complete account of a covered stretch of work: every
// accepted event renders one independent row. The collapsed row previews the
// sentence; expanding shows it in full beside the turns and source it covered.

import { memo, useState } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconSparkleRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { RecapChatData } from '../contract/chat-nodes.ts'
import css from './MessageItem.module.css'

interface RecapItemProps {
  node: RecapChatData
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * Renders one accepted session recap.
 * @param props - the recap node data and the owning view's translator.
 * @returns the recap row, with its full text and coverage when expanded.
 */
export const RecapItem = memo(function RecapItem({ node, t }: RecapItemProps) {
  const [expanded, setExpanded] = useState(false)
  const range = node.turnRange
  const turns = range.first === range.last
    ? t('message.recap.turn.single', { turn: range.first })
    : t('message.recap.turn.range', { first: range.first, last: range.last })
  const source = node.source.model === undefined
    ? t('message.recap.source.provider', { provider: node.source.provider })
    : t('message.recap.source.model', {
      provider: node.source.provider,
      model: node.source.model.model,
    })
  return (
    <div className={css.compactionRow}>
      <button
        type="button"
        className={css.compactionButton}
        aria-expanded={expanded}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.compactionLeading} aria-hidden>
          <span className={css.compactionContextIcon} data-recap-icon="recap"><IconSparkleRegular /></span>
          <span
            className={css.compactionDisclosureIcon}
            data-recap-disclosure={expanded ? 'expanded' : 'collapsed'}
          >
            {expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
          </span>
        </span>
        <span className={css.compactionTitle}>{t('message.recap')}</span>
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionSummary}>{node.text}</span>
      </button>
      {expanded && (
        <div className={css.compactionBody}>
          <div className={css.recapText}>{node.text}</div>
          <div className={css.recapMeta}>{t('message.recap.meta', { turns, source })}</div>
        </div>
      )}
    </div>
  )
})

/** Session recap keyed Chat renderer. */
export const RecapNodeView = memo(function RecapNodeView({ node, t }: ChatNodeViewProps<'recap'>) {
  return <RecapItem node={node.data} t={t} />
})
