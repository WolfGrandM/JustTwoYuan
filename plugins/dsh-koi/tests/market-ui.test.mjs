/**
 * 市场版 T8 —— UI 验证（MC-16 测试策略，本机无 react/react-dom）：
 * ① lib/ui-logic.js 纯函数 node --test 直测（门控缺失清单/校验联动/降级触发条件/未读游标/详略选择）；
 * ② client.js factory(require) 注入微桩：假 react/react-dom 记录调用序列——mountPet 的
 *    ensureCss→require→appendContainer→createRoot→render 次序、unmount 的 unmount+容器移除、
 *    降级第一级触发路径（react-dom 不可解析 → 容器移除不抛错）；
 * ③ 内联副本与 lib/ui-logic.js 行为等价断言（MD-21）。
 * React 渲染壳标注「未跑待主人上机」（MC-16 ③/AC-109 渲染面沿 MC-13 移交）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  WIZARD_STEPS, wizardCanAdvance, wizardComplete, sectionValidation, SECTIONS,
  degradeDecision, unreadCount, winUnreadCount, verbosityChoice, bubbleTitle,
} from '../lib/ui-logic.js'
import { buildConfigDefaults } from '../lib/config.js'

// ── ① 纯函数 ─────────────────────────────────────────────────────────────────

test('向导门控状态机：五步清单 + 逐步缺失阻止前进 + 完成判定（S-116 的 UI 面）', () => {
  assert.deepEqual(WIZARD_STEPS.map((s) => s.key), ['channels', 'tier', 'time', 'honesty', 'data'])
  assert.equal(wizardCanAdvance(0, {}), true)
  assert.equal(wizardCanAdvance(0, { channels: true }), false, '渠道缺失阻止第 1 步前进')
  assert.equal(wizardCanAdvance(3, { honesty: false }), true)
  assert.equal(wizardCanAdvance(99, {}), false, '越界步不放行')
  assert.equal(wizardComplete({}), true)
  assert.equal(wizardComplete({ channels: true }), false)
  assert.equal(wizardComplete({ data: true }), false)
})

test('六区校验联动：validateConfig 分区归组（预算错进 budget 区、roles 错进 roles 区、全对无分区）', () => {
  const bad = buildConfigDefaults()
  bad.budget.weeklyCap = 0
  bad.roles.strategists = 9
  bad.verbosity = 'loud'
  const r = sectionValidation(bad)
  assert.equal(r.ok, false)
  assert.ok((r.sections.budget ?? []).some((e) => e.includes('weeklyCap')))
  assert.ok((r.sections.roles ?? []).some((e) => e.includes('strategists')))
  assert.ok((r.sections.verbosity ?? []).some((e) => e.includes('verbosity')))
  const good = sectionValidation(buildConfigDefaults())
  assert.equal(good.ok, true)
  assert.deepEqual(good.sections, {})
  assert.deepEqual(SECTIONS.map((s) => s.key), ['channels', 'roles', 'budget', 'effort', 'verbosity', 'tiers'])
})

test('降级判定（MB-28 第一级）：react-dom 缺席 → panel-only（容器移除/链路不受影响）；桌宠关闭 → pet-off', () => {
  const d1 = degradeDecision({ reactDomAvailable: false, petEnabled: true })
  assert.equal(d1.level, 'panel-only')
  assert.equal(d1.removePetContainer, true)
  assert.equal(d1.panelChannelUnaffected, true, '桌宠 UI 缺席 ≠ 通知丢失')
  assert.ok(d1.note.includes('事件列表'))
  const d2 = degradeDecision({ reactDomAvailable: true, petEnabled: true })
  assert.equal(d2.level, 'normal')
  const d3 = degradeDecision({ reactDomAvailable: true, petEnabled: false })
  assert.equal(d3.level, 'pet-off')
  assert.equal(d3.panelChannelUnaffected, true, 'S-123：事件照常分发其他渠道')
})

test('红点未读游标：空/无游标/游标在窗口/游标不在窗口（回全部未读）', () => {
  const ev = (id) => ({ id })
  const list = [ev('a'), ev('b'), ev('c'), ev('d')]
  assert.equal(unreadCount([], null), 0)
  assert.equal(unreadCount(list, null), 4)
  assert.equal(unreadCount(list, 'b'), 2, 'b 之后 2 条未读')
  assert.equal(unreadCount(list, 'd'), 0)
  assert.equal(unreadCount(list, 'zzz'), 4, '游标不在窗口 → 全部计未读')
})

test('中奖未读游标（主人 2026-10-25 拍板：只有中奖才通知——红点/冒泡/面板未读只统计 won===true 战果）', () => {
  const ev = (id, won) => ({ id, won: won === true })
  const list = [ev('a'), ev('b', true), ev('c'), ev('d', true)]
  assert.equal(winUnreadCount([], null), 0)
  assert.equal(winUnreadCount(list, null), 2, '无游标 → 全部中奖战果计未读')
  assert.equal(winUnreadCount(list, 'b'), 1, 'b 之后仅 d 中奖')
  assert.equal(winUnreadCount(list, 'd'), 0)
  assert.equal(winUnreadCount(list, 'zzz'), 2, '游标不在窗口 → 全部中奖战果计未读')
  assert.equal(winUnreadCount([ev('a'), ev('c')], null), 0, '无中奖 → 恒 0（非中奖事件不打扰）')
})

test('详略选择（DC-107 全局单档）与冒泡标题', () => {
  assert.deepEqual(verbosityChoice('concise'), { value: 'chatty', label: '叨逼叨', next: 'concise', desc: '号码 + ≤100 字结构化摘要 + 合规字段' })
  assert.deepEqual(verbosityChoice('chatty'), { value: 'concise', label: '简洁', next: 'chatty', desc: '只号码 + 合规字段 + 诚实基调句' })
  assert.equal(bubbleTitle({ kind: 'predict', game: 'ssq', issue: '2026122' }), '🐟 出号 · ssq 第 2026122 期')
  assert.equal(bubbleTitle({ kind: 'heartbeat' }), '🐟 心跳')
  assert.equal(bubbleTitle(null), '')
})

// ── ② client.js factory(require) 微桩（MD-05）────────────────────────────────

function loadClientStub() {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
  new Function(src)()
  const calls = []
  let container = null
  const mkEl = (id) => ({
    id, style: {}, parentNode: null,
    remove() { calls.push(['remove', this.id]); this.parentNode = null },
    appendChild() {},
  })
  globalThis.document = {
    head: { appendChild: (el) => { calls.push(['style', el.id]) } },
    body: { appendChild: (el) => { el.parentNode = globalThis.document.body; calls.push(['append', el.id]); container = el } },
    getElementById: (id) => (id === 'koi-pet-root' && container && container.parentNode ? container : null),
    createElement: (tag) => mkEl(tag === 'style' ? 'style' : 'koi-pet-root'),
  }
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (f) => f, useEffect: () => {}, useRef: () => ({ current: null }), useState: (v) => [v, () => {}],
  }
  const fakeReactDOM = {
    createRoot: (el) => { calls.push(['createRoot', el.id]); return { render: (e) => calls.push(['render', e?.type?.name ?? String(e?.type)]), unmount: () => calls.push(['unmount']) } },
  }
  const fakeRequire = (name) => {
    calls.push(['require', name])
    if (name === 'react') return fakeReact
    if (name === 'react-dom') return fakeReactDOM
    throw new Error('模块不可用: ' + name)
  }
  const client = captured.factory(fakeRequire)
  return { client, calls, fakeRequire, getContainer: () => container, resetCalls: () => { calls.length = 0 } }
}

test('微桩②：mountPet 调用序列 = style → require(react-dom) → append 容器 → createRoot → render（dsh-m mountPanel 次序）', () => {
  const { client, calls, fakeRequire, resetCalls } = loadClientStub()
  resetCalls()   // 去掉 factory 顶部的 require('react') 噪声
  const r = client.mountPet(fakeRequire)
  assert.deepEqual(r, { ok: true, degraded: false })
  const seq = calls.map((c) => c[0])
  assert.deepEqual(seq, ['style', 'require', 'append', 'createRoot', 'render'], '次序断言（MC-16 ②）')
})

test('微桩②：unmountPet = root.unmount + 容器移除；pet.enabled=false 走 unmount 路径', () => {
  const { client, calls, resetCalls } = loadClientStub()
  const req = (name) => {
    if (name === 'react-dom') return { createRoot: (el) => ({ render: () => {}, unmount: () => calls.push(['unmount']) }) }
    throw new Error('no')
  }
  client.mountPet(req)
  resetCalls()
  client.unmountPet()
  assert.deepEqual(calls.map((c) => c[0]), ['unmount', 'remove'], '卸载 = unmount + 容器移除（D-003）')
})

test('微桩②：降级第一级——react-dom 不可解析 → 返回 degraded、不抛错、容器不在 DOM（MB-28）', () => {
  const { client } = loadClientStub()
  const r = client.mountPet(() => { throw new Error('Cannot find module react-dom') })
  assert.equal(r.ok, false)
  assert.equal(r.degraded, true)
  assert.match(r.error, /react-dom/)
  // 再次降级（createRoot 缺失形态）
  const r2 = client.mountPet(() => ({ /* 缺 createRoot */ }))
  assert.equal(r2.degraded, true)
})

test('微桩③：内联 __uiLogic 与 lib/ui-logic.js 行为等价（MD-21 抽样对照）', () => {
  const { client } = loadClientStub()
  const inline = client.__uiLogic
  assert.ok(inline, 'client 导出内联副本')
  assert.deepEqual(inline.WIZARD_STEPS, WIZARD_STEPS)
  const events = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  for (const cursor of [null, 'a', 'b', 'zzz']) assert.equal(inline.unreadCount(events, cursor), unreadCount(events, cursor), `unreadCount(${cursor})`)
  assert.deepEqual(inline.degradeDecision({ reactDomAvailable: false, petEnabled: true }), degradeDecision({ reactDomAvailable: false, petEnabled: true }))
  assert.deepEqual(inline.verbosityChoice('concise'), verbosityChoice('concise'))
  assert.equal(inline.wizardComplete({ channels: true }), wizardComplete({ channels: true }))
  assert.equal(inline.bubbleTitle({ kind: 'result', game: 'p3', issue: '26283' }), bubbleTitle({ kind: 'result', game: 'p3', issue: '26283' }))
})

test('client.js 零 QQ 文案（hygiene 前置 grep）+ slots 注入声明不变', () => {
  const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const banned of ['NapCat', '私聊', '1017099872', 'napcatHttp', 'push.target']) {
    assert.ok(!src.includes(banned), `client.js 不得含 ${banned}`)
  }
  const { client } = loadClientStub()
  assert.deepEqual(client.inject, ['slots'])
  assert.equal(typeof client.KoiSection, 'function')
  assert.equal(typeof client.KoiPet, 'function')
})
