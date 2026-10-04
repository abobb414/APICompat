/**
 * APICompat 自测台 —— 对着 tests/mock.py 起的假中转站跑通整条链路。
 *
 *   python3 tests/mock.py &            # 先起 mock（默认 8788）
 *   node tests/smoke.mjs               # 再跑断言
 *   # 或一把梭：bash tests/run.sh
 *
 * 需要 Playwright（`npm i -D playwright && npx playwright install chromium`）。
 *
 * BASE 指到本机（默认 127.0.0.1:8788）跑全量；
 * BASE 指到别的地址（例如 https://apicompat.abobb.site）进「线上模式」，
 * 只跑不依赖上游的那几段：首屏 + 主题按系统分流 + file:// 直开。
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BASE = process.env.BASE || 'http://127.0.0.1:8788';

/* BASE 指到本机之外（例如 BASE=https://apicompat.abobb.site）时进「线上模式」：
   线上没有 tests/mock.py，跑整轮只会往真站点甩 160 条注定 404 的真请求，
   既验不出东西也给人家添日志。所以线上只跑「页面自己」的断言 ——
   首屏、主题按系统分流、file:// 直开，这些都不需要上游。 */
const LIVE = !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(BASE);

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
/* 只记「这个页面自己的」报错，判据收在报错来自哪个源上。
   线上站点前面有 Cloudflare，边缘会往 HTML 里注入一段 static.cloudflareinsights.com
   的分析脚本；本地连不上它时浏览器会报一条「Failed to load resource」——
   那不是这个页面的错，不该让「无控制台报错」这条挂掉。 */
page.on('console', m => {
  if (m.type() !== 'error') return;
  const src = (m.location() && m.location().url) || '';
  if (src && !src.startsWith(BASE)) return;
  consoleErrors.push(m.text());
});
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

// ---- 1. 首屏 ----
await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(400);

const hero = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#protoGrid .proto')];
  return {
    cards: cards.length,
    on: cards.filter(e => e.classList.contains('on')).map(e => e.dataset.id),
    title: document.title,
    foot: document.querySelector('footer')?.innerText || '',
    // 新版的每张协议卡都要把「名字 / 标签 / 路径 / 一句场景说明」四件套摆全 ——
    // 这是它相对旧版 3 列密排的主要改动，缺了就等于退回到只给路径
    fields: cards.filter(c => c.querySelector('.p-name') && c.querySelector('.p-tag')
      && (c.querySelector('.p-path')?.textContent || '').trim()
      && (c.querySelector('.p-desc')?.textContent || '').trim().length > 8).length,
    hasThemeBtn: !!document.getElementById('themeBtn'),
    hasSamplingUi: !!document.getElementById('samples') || !!document.getElementById('probeMode'),
  };
});
check('页面载入无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
check('渲染 10 张协议卡', hero.cards === 10, `实际 ${hero.cards}`);
check('默认只勾选 3 个主协议', hero.on.length === 3 && hero.on.includes('openai') && hero.on.includes('anthropic'),
  hero.on.join(','));
check('每张协议卡都带名字 / 标签 / 路径 / 场景说明', hero.fields === 10, `齐整 ${hero.fields} / 10`);
check('页脚是纯前端说明', /纯前端实现/.test(hero.foot) && /只留在本机浏览器/.test(hero.foot), hero.foot);
// 主题开关与采样/测速控件都被刻意从界面上去掉了，这里把「不出现」钉成断言，
// 免得日后有人顺手又把它们加回页面上
check('页面上没有主题切换按钮', !hero.hasThemeBtn);
check('页面上没有采样次数与探测模式控件', !hero.hasSamplingUi);

if (LIVE) {
  await runThemeChecks(browser);
  await runFileOpenCheck(browser);
  await finish();
}

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
// 新版报告的标题是「各协议通过率」与「结论」（旧版叫「结论分析」）
check('诊断报告生成（含协议通过率与结论）',
  R.report.includes('各协议通过率') && R.report.includes('结论'), R.report.slice(0, 80));

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

// ---- 8. 深浅主题：跟随系统，页面上没有开关 ----
// 新版把主题开关整个去掉了，配色交给 prefers-color-scheme 的纯 CSS 媒体查询。
// 好处是根本不存在「先亮一屏再变暗」：没有 JS 参与，也就没有首屏闪烁，
// 连旧版 <head> 里那段同步脚本都不需要了。
// 这里用两套 colorScheme 各开一个页面，验证「跟随系统」确实跟着系统走。
// 写成一个函数是为了线上模式也能复用 —— 这段不依赖上游。
async function runThemeChecks(browser) {
  const schemeCases = [
    { scheme: 'light', bg: 'rgb(245, 245, 247)', dark: false },
    { scheme: 'dark',  bg: 'rgb(16, 16, 19)',    dark: true  },
  ];
  for (const c of schemeCases) {
    const p = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: c.scheme });
    await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForTimeout(300);
    const r = await p.evaluate(() => {
      const body = getComputedStyle(document.body);
      /* 深色下还亮着的「面」＝漏改的硬编码色。逐个量真正参与渲染的元素，
         而不是只看 body —— 白块通常出现在卡片、表头、输入框这些内层。 */
      const sel = '.panel,.proto,.stat,.key-toggle,.link-btn,.btn-ghost,.modal .box,' +
                  'table.matrix thead th,.matrix-scroll';
      const whites = [];
      document.querySelectorAll(sel).forEach(el => {
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
        if (m && +m[1] > 235 && +m[2] > 235 && +m[3] > 235) whites.push(el.className + ' → ' + bg);
      });
      const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
      return {
        bg: body.backgroundColor, fg: body.color, whites,
        metas: metas.length,
        media: metas.map(m => (m.getAttribute('media') || '').replace(/\s+/g, '')),
        // 首屏不该有任何 JS 在改主题 —— data-theme / data-theme-mode 这类属性一个都不该有
        attrs: [...document.documentElement.attributes].map(a => a.name)
          .filter(n => n.indexOf('data-') === 0),
      };
    });
    const tag = c.dark ? '深色' : '浅色';
    check(`系统${tag}时页面底色跟着走`, r.bg === c.bg, r.bg);
    check(`系统${tag}时正文对比正确`,
      c.dark ? +((r.fg.match(/\d+/) || [0])[0]) > 180 : +((r.fg.match(/\d+/) || [255])[0]) < 120, r.fg);
    check(`系统${tag}时没有 JS 落定的主题属性`, r.attrs.length === 0, r.attrs.join(','));
    // 白底扫描只在深色下有判据：浅色本来就是白底，扫不出东西
    if (c.dark) {
      check('深色下没有残留白底元素', r.whites.length === 0, r.whites.slice(0, 3).join(' | '));
    }
    check(`${tag}下有两条按系统分流 theme-color 的 meta`,
      r.metas === 2
        && r.media.some(x => x.includes('prefers-color-scheme:light'))
        && r.media.some(x => x.includes('prefers-color-scheme:dark')),
      JSON.stringify(r.media));
    await p.close();
  }
}
await runThemeChecks(browser);

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

/* 采样与测速在页面上没有控件（刻意不放），自测直接改内部口径对象。
   probeSettings 只在 run() 开头读一次，所以必须在点「开始测试」之前改。 */
const setProbe = (o) => page.evaluate(
  (v) => Object.assign(window.__MAT__.probeSettings, v), o);

/* 地址栏参数是这两项能力唯一的入口，所以解析本身也要有断言 ——
   不然 README 里写的 ?samples= / ?meter= 就成了没人验过的说法。 */
{
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await p.goto(BASE + '?samples=4&meter=1', { waitUntil: 'domcontentloaded' });
  const on = await p.evaluate(() => window.__MAT__.probeSettings);
  check('?samples=4&meter=1 被解析进内部口径',
    on.samples === 4 && on.metering === true, JSON.stringify(on));

  await p.goto(BASE + '?samples=99&meter=nope', { waitUntil: 'domcontentloaded' });
  const clamp = await p.evaluate(() => window.__MAT__.probeSettings);
  check('参数越界取上限、认不出的值当关',
    clamp.samples === 5 && clamp.metering === false, JSON.stringify(clamp));

  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  const off = await p.evaluate(() => window.__MAT__.probeSettings);
  check('不带参数时是零额外消耗的默认口径',
    off.samples === 1 && off.metering === false, JSON.stringify(off));
  await p.close();
}

await setProbe({ samples: 3, metering: false });
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

await setProbe({ samples: 1, metering: true });
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

await setProbe({ samples: 1, metering: false });

// ---- 10. file:// 直开 ----
// 读的是本仓库里那份 index.html，同样不依赖上游，线上模式也复用。
async function runFileOpenCheck(browser) {
  const p = await browser.newPage();
  const ferr = [];
  p.on('pageerror', e => ferr.push(e.message));
  await p.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
  await p.waitForTimeout(400);
  const n = await p.evaluate(() => document.querySelectorAll('#protoGrid .proto').length);
  check('file:// 双击直开可用（协议卡与脚本都在）', n === 10 && ferr.length === 0, `卡片 ${n}，错误 ${ferr.length}`);
  await p.close();
}
await runFileOpenCheck(browser);

async function finish() {
  await browser.close();
  console.log('\n' + '='.repeat(52));
  console.log(`  ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log('  失败项: ' + failures.join(', ')); }
  console.log('='.repeat(52));
  process.exit(failures.length ? 1 : 0);
}
await finish();
