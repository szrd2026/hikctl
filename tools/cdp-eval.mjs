/**
 * 在真实浏览器里执行一段 JS 并把结果打印出来（调试用）。
 * 用法: node tools/cdp-eval.mjs <url> "<js表达式>"
 */
import { launch, CDP } from './shoot.mjs';

const [url, expr] = process.argv.slice(2);
if (!url || !expr) {
  console.error('用法: node tools/cdp-eval.mjs <url> "<js>"');
  process.exit(2);
}

const browser = await launch();
try {
  const cdp = await CDP.connect(browser.wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const loaded = new Promise((res) => {
    const t = setTimeout(res, 15000);
    cdp.on('Page.loadEventFired', () => { clearTimeout(t); res(); });
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  await new Promise((r) => setTimeout(r, 2500));

  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (r.exceptionDetails) {
    console.log('EXCEPTION:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    process.exitCode = 1;
  } else {
    console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
  }
  cdp.close();
} finally {
  browser.close();
}