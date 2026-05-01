import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { mergeMarkdown } from '../server/lib/markdown.js';
import { buildPdfExport } from '../server/lib/pdf-export.js';
import {
  clearAllState,
  createExportJob,
  createTask,
  deleteTask,
  exportTask,
  getExportJob,
  getTask,
  readExportJobArtifact,
  updateBlock
} from '../server/lib/task-service.js';

async function installFakePandoc(t) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mts-pandoc-test-'));
  const fakePandocPath = path.join(tempDir, 'fake-pandoc.mjs');
  const previousPandocBin = process.env.MARKDOWN_TRANSLATOR_PANDOC_BIN;

  await writeFile(fakePandocPath, `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
let outputPath = '';
let inputPath = '';

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '-o' || arg === '--output') {
    outputPath = args[index + 1] || '';
    index += 1;
    continue;
  }
  if (arg.startsWith('-')) {
    if (['--from', '--to', '--metadata-file', '--css'].includes(arg)) {
      index += 1;
    }
    continue;
  }
  inputPath = arg;
}

if (!outputPath) {
  process.stderr.write('missing output path');
  process.exit(2);
}

const input = inputPath ? fs.readFileSync(inputPath, 'utf8') : '';
fs.writeFileSync(outputPath, 'fake-epub\\n' + input, 'utf8');
`, { mode: 0o755 });

  process.env.MARKDOWN_TRANSLATOR_PANDOC_BIN = fakePandocPath;

  t.after(async () => {
    if (previousPandocBin === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_PANDOC_BIN;
    } else {
      process.env.MARKDOWN_TRANSLATOR_PANDOC_BIN = previousPandocBin;
    }
    await rm(tempDir, { recursive: true, force: true });
  });
}

test('translation-only markdown export uses a visible placeholder for unfinished blocks', () => {
  const output = mergeMarkdown([
    {
      id: 'p-001',
      type: 'paragraph',
      status: 'queued',
      shouldTranslate: true,
      sourceMarkdown: 'Still English',
      translatedMarkdown: '',
      separatorAfter: ''
    }
  ], 'target_only');

  assert.equal(output, '[TRANSLATION PENDING p-001 status=queued]');
});

test('bilingual markdown export keeps the target side even when source and translation match', () => {
  const output = mergeMarkdown([
    {
      id: 'p-001',
      type: 'paragraph',
      status: 'translated',
      shouldTranslate: true,
      sourceMarkdown: 'API',
      translatedMarkdown: 'API',
      separatorAfter: ''
    }
  ], 'bilingual');

  assert.equal(output, 'API\n\nAPI');
});

test('markdown export filename follows the configured target language', async (t) => {
  clearAllState();

  const task = await createTask({
    filename: 'demo.md',
    documentFormat: 'markdown',
    content: 'Hello world',
    config: {
      targetLanguage: 'English'
    }
  });

  t.after(async () => {
    await deleteTask(task.id);
    clearAllState();
  });

  const detail = getTask(task.id);
  const blockId = detail.blocks.find((block) => block.shouldTranslate)?.id;
  assert.ok(blockId, 'Expected a translatable markdown block.');

  await updateBlock(task.id, blockId, { translatedMarkdown: 'Hello world' });
  const artifact = await exportTask(task.id, 'markdown');

  assert.equal(artifact.export.filename, 'demo.en.md');
});

test('pdf export filename follows the configured target language', async () => {
  const artifact = await buildPdfExport({
    id: 'pdf-demo',
    filename: 'demo.md',
    config: {
      targetLanguage: 'English'
    },
    blocks: [
      {
        id: 'p-001',
        type: 'paragraph',
        status: 'translated',
        shouldTranslate: true,
        sourceMarkdown: 'Hello',
        translatedMarkdown: 'Hello'
      }
    ]
  }, {
    layout: 'translation-only'
  });

  assert.equal(artifact.filename, 'demo.en.pdf');
  assert.ok(Buffer.from(artifact.content, 'base64').length > 0);
});

test('pdf export fails clearly for CJK content when no browser renderer is available', async () => {
  const previous = process.env.MARKDOWN_TRANSLATOR_PDF_DISABLE_BROWSER;
  process.env.MARKDOWN_TRANSLATOR_PDF_DISABLE_BROWSER = '1';

  try {
    await assert.rejects(
      () => buildPdfExport({
        id: 'pdf-cjk',
        filename: 'demo.md',
        config: {
          targetLanguage: 'Chinese'
        },
        blocks: [
          {
            id: 'p-001',
            type: 'paragraph',
            status: 'translated',
            shouldTranslate: true,
            sourceMarkdown: 'Hello world',
            translatedMarkdown: '中文测试'
          }
        ]
      }, {
        layout: 'translation-only'
      }),
      (error) => error?.code === 'pdf_renderer_unavailable'
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_PDF_DISABLE_BROWSER;
    } else {
      process.env.MARKDOWN_TRANSLATOR_PDF_DISABLE_BROWSER = previous;
    }
  }
});

test('pdf export renders chunks and merges them when a merge tool is available', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mts-pdf-test-'));
  const fakeBrowserPath = path.join(tempDir, 'fake-browser.sh');
  const fakeMergePath = path.join(tempDir, 'fake-pdfunite.sh');
  const previousBrowser = process.env.MARKDOWN_TRANSLATOR_CHROME_BIN;
  const previousMerge = process.env.MARKDOWN_TRANSLATOR_PDFUNITE_BIN;
  const previousDisable = process.env.MARKDOWN_TRANSLATOR_PDF_DISABLE_BROWSER;

  await writeFile(fakeBrowserPath, `#!/bin/sh
pdf=""
for arg in "$@"; do
  case "$arg" in
    --print-to-pdf=*) pdf="\${arg#--print-to-pdf=}" ;;
  esac
done
[ -n "$pdf" ] || exit 2
printf "chunk" > "$pdf"
`, { mode: 0o755 });
  await writeFile(fakeMergePath, `#!/bin/sh
last=""
for arg in "$@"; do
  last="$arg"
done
[ -n "$last" ] || exit 2
printf "merged-pdf" > "$last"
`, { mode: 0o755 });

  process.env.MARKDOWN_TRANSLATOR_CHROME_BIN = fakeBrowserPath;
  process.env.MARKDOWN_TRANSLATOR_PDFUNITE_BIN = fakeMergePath;
  delete process.env.MARKDOWN_TRANSLATOR_PDF_DISABLE_BROWSER;

  t.after(async () => {
    if (previousBrowser === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_CHROME_BIN;
    } else {
      process.env.MARKDOWN_TRANSLATOR_CHROME_BIN = previousBrowser;
    }
    if (previousMerge === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_PDFUNITE_BIN;
    } else {
      process.env.MARKDOWN_TRANSLATOR_PDFUNITE_BIN = previousMerge;
    }
    if (previousDisable === undefined) {
      delete process.env.MARKDOWN_TRANSLATOR_PDF_DISABLE_BROWSER;
    } else {
      process.env.MARKDOWN_TRANSLATOR_PDF_DISABLE_BROWSER = previousDisable;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const progressUpdates = [];
  const artifact = await buildPdfExport({
    id: 'pdf-chunked',
    filename: 'chunked.md',
    config: {
      targetLanguage: 'English'
    },
    blocks: Array.from({ length: 120 }, (_, index) => ({
      id: `p-${String(index + 1).padStart(3, '0')}`,
      type: 'paragraph',
      status: 'translated',
      shouldTranslate: true,
      sourceMarkdown: `Source paragraph ${index + 1}`,
      translatedMarkdown: 'translated sentence '.repeat(40)
    }))
  }, {
    layout: 'translation-only',
    onProgress: (progress) => {
      progressUpdates.push(progress);
    }
  });

  assert.equal(artifact.renderer, 'cli-chunked');
  assert.equal(Buffer.from(artifact.content, 'base64').toString('utf8'), 'merged-pdf');
  assert.ok(progressUpdates.some((progress) => progress.stage === 'rendering' && /chunk 1\//i.test(progress.detail)));
  assert.ok(progressUpdates.some((progress) => progress.stage === 'merging'));
});

test('markdown tasks can export translation-only EPUB via pandoc', async (t) => {
  clearAllState();
  await installFakePandoc(t);

  const task = await createTask({
    filename: 'demo.md',
    documentFormat: 'markdown',
    content: 'Hello world',
    config: {
      targetLanguage: 'Chinese'
    }
  });

  t.after(async () => {
    await deleteTask(task.id);
    clearAllState();
  });

  const detail = getTask(task.id);
  const blockId = detail.blocks.find((block) => block.shouldTranslate)?.id;
  assert.ok(blockId, 'Expected a translatable markdown block.');

  await updateBlock(task.id, blockId, { translatedMarkdown: '你好，世界' });
  const artifact = await exportTask(task.id, 'epub');
  const payload = Buffer.from(artifact.export.content, 'base64').toString('utf8');

  assert.equal(artifact.export.filename, 'demo.zh-CN.epub');
  assert.equal(artifact.export.mimeType, 'application/epub+zip');
  assert.match(payload, /你好，世界/);
});

test('async export jobs cache markdown-to-EPUB bilingual downloads', async (t) => {
  clearAllState();
  await installFakePandoc(t);

  const task = await createTask({
    filename: 'async-epub.md',
    documentFormat: 'markdown',
    content: 'Hello world',
    config: {
      targetLanguage: 'Chinese'
    }
  });

  t.after(async () => {
    await deleteTask(task.id);
    clearAllState();
  });

  const detail = getTask(task.id);
  const blockId = detail.blocks.find((block) => block.shouldTranslate)?.id;
  assert.ok(blockId, 'Expected a translatable markdown block.');
  await updateBlock(task.id, blockId, { translatedMarkdown: '你好，世界' });

  const queued = createExportJob(task.id, { format: 'epub_bilingual' });
  assert.equal(queued.job.status, 'queued');

  let completed = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = getExportJob(task.id, queued.job.id).job;
    if (current.status === 'completed') {
      completed = current;
      break;
    }
    if (current.status === 'failed') {
      assert.fail(current.errorMessage || 'Expected markdown-to-EPUB export job to complete.');
    }
    await delay(50);
  }

  assert.ok(completed, 'Expected export job to complete.');
  assert.equal(completed.canDownload, true);

  const artifact = await readExportJobArtifact(task.id, queued.job.id);
  const payload = artifact.payload.toString('utf8');
  assert.equal(artifact.filename, 'async-epub.bilingual.epub');
  assert.match(payload, /Hello world/);
  assert.match(payload, /你好，世界/);
});

test('async export jobs cache markdown downloads for later retrieval', async (t) => {
  clearAllState();

  const task = await createTask({
    filename: 'async-export.md',
    documentFormat: 'markdown',
    content: 'Hello world',
    config: {
      targetLanguage: 'English'
    }
  });

  t.after(async () => {
    await deleteTask(task.id);
    clearAllState();
  });

  const detail = getTask(task.id);
  const blockId = detail.blocks.find((block) => block.shouldTranslate)?.id;
  assert.ok(blockId, 'Expected a translatable markdown block.');
  await updateBlock(task.id, blockId, { translatedMarkdown: 'Hello world' });

  const queued = createExportJob(task.id, { format: 'markdown' });
  assert.equal(queued.job.status, 'queued');

  let completed = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = getExportJob(task.id, queued.job.id).job;
    if (current.status === 'completed') {
      completed = current;
      break;
    }
    if (current.status === 'failed') {
      assert.fail(current.errorMessage || 'Expected async export job to complete.');
    }
    await delay(50);
  }

  assert.ok(completed, 'Expected export job to complete.');
  assert.equal(completed.canDownload, true);

  const artifact = await readExportJobArtifact(task.id, queued.job.id);
  assert.equal(artifact.filename, 'async-export.en.md');
  assert.match(artifact.payload.toString('utf8'), /Hello world/);
});
