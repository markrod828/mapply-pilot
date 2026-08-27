import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { prepareContext } from '../src/context';
import { submitAndConfirm } from '../src/submit';
import type { FormTemplate } from '../src/templates/types';

/**
 * The submit path, against a real server.
 *
 * Worth the machinery of an actual HTTP server rather than a stubbed page: the
 * thing being tested is whether a POST, a redirect and a status code are read
 * correctly, and none of that exists without a server on the other end.
 */

type Handler = (path: string, method: string) => { status: number; headers?: Record<string, string>; body: string };

function form(action: string): string {
  return `<!doctype html><html><body><h1>Apply</h1>
    <form id="application_form" action="${action}" method="post">
      <input type="text" name="first_name" value="Test">
      <button type="submit" id="submit_app">Submit Application</button>
    </form></body></html>`;
}

const THANKS = '<!doctype html><html><body><h1>Thank you for applying</h1></body></html>';

function template(origin: string): FormTemplate {
  return {
    id: 'test.v1',
    atsKind: 'greenhouse',
    urlPattern: /localhost/,
    domSignature: '#application_form',
    fields: [],
    submitSelector: '#submit_app',
    confirm: {
      responseUrl: new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/applications`),
      urlPattern: /(confirmation|thank|success)/i,
      textPattern: /thank you for applying/i,
    },
  };
}

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => {
  await browser?.close();
});

async function withServer<T>(handler: Handler, run: (origin: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((req, res) => {
    const { status, headers, body } = handler(req.url ?? '/', req.method ?? 'GET');
    res.writeHead(status, { 'content-type': 'text/html', ...headers });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await run(origin);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function attempt(origin: string, handler: Handler) {
  const context = await browser.newContext();
  await prepareContext(context);
  const page = await context.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    let clicked = false;
    const result = await submitAndConfirm(page, page, template(origin), async () => {
      clicked = true;
    });
    return { result, clicked };
  } finally {
    await context.close();
  }
}

describe('submitAndConfirm', () => {
  it('confirms a form that posts and renders thanks in place', async () => {
    const handler: Handler = (path, method) =>
      method === 'POST'
        ? { status: 200, body: THANKS }
        : { status: 200, body: form('/applications') };

    await withServer(handler, async (origin) => {
      const { result, clicked } = await attempt(origin, handler);
      assert.ok(clicked, 'the caller must be told before the click, not after');
      assert.ok(result.confirmed, `expected confirmation, got signals ${result.signals.join(',')}`);
      assert.ok(result.signals.includes('network'));
      assert.ok(result.signals.includes('text'));
      assert.equal(result.httpStatus, 200);
      assert.match(result.confirmationText ?? '', /thank you for applying/i);
    });
  });

  it('confirms a post that redirects to a confirmation page', async () => {
    // The classic pattern - post, then 302 to a thank-you URL. The redirect is
    // the success, so a check that only accepts 2xx misses it entirely.
    const handler: Handler = (path, method) => {
      if (method === 'POST') return { status: 302, headers: { location: '/confirmation' }, body: '' };
      if (path.startsWith('/confirmation')) return { status: 200, body: THANKS };
      return { status: 200, body: form('/applications') };
    };

    await withServer(handler, async (origin) => {
      const { result } = await attempt(origin, handler);
      assert.ok(result.confirmed, `expected confirmation, got signals ${result.signals.join(',')}`);
      assert.ok(result.signals.includes('url'));
      assert.ok(
        result.signals.includes('network'),
        'a 302 after POST is the application being accepted, and must count as the network signal',
      );
    });
  });

  it('refuses to call a rejected submission confirmed', async () => {
    // The safety case. The server said no and re-rendered the form; nothing here
    // may report success, and the caller must be left to park it for a human.
    const handler: Handler = (path, method) =>
      method === 'POST'
        ? { status: 422, body: `${form('/applications')}<p class="error">Email is required</p>` }
        : { status: 200, body: form('/applications') };

    await withServer(handler, async (origin) => {
      const { result } = await attempt(origin, handler);
      assert.ok(!result.confirmed, `a 422 must never confirm; signals were ${result.signals.join(',')}`);
      assert.ok(result.unverified);
      assert.equal(result.httpStatus, 422);
    });
  });
});
