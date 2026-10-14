import { expect, type Page, test } from '@playwright/test';
import { darkRatio, openSample } from './helpers';

const SAMPLE = process.env.RVT_SAMPLE;
const SHOTS = process.env.RVT_SCREENSHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** A point over a model element: hover a grid until the status bar names an element. */
async function findElementPoint(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const status = page.locator('.status-message');
  const idle = await status.textContent();
  for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const x = box.x + box.width * fx;
      const y = box.y + box.height * fy;
      await page.mouse.move(x, y);
      await page.waitForTimeout(60);
      if ((await status.textContent()) !== idle) return { x, y };
    }
  }
  throw new Error('no element under the sampled points');
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  return errors;
}

test('home screen renders in Japanese', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'RVT ビューア' })).toBeVisible();
  await expect(page.getByText('ここに .rvt ファイルをドロップ')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await shot(page, '01-home');
  expect(errors).toEqual([]);
});

test('manifest and service worker make the app installable and offline-capable', async ({ page, context }) => {
  await page.goto('./');
  const manifest = await (await page.request.get('manifest.webmanifest')).json();
  expect(manifest.lang).toBe('ja');
  expect(manifest.file_handlers[0].accept['application/octet-stream']).toContain('.rvt');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30_000 });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'RVT ビューア' })).toBeVisible();
  await context.setOffline(false);
});

test.describe('with a sample model', () => {
  test.skip(!SAMPLE, 'RVT_SAMPLE is not set');

  test('Revit-like viewing workflow', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await openSample(page, SAMPLE!);
    await expect(page.locator('.view-tab.active')).toContainText('3D ビュー', { timeout: 90_000 });
    await page.waitForTimeout(800);
    await shot(page, '02-3d');

    const canvas = page.locator('.viewer-canvas');
    const box = (await canvas.boundingBox())!;
    const { x: cx, y: cy } = await findElementPoint(page, box);

    // Click selects; the palette shows element properties and the contextual tab appears.
    await page.mouse.click(cx, cy);
    await expect(page.locator('.ribbon-tab.contextual')).toContainText('修正 |');
    await expect(page.locator('.prop-group-header', { hasText: '識別情報' })).toBeVisible();
    await expect(page.locator('.status-filter')).toContainText(':1');
    await shot(page, '03-selected');

    // Right-click → temporary isolate → cyan frame.
    await page.mouse.click(cx, cy, { button: 'right' });
    await page.getByRole('menuitem', { name: '一時的に非表示/選択要素を分離' }).hover();
    await page.getByRole('menuitem', { name: 'カテゴリを選択要素として分離' }).click();
    await expect(page.locator('.view-frame-label.temp')).toBeVisible();
    await shot(page, '04-isolate');
    await page.locator('.view-control-bar').getByTitle('一時的に非表示/選択要素を分離').click();
    await page.getByRole('menuitem', { name: '一時的な非表示/選択要素を分離をリセット' }).click();
    await expect(page.locator('.view-frame-label.temp')).toHaveCount(0);

    // Window selection (left → right).
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 160, box.y + box.height - 20, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.status-filter')).not.toContainText(':0');
    await page.keyboard.press('Escape');
    await expect(page.locator('.status-filter')).toContainText(':0');

    // Wheel zoom and middle-button pan keep working without errors.
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -400);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(cx + 80, cy + 40, { steps: 4 });
    await page.mouse.up({ button: 'middle' });

    // ViewCube: top face.
    const cube = (await page.locator('.viewcube').boundingBox())!;
    await page.mouse.click(cube.x + cube.width * 0.5, cube.y + cube.height * 0.3);
    await page.waitForTimeout(600);
    await shot(page, '05-top');

    // Section box from the view control bar.
    await page.locator('.view-control-bar').getByTitle('切断ボックス').click();
    await expect(page.getByLabel('切断ボックス', { exact: true })).toBeChecked();

    // Visibility/Graphics: hide the first category.
    await page.getByRole('button', { name: '表示/グラフィックス' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('モデル カテゴリ');
    await dialog.locator('.vg-row:not(.vg-head) input[type="checkbox"]').first().uncheck();
    await shot(page, '06-vg');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog).toHaveCount(0);

    // Project Browser: open a floor plan, an elevation and a schedule.
    const plan = page.locator('.tree-row[data-view-kind="plan"]').first();
    await plan.dblclick();
    await expect(page.locator('.view-tab.active')).toContainText('平面図');
    await page.waitForTimeout(600);
    await shot(page, '07-plan');
    await page.locator('.tree-row', { hasText: /^南$/ }).dblclick();
    await expect(page.locator('.view-tab.active')).toContainText('立面図: 南');
    await page.locator('.tree-row', { hasText: '要素集計表' }).dblclick();
    await expect(page.locator('.schedule-row').first()).toBeVisible();
    await shot(page, '08-schedule');

    // Level visibility in the 3D view: "show only this level" from a plan row, then all levels again.
    await page.locator('.view-tab', { hasText: '3D ビュー' }).click();
    const levelRow = page.locator('.tree-row[data-view-kind="plan"]').first();
    const levelName = ((await levelRow.textContent()) ?? '').trim();
    await levelRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'アクティブ ビューでこのレベルのみ表示' }).click();
    await page.waitForTimeout(400);
    await shot(page, '09-only-level');
    await page.getByRole('button', { name: '表示/グラフィックス' }).first().click();
    await page.getByRole('tab', { name: 'レベル' }).click();
    const levelChecks = page.locator('.vg-level-row:not(.vg-head) input[type="checkbox"]');
    const levelCount = await levelChecks.count();
    expect(levelCount).toBeGreaterThan(0);
    await expect(page.locator('.vg-level-row', { hasText: levelName }).locator('input[type="checkbox"]')).toBeChecked();
    await expect(page.locator('.vg-level-row:not(.vg-head) input[type="checkbox"]:checked')).toHaveCount(1);
    await page.getByRole('button', { name: 'すべて', exact: true }).click();
    await page.getByRole('button', { name: 'OK' }).click();

    // Export IFC from the File menu.
    await page.getByRole('button', { name: 'ファイル', exact: true }).click();
    await page.getByRole('button', { name: '書き出し', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /IFC \(IFC4\)/ }).click();
    expect((await download).suggestedFilename()).toMatch(/\.ifc$/);

    expect(errors).toEqual([]);
  });

  test('boxed bodies are redrawn from the meshes Revit saved for display', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = collectErrors(page);
    await page.goto('./');
    await openSample(page, SAMPLE!);
    await expect(page.locator('.view-tab.active')).toContainText('3D ビュー', { timeout: 90_000 });
    await page.waitForTimeout(500);
    await shot(page, '10-boxes');
    await expect(page.locator('.statusbar')).toHaveAttribute('data-saved-meshes', 'done', { timeout: 180_000 });
    await expect(page.locator('.status-busy')).toHaveCount(0);
    await page.waitForTimeout(500);
    await shot(page, '11-saved-meshes');

    await page.locator('.statusbar .status-button').first().click();
    const row = page.getByRole('row', { name: /保存済みメッシュで表示した要素/ });
    const [replaced, candidates] = ((await row.locator('td').textContent()) ?? '').split('/').map((s) => Number(s.trim()));
    expect(replaced).toBeGreaterThanOrEqual(0);
    expect(replaced).toBeLessThanOrEqual(candidates!);
    await page.getByRole('button', { name: 'OK' }).click();

    // Doors are boxes without the saved meshes: select them all and read where their bodies came from.
    await page.getByRole('searchbox', { name: 'プロジェクト ブラウザを検索' }).fill('ドア');
    const doors = page.locator('.tree-row.kind-category', { hasText: /^ドア$/ });
    if (replaced! > 0 && (await doors.count()) > 0) {
      await doors.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'すべてのインスタンスを選択' }).hover();
      await page.getByRole('menuitem', { name: 'プロジェクト全体' }).click();
      await page.locator('.prop-group-header', { hasText: '読込情報' }).click();
      await expect(page.locator('.prop-row', { hasText: '形状の取得元' })).toContainText('保存済み表示メッシュ');
      await shot(page, '12-doors');
    }
    // RPC planting and entourage: placeholder meshes rvt-rs does not decode, often turned off the axes.
    await page.getByRole('searchbox', { name: 'プロジェクト ブラウザを検索' }).fill('RPC');
    const rpc = page.locator('.tree-row.kind-family', { hasText: 'RPC' });
    if (replaced! > 0 && (await rpc.count()) > 0) {
      await rpc.first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'すべてのインスタンスを選択' }).hover();
      await page.getByRole('menuitem', { name: 'プロジェクト全体' }).click();
      const source = page.locator('.prop-row', { hasText: '形状の取得元' });
      if (!(await source.isVisible())) await page.locator('.prop-group-header', { hasText: '読込情報' }).click();
      await expect(source).toContainText('保存済み表示メッシュ');
      await shot(page, '13-rpc');
    }
    expect(errors).toEqual([]);
  });

  test('floor plans are not crushed to black by the cut fill', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto('./');
    await openSample(page, SAMPLE!);
    await expect(page.locator('.view-tab.active')).toBeVisible({ timeout: 90_000 });
    // Measure the final bodies, saved meshes included.
    await expect(page.locator('.statusbar')).not.toHaveAttribute('data-saved-meshes', 'pending', { timeout: 180_000 });
    const plans = page.locator('.tree-row[data-view-kind="plan"]');
    const n = await plans.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const row = plans.nth(i);
      const name = (await row.textContent()) ?? '';
      await row.dblclick();
      await expect(page.locator('.view-tab.active')).toContainText(name);
      await page.waitForTimeout(400);
      const ratio = darkRatio(await page.locator('.view-content').screenshot());
      expect(ratio, `plan "${name}" dark share`).toBeLessThan(0.3);
    }
  });
});
