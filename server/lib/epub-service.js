import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = path.resolve(__dirname, '../../scripts/epub_tool.ps1');
const TASKS_ROOT = path.resolve(__dirname, '../data/tasks');
const POWERSHELL = 'powershell.exe';

function createError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function stripCodeFences(fragment = '') {
  const trimmed = String(fragment || '').trim();
  const fenced = trimmed.match(/^```(?:xml|html|xhtml)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

async function runTool(mode, args = {}) {
  const workingDir = await mkdtemp(path.join(os.tmpdir(), `mts-epub-${randomUUID()}-`));
  const jsonPath = path.join(workingDir, `${mode}.json`);

  const psArgs = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', TOOL_PATH,
    '-Mode', mode,
    '-JsonPath', jsonPath
  ];

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    psArgs.push(`-${key}`, String(value));
  }

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(POWERSHELL, psArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(createError(422, 'epub_processing_failed', stderr.trim() || `EPUB tool exited with code ${code}.`));
      });
    });

    const raw = await readFile(jsonPath, 'utf8');
    return JSON.parse(raw);
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}

function exportBaseName(filename) {
  return String(filename || 'document').replace(/\.(md|markdown|epub)$/i, '');
}

export function taskArtifactsRoot() {
  return TASKS_ROOT;
}

export async function parseEpubArchive({ taskId, contentBase64 }) {
  if (!contentBase64) {
    throw createError(400, 'invalid_request', 'contentBase64 is required for EPUB tasks.');
  }

  await mkdir(TASKS_ROOT, { recursive: true });
  const taskDir = path.join(TASKS_ROOT, taskId);
  await mkdir(taskDir, { recursive: true });

  const uploadPath = path.join(taskDir, 'upload.epub');
  await writeFile(uploadPath, Buffer.from(contentBase64, 'base64'));

  try {
    return await runTool('parse', {
      InputPath: uploadPath,
      TaskDir: taskDir
    });
  } finally {
    await rm(uploadPath, { force: true });
  }
}

export async function reparseEpubArchive({ taskDir, inputPath }) {
  if (!taskDir || !inputPath) {
    throw createError(400, 'invalid_request', 'taskDir and inputPath are required to reparse an EPUB task.');
  }

  return runTool('parse', {
    InputPath: inputPath,
    TaskDir: taskDir
  });
}

export async function validateEpubFragment({ sourceFragment, translatedFragment }) {
  const cleaned = stripCodeFences(translatedFragment);
  if (!cleaned) {
    throw createError(422, 'epub_fragment_invalid', 'Translated EPUB fragment is empty.');
  }

  return runTool('validate-fragment', {
    SourceFragmentBase64: Buffer.from(String(sourceFragment || ''), 'utf8').toString('base64'),
    TranslatedFragmentBase64: Buffer.from(cleaned, 'utf8').toString('base64')
  });
}

export async function applyEpubSegmentTranslations({ sourceFragment, translatedSegments }) {
  if (!Array.isArray(translatedSegments) || !translatedSegments.length) {
    throw createError(422, 'epub_segment_invalid', 'Translated segment list is empty.');
  }

  return runTool('apply-segments', {
    SourceFragmentBase64: Buffer.from(String(sourceFragment || ''), 'utf8').toString('base64'),
    TranslatedSegmentsBase64: Buffer.from(JSON.stringify(translatedSegments), 'utf8').toString('base64')
  });
}

export async function buildEpubExport(task) {
  if (!task?.asset?.taskDir) {
    throw createError(409, 'epub_assets_missing', 'EPUB assets are missing for this task.');
  }

  const workingDir = await mkdtemp(path.join(os.tmpdir(), `mts-epub-export-${randomUUID()}-`));
  const taskJsonPath = path.join(workingDir, 'task.json');
  const outputPath = path.join(workingDir, `${exportBaseName(task.filename)}.zh-CN.epub`);

  try {
    await writeFile(taskJsonPath, JSON.stringify(task, null, 2), 'utf8');
    const result = await runTool('export', {
      TaskJsonPath: taskJsonPath,
      OutputPath: outputPath
    });
    const buffer = await readFile(outputPath);
    return {
      filename: `${exportBaseName(task.filename)}.zh-CN.epub`,
      mimeType: 'application/epub+zip',
      encoding: 'base64',
      previewText: 'Translated EPUB export',
      content: buffer.toString('base64'),
      sizeBytes: result.sizeBytes || buffer.length,
      generatedAt: new Date().toISOString(),
      validator: 'internal-xhtml-validator'
    };
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}

export async function removeTaskArtifacts(task) {
  const taskDir = task?.asset?.taskDir;
  if (!taskDir) {
    return;
  }
  await rm(taskDir, { recursive: true, force: true });
}
