import { installStyles } from './styles.cjs'
import type { Ctx } from './types.cjs'
import { YutangSettings } from './settings.cjs'

exports.inject = ['slots', 'connection'] as const
exports.apply = function apply(ctx: Ctx) {
  ctx.effect(installStyles, 'dsh-yutang: client settings styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-yutang', order: 45,
    label: () => '鱼塘', inject: () => ({ rpc: ctx.connection.rpc }),
  }, YutangSettings))
}
