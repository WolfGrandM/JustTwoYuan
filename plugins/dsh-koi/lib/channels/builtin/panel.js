/**
 * 内置桌宠渠道（市场版 FR-1002/§2.2.1-5）—— send = 标记面板可见（事件对桌宠/面板可见即视为送达）；
 * 无网络 IO；test 恒 ok。市场包唯一内置适配器；用户/作者适配器放 $DSH_HOME/koi/channels/（S-115 升级隔离）。
 */
export default {
  type: 'panel',
  configSchema: {},   // 桌宠渠道无凭证字段
  async send(_event, _cfg) {
    return { ok: true, word: '面板可见' }
  },
  async test(_cfg) {
    return { ok: true, word: '桌宠/面板渠道在位' }
  },
}
