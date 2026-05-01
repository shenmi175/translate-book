import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASK_SERVICE_URL = pathToFileURL(path.join(ROOT_DIR, 'server/lib/task-service.js')).href;

test('SQLite persistence survives a simulated process restart', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'translate-book-sqlite-'));
  const dbPath = path.join(tempDir, 'state.sqlite');
  const exportCacheDir = path.join(tempDir, 'export-cache');
  const previousDbPath = process.env.MARKDOWN_TRANSLATOR_DB_PATH;
  const previousExportCacheDir = process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR;

  try {
    process.env.MARKDOWN_TRANSLATOR_DB_PATH = dbPath;
    process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR = exportCacheDir;

    const mod1 = await import(`${TASK_SERVICE_URL}?sqlite-persist=1`);
    mod1.clearAllState();

    const createdTask = await mod1.createTask({
      filename: 'persisted.md',
      documentFormat: 'markdown',
      content: 'Hello world'
    });
    mod1.flushState();

    assert.ok(fs.existsSync(dbPath), 'Expected the SQLite state file to be created.');

    const mod2 = await import(`${TASK_SERVICE_URL}?sqlite-persist=2`);
    const tasks = mod2.listTasks().map((task) => ({
      id: task.id,
      filename: task.filename
    }));

    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0], {
      id: createdTask.id,
      filename: createdTask.filename
    });
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_DB_PATH;
    } else {
      process.env.MARKDOWN_TRANSLATOR_DB_PATH = previousDbPath;
    }
    if (previousExportCacheDir === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR;
    } else {
      process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR = previousExportCacheDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite FTS search finds persisted block content after reload', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'translate-book-sqlite-search-'));
  const dbPath = path.join(tempDir, 'state.sqlite');
  const exportCacheDir = path.join(tempDir, 'export-cache');
  const previousDbPath = process.env.MARKDOWN_TRANSLATOR_DB_PATH;
  const previousExportCacheDir = process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR;

  try {
    process.env.MARKDOWN_TRANSLATOR_DB_PATH = dbPath;
    process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR = exportCacheDir;

    const mod1 = await import(`${TASK_SERVICE_URL}?sqlite-search=1`);
    mod1.clearAllState();

    const task = await mod1.createTask({
      filename: 'searchable.md',
      documentFormat: 'markdown',
      content: 'The Road to Serfdom'
    });
    const detail = mod1.getTask(task.id);
    const blockId = detail.blocks.find((block) => block.shouldTranslate)?.id;
    assert.ok(blockId, 'Expected a translatable block.');
    await mod1.updateBlock(task.id, blockId, { translatedMarkdown: '通往奴役之路' });
    mod1.flushState();

    const mod2 = await import(`${TASK_SERVICE_URL}?sqlite-search=2`);
    const result = mod2.searchTaskBlocks(task.id, {
      query: 'Serfdom',
      pageSize: 20,
      limit: 10
    });

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].id, blockId);
    assert.match(result.matches[0].sourceExcerpt, /Serfdom/);
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_DB_PATH;
    } else {
      process.env.MARKDOWN_TRANSLATOR_DB_PATH = previousDbPath;
    }
    if (previousExportCacheDir === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR;
    } else {
      process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR = previousExportCacheDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite stores export jobs separately from task payload rows', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'translate-book-sqlite-exports-'));
  const dbPath = path.join(tempDir, 'state.sqlite');
  const exportCacheDir = path.join(tempDir, 'export-cache');
  const previousDbPath = process.env.MARKDOWN_TRANSLATOR_DB_PATH;
  const previousExportCacheDir = process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR;

  try {
    process.env.MARKDOWN_TRANSLATOR_DB_PATH = dbPath;
    process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR = exportCacheDir;

    const mod1 = await import(`${TASK_SERVICE_URL}?sqlite-export-jobs=1`);
    mod1.clearAllState();

    const task = await mod1.createTask({
      filename: 'exports.md',
      documentFormat: 'markdown',
      content: 'First paragraph.\n\nSecond paragraph.'
    });

    const queued = mod1.createExportJob(task.id, { format: 'markdown' });
    let finalJob = queued.job;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = mod1.getExportJob(task.id, queued.job.id).job;
      finalJob = current;
      if (current.status === 'completed' || current.status === 'failed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    mod1.flushState();

    assert.notEqual(finalJob.status, 'queued');

    const db = new DatabaseSync(dbPath);
    try {
      const taskRow = db.prepare('SELECT payload_json, summary_json FROM tasks WHERE id = ?').get(task.id);
      assert.ok(taskRow, 'Expected persisted task row.');
      const payload = JSON.parse(taskRow.payload_json);
      const summary = JSON.parse(taskRow.summary_json);
      const blockCount = Number(db.prepare('SELECT COUNT(*) AS count FROM task_blocks WHERE task_id = ?').get(task.id).count || 0);
      const exportJobCount = Number(db.prepare('SELECT COUNT(*) AS count FROM task_export_jobs WHERE task_id = ?').get(task.id).count || 0);

      assert.equal(payload.blocks, undefined);
      assert.equal(payload.exportJobs, undefined);
      assert.equal(blockCount, task.blocks.length);
      assert.ok(exportJobCount >= 1, 'Expected export jobs to be persisted in the separate table.');
      assert.equal(summary.totalBlocks, task.blocks.length);
    } finally {
      db.close();
    }

    const mod2 = await import(`${TASK_SERVICE_URL}?sqlite-export-jobs=2`);
    const listedTask = mod2.listTasks().find((candidate) => candidate.id === task.id);
    assert.ok(listedTask, 'Expected the exported task to be listed after reload.');
    assert.ok((listedTask.exportJobs || []).length >= 1, 'Expected listTasks() to hydrate export jobs from SQLite.');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_DB_PATH;
    } else {
      process.env.MARKDOWN_TRANSLATOR_DB_PATH = previousDbPath;
    }
    if (previousExportCacheDir === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR;
    } else {
      process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR = previousExportCacheDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite only rewrites dirty block rows during block edits', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'translate-book-sqlite-blocks-'));
  const dbPath = path.join(tempDir, 'state.sqlite');
  const exportCacheDir = path.join(tempDir, 'export-cache');
  const previousDbPath = process.env.MARKDOWN_TRANSLATOR_DB_PATH;
  const previousExportCacheDir = process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR;

  try {
    process.env.MARKDOWN_TRANSLATOR_DB_PATH = dbPath;
    process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR = exportCacheDir;

    const mod = await import(`${TASK_SERVICE_URL}?sqlite-dirty-block=1`);
    mod.clearAllState();

    const task = await mod.createTask({
      filename: 'dirty-block.md',
      documentFormat: 'markdown',
      content: 'First paragraph.\n\nSecond paragraph.'
    });
    mod.flushState();

    const detail = mod.getTask(task.id);
    const editableBlocks = detail.blocks.filter((block) => block.shouldTranslate).slice(0, 2);
    assert.equal(editableBlocks.length, 2, 'Expected two editable blocks.');

    const db = new DatabaseSync(dbPath);
    try {
      const beforeRows = db.prepare(`
        SELECT block_id, updated_at
        FROM task_blocks
        WHERE task_id = ?
        ORDER BY order_index ASC
      `).all(task.id);
      const beforeById = new Map(beforeRows.map((row) => [row.block_id, row.updated_at]));

      await new Promise((resolve) => setTimeout(resolve, 20));
      await mod.updateBlock(task.id, editableBlocks[0].id, { translatedMarkdown: '第一段' });
      mod.flushState();

      const afterRows = db.prepare(`
        SELECT block_id, updated_at, translated_text
        FROM task_blocks
        WHERE task_id = ?
        ORDER BY order_index ASC
      `).all(task.id);
      const afterById = new Map(afterRows.map((row) => [row.block_id, row]));

      assert.notEqual(
        afterById.get(editableBlocks[0].id)?.updated_at,
        beforeById.get(editableBlocks[0].id),
        'Expected the edited block row to receive a new updated_at timestamp.'
      );
      assert.equal(
        afterById.get(editableBlocks[1].id)?.updated_at,
        beforeById.get(editableBlocks[1].id),
        'Expected untouched block rows to keep their original updated_at timestamp.'
      );
      assert.match(afterById.get(editableBlocks[0].id)?.translated_text || '', /第一段/);
    } finally {
      db.close();
    }
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_DB_PATH;
    } else {
      process.env.MARKDOWN_TRANSLATOR_DB_PATH = previousDbPath;
    }
    if (previousExportCacheDir === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR;
    } else {
      process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR = previousExportCacheDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
