/**
 * dsh-koi 时间小工具单点（v0.2 T-07 / docs/22 P4-d）—— hhmm/todayStr 统一于此。
 * 接受时刻注入（默认真实时钟）：测试/调度器注入 now 用同一份实现。
 * 格式纪律：sv-SE 逐字保持（hhmm = 'HH:MM' 五字符，todayStr = 'YYYY-MM-DD'）——
 * 出号/对账窗口比较、事件层终止线比较（isPastDeadline 同日判定）均依赖该格式的字典序可比性，
 * 改 locale/选项即改行为（FZ-5 相位机的时刻判断消费本格式）。
 */
export const hhmm = (d = new Date()) => d.toLocaleTimeString('sv-SE', { hour12: false }).slice(0, 5)
export const todayStr = (d = new Date()) => d.toLocaleDateString('sv-SE')
