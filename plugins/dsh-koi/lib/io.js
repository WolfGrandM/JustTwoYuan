/**
 * dsh-koi IO 层（v1.1 / C3 / FR-003）—— 读容错 + 原子写统一。
 *
 * writeJsonAtomic 与调度器原内部 writeJson（scheduler.js）同语义抽出共用：
 * temp + rename，任何时刻中断都不会留下半写文件（AC-016 注入中断测试的语义载体）。
 * koi.mjs 原三处裸 writeFileSync 一律换成本函数（BUG-K2 修复）。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 读 JSON；文件缺失/坏 JSON 一律返回 fallback（读取方自然容忍未知字段——JSON.parse 原样保留） */
export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}

/**
 * 原子写 JSON：先写同目录 temp（带 pid 后缀防串），再 rename 覆盖。
 * 产物与原 writeJson / 裸写逐字节一致：JSON.stringify(o, null, 2) + '\n'。
 */
export function writeJsonAtomic(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n')
  fs.renameSync(tmp, p)
}

/**
 * schemaVersion 落盘守卫（C4 / FR-004，docs/10 §6 规则 2）：
 * 写入前校验已存版本 ≤ 已知版本；高版本文件「可读则读，不可读则报错拒绝写」。
 * 返回带 schemaVersion 的浅拷贝（不改动调用方持有的原对象）。
 */
export function ensureSchemaVersion(obj, known = 1) {
  const v = obj?.schemaVersion
  if (v != null && Number(v) > known) {
    throw new Error(`schemaVersion ${v} 高于已知版本 ${known}，拒绝写入（docs/10 §6 规则 2）`)
  }
  return { ...obj, schemaVersion: known }
}
