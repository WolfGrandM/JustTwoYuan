/**
 * dsh-koi 后台作业互斥锁（第二波 W2A-20，BC-012「任一时刻至多一个后台作业」的市场版落点）——
 * koi/job-lock.json 落盘锁：backfill / ingest / backtest 三类后台作业跨进程互斥
 * （CLI 直跑与宿主进程经同一把锁文件串行）。
 *
 * 记录形状：{ kind, key, at, heartbeatAt }（kind ∈ backfill|ingest|backtest）。
 * 心跳：持锁方每批/每步更新 heartbeatAt；停更超过 staleMs（默认 30 分钟）视为残留锁，
 * 可被抢占（抢占留痕：preempted 信息写入新锁记录并由调用方日志输出，绝不静默）。
 * io.js 原子写（防半写）；释放即删文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'

export const JOB_KINDS = ['backfill', 'ingest', 'backtest']

export function createJobLock({ file, now = () => new Date(), staleMs = 30 * 60_000, log = () => {} } = {}) {
  let held = null   // 本实例当前持有的 { kind, key }

  const read = () => readJson(file, null)
  const isStale = (rec) => {
    const hb = Date.parse(rec?.heartbeatAt ?? rec?.at ?? '')
    if (Number.isNaN(hb)) return true
    return now().getTime() - hb > staleMs
  }

  return {
    fileOf: () => file,
    /** 当前占用者快照（无锁 = null） */
    current() { return read() },
    /** 我们是否持锁 */
    holding() { return held ? { ...held } : null },
    /**
     * 获取锁。返回 { ok:true, preempted? } 或 { ok:false, held:{kind,key} }。
     * 被占（含本进程自持）→ ok:false；残留锁（心跳停更 > staleMs）→ 抢占并留痕。
     */
    acquire(kind, key) {
      if (!JOB_KINDS.includes(kind)) throw new Error(`作业锁 kind 非法：${kind}`)
      if (held) return { ok: false, held: { ...held }, error: '本进程已持锁' }
      const rec = read()
      let preempted = null
      if (rec && rec.kind) {
        if (!isStale(rec)) {
          return { ok: false, held: { kind: rec.kind, key: rec.key ?? null } }
        }
        preempted = { kind: rec.kind, key: rec.key ?? null, heartbeatAt: rec.heartbeatAt ?? rec.at ?? null }
        log(`[koi] 检出残留作业锁（${rec.kind}/${rec.key ?? '-'} 心跳停更超 ${Math.round(staleMs / 60_000)} 分钟），抢占并留痕`)
      }
      held = { kind, key }
      const nu = { kind, key, at: now().toISOString(), heartbeatAt: now().toISOString(), ...(preempted ? { preemptedOver: preempted } : {}) }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writeJsonAtomic(file, nu)
      return { ok: true, ...(preempted ? { preempted } : {}) }
    },
    /** 心跳（仅持锁方有效） */
    heartbeat() {
      if (!held) return false
      const rec = read()
      // 防御：文件已被外部抢占/清除 → 停止心跳并视为失锁（保守，不覆盖他锁）
      if (!rec || rec.kind !== held.kind || rec.key !== held.key) { held = null; return false }
      writeJsonAtomic(file, { ...rec, heartbeatAt: now().toISOString() })
      return true
    },
    /** 释放（幂等；只删自己持有的锁） */
    release() {
      if (!held) return false
      const rec = read()
      if (rec && rec.kind === held.kind && rec.key === held.key) {
        try { fs.rmSync(file, { force: true }) } catch { /* 尽力释放 */ }
      }
      held = null
      return true
    },
  }
}
