import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(resolve('apps/desktop/package.json'));
const { chromium } = require('playwright-core');
const evidence = resolve('docs/research/VC-757');
const tmp = resolve(evidence, '.browser-tmp');
await mkdir(tmp, { recursive: true });
process.env.TMPDIR = tmp;
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-mock-keychain', '--password-store=basic'],
});
const consoleMessages = [];
const pageErrors = [];
const result = { route: 'http://localhost:5337/lab/#running-bash', viewport: '1440x1000', checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
  page.setDefaultTimeout(30000);
  await page.goto(result.route, { waitUntil: 'networkidle', timeout: 120000 });
  const section = label => page.locator('section').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
  const running = section('Running · click Move to background');
  await running.waitFor();
  const move = running.getByRole('button', { name: 'Move to background', exact: true });
  assert.equal(await move.isEnabled(), true);
  const cap = section('At capacity · 4 running background shells').getByRole('button', { name: 'Move to background', exact: true });
  assert.equal(await cap.isDisabled(), true);
  const reason = 'This Session already has 4 running background shells. Stop one first.';
  assert.equal(await cap.getAttribute('aria-description'), reason);
  assert.equal(await cap.locator('..').getAttribute('title'), reason);
  result.checks.push('Running control enabled; capacity control disabled with matching aria-description and native title: ' + reason);
  for (const label of ['Unsupported foreground path', 'Nested Code Mode shell · no top-level control']) {
    assert.equal(await section(label).getByRole('button', { name: 'Move to background', exact: true }).count(), 0);
    result.checks.push(label + ': Move to background absent');
  }
  await writeFile(resolve(evidence, 'before.aria.txt'), await page.locator('body').ariaSnapshot());
  await page.screenshot({ path: resolve(evidence, 'before.png'), fullPage: true });
  await move.click();
  const moved = section('Moved · turn continues');
  await moved.waitFor();
  assert.equal(await moved.getByRole('button', { name: 'Move to background', exact: true }).count(), 0);
  assert.equal(await cap.isDisabled(), true);
  await writeFile(resolve(evidence, 'after.aria.txt'), await page.locator('body').ariaSnapshot());
  await page.screenshot({ path: resolve(evidence, 'after.png'), fullPage: true });
  result.checks.push('Clicked real running-row Move to background button; heading becomes Moved · turn continues; its move control disappears; capacity remains disabled');
  // Open the settled production ToolRow to verify its receipt, not just the fixture heading.
  result.movedSectionBeforeExpand = await moved.innerText();
  console.log('Moved section accessibility:', await moved.ariaSnapshot());
  await moved.getByRole('button', { name: 'Show details', exact: true }).click();
  await moved.getByText('Moved to background: moved-shell', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidence, 'after-receipt.png'), fullPage: true });
  result.checks.push('Expanded settled ToolRow; visible receipt: Moved to background: moved-shell');
  result.consoleErrors = consoleMessages.filter(message => message.type === 'error');
  result.pageErrors = pageErrors;
  assert.deepEqual(pageErrors, []);
  result.status = result.consoleErrors.length ? 'UI CHECKS PASS; CONSOLE ERRORS RECORDED' : 'PASS';
} catch (error) {
  result.status = 'FAIL';
  result.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(evidence, 'browser-console.json'), JSON.stringify({ consoleMessages, pageErrors }, null, 2) + '\n');
  await writeFile(resolve(evidence, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  await rm(tmp, { recursive: true, force: true });
}
