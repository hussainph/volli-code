/** Run from repo root: node docs/research/VC-758/screenshots-capture.mjs before|after
 * Plain Chrome, temporary isolated profile. No Electron or runtime/provider API.
 */
import { createRequire } from 'node:module';
import { writeFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const phase = process.argv[2] ?? 'before';
assert(['before', 'after'].includes(phase), 'Choose before or after');
const port = Number(process.env.VC758_LAB_PORT ?? 5368);
assert(Number.isInteger(port) && port >= 5300 && port <= 5399, 'Use an allowed lab port (5300–5399)');
const baselineCommit = 'c0cfd4577363c86022df3bb6e9cb2720b8c17897';
const temporarySources = [];
if (phase === 'before') {
  for (const name of ['chat-plane.tsx', 'chat-plane-model.ts', 'composer-ui.tsx']) {
    const target = `apps/desktop/src/renderer/lab/scratches/vc-758-before-${name}`;
    let source = execFileSync('git', ['show', `${baselineCommit}:apps/desktop/src/renderer/src/components/chat/${name}`], { encoding: 'utf8' });
    if (name === 'chat-plane.tsx') source = source.replace('from "@renderer/components/chat/chat-plane-model";', 'from "./vc-758-before-chat-plane-model";').replace('from "@renderer/components/chat/composer-ui";', 'from "./vc-758-before-composer-ui";');
    await writeFile(target, source, { flag: 'wx' });
    temporarySources.push(target);
  }
}
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const evidence = [];
const states = ['sending', 'steering', 'queued', 'working', 'error'];
if (phase === 'after') states.push('error-scrolled');
try {
  for (const theme of ['light', 'dark']) {
    for (const state of states) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 780 }, colorScheme: theme });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://localhost:${port}/lab/?clean&state=${state}&phase=${phase}#vc-758-silent-ends`, { timeout: 120000 });
      await page.locator('[data-vc-758-state]').waitFor();
      await page.getByText('Claude Sonnet 4.5', { exact: true }).waitFor();
      if (['steering', 'queued', 'error'].includes(state)) await page.getByText('Check the release notes before we ship.', { exact: true }).waitFor();
      if (state === 'queued') await page.getByText('Also check the migration notes.', { exact: true }).waitFor();
      await page.waitForTimeout(500);
      const root = page.locator('[data-vc-758-state]');
      if (state === 'error-scrolled') {
        await root.getByRole('log').hover({ position: { x: 400, y: 200 } });
        await page.mouse.wheel(0, -1600);
        await root.getByRole('button', { name: /Context assembly failed.*Scroll to latest/ }).waitFor();
        await page.waitForTimeout(300);
      }
      const text = await root.innerText();
      const accessibility = await root.ariaSnapshot();
      const checks = {};
      if (state === 'sending') {
        checks.pending = text.includes('Pending');
        assert.equal(checks.pending, phase === 'after');
      }
      if (state === 'steering') {
        checks.steeringVisible = text.includes('Focus on the compatibility section first.');
        assert.equal(checks.steeringVisible, phase === 'after');
        if (phase === 'after') {
          assert(text.includes('After the current step'));
          const working = await root.getByRole('status').filter({ hasText: 'Working' }).boundingBox();
          const message = await root.getByText('Focus on the compatibility section first.', { exact: true }).boundingBox();
          checks.workingAboveSteering = working !== null && message !== null && working.y < message.y;
          assert(checks.workingAboveSteering);
        }
      }
      if (state === 'queued') {
        checks.queuedLabel = await root.locator('[data-slot="queue-status"]').count() > 0;
        assert.equal(checks.queuedLabel, phase === 'after');
      }
      if (state === 'working') {
        checks.workingStatus = await root.getByRole('status').filter({ hasText: 'Working' }).count() > 0;
        assert.equal(checks.workingStatus, phase === 'after');
      }
      if (phase === 'after') {
        const oldMessage = root.locator('.is-user').filter({ hasText: 'Check the release notes before we ship.' });
        if (state !== 'sending' && await oldMessage.count() > 0) {
          checks.oldHistoryHasNoFooter = await oldMessage.locator('[data-slot="message-delivery"]').count() === 0;
          assert(checks.oldHistoryHasNoFooter);
        }
        if (state === 'sending' || state === 'steering') {
          const label = root.locator('[data-slot="message-delivery"]');
          const geometry = await label.evaluate(node => {
            const labelBox = node.getBoundingClientRect();
            const bubbleBox = node.parentElement.firstElementChild.getBoundingClientRect();
            return { labelRight: labelBox.right, bubbleRight: bubbleBox.right };
          });
          checks.deliveryGeometry = geometry;
          checks.deliveryRightAligned = Math.abs(geometry.labelRight - geometry.bubbleRight) <= 1;
          assert(checks.deliveryRightAligned);
        }
      }
      if (state === 'error' || state === 'error-scrolled') {
        checks.errorInComposer = await root.locator('[data-slot="chat-composer-dock"] [data-slot="session-blocker"]').count() > 0;
        assert.equal(checks.errorInComposer, phase === 'before');
        checks.runtimeRecoveries = await root.getByRole('button', { name: 'Retry', exact: true }).count();
        assert.equal(checks.runtimeRecoveries, 1);
      }
      if (state === 'error-scrolled') {
        const hint = root.getByRole('button', { name: /Context assembly failed.*Scroll to latest/ });
        checks.faultHintVisible = await hint.isVisible();
        const bounds = await hint.boundingBox();
        checks.faultHintInViewport = bounds !== null && bounds.y >= 0 && bounds.y + bounds.height <= 780;
        assert(checks.faultHintVisible && checks.faultHintInViewport);
      }
      assert.deepEqual(errors, []);
      const file = `docs/research/VC-758/screenshots/${phase}-${state}-${theme}.png`;
      await root.screenshot({ path: file, animations: 'disabled' });
      if (state === 'error-scrolled') {
        await root.getByRole('button', { name: /Context assembly failed.*Scroll to latest/ }).click();
        await page.waitForTimeout(300);
        const retry = await root.getByRole('button', { name: 'Retry', exact: true }).boundingBox();
        checks.hintNavigatesToRecovery = retry !== null && retry.y >= 0 && retry.y + retry.height < 780;
        assert(checks.hintNavigatesToRecovery);
        assert.equal(await root.getByRole('button', { name: /Context assembly failed.*Scroll to latest/ }).count(), 0);
      }
      evidence.push({ phase, state, theme, file, text, accessibility, checks, errors, ...(phase === 'before' ? { baselineCommit } : {}) });
      console.log(`${phase}/${state}/${theme}: ${errors.length} page errors; ${text.replaceAll('\n', ' | ')}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  for (const file of temporarySources) await unlink(file);
}
await writeFile(`docs/research/VC-758/screenshots-${phase}-evidence.json`, JSON.stringify(evidence, null, 2) + '\n');
if (evidence.some(item => item.errors.length)) process.exitCode = 1;
