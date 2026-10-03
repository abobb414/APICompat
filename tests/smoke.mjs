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
  return {
    vis: !!m && m.classList.contains('on'),
    txt: m ? m.innerText.replace(/\s+/g, ' ') : '',
    // 只看「行标签」，不能拿全文 includes('总耗时') 去判 ——
    // 「计时口径」那行的说明文字里本来就写着「故不统计总耗时」。
    dts: m ? [...m.querySelectorAll('dt')].map(e => e.textContent.trim()) : []
  };
});
check('点格子弹出明细（含首块延迟与计时口径）',
  modal.vis && modal.txt.includes('首块延迟') && modal.txt.includes('计时口径'), modal.txt.slice(0, 90));
check('明细弹窗不再把首块延迟谎报成「总耗时」',
  !modal.dts.includes('总耗时'), modal.dts.join(' / '));
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

// ---- 6. 重试代价可见 ----
// mock 里有两个「隔一次就 500」的组合。这一轮把重试次数设为 1，它们会在第一次尝试
// 收到 500、重试才通过。重点不是「重试能成功」，而是工具必须把重试前付出的代价也摆出来，
// 而不是只显示重试成功那一次的漂亮延迟（那正是中转站看板吞掉失败率的做法）。
await fetch(BASE + '/__reset');
await page.evaluate(() => { const d = document.querySelector('details.adv'); if (d) d.open = true; });
await page.fill('#retries', '1');
await page.click('#runBtn');
let ran2 = true;
try {
  await page.waitForFunction(
    () => { const a = document.querySelector('#resultActions');
            return a && getComputedStyle(a).display !== 'none'; }, null, { timeout: 180000 });
} catch { ran2 = false; }
await page.waitForTimeout(600);
check('第二轮（重试=1）跑完', ran2);

const RT = await page.evaluate(() => {
  const marked = [...document.querySelectorAll('#tableWrap .mcell .rt')];
  // 悬停说明挂在外层格子上（↻ 只是格内的一个记号），所以从记号往上找宿主
  const host = marked[0] ? marked[0].closest('.mcell') : null;
  return {
    n: marked.length,
    title: host ? (host.getAttribute('title') || '') : '',
    banner: document.querySelector('#panel-conn').innerText.replace(/\s+/g, ' '),
  };
});
check('重试通过的格子带 ↻ 标记', RT.n >= 2, `带标记 ${RT.n} 个`);
check('↻ 的悬停说明交代了首次尝试的代价',
  /第 1 次为/.test(RT.title) && /ms/.test(RT.title), RT.title.slice(0, 90));
check('完成横幅报出「重试之后才通过」的组合数',
  /重试之后才通过/.test(RT.banner), RT.banner.slice(0, 140));

await page.locator('#tableWrap .mcell:has(.rt)').first().click();
await page.waitForTimeout(350);
const modal2 = await page.evaluate(() => {
  const m = document.querySelector('#modal');
  return { vis: !!m && m.classList.contains('on'), txt: m ? m.innerText.replace(/\s+/g, ' ') : '' };
});
check('明细弹窗里有「尝试次数」与「首次尝试」',
  modal2.vis && modal2.txt.includes('尝试次数') && modal2.txt.includes('首次尝试'), modal2.txt.slice(0, 110));
await page.click('#modalClose');
await page.waitForTimeout(250);

// 报告是拿给别人看的，重试信息必须跟着数据走，否则读报告的人还以为一格 = 一次请求
const J = await page.evaluate(async () => {
  window.__cap = null;
  document.querySelector('#expJson').click();
  await new Promise(r => setTimeout(r, 300));
  const t = window.__cap ? await window.__cap.text() : '';
  return {
    attempts: /"attempts"/.test(t), retried: /"retried":\s*true/.test(t),
    elapsed: /"elapsedMs"/.test(t), scope: /"timingScope"/.test(t), total: /"totalMs"/.test(t),
  };
});
check('JSON 导出含 attempts / retried / timingScope',
  J.attempts && J.retried && J.elapsed && J.scope, JSON.stringify(J));
check('JSON 导出不再出现误导性的 totalMs 字段', !J.total, JSON.stringify(J));

// ---- 7. 响应式 ----
for (const w of [390, 768, 1024]) {
  const p = await browser.newPage({ viewport: { width: w, height: 900 } });
  await p.goto(BASE, { waitUntil: 'load' });
  const o = await p.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  check(`${w}px 宽无横向溢出`, o.s <= o.c, `scrollW ${o.s} > clientW ${o.c}`);
  await p.close();
}

// ---- 8. 深浅主题 ----
const btnTheme = await page.evaluate(() => {
  const b = document.getElementById('themeBtn');
  return {
    has: !!b,
    w: b ? Math.round(b.getBoundingClientRect().width) : 0,
    // 太阳 / 月亮两张 mask 同时躺在按钮里，同一时刻只该露出一张：
    // 非当前态缩到 0.45 并转 -25°，靠 opacity 隐藏（不是 display:none，这样才有过渡）
    shown: b ? [...b.querySelectorAll('.ic')].filter(e => +getComputedStyle(e).opacity > 0.5).length : 0,
    icons: b ? b.querySelectorAll('.ic').length : 0,
  };
});
check('顶栏有主题切换按钮', btnTheme.has && btnTheme.w > 20, `宽 ${btnTheme.w}`);
check('主题按钮里是太阳和月亮两张、同一时刻只露一张',
  btnTheme.icons === 2 && btnTheme.shown === 1, `${btnTheme.icons} 张里露了 ${btnTheme.shown} 张`);

await page.click('#themeBtn');   // 浅 → 深（首次访问没有记录，按系统落在浅色）
/* 先等过渡跑完再量。按钮/卡片上挂着 transition:background .15s，图标本身还有
   .18s 与 .26s 的交叉旋转淡入 —— 点完立刻量会采到中间帧（曾在这里误报出 .theme-btn 的
   rgb(253,254,254)、.key-toggle 的 rgb(247,249,252)、.link-btn 的纯白，
   三个都是过渡第一帧，等 400ms 后终态一律收敛到 #151c26 / #0d1117）。 */
await page.waitForTimeout(400);
const dark = await page.evaluate(() => {
  const root = document.documentElement;
  /* 深色下还亮着的「面」＝漏改的硬编码色。逐个量真正参与渲染的那些元素，
     而不是只看 body —— 白块通常出现在卡片、表头、输入框这些内层。 */
  const sel = '.panel,.stat,.matrix-scroll,.btn-ghost,.proto,.link-btn,input[type=text],' +
              'table.matrix thead th,.modal .box,.theme-btn,.key-toggle';
  const whites = [];
  document.querySelectorAll(sel).forEach(el => {
    const bg = getComputedStyle(el).backgroundColor;
    const m = bg.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    if (m && +m[1] > 235 && +m[2] > 235 && +m[3] > 235) whites.push(el.className + ' → ' + bg);
  });
  const body = getComputedStyle(document.body);
  const moon = document.querySelector('.ic-t-moon');
  let saved = null;
  try { saved = localStorage.getItem('apicompat.theme'); } catch (e) {}
  return {
    theme: root.getAttribute('data-theme'), saved,
    bg: body.backgroundColor, fg: body.color, whites,
    meta: (document.querySelector('meta[name="theme-color"]') || {}).content || '',
    moonOpacity: moon ? +getComputedStyle(moon).opacity : 0,
  };
});
check('切到深色后 html[data-theme=dark]', dark.theme === 'dark', String(dark.theme));
check('深色下页面底色确实是深的', dark.bg === 'rgb(13, 17, 23)', dark.bg);
check('深色下正文是浅色字', (dark.fg.match(/\d+/) || [0])[0] > 180, dark.fg);
check('深色下没有残留白底元素', dark.whites.length === 0, dark.whites.slice(0, 3).join(' | '));
check('地址栏染色跟着主题走', dark.meta === '#0d1117', dark.meta);

await page.click('#themeBtn');   // 深 → 浅
await page.waitForTimeout(400);
const back = await page.evaluate(() => {
  let saved = null;
  try { saved = localStorage.getItem('apicompat.theme'); } catch (e) {}
  return { theme: document.documentElement.getAttribute('data-theme'), saved };
});
check('再点一次切回浅色，且月亮已淡出、选择被记住',
  back.theme === 'light' && back.saved === 'light' && dark.moonOpacity > 0.9,
  `${back.theme}/${back.saved}，深色时月亮 opacity=${dark.moonOpacity}`);

// ---- 9. 采样次数与测速档 ----
// 压到单协议 × 全部模型的 16 格，并把两件事分两轮跑，各自只花几秒
await page.evaluate(() => { const d = document.querySelector('details.adv'); if (d) d.open = true; });
await page.click('#pNone');
await page.evaluate(() => {
  const c = [...document.querySelectorAll('#protoGrid .proto')].find(e => e.getAttribute('data-id') === 'openai');
  if (c && !c.classList.contains('on')) c.click();
});
const waitDone = () => page.waitForFunction(
  () => { const b = document.getElementById('runBtn'); return b && !b.disabled; }, null, { timeout: 180000 });

await page.fill('#samples', '3');
await page.selectOption('#probeMode', 'fast');
await page.waitForTimeout(120);
await page.click('#runBtn');
await waitDone();

const S = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('#tableWrap .mcell:not(.plain)')];
  cells[0].click();
  const m = document.querySelector('#modal');
  return {
    cells: cells.length,
    title: cells[0].getAttribute('title') || '',
    modal: m ? m.innerText.replace(/\s+/g, ' ') : '',
    banner: document.querySelector('#panel-conn').innerText.replace(/\s+/g, ' '),
  };
});
check('采样 3 次后矩阵仍是 16 格', S.cells === 16, `实际 ${S.cells}`);
check('格子悬停交代了采样次数与各次延迟',
  /采样 3 次/.test(S.title) && /各次首块/.test(S.title), S.title.slice(0, 120));
check('明细弹窗给出采样次数与「格内取中位」',
  S.modal.includes('采样次数') && S.modal.includes('格内取中位'), S.modal.slice(0, 140));
check('完成横幅说明这轮每格采样了几次', /每格采样 3 次/.test(S.banner), S.banner.slice(0, 140));
await page.click('#modalClose');
await page.waitForTimeout(200);

await page.fill('#samples', '1');
await page.selectOption('#probeMode', 'meter');
await page.waitForTimeout(120);
await page.click('#runBtn');
await waitDone();

const M = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('#tableWrap .mcell:not(.plain)')];
  const withCps = cells.filter(c => c.querySelector('.cps'));
  const raw = withCps[0] ? withCps[0].querySelector('.cps').textContent : '';
  if (withCps[0]) withCps[0].click();
  const m = document.querySelector('#modal');
  return {
    cells: cells.length, cps: withCps.length,
    spd: +String(raw).replace(/[^\d]/g, ''),
    title: withCps[0] ? (withCps[0].getAttribute('title') || '') : '',
    modal: m ? m.innerText.replace(/\s+/g, ' ') : '',
    stats: document.querySelector('#stats').innerText.replace(/\s+/g, ' '),
  };
});
check('测速档每个可用格子都带出速度', M.cps === M.cells && M.cells > 0, `${M.cps} / ${M.cells}`);
check('输出速度落在 mock 的量级里（≈40 字/秒）', M.spd >= 20 && M.spd <= 90, `${M.spd} 字/秒`);
check('悬停写清了速度是怎么算的',
  /吐字速度/.test(M.title) && /首块之后/.test(M.title), M.title.slice(0, 130));
check('明细弹窗解释了测速口径',
  M.modal.includes('输出速度') && M.modal.includes('测速口径'), M.modal.slice(0, 150));
check('统计条多了「中位输出速度」', M.stats.includes('中位输出速度'), M.stats.slice(0, 150));
await page.click('#modalClose');
await page.waitForTimeout(200);

const EX = await page.evaluate(async () => {
  window.__cap = null;
  document.querySelector('#expJson').click();
  await new Promise(r => setTimeout(r, 350));
  const t = window.__cap ? await window.__cap.text() : '';
  return {
    setup: /"setup"/.test(t), cps: /"cps"/.test(t),
    samples: /"samples"/.test(t), jitter: /"jitterMs"/.test(t),
    scope: /"timingScope"/.test(t),
  };
});
check('JSON 导出带上了测量口径与新指标',
  EX.setup && EX.cps && EX.samples && EX.jitter && EX.scope, JSON.stringify(EX));

// ---- 10. file:// 直开 ----
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
