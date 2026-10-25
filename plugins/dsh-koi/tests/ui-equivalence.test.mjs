/**
 * v0.2-B1 T-02 —— client.js 内联副本 ↔ lib/ui-logic.js 全成员行为等价门（MD-21 / docs/22 P1）。
 * 三件套（vpe point6 方案二：放弃逐字文本断言——与 T-12 生成块的剥壳重组天然矛盾）：
 *   ① 成员存在性：以 lib/ui-logic.js 导出清单为基准，内联副本（client.js exports.__uiLogic）缺员即失败；
 *      反向亦检查内联副本多员（多员 = 未同步进权威源的私生成员，同为漂移）；
 *   ② 常量类 deepStrictEqual（文案即需求 FR-1015——文案 diff 在此拦死）；
 *   ③ 全部函数同夹具对照（每函数一组确定夹具，两侧调用结果逐夹具 deepStrictEqual）。
 * 豁免清单 BROWSER_UNUSED：SECTIONS / sectionValidation —— 浏览器端零消费（client.js 全文零引用；
 * 六区校验在浏览器走 POST /api/config 服务端 validateConfig），非同源成员漂移（决策 v0.2B1-D5）。
 * T-12 起内联块由 tools/gen-ui-logic.mjs 机械生成（同源守卫见 tests/gen-ui-logic.test.mjs），
 * 本门继续作为**行为**兜底：生成器出错但两侧恰好等价时放行，行为漂移时必失败。
 * 豁免自带守卫：一旦 client.js 源码出现对豁免成员的引用而内联副本仍缺员，本门立即失败。
 * 微桩加载形态沿 tests/market-ui.test.mjs loadClientStub（假 window 捕获 factory，本文件只需 exports）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as ui from '../lib/ui-logic.js'

// 浏览器端不消费、故内联副本合法缺员的权威源导出（守卫见「成员存在性」测试）
const BROWSER_UNUSED = ['SECTIONS', 'sectionValidation']

const CLIENT_SRC = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadInlineUiLogic() {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
  globalThis.document = {
    head: { appendChild() {} }, body: { appendChild() {} },
    getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, remove() {} }),
  }
  new Function(CLIENT_SRC)()
  const fakeReact = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const client = captured.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('等价门加载不应 require: ' + name)
  })
  const inline = client.__uiLogic
  assert.ok(inline, 'client.js 必须导出 __uiLogic 内联副本')
  return inline
}

const inline = loadInlineUiLogic()

const comparedKeys = Object.keys(ui).filter((k) => !BROWSER_UNUSED.includes(k))

test('等价门①：成员存在性——权威源（ui-logic.js）导出的每个非豁免成员，内联副本必须有', () => {
  assert.ok(Object.keys(ui).length >= 20, `权威源导出清单异常（仅 ${Object.keys(ui).length} 个）——若新增导出请同步内联副本或审豁免清单`)
  const missing = comparedKeys.filter((k) => !(k in inline))
  assert.deepEqual(missing, [], `内联副本缺员（双源漂移）：${missing.join(', ')}`)
})

test('等价门①-反向：内联副本不得有权威源之外的多余成员（私生成员=未同步漂移）', () => {
  const extra = Object.keys(inline).filter((k) => !(k in ui))
  assert.deepEqual(extra, [], `内联副本多员（未进权威源）：${extra.join(', ')}`)
})

test('等价门①-豁免守卫：豁免成员必须在 client.js 保持零引用，否则必须补进内联副本并移出豁免清单', () => {
  for (const name of BROWSER_UNUSED) {
    const used = new RegExp(`\\b${name}\\b`).test(CLIENT_SRC)
    assert.equal(used, false, `豁免成员 ${name} 已在 client.js 出现引用——浏览器开始消费它而内联副本缺员，等价门失效：请把 ${name} 加入 exports.__uiLogic 并从 BROWSER_UNUSED 移除`)
  }
})

test('等价门②：常量类逐个 deepStrictEqual（含文案常量——FR-1015 文案即需求）', () => {
  const constants = comparedKeys.filter((k) => typeof ui[k] !== 'function')
  assert.ok(constants.includes('WIZARD_STEPS') && constants.includes('LEARNING_COPY'), '常量清单异常')
  for (const k of constants) {
    assert.deepEqual(inline[k], ui[k], `常量 ${k} 内联副本与权威源不一致`)
  }
})

test('等价门③：全部函数同夹具对照（每夹具两侧各调一次，结果 deepStrictEqual）', () => {
  const FNS = [
    ['wizardCanAdvance', [[0, {}], [0, { channels: true }], [4, { data: true }], [3, { honesty: false }], [99, {}]]],
    ['wizardComplete', [[{}], [{ channels: true }], [{ channels: false, tier: false, time: false, honesty: false, data: false }], [{ data: 'oops' }]]],
    ['degradeDecision', [[{}], [{ reactDomAvailable: false }], [{ reactDomAvailable: true }], [{ reactDomAvailable: true, petEnabled: false }], [{ reactDomAvailable: false, petEnabled: false, panelChannelEnabled: false }]]],
    ['unreadCount', [[[], null], [[{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], null], [[{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], 'b'], [[{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], 'zzz'], [[{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], 'd'], [null, null], ['not-array', 'x']]],
    ['winUnreadCount', [[[], null], [[{ id: 'a' }, { id: 'b', won: true }, { id: 'c' }, { id: 'd', won: true }], null], [[{ id: 'a' }, { id: 'b', won: true }, { id: 'c' }, { id: 'd', won: true }], 'b'], [[{ id: 'a' }, { id: 'c' }], null], [[{ id: 'a' }, { id: 'b', won: true }], 'zzz'], [undefined, 'a']]],
    ['verbosityChoice', [['concise'], ['chatty'], [undefined], ['other']]],
    ['bubbleTitle', [[null], [{ kind: 'predict', game: 'ssq', issue: '2026122' }], [{ kind: 'heartbeat' }], [{ kind: 'mystery' }], [{ kind: 'result', game: 'p3' }]]],
    ['rejectedNote', [[['格式不对', '超过 20MB']], ['单一原因'], [null], [undefined], [[]]]],
    ['ruleDupHint', [['和值守恒律'], ['']]],
    ['verdictTextOf', [['better-in-sample'], ['no-signal'], [undefined]]],
    ['uploadFormatOk', [['技巧.txt'], ['notes.md'], ['photo.pdf'], ['A.TXT'], [null], ['']]],
    ['formatBytes', [[0], [512], [2048], [2621440], ['abc'], [null], [-5]]],
    ['uploadEstimate', [[1200, 0], [1200, 10000], [null, null], [-5, 100], [0, -3]]],
    ['backfillProgressText', [[null, 5], ['已拉至 26101', 30], ['已拉至 26101', null], ['', 10], [undefined, undefined]]],
    ['jobBadgeText', [[{ status: 'done' }], [{ status: 'pending-llm', waitingNote: '模型未就绪' }], [{}], [null], [{ status: 'mystery' }], [{ status: 'queued', waitingNote: '' }]]],
  ]
  // 覆盖完备性：除豁免外，权威源的每个函数导出都必须出现在对照表里（防新增函数漏夹具）
  const fnKeys = comparedKeys.filter((k) => typeof ui[k] === 'function').sort()
  assert.deepEqual(FNS.map(([n]) => n).sort(), fnKeys, '函数对照表与权威源函数导出清单不一致（缺或多了夹具项）')
  for (const [name, cases] of FNS) {
    assert.equal(typeof inline[name], 'function', `内联副本缺函数: ${name}`)
    for (const args of cases) {
      const expected = ui[name](...args)
      const actual = inline[name](...args)
      assert.deepEqual(actual, expected, `${name}(${args.map((a) => JSON.stringify(a) ?? 'undefined').join(', ')}) 内联副本与权威源不一致`)
    }
  }
})
