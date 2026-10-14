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
const result = {
  route: 'http://localhost:5337/lab/#running-bash',
  viewport: '1440x1400',
  scope: 'Browser-only real renderer components with fixture RPC/store. No real process, host receipt, or desktop proof.',
  checks: [],
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 1 });
  page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
  page.setDefaultTimeout(30000);
  const section = label => page.locator('section').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
  const capture = async name => {
    await writeFile(resolve(evidence, `${name}.aria.txt`), await page.locator('body').ariaSnapshot());
    await page.screenshot({ path: resolve(evidence, `${name}.png`), fullPage: true });
  };
  await page.goto(result.route, { waitUntil: 'networkidle', timeout: 120000 });
  const running = section('Running · click Move to background');
  await running.waitFor();
  const move = running.getByRole('button', { name: 'Move to background', exact: true });
  assert.equal(await move.isEnabled(), true);
  const capSection = section('At capacity · 4 running background shells');
  const cap = capSection.getByRole('button', { name: 'Move to background', exact: true });
  const capReason = 'This Session already has 4 running background shells. Stop one first.';
  const unsupportedReason = 'This command can’t move to the background. Nested commands and Sessions without background-shell support aren’t supported.';
  for (const [label, reason] of [
    ['At capacity · 4 running background shells', capReason],
    ['Old frozen Session · no background-shell support', unsupportedReason],
    ['Unsupported foreground path', unsupportedReason],
    ['Nested Code Mode shell · visible unsupported reason', unsupportedReason],
  ]) {
    const row = section(label);
    const control = row.getByRole('button', { name: 'Move to background', exact: true });
    assert.equal(await control.isDisabled(), true);
    assert.equal(await control.getAttribute('aria-description'), reason);
    assert.equal(await control.locator('..').getAttribute('title'), reason);
    assert.equal(await row.getByText(reason, { exact: true }).isVisible(), true);
    result.checks.push(`${label}: disabled action and persistent visible reason, matching aria-description/title`);
  }
  const settled = section('Moved · settled receipt');
  assert.equal(await settled.getByRole('button', { name: 'Show details', exact: true }).getAttribute('aria-expanded'), 'false');
  assert.equal(await settled.getByText('Moved to background', { exact: true }).isVisible(), true);
  result.checks.push('Settled ToolRow has visible Moved to background marker while details remain collapsed');
  const collapsed = section('Collapsed activity · focus composer and press Ctrl+Shift+B');
  const bundle = collapsed.getByRole('button', { name: 'Running 1 command…', exact: true });
  assert.equal(await bundle.getAttribute('aria-expanded'), 'false');
  assert.equal(await collapsed.getByRole('button', { name: 'Show details', exact: true }).count(), 0);
  assert.equal(await collapsed.getByRole('button', { name: 'Move to background', exact: true }).count(), 0);
  await capture('before');
  await collapsed.getByRole('textbox', { name: 'Composer', exact: true }).click();
  await page.keyboard.press('Control+Shift+B');
  const completedBundle = collapsed.getByRole('button', { name: 'Ran 1 command', exact: true });
  await completedBundle.waitFor();
  assert.equal(await completedBundle.getAttribute('aria-expanded'), 'false');
  assert.equal(await collapsed.getByRole('button', { name: 'Show details', exact: true }).count(), 0);
  const moved = section('Moved · turn continues');
  await moved.waitFor();
  assert.equal(await moved.getByRole('button', { name: 'Move to background', exact: true }).count(), 0);
  assert.equal(await moved.getByRole('button', { name: 'Show details', exact: true }).getAttribute('aria-expanded'), 'false');
  assert.equal(await moved.getByText('Moved to background', { exact: true }).isVisible(), true);
  assert.equal(await cap.isDisabled(), true);
  await capture('after');
  result.checks.push('Composer Ctrl+Shift+B changes genuine collapsed ActivityBundle from Running 1 command… to Ran 1 command; bundle never opened; fixture moves and standalone collapsed ToolRow displays marker');
  await completedBundle.click();
  assert.equal(await completedBundle.getAttribute('aria-expanded'), 'true');
  const details = collapsed.getByRole('button', { name: 'Show details', exact: true });
  assert.equal(await details.getAttribute('aria-expanded'), 'false');
  assert.equal(await collapsed.getByText('Moved to background', { exact: true }).isVisible(), true);
  await capture('after-bundle-open');
  result.checks.push('Opening settled ActivityBundle reveals a still-collapsed ToolRow with visible Moved to background marker');
  await details.click();
  await collapsed.getByText('Moved command to background shell moved-shell.', { exact: false }).waitFor();
  await capture('after-receipt');
  result.checks.push('Expanding ToolRow displays fixture receipt: Moved command to background shell moved-shell.');
  // Separate fresh-page button path: do not let the shared fixture move conflate the two actions.
  await page.reload({ waitUntil: 'networkidle' });
  await move.waitFor();
  await move.click();
  await moved.waitFor();
  assert.equal(await moved.getByText('Moved to background', { exact: true }).isVisible(), true);
  assert.equal(await moved.getByRole('button', { name: 'Show details', exact: true }).getAttribute('aria-expanded'), 'false');
  await capture('after-click');
  result.checks.push('Fresh-page direct Move to background click also settles the collapsed ToolRow with its visible marker');
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
