import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TASK_SERVICE_URL = new URL('../server/lib/task-service.js', import.meta.url).href;

test('admin auth supports first registration, login lockout, and server reset', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'translate-book-auth-'));
  const previousDbPath = process.env.MARKDOWN_TRANSLATOR_DB_PATH;
  const previousDotenvPath = process.env.MARKDOWN_TRANSLATOR_DOTENV_PATH;
  process.env.MARKDOWN_TRANSLATOR_DB_PATH = path.join(tempDir, 'state.sqlite');
  process.env.MARKDOWN_TRANSLATOR_DOTENV_PATH = path.join(tempDir, '.env');

  try {
    const mod = await import(`${TASK_SERVICE_URL}?auth=${Date.now()}`);
    mod.clearAllState();

    assert.equal(mod.getAdminAuthState().configured, false);
    assert.equal(mod.getServiceOverview().authRequired, false);

    const registered = mod.registerAdminAccount({ username: 'admin', password: 'correct-password' });
    assert.equal(typeof registered.token, 'string');
    assert.equal(registered.auth.configured, true);
    assert.equal(mod.verifyAdminAuthSession(registered.token), true);
    assert.equal(mod.getServiceOverview().authRequired, true);

    mod.logoutAdminSession(registered.token);
    assert.equal(mod.verifyAdminAuthSession(registered.token), false);
    const activeSession = mod.loginAdminAccount({ username: 'admin', password: 'correct-password' });
    assert.equal(mod.verifyAdminAuthSession(activeSession.token), true);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.throws(
        () => mod.loginAdminAccount({ username: 'admin', password: 'wrong-password' }),
        (error) => error?.code === 'invalid_credentials' && error?.details?.remainingAttempts === 5 - attempt
      );
    }

    assert.throws(
      () => mod.loginAdminAccount({ username: 'admin', password: 'wrong-password' }),
      (error) => error?.code === 'admin_locked' && error?.statusCode === 423
    );
    assert.equal(mod.getAdminAuthState().locked, true);
    assert.equal(mod.verifyAdminAuthSession(activeSession.token), false);
    assert.throws(
      () => mod.loginAdminAccount({ username: 'admin', password: 'correct-password' }),
      (error) => error?.code === 'admin_locked'
    );

    mod.resetAdminPasswordFromServer({ username: 'admin', password: 'new-correct-password' });
    assert.equal(mod.getAdminAuthState().locked, false);

    const loggedIn = mod.loginAdminAccount({ username: 'admin', password: 'new-correct-password' });
    assert.equal(mod.verifyAdminAuthSession(loggedIn.token), true);
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_DB_PATH;
    } else {
      process.env.MARKDOWN_TRANSLATOR_DB_PATH = previousDbPath;
    }
    if (previousDotenvPath === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_DOTENV_PATH;
    } else {
      process.env.MARKDOWN_TRANSLATOR_DOTENV_PATH = previousDotenvPath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
