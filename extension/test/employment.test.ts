import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * The repeating-section filler, against a form shaped like the ones it broke on.
 *
 * These functions only exist inside a page, so the module is bundled and
 * injected rather than imported: testing a copy of the logic would pass while
 * the real thing stayed broken.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(resolve(HERE, 'fixtures/repeating-sections.html')).href;

let browser: Browser;
let bundle: string;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome' });
  const built = await build({
    entryPoints: [resolve(HERE, '../src/content/autofill/employment.ts')],
    bundle: true,
    format: 'iife',
    globalName: 'employment',
    write: false,
    logLevel: 'silent',
  });
  bundle = built.outputFiles[0].text;
});

after(async () => {
  await browser?.close();
});

async function open(): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: bundle });
  return page;
}

describe('addAnotherFor', () => {
  it("refuses another list's button when its own list has none", async () => {
    // The defect this covers. Work history here has no add button; education
    // does. Searching beyond the list's own container finds education's, and
    // clicking it grows an empty education block instead of a work row.
    const page = await open();
    try {
      const picked = await page.evaluate(() => {
        const rows = employment.findRows();
        return employment.addAnotherFor(rows)?.id ?? null;
      });
      assert.equal(picked, null, "it should decline rather than borrow another list's button");
    } finally {
      await page.close();
    }
  });

  it('takes its own button when the list has one', async () => {
    const page = await open();
    try {
      const picked = await page.evaluate(() => {
        const own = document.createElement('a');
        own.id = 'add-employment';
        own.textContent = 'Add another';
        document.getElementById('employment')!.append(own);

        const rows = employment.findRows();
        return employment.addAnotherFor(rows)?.id ?? null;
      });
      assert.equal(picked, 'add-employment');
    } finally {
      await page.close();
    }
  });
});

describe('fillEmploymentHistory', () => {
  const experience = [
    { title: 'Staff Engineer', company: 'Acme', startDate: 'Jan 2022', endDate: 'Present', bullets: [] },
    { title: 'Engineer', company: 'Globex', startDate: 'Mar 2019', endDate: 'Dec 2021', bullets: [] },
  ];

  /** Gives the work-history list an add button of its own. */
  const giveOwnButton = `
    const own = document.createElement('a');
    own.id = 'add-employment';
    own.textContent = 'Add another';
    document.getElementById('employment').append(own);
    let n = 1;
    own.addEventListener('click', (e) => {
      e.preventDefault();
      const block = document.createElement('div');
      block.className = 'section entry';
      block.innerHTML =
        '<div><label for="c' + n + '">Company</label><input type="text" id="c' + n + '"></div>' +
        '<div><label for="t' + n + '">Title</label><input type="text" id="t' + n + '"></div>';
      own.before(block);
      n += 1;
    });
  `;

  it('never grows a list it was not given a button for', async () => {
    const page = await open();
    try {
      const counts = await page.evaluate(async (roles) => {
        await employment.fillEmploymentHistory(roles, new Set(), { mayAddRows: true });
        return {
          employment: document.querySelectorAll('#employment .entry').length,
          education: document.querySelectorAll('#education .entry').length,
        };
      }, experience);

      assert.equal(counts.employment, 1, 'no work row can be added without a button for it');
      assert.equal(counts.education, 1, 'education must be untouched');
    } finally {
      await page.close();
    }
  });

  it('adds what the resume needs when a press asks for it', async () => {
    const page = await open();
    try {
      await page.evaluate(giveOwnButton);
      const rows = await page.evaluate(async (roles) => {
        await employment.fillEmploymentHistory(roles, new Set(), { mayAddRows: true });
        return document.querySelectorAll('#employment .entry').length;
      }, experience);
      assert.equal(rows, 2, 'two roles should produce two rows');
    } finally {
      await page.close();
    }
  });

  it('adds no more than the resume has, however often it is pressed', async () => {
    const page = await open();
    try {
      await page.evaluate(giveOwnButton);
      const rows = await page.evaluate(async (roles) => {
        for (let press = 0; press < 6; press += 1) {
          await employment.fillEmploymentHistory(roles, new Set(), { mayAddRows: true });
        }
        return document.querySelectorAll('#employment .entry').length;
      }, experience);
      assert.equal(rows, 2, `six presses produced ${rows} rows for two roles`);
    } finally {
      await page.close();
    }
  });

  it('the background sweep never creates a row', async () => {
    // The loop this closes: the sweep runs because the page changed, and adding
    // a row changes the page. Filling what is already there is safe to repeat;
    // creating something is not, so only a person asking can do it.
    const page = await open();
    try {
      await page.evaluate(giveOwnButton);
      const counts = await page.evaluate(async (roles) => {
        for (let sweep = 0; sweep < 10; sweep += 1) {
          await employment.fillEmploymentHistory(roles, new Set(), { mayAddRows: false });
        }
        return {
          employment: document.querySelectorAll('#employment .entry').length,
          education: document.querySelectorAll('#education .entry').length,
        };
      }, experience);

      assert.equal(counts.employment, 1, `ten sweeps created ${counts.employment - 1} row(s)`);
      assert.equal(counts.education, 1, `ten sweeps created ${counts.education - 1} education block(s)`);
    } finally {
      await page.close();
    }
  });
});

declare global {
  const employment: typeof import('../src/content/autofill/employment');
}
