/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-file-viewer/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-file-viewer'

/** Cordis companion plugin name. */
export const name = 'host-file-viewer-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the gateway is a stateless projection over `ctx.fs`.
 * Every result is derived per call from the injected filesystem, it emits no
 * cordis events, and it holds no cross-plugin state to relate.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
