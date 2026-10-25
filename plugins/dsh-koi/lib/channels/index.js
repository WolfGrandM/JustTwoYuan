/**
 * dsh-koi 渠道适配器层（市场版 FR-1003/BC-102）—— 契约、双目录发现加载、侧车 cfg 组装、掩码。
 *
 * 契约（IF-N02）：适配器 = ESM 文件 default export
 *   { type: string, configSchema: object(声明式字段表：{字段:{type,required,mask}}),
 *     send: async (event, cfg) => ({ok, word}), test: async (cfg) => ({ok, word}) }
 * 发现（D-002）：lib/channels/builtin/*.js（内置，市场版仅 panel.js）∪ $DSH_HOME/koi/channels/*.js
 * （用户目录；作者私有 qq.js 于此挂载，docs/16 §8.6 模板）。缺 type/send 即拒绝加载并报清晰错误（S-112）。
 * cfg 组装（IF-N03/MB-23）：resolveChannelCfg = 合并(channels[i] 非凭证字段, 侧车 <type>.config.json)，
 * 侧车优先且凭证字段一律只存侧车（凭证不进主配置，NFR-106）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BUILTIN_DIR = path.dirname(fileURLToPath(import.meta.url)) + path.sep + 'builtin'

async function importAdapter(file) {
  const mod = await import(pathToFileURL(file).href)
  return mod.default ?? mod
}

/**
 * 双目录发现加载。返回 { adapters: Map<type, {adapter, source}>, problems: [{file, error}] }。
 * 契约校验：缺 type / send / test → 拒绝加载并记入 problems（进程不崩溃，其余渠道照常，S-112）。
 * 用户目录同名 type 覆盖内置（私有定制优先）。
 */
export async function loadAdapters(userDir) {
  const adapters = new Map()
  const problems = []
  const dirs = [[BUILTIN_DIR, 'builtin']]
  if (userDir) dirs.push([userDir, 'user'])
  for (const [dir, source] of dirs) {
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')) } catch { /* 目录不存在 = 没有用户/私有适配器，正常 */ }
    for (const f of files) {
      const file = path.join(dir, f)
      try {
        const adapter = await importAdapter(file)
        if (!adapter || typeof adapter.type !== 'string' || !adapter.type.trim()) throw new Error('缺 type（适配器标识）')
        if (typeof adapter.send !== 'function') throw new Error('缺 send(event, cfg) 方法')
        if (typeof adapter.test !== 'function') throw new Error('缺 test(cfg) 方法')
        adapter.configSchema = adapter.configSchema ?? {}
        adapters.set(adapter.type, { adapter, source })
      } catch (e) {
        problems.push({ file: f, error: String(e?.message ?? e).slice(0, 160) })
      }
    }
  }
  return { adapters, problems }
}

/** 侧车凭证文件路径（$DSH_HOME/koi/channels/<type>.config.json） */
export function sidecarPath(userDir, type) {
  return path.join(userDir, `${type}.config.json`)
}

/**
 * cfg 组装（IF-N03）：主配置 channels[i] 非凭证字段 + 侧车 <type>.config.json，侧车优先。
 * 侧车缺失/坏 JSON → 空对象容忍（MD-07：凭证未配置时 test 报「凭证缺失」，加载不崩）。
 */
export function resolveChannelCfg(entry, userDir) {
  let sidecar = {}
  try { sidecar = JSON.parse(fs.readFileSync(sidecarPath(userDir, entry.type), 'utf8')) } catch { /* 无侧车 */ }
  return { ...entry, ...sidecar }
}

/** 适配器声明的敏感字段名集（configSchema 中 mask !== false 且常见敏感命名的字段） */
export function sensitiveFieldsOf(adapter) {
  const schema = adapter?.configSchema ?? {}
  return Object.entries(schema)
    .filter(([, def]) => def && def.mask !== false)
    .map(([k]) => k)
}

/** 掩码一个值（head3tail2 风格；短值全星号） */
export function maskValue(v) {
  const s = String(v ?? '')
  if (!s) return ''
  if (s.length <= 4) return '****'
  return `${s.slice(0, 3)}****${s.slice(-2)}`
}

/** 渠道 cfg 掩码副本（面板/CLI 永不接收明文凭证，NFR-106） */
export function maskChannelCfg(cfg, adapter) {
  const fields = sensitiveFieldsOf(adapter)
  const out = { ...(cfg ?? {}) }
  for (const f of fields) if (out[f] !== undefined) out[f] = maskValue(out[f])
  return out
}

/** 从 cfg 提取明文敏感值集合（供事件层对日志/错误串做出现性擦除） */
export function secretsOf(cfg, adapter) {
  const fields = sensitiveFieldsOf(adapter)
  const out = []
  for (const f of fields) {
    const v = cfg?.[f]
    if (typeof v === 'string' && v.length > 3) out.push(v)
  }
  return out
}

/** 在任意文本中擦除敏感值出现（maskCredentials 全出口，NFR-106/FR-1005） */
export function maskString(text, secrets) {
  let s = String(text ?? '')
  for (const sec of secrets ?? []) s = s.split(sec).join(maskValue(sec))
  return s
}

/**
 * 渠道面状态（status API / deps）：逐启用渠道 adapter.test（探针），缺适配器置 error 字段不崩溃（S-112/AC-102）。
 * test 失败不抛出（单渠道隔离）。
 */
export async function channelsStatus(channels, { adapters, userDir }) {
  const out = []
  for (const [i, ch] of (Array.isArray(channels) ? channels : []).entries()) {
    if (!ch || typeof ch.type !== 'string') { out.push({ index: i, type: '?', enabled: ch?.enabled !== false, status: 'error', error: '渠道条目缺 type' }); continue }
    const found = adapters.get(ch.type)
    const entry = {
      index: i, type: ch.type,
      enabled: ch.enabled !== false,
      masked: {},
    }
    if (!found) {
      entry.status = 'missing'
      entry.error = `渠道 ${ch.type} 的适配器缺失，请在渠道目录（koi/channels/）补入 ${ch.type}.js 或停用该渠道`
      out.push(entry); continue
    }
    entry.source = found.source
    const cfg = resolveChannelCfg(ch, userDir)
    entry.masked = maskChannelCfg(cfg, found.adapter)
    const required = Object.entries(found.adapter.configSchema ?? {})
      .filter(([, def]) => def?.required) .map(([k]) => k)
      .filter((k) => cfg[k] === undefined || cfg[k] === '' || cfg[k] == null)
    if (required.length) {
      entry.status = 'no-credentials'
      entry.error = `凭证缺失：${required.join('、')}（请在 koi/channels/${ch.type}.config.json 配置）`
      out.push(entry); continue
    }
    if (!entry.enabled) { entry.status = 'disabled'; out.push(entry); continue }
    try {
      const r = await found.adapter.test(cfg)
      entry.status = r?.ok ? 'ok' : 'fail'
      if (!r?.ok) entry.error = String(r?.word ?? 'test 失败').slice(0, 120)
      entry.detail = r?.ok ? String(r?.word ?? '') : undefined
    } catch (e) {
      entry.status = 'fail'
      entry.error = String(e?.message ?? e).slice(0, 120)
    }
    out.push(entry)
  }
  return out
}
