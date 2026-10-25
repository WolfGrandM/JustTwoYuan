/**
 * dsh-koi 共享轮询微工具（v0.2 T-06 / docs/22 P4-c）—— waitJsonFile / sleep / randSuffix 单点。
 *
 * 设计纪律（v0.2B2-D2）：四处调用点的微差**全部显式传参**，不设隐藏默认：
 *   · scheduler ：timeout 240000 / 重写轮 60000，poll 3000，**stopCheck = () => stopped（停机取消语义，独此一份）**
 *   · ingest    ：timeout 调用点 waitMs / 重写轮 min(waitMs,60000)，poll 3000，无取消
 *   · advisory  ：timeout 90000，poll 3000，无取消
 *   · factorize ：timeout 600000，poll 3000，无取消
 * 取消语义靠参数显式化保住——合并实现时丢掉 stopCheck，scheduler 停机就会卡满超时。
 */
import fs from 'node:fs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const randSuffix = () => Math.random().toString(36).slice(2, 8)

/**
 * 轮询等待一个 JSON 文件落盘并解析。
 * @param {string} p 文件路径
 * @param {{timeoutMs:number, pollMs?:number, now?:()=>number, stopCheck?:()=>boolean}} opts
 * @returns {Promise<any|null>} 解析成功返回对象；超时或被取消返回 null
 */
export async function waitJsonFile(p, { timeoutMs, pollMs = 3_000, now = Date.now, stopCheck = () => false } = {}) {
  const t0 = now()
  while (now() - t0 < timeoutMs) {
    if (stopCheck()) return null
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* 还没写好 */ }
    await sleep(pollMs)
  }
  return null
}
