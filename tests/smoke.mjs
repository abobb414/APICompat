/**
 * APICompat 自测台 —— 对着 tests/mock.py 起的假中转站跑通整条链路。
 *
 *   python3 tests/mock.py &            # 先起 mock（默认 8788）
 *   node tests/smoke.mjs               # 再跑断言
 *   # 或一把梭：bash tests/run.sh
 *
 * 需要 Playwright（`npm i -D playwright && npx playwright install chromium`）。
 * 通过 BASE 环境变量可指到别的地址，例如 BASE=https://apicompat.abobb.site。
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BASE = process.env.BASE || 'http://127.0.0.1:8788';

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

// ---- 1. 首屏 ----
await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(400);

const hero = await page.evaluate(() => ({
  cards: document.querySelectorAll('#protoGrid .proto').length,
  on: [...document.querySelectorAll('#protoGrid .proto.on')].map(e => e.dataset.id),
  title: document.title,
  foot: document.querySelector('footer')?.innerText || '',
  noPaint: [...document.querySelectorAll('.ic')]
    .filter(e => e.offsetParent !== null)
    .filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
      return r.width === 0 || !(cs.maskImage || cs.webkitMaskImage || 'none').includes('url'); }).length,
}));
check('页面载入无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
check('渲染 10 张协议卡', hero.cards === 10, `实际 ${hero.cards}`);
check('默认只勾选 3 个主协议', hero.on.length === 3 && hero.on.includes('openai') && hero.on.includes('anthropic'),
  hero.on.join(','));
check('图标全部挂上矢量蒙版', hero.noPaint === 0, `${hero.noPaint} 个异常`);
check('页脚含小额度 Key 提示与免责声明', hero.foot.includes('小额度 Key') && hero.foot.includes('不承担任何责任'));

// ---- 2. 跑一轮（接 mock）----
page.on('dialog', d => { consoleErrors.push('dialog: ' + d.message()); d.dismiss(); });
await page.fill('#baseUrl', BASE);
await page.fill('#apiKey', 'sk-smoke-test');
// 「全选」会把「自定义协议」一起勾上，而它没填地址时点开始只会弹 alert 然后退出 ——
// 给它一个真实地址，让 10 种协议全部参与实测。
await page.click('#pAll');
await page.fill('#customUrl', BASE + '/v1/chat/completions');
await page.evaluate(() => { const d = document.querySelector('details.adv'); if (d) d.open = true; });
await page.waitForTimeout(150);
await page.fill('#retries', '0');

// 「连接成功，发现 N 个可见模型」这条横幅是瞬态的：清单拉回来后写进 #connResult，
// 等全轮跑完又被实测摘要覆盖掉，跑完再读就看不到了。所以在点开始之前先挂个观察器，
// 把 #connResult 每次改写都留档，断言时在留档里找。
await page.evaluate(() => {
  window.__connLog = [];
  const t = document.querySelector('#connResult');
  if (!t) return;
  const snap = () => {
    const s = t.innerText.replace(/\s+/g, ' ');
    if (s && window.__connLog[window.__connLog.length - 1] !== s) window.__connLog.push(s);
  };
  snap();
  new MutationObserver(snap).observe(t, { childList: true, subtree: true, characterData: true });
});

await page.click('#runBtn');

let ran = true;
try {
  await page.waitForFunction(
    () => { const a = document.querySelector('#resultActions');
            return a && getComputedStyle(a).display !== 'none'; },
    null, { timeout: 180000 });
} catch { ran = false; }
check('全协议探测跑完', ran);

const R = await page.evaluate(() => {
  const stat = {};
  document.querySelectorAll('#stats .stat').forEach(e => { stat[e.querySelector('.k').textContent] = e.querySelector('.v').textContent; });
  return {
    stat,
    // 清单横幅是瞬态的，从留档里找（见上面 MutationObserver 那段）
    connLog: (window.__connLog || []).join(' ⏎ '),
    conn: document.querySelector('#panel-conn').innerText.replace(/\s+/g, ' ').slice(0, 200),
    rows: document.querySelectorAll('#tableWrap tbody tr').length,
    cols: document.querySelectorAll('#tableWrap thead th').length,
    cells: document.querySelectorAll('#tableWrap .mcell').length,
    okCells: document.querySelectorAll('#tableWrap .mcell.ok').length,
    // 不要在这里 slice：「结论分析」在报告里排在 10 行协议通过率之后，
    // 截到 400 字就正好被切掉，读起来像报告没生成，其实是断言自己截短的。
    report: document.querySelector('#panel-report').innerText.replace(/\s+/g, ' '),
    legend: document.querySelector('#legend').innerText.replace(/\s+/g, ' '),
  };
});

check('拿到模型清单（16 个可见模型）', /发现\s*16\s*个可见模型/.test(R.connLog), R.connLog.slice(0, 120) || R.conn.slice(0, 90));
check('矩阵行数 = 模型数', R.rows === 16, `实际 ${R.rows}`);
check('矩阵列数 = 模型 + 声明 + 10 协议', R.cols === 12, `实际 ${R.cols}`);
check('矩阵单元 = 16 × 10', R.cells === 160, `实际 ${R.cells}`);
check('统计条「组合总数」自洽', R.stat['组合总数'] === '160' && R.stat['模型数'] === '16' && R.stat['协议数'] === '10',
  JSON.stringify(R.stat));
check('存在可用组合且与统计一致',
  Number(R.stat['可用组合']) === R.okCells && R.okCells > 0, `${R.stat['可用组合']} / ${R.okCells}`);
check('图例四色齐全', ['可用', '降级', '失败', '不支持'].every(t => R.legend.includes(t)), R.legend);
check('诊断报告生成（含协议通过率与结论分析）',
  R.report.includes('协议通过率') && R.report.includes('结论分析'), R.report.slice(0, 80));

// ---- 3. 明细弹窗 ----
const cell = page.locator('#tableWrap .mcell').first();
await cell.click();
await page.waitForTimeout(350);
const modal = await page.evaluate(() => {
  const m = document.querySelector('#modal');
  return { vis: !!m && m.classList.contains('on'), txt: m ? m.innerText.replace(/\s+/g, ' ') : '' };
});
check('点格子弹出明细（含首块延迟与总耗时）',
  modal.vis && modal.txt.includes('首块延迟') && modal.txt.includes('总耗时'), modal.txt.slice(0, 90));
await page.click('#modalClose');
await page.waitForTimeout(250);

// ---- 4. 筛选 ----
const before = (await page.evaluate(() => document.querySelectorAll('#tableWrap tbody tr').length));
await page.click('#onlyOk');
await page.waitForTimeout(300);
const after = (await page.evaluate(() => document.querySelectorAll('#tableWrap tbody tr').length));
await page.click('#onlyOk');
await page.waitForTimeout(300);
check('「只看可用协议」筛选生效且可撤销',
  after > 0 && after <= before && (await page.evaluate(() => document.querySelectorAll('#tableWrap tbody tr').length)) === before,
  `${before} → ${after}`);

// ---- 5. 四种导出 ----
for (const [id, label] of [['#expHtml', 'HTML'], ['#expMd', 'Markdown'], ['#expJson', 'JSON'], ['#expCsv', 'CSV']]) {
  const n = await page.evaluate(async (sel) => {
    window.__cap = null;
    if (!window.__patched) {
      window.__patched = 1;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function (b) { if (window.__cap === null) window.__cap = b; return orig(b); };
    }
    document.querySelector(sel).click();
    await new Promise(r => setTimeout(r, 250));
    return window.__cap ? (await window.__cap.text()).length : 0;
  }, id);
  check(`导出 ${label} 非空`, n > 200, `${n} 字节`);
}

// ---- 6. 响应式 ----
for (const w of [390, 768, 1024]) {
  const p = await browser.newPage({ viewport: { width: w, height: 900 } });
  await p.goto(BASE, { waitUntil: 'load' });
  const o = await p.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  check(`${w}px 宽无横向溢出`, o.s <= o.c, `scrollW ${o.s} > clientW ${o.c}`);
  await p.close();
}

// ---- 7. file:// 直开 ----
{
  const p = await browser.newPage();
  const ferr = [];
  p.on('pageerror', e => ferr.push(e.message));
  await p.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
  await p.waitForTimeout(400);
  const n = await p.evaluate(() => document.querySelectorAll('#protoGrid .proto').length);
  check('file:// 双击直开可用（协议卡与脚本都在）', n === 10 && ferr.length === 0, `卡片 ${n}，错误 ${ferr.length}`);
  await p.close();
}

await browser.close();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('  失败项: ' + failures.join(', ')); }
console.log('='.repeat(52));
process.exit(failures.length ? 1 : 0);
