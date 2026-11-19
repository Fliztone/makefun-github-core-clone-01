// The entrypoint: the entry <-> env lifecycle. Bind an ephemeral port of our own (never
// 8080, the env's), POST {"port": N} to $MAKEFUN_ENV_URL/register inside the boot budget,
// answer the env's GET /healthz probes, then poll GET $MAKEFUN_ENV_URL/done until the
// suite says it is over and exit 0. The forge itself lives in forge.ts and is listening
// before the register goes out, so the health probes always find it up.

import { createForge } from './forge.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** One register or done request may take this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200) or another entry won (409). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      // The env may still be starting: retry with backoff.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never exit before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const { server } = createForge();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the forge did not bind a TCP port');
  process.stdout.write(`[forge] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[forge] registered; serving until the env says done\n');

  await waitForDone();
  server.close();
  server.closeAllConnections();
  process.stdout.write('[forge] done\n');
}

// A stray error must not kill the forge mid-trial: log it and keep serving.
process.on('uncaughtException', (err: Error) => {
  process.stderr.write(`[forge] uncaught exception: ${err.stack ?? err.message}\n`);
});
process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`[forge] unhandled rejection: ${String(reason)}\n`);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
