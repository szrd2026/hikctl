/**
 * 生成一张「演示摄像头画面」JPEG，给 mock-device 当抓图返回。
 *
 * 用无头浏览器的 canvas 画（本机没有图像库，也不联网装依赖）。
 * 画面里只有合成图形和 "DEMO" 字样，不含任何真实设备信息。
 *
 * 用法： node tools/make-fixture.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { launch, CDP } from './shoot.mjs';

const OUT = path.join(import.meta.dirname, '..', 'test', 'fixtures', 'demo-snapshot.jpg');

const DRAW = `(() => {
  const w = 1280, h = 720;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');

  // 天空到地面的渐变
  const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#1b2a3a'); sky.addColorStop(1, '#3d5a72');
  g.fillStyle = sky; g.fillRect(0, 0, w, h * 0.62);

  const ground = g.createLinearGradient(0, h * 0.62, 0, h);
  ground.addColorStop(0, '#2a2f34'); ground.addColorStop(1, '#14171a');
  g.fillStyle = ground; g.fillRect(0, h * 0.62, w, h * 0.38);

  // 远处的楼体剪影
  g.fillStyle = 'rgba(20,26,32,.85)';
  for (let i = 0; i < 7; i++) {
    const bw = 90 + (i * 37) % 110;
    const bh = 120 + (i * 91) % 220;
    g.fillRect(70 + i * 165, h * 0.62 - bh, bw, bh);
  }

  // 地面透视线
  g.strokeStyle = 'rgba(120,160,200,.28)'; g.lineWidth = 2;
  for (let i = -4; i <= 4; i++) {
    g.beginPath(); g.moveTo(w / 2 + i * 120, h * 0.62); g.lineTo(w / 2 + i * 520, h); g.stroke();
  }
  for (let i = 1; i <= 4; i++) {
    const y = h * 0.62 + Math.pow(i / 4, 1.8) * h * 0.38;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }

  // 角落信息（合成数据）
  g.font = '600 26px ui-monospace, Consolas, monospace';
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.fillText('DEMO / SYNTHETIC FEED', 40, 60);
  g.font = '22px ui-monospace, Consolas, monospace';
  g.fillStyle = 'rgba(255,255,255,.72)';
  g.fillText('CAM-01   CH-101   1280x720', 40, 96);

  // 水印（明确标注是合成画面）
  g.textAlign = 'center';
  g.font = '700 92px system-ui, sans-serif';
  g.fillStyle = 'rgba(255,255,255,.10)';
  g.fillText('DEMO', w / 2, h / 2 + 30);

  // 时间戳故意不烧进画面：抽屉右下角已经有一行实时时间，画面上再叠一个会互相压字。
  // 录像指示点
  g.beginPath(); g.arc(w - 60, 52, 9, 0, Math.PI * 2);
  g.fillStyle = '#e5484d'; g.fill();

  return c.toDataURL('image/jpeg', 0.82);
})()`;

const browser = await launch();
try {
  const cdp = await CDP.connect(browser.wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const r = await cdp.send('Runtime.evaluate', { expression: DRAW, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'canvas 绘制失败');
  const dataUrl = r.result.value;
  if (!dataUrl || !dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('未拿到 JPEG dataURL');
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);
  console.log(`✅ ${OUT}`);
  console.log(`   ${(buf.length / 1024).toFixed(1)} KB，魔数 ${buf.subarray(0, 3).toString('hex')}`);
  cdp.close();
} finally {
  browser.close();
}