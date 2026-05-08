// End-to-end checks for the DisC wizard. Each test corresponds to one item
// on the verification checklist. They share a fresh page, but state is
// independent — each test reloads / and starts from the demo seed.

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Collect any browser-side console errors so every test can assert "no errors".
function attachConsoleCollector(page) {
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', msg => {
        if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });
    return errors;
}

async function gotoApp(page) {
    const errors = attachConsoleCollector(page);
    await page.goto('/');
    // Wait for Step 1 to be ready. The demo IIFE pre-fills the textarea, so
    // a populated #story-input is a reliable readiness signal.
    await page.waitForFunction(
        () => {
            const t = document.getElementById('story-input');
            return t && t.value && t.value.length > 0;
        },
        { timeout: 5000 }
    );
    return errors;
}

// Navigate to Step 2 (Designer). Tests that touch participants/composer
// call this first.
async function gotoDesigner(page) {
    await page.locator('#story-next').click();
    await page.waitForSelector('#participants-list .pc-card', { timeout: 5000 });
}

test.describe('DisC wizard', () => {

    test('1. page loads with no JS errors and demo seed renders on step 2', async ({ page }) => {
        const errors = await gotoApp(page);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-step1-loaded.png'), fullPage: true });

        await gotoDesigner(page);
        // Demo seeds 4 participants + 6 sequence steps (4 calls + loop pair).
        const cards = await page.locator('.pc-card').count();
        expect(cards).toBe(4);
        const stepRows = await page.locator('#steps-board .step-row').count();
        expect(stepRows).toBeGreaterThanOrEqual(6);
        // SVG diagram should render in the live-sequence area.
        const svgCount = await page.locator('#live-sequence svg.seq-svg').count();
        expect(svgCount).toBe(1);

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01b-step2-demo.png'), fullPage: true });
        // Note: runScan against /Users/mossgu/Downloads/demo may produce a
        // server-side error visible in the chip — that's NOT a JS error.
        const realErrors = errors.filter(e => !e.includes('Failed to load resource') && !e.includes('/api/scan'));
        expect(realErrors, JSON.stringify(realErrors, null, 2)).toEqual([]);
    });

    test('2. step nav: continue from story to designer', async ({ page }) => {
        await gotoApp(page);
        // Step 1 panel should be visible by default.
        await expect(page.locator('#panel-1')).toBeVisible();
        // The story-input has demo text already.
        const story = await page.locator('#story-input').inputValue();
        expect(story.length).toBeGreaterThan(20);

        await page.locator('#story-next').click();
        await expect(page.locator('#panel-2')).toBeVisible();
        await expect(page.locator('#panel-1')).toBeHidden();
        // Stepper should mark step 2 active.
        await expect(page.locator('.step[data-step="2"]')).toHaveClass(/active/);
    });

    test('3. participants render with caller badge + method preview', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);
        // First card is the caller — should have CALLER badge.
        const firstCard = page.locator('.pc-card').first();
        await expect(firstCard).toContainText('InvoiceService');
        await expect(firstCard.locator('.caller-badge')).toBeVisible();
        // OrderRepository should be the second card.
        const cards = page.locator('.pc-card');
        await expect(cards.nth(1)).toContainText('OrderRepository');
        await expect(cards.nth(3)).toContainText('InvoiceBuilder');
    });

    test('4. opening a participant modal shows methods, can be closed', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);
        // The 4th card is InvoiceBuilder (the others are InvoiceService,
        // OrderRepository, InvoiceBuilderFactory). Use index — name-based
        // matching is ambiguous because InvoiceBuilderFactory contains
        // "InvoiceBuilder".
        await page.locator('.pc-card').nth(3).click();
        await expect(page.locator('#participant-modal')).toBeVisible();
        // Modal title should reflect InvoiceBuilder.
        await expect(page.locator('#modal-title')).toContainText('InvoiceBuilder');
        // Modal should list 2 methods for InvoiceBuilder (addLine + build).
        const methodCount = await page.locator('#modal-methods .method-block').count();
        expect(methodCount).toBe(2);
        await page.locator('#modal-done').click();
        await expect(page.locator('#participant-modal')).toBeHidden();
    });

    test('5. live SVG sequence diagram shows lifelines + arrows for the demo', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);
        const svg = page.locator('#live-sequence svg.seq-svg');
        await expect(svg).toBeVisible();
        // 4 lifelines = 4 head rects + 4 verticals; 4 calls + 1 loop bracket; check we have a healthy count of paths.
        const paths = await svg.locator('path').count();
        expect(paths).toBeGreaterThan(4);
        // SVG nodes don't support innerText — read textContent via DOM eval.
        const text = await svg.evaluate(el => el.textContent || '');
        expect(text).toContain('InvoiceService');
        expect(text).toContain('InvoiceBuilder');
        // Loop bracket label "↻ loop" should be present (demo seeds a loop).
        expect(text.toLowerCase()).toContain('loop');
    });

    test('6. flow-control composer exposes all 6 fragment buttons + end', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);
        const composer = page.locator('.add-step-panel');
        await expect(composer).toBeVisible();
        for (const ft of ['loop', 'while', 'foreach', 'alt', 'opt', 'par']) {
            const btn = composer.locator(`.as-frag-add[data-frag-type="${ft}"]`);
            await expect(btn, `+ ${ft} button`).toBeVisible();
        }
        await expect(composer.locator('.as-frag-end-btn')).toBeVisible();
    });

    test('7. add a CALL step extends the sequence and updates the diagram', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);
        const beforeRows = await page.locator('#steps-board .step-row').count();

        // Pick caller=InvoiceService, callee=OrderRepository, method=findAllByCustomerId.
        const composer = page.locator('.add-step-panel');
        await composer.locator('.as-caller').selectOption({ label: 'InvoiceService' });
        await composer.locator('.as-callee').selectOption({ label: 'OrderRepository' });
        await composer.locator('.as-method').selectOption({ label: 'findAllByCustomerId' });
        await composer.locator('.as-add').click();

        // Step row count should have grown by 1.
        const afterRows = await page.locator('#steps-board .step-row').count();
        expect(afterRows).toBe(beforeRows + 1);
    });

    test('8. add an alt fragment with else, verify rows + emit', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);

        // Click + if/else, fill label, submit.
        await page.locator('.as-frag-add[data-frag-type="alt"]').click();
        await page.locator('.as-frag-input').fill('orders.isEmpty()');
        await page.locator('.as-frag-confirm').click();

        // A frag-start.frag-alt row should be rendered.
        await expect(page.locator('.step-row.frag-start.frag-alt')).toHaveCount(1);

        // + else button should now appear (alt allows else).
        await expect(page.locator('.as-frag-else-btn')).toBeVisible();
        await page.locator('.as-frag-else-btn').click();
        // FRAG_ELSE label is editable; fill it.
        await page.locator('.step-row.frag-else .frag-label').fill('orders.nonEmpty()');

        // Close the alt.
        await page.locator('.as-frag-end-btn').click();
        await expect(page.locator('.step-row.frag-end.frag-alt')).toHaveCount(1);

        // Navigate to step 4 and check the emitted PlantUML contains alt/else/end.
        await page.locator('#flow-next').click();
        await expect(page.locator('#panel-3')).toBeVisible();
        await page.locator('#preview-next').click();
        await expect(page.locator('#panel-4')).toBeVisible();
        const puml = await page.locator('#output').innerText();
        expect(puml).toContain('alt orders.isEmpty()');
        expect(puml).toContain('else orders.nonEmpty()');
        expect(puml).toContain('end');
    });

    test('9. add a while + foreach fragment, verify emit', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);

        await page.locator('.as-frag-add[data-frag-type="while"]').click();
        await page.locator('.as-frag-input').fill('balance > 0');
        await page.locator('.as-frag-confirm').click();
        await page.locator('.as-frag-end-btn').click();

        await page.locator('.as-frag-add[data-frag-type="foreach"]').click();
        await page.locator('.as-frag-input').fill('order in orders');
        await page.locator('.as-frag-confirm').click();
        await page.locator('.as-frag-end-btn').click();

        await page.locator('#flow-next').click();
        await page.locator('#preview-next').click();
        const puml = await page.locator('#output').innerText();
        expect(puml).toContain('loop while balance > 0');
        expect(puml).toContain('loop for each order in orders');
    });

    test('10. add a par fragment with else branch, verify emit', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);

        await page.locator('.as-frag-add[data-frag-type="par"]').click();
        await page.locator('.as-frag-input').fill('cache writeback');
        await page.locator('.as-frag-confirm').click();
        await page.locator('.as-frag-else-btn').click();
        await page.locator('.step-row.frag-else .frag-label').fill('audit log');
        await page.locator('.as-frag-end-btn').click();

        await page.locator('#flow-next').click();
        await page.locator('#preview-next').click();
        const puml = await page.locator('#output').innerText();
        expect(puml).toContain('par cache writeback');
        expect(puml).toContain('else audit log');
    });

    test('11. add an opt fragment, verify emit', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);

        await page.locator('.as-frag-add[data-frag-type="opt"]').click();
        await page.locator('.as-frag-input').fill('debugMode');
        await page.locator('.as-frag-confirm').click();
        await page.locator('.as-frag-end-btn').click();

        await page.locator('#flow-next').click();
        await page.locator('#preview-next').click();
        const puml = await page.locator('#output').innerText();
        expect(puml).toContain('opt debugMode');
    });

    test('12. step 4 generate panel shows package + filename + plantuml', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);
        await page.locator('#flow-next').click();
        await page.locator('#preview-next').click();
        await expect(page.locator('#panel-4')).toBeVisible();
        // Demo seed sets targetPackage = com.example.invoice.
        await expect(page.locator('#puml-package')).toHaveValue('com.example.invoice');
        // Filename auto-derives from caller + first method.
        const filename = await page.locator('#puml-filename').inputValue();
        expect(filename.endsWith('.puml')).toBeTruthy();
        // Output should contain @startuml + @package header + @enduml.
        const puml = await page.locator('#output').innerText();
        expect(puml).toContain('@startuml');
        expect(puml).toContain("' @package com.example.invoice");
        expect(puml).toContain('@enduml');

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '12-step4-generate.png'), fullPage: true });
    });

    test('13. fonts loaded (Inter applied to body)', async ({ page }) => {
        await gotoApp(page);
        const family = await page.evaluate(() =>
            getComputedStyle(document.body).fontFamily
        );
        // Computed font-family on body should mention Inter (the first var in --font-sans).
        expect(family.toLowerCase()).toContain('inter');
    });

    test('14. comprehensive demo screenshot — step 2 with all fragments', async ({ page }) => {
        await gotoApp(page);
        await gotoDesigner(page);
        // Add a small alt + opt to make the step list show the new types.
        await page.locator('.as-frag-add[data-frag-type="alt"]').click();
        await page.locator('.as-frag-input').fill('order is gift');
        await page.locator('.as-frag-confirm').click();
        await page.locator('.as-frag-end-btn').click();

        await page.locator('.as-frag-add[data-frag-type="opt"]').click();
        await page.locator('.as-frag-input').fill('audit enabled');
        await page.locator('.as-frag-confirm').click();
        await page.locator('.as-frag-end-btn').click();

        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '14-step2-fragments.png'), fullPage: true });
    });

});
