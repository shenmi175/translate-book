import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyEpubTranslationUnit } from '../server/lib/epub-hotpath.js';
import { buildEpubExport, parseEpubArchive, removeTaskArtifacts } from '../server/lib/epub-service.js';
import { clearAllState, createTask, deleteTask, getTaskStatus } from '../server/lib/task-service.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_FIXTURE_DIR = path.join(ROOT_DIR, 'server', 'data', 'tasks');

function findSampleEpub(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return '';
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findSampleEpub(fullPath);
      if (nested) {
        return nested;
      }
      continue;
    }
    if (entry.isFile() && entry.name === 'source.epub') {
      return fullPath;
    }
  }

  return '';
}

const SAMPLE_EPUB_PATH = findSampleEpub(TASKS_FIXTURE_DIR);

test('EPUB parse and export smoke test', async (t) => {
  if (!SAMPLE_EPUB_PATH) {
    t.skip('No sample EPUB fixture is available under server/data/tasks.');
    return;
  }

  const contentBuffer = await readFile(SAMPLE_EPUB_PATH);
  const taskId = randomUUID();
  const parsed = await parseEpubArchive({
    taskId,
    contentBuffer
  });

  t.after(async () => {
    await removeTaskArtifacts({ asset: parsed.asset });
  });

  assert.ok(parsed.parser.engine.includes('epub-xhtml-xml'));
  assert.ok(parsed.stats.translatableBlocks > 0);

  const translatableBlocks = parsed.blocks
    .filter((block) => block.shouldTranslate && block.translationUnit?.segmentTemplate)
    .slice(0, 5);
  assert.ok(translatableBlocks.length >= 2, 'Expected at least two segment-mapped EPUB blocks.');

  const appliedByBlockId = new Map(translatableBlocks.map((block, blockIndex) => {
    const translatedSegments = block.translationUnit.segments.map((segment, segmentIndex) => `${segment.sourceText} [ZH-${blockIndex + 1}-${segmentIndex + 1}]`);
    const applied = applyEpubTranslationUnit({
      blockType: block.type,
      sourceMarkdown: block.sourceMarkdown,
      translationUnit: block.translationUnit,
      translatedSegments
    });
    return [block.id, applied];
  }));

  const exportTask = {
    id: taskId,
    filename: 'fixture.epub',
    config: {
      targetLanguage: 'English'
    },
    asset: parsed.asset,
    blocks: parsed.blocks.map((block) => {
      const applied = appliedByBlockId.get(block.id);
      if (!applied) {
        return block;
      }
      return {
        ...block,
        status: 'translated',
        translatedMarkdown: applied.previewText,
        translationUnit: {
          ...block.translationUnit,
          translatedFragment: applied.normalizedFragment
        }
      };
    })
  };

  const artifact = await buildEpubExport(exportTask);
  const outputBuffer = Buffer.from(artifact.content, 'base64');

  assert.equal(artifact.mimeType, 'application/epub+zip');
  assert.equal(artifact.filename, 'fixture.en.epub');
  assert.ok(outputBuffer.length > 0);
  assert.equal(outputBuffer.subarray(0, 2).toString('utf8'), 'PK');

  const bilingualArtifact = await buildEpubExport(exportTask, { layout: 'bilingual' });
  const bilingualOutputBuffer = Buffer.from(bilingualArtifact.content, 'base64');

  assert.equal(bilingualArtifact.mimeType, 'application/epub+zip');
  assert.equal(bilingualArtifact.filename, 'fixture.bilingual.epub');
  assert.equal(bilingualArtifact.layout, 'bilingual');
  assert.ok(bilingualOutputBuffer.length > 0);
  assert.equal(bilingualOutputBuffer.subarray(0, 2).toString('utf8'), 'PK');
});

test('EPUB export resolves stale absolute asset paths after container moves', async (t) => {
  if (!SAMPLE_EPUB_PATH) {
    t.skip('No sample EPUB fixture is available under server/data/tasks.');
    return;
  }

  const contentBuffer = await readFile(SAMPLE_EPUB_PATH);
  const taskId = randomUUID();
  const parsed = await parseEpubArchive({
    taskId,
    contentBuffer
  });

  t.after(async () => {
    await removeTaskArtifacts({ asset: parsed.asset });
  });

  const translatableBlock = parsed.blocks.find((block) => block.shouldTranslate && block.translationUnit?.segmentTemplate);
  assert.ok(translatableBlock, 'Expected at least one segment-mapped EPUB block.');

  const translatedSegments = translatableBlock.translationUnit.segments.map((segment) => segment.sourceText);
  const applied = applyEpubTranslationUnit({
    blockType: translatableBlock.type,
    sourceMarkdown: translatableBlock.sourceMarkdown,
    translationUnit: translatableBlock.translationUnit,
    translatedSegments
  });

  const staleTask = {
    id: taskId,
    filename: 'moved.epub',
    config: {
      targetLanguage: 'English'
    },
    asset: {
      ...parsed.asset,
      taskDir: `/app/server/data/tasks/${taskId}`,
      sourceArchivePath: `/app/server/data/tasks/${taskId}/source.epub`,
      extractRoot: `/app/server/data/tasks/${taskId}/source`
    },
    blocks: parsed.blocks.map((block) => {
      if (block.id !== translatableBlock.id) {
        return block;
      }
      return {
        ...block,
        status: 'translated',
        translatedMarkdown: applied.previewText,
        translationUnit: {
          ...block.translationUnit,
          translatedFragment: applied.normalizedFragment
        }
      };
    })
  };

  const artifact = await buildEpubExport(staleTask);
  assert.equal(artifact.filename, 'moved.en.epub');
});

test('Task status omits heavyweight global block list by default', async (t) => {
  if (!SAMPLE_EPUB_PATH) {
    t.skip('No sample EPUB fixture is available under server/data/tasks.');
    return;
  }

  clearAllState();

  const contentBuffer = await readFile(SAMPLE_EPUB_PATH);
  const task = await createTask({
    filename: 'fixture.epub',
    documentFormat: 'epub',
    contentBuffer
  });

  t.after(async () => {
    await deleteTask(task.id);
    clearAllState();
  });

  const status = getTaskStatus(task.id);

  assert.equal(status.blocks, undefined);
  assert.ok(Array.isArray(status.failedBlocks));
  assert.ok(Array.isArray(status.pageBlocks));
  assert.ok(status.pageBlocks.length > 0);
});
