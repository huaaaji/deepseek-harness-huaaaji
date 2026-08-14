/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-git-status`.
 * @module @deepseek-ai/dsh-client-ui-git-status/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-git-status'

/** Cordis companion plugin name. */
export const name = 'client-ui-git-status-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the one mutable relation this package owns — the
 * widget's snapshot load state — lives in the browser process, out of reach of
 * the host invariant service, and the node half emits no cordis events and
 * holds no cross-plugin state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
