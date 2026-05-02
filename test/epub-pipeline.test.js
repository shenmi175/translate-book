import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function breakFragmentStructure(fragment) {
  const rootMatch = String(fragment || '').match(/^<([A-Za-z][\w:-]*)\b/);
  if (!rootMatch) {
    return '';
  }

  const rootTag = rootMatch[1];
  const tags = [...String(fragment).matchAll(/<([A-Za-z][\w:-]*)\b/g)].map((match) => match[1]);
  const nestedTag = tags.find((name, index) => index > 0 && name !== rootTag && !['br', 'img'].includes(name.toLowerCase()));
  if (!nestedTag) {
    return '';
  }

  const replacementTag = nestedTag.toLowerCase() === 'span' ? 'strong' : 'span';
  const escapedTag = escapeRegExp(nestedTag);
  return String(fragment)
    .replace(new RegExp(`<${escapedTag}(?=\\b)`, 'g'), `<${replacementTag}`)
    .replace(new RegExp(`</${escapedTag}>`, 'g'), `</${replacementTag}>`);
}

async function createTextHtmlSpineEpub(t) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mts-text-html-epub-'));
  const epubPath = path.join(tempDir, 'text-html-spine.epub');

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const script = String.raw`
import sys
import zipfile
import base64

epub_path = sys.argv[1]
files = {
  "META-INF/container.xml": """<?xml version="1.0" encoding="utf-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile media-type="application/oebps-package+xml" full-path="EPUB/content.opf"/>
  </rootfiles>
</container>
""",
  "EPUB/content.opf": """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">text-html-spine</dc:identifier>
    <dc:title>Text HTML Spine Fixture</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item href="chapter.html" id="chapter_1" media-type="text/html"/>
    <item href="images/pixel.png" id="image_1" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="chapter_1"/>
  </spine>
</package>
""",
  "EPUB/chapter.html": """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">
  <head><title>Article</title></head>
  <body>
    <h1>Article headline</h1>
    <img src="images/pixel.png" alt="Chart image"/>
    <p>First paragraph for translation.</p>
  </body>
</html>
""",
}
image_files = {
  "EPUB/images/pixel.png": base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=")
}

with zipfile.ZipFile(epub_path, "w") as archive:
  archive.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
  for name, content in files.items():
    archive.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
  for name, content in image_files.items():
    archive.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
`;

  const result = spawnSync('python3', ['-c', script, epubPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return readFile(epubPath);
}

test('EPUB parser accepts XHTML spine files declared as text/html', async (t) => {
  const contentBuffer = await createTextHtmlSpineEpub(t);
  const taskId = randomUUID();
  const parsed = await parseEpubArchive({
    taskId,
    contentBuffer
  });

  t.after(async () => {
    await removeTaskArtifacts({ asset: parsed.asset });
  });

  const translatableText = parsed.blocks
    .filter((block) => block.shouldTranslate)
    .map((block) => block.sourceMarkdown)
    .join('\n');

  assert.equal(parsed.asset.spineCount, 1);
  assert.ok(parsed.stats.translatableBlocks >= 2);
  assert.equal(parsed.blocks.find((block) => block.type === 'image')?.shouldTranslate, false);
  assert.match(translatableText, /Article headline/);
  assert.match(translatableText, /First paragraph for translation/);

  const artifact = await buildEpubExport({
    id: taskId,
    filename: 'text-html-spine.epub',
    config: {
      targetLanguage: 'Chinese'
    },
    asset: parsed.asset,
    blocks: parsed.blocks
  });
  const outputPath = path.join(path.dirname(parsed.asset.taskDir), `${taskId}-image-preserve-check.epub`);
  await fs.promises.writeFile(outputPath, Buffer.from(artifact.content, 'base64'));
  t.after(async () => {
    await rm(outputPath, { force: true });
  });

  const listing = spawnSync('unzip', ['-l', outputPath], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr || listing.stdout);
  assert.match(listing.stdout, /EPUB\/images\/pixel\.png/);
});

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

test('EPUB bilingual export repairs translated fragment structure drift', async (t) => {
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

  const structuredBlock = parsed.blocks.find((block) =>
    block.shouldTranslate
    && block.translationUnit?.segmentTemplate
    && (block.translationUnit.sourceFragment.match(/<([A-Za-z][\w:-]*)\b/g) || []).length > 1
  );
  if (!structuredBlock) {
    t.skip('No structured EPUB fragment is available in the sample fixture.');
    return;
  }

  const translatedSegments = structuredBlock.translationUnit.segments.map((segment, segmentIndex) => `${segment.sourceText} [ZH-${segmentIndex + 1}]`);
  const applied = applyEpubTranslationUnit({
    blockType: structuredBlock.type,
    sourceMarkdown: structuredBlock.sourceMarkdown,
    translationUnit: structuredBlock.translationUnit,
    translatedSegments
  });
  const brokenFragment = breakFragmentStructure(applied.normalizedFragment);
  if (!brokenFragment) {
    t.skip('Failed to synthesize a structure-drift fragment from the sample block.');
    return;
  }

  const exportTask = {
    id: taskId,
    filename: 'fixture.epub',
    config: {
      targetLanguage: 'English'
    },
    asset: parsed.asset,
    blocks: parsed.blocks.map((block) => {
      if (block.id !== structuredBlock.id) {
        return block;
      }
      return {
        ...block,
        status: 'translated',
        translatedMarkdown: applied.previewText,
        translationUnit: {
          ...block.translationUnit,
          translatedFragment: brokenFragment
        }
      };
    })
  };

  const bilingualArtifact = await buildEpubExport(exportTask, { layout: 'bilingual' });
  const bilingualOutputBuffer = Buffer.from(bilingualArtifact.content, 'base64');

  assert.equal(bilingualArtifact.mimeType, 'application/epub+zip');
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
