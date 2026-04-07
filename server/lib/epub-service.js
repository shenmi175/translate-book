import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveExportLanguage } from './export-language.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POWERSHELL_TOOL_PATH = path.resolve(__dirname, '../../scripts/epub_tool.ps1');
const PYTHON_TOOL_PATH = path.resolve(__dirname, '../../scripts/epub_tool.py');
const TASKS_ROOT = path.resolve(__dirname, '../data/tasks');
const TOOL_RUNNERS = process.platform === 'win32'
  ? [
      { label: 'python3', command: 'python', fixedArgs: [PYTHON_TOOL_PATH] },
      { label: 'py', command: 'py', fixedArgs: ['-3', PYTHON_TOOL_PATH] },
      { label: 'powershell.exe', command: 'powershell.exe', fixedArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', POWERSHELL_TOOL_PATH] }
    ]
  : [
      { label: 'python3', command: 'python3', fixedArgs: [PYTHON_TOOL_PATH] },
      { label: 'python', command: 'python', fixedArgs: [PYTHON_TOOL_PATH] },
      { label: 'pwsh', command: 'pwsh', fixedArgs: ['-NoProfile', '-File', POWERSHELL_TOOL_PATH] }
    ];
let preferredToolRunner = null;

function toKebabCaseFlag(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

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

  try {
    const runnerCandidates = preferredToolRunner
      ? [preferredToolRunner, ...TOOL_RUNNERS.filter((runner) => runner.command !== preferredToolRunner.command)]
      : TOOL_RUNNERS;

    let lastError = null;
    let executed = false;

    for (const runner of runnerCandidates) {
      const invocationArgs = [...runner.fixedArgs];
      if (runner.fixedArgs.includes(PYTHON_TOOL_PATH)) {
        invocationArgs.push('--mode', mode, '--json-path', jsonPath);
      } else {
        invocationArgs.push('-Mode', mode, '-JsonPath', jsonPath);
      }

      for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null || value === '') {
          continue;
        }
        const normalizedKey = runner.fixedArgs.includes(PYTHON_TOOL_PATH)
          ? `--${toKebabCaseFlag(key)}`
          : `-${key}`;
        invocationArgs.push(normalizedKey, String(value));
      }

      try {
        await new Promise((resolve, reject) => {
          const child = spawn(runner.command, invocationArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
          });
          child.on('error', (error) => {
            if (error?.code === 'ENOENT') {
              const missing = createError(500, 'epub_tool_unavailable', `${runner.label} is not available for EPUB processing.`);
              missing.isToolMissing = true;
              reject(missing);
              return;
            }
            reject(error);
          });
          child.on('exit', (code) => {
            if (code === 0) {
              resolve();
              return;
            }
            reject(createError(422, 'epub_processing_failed', stderr.trim() || `EPUB tool exited with code ${code}.`));
          });
        });
        preferredToolRunner = runner;
        executed = true;
        break;
      } catch (error) {
        lastError = error;
        if (error?.isToolMissing) {
          continue;
        }
        throw error;
      }
    }

    if (!executed) {
      throw lastError || createError(500, 'epub_tool_unavailable', 'No compatible EPUB processing runtime is available.');
    }

    const raw = await readFile(jsonPath, 'utf8');
    return JSON.parse(raw);
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}

function exportBaseName(filename) {
  return String(filename || 'document').replace(/\.(md|markdown|epub)$/i, '');
}

async function pathExists(pathValue) {
  if (!pathValue) {
    return false;
  }

  try {
    await access(pathValue);
    return true;
  } catch {
    return false;
  }
}

function uniquePaths(paths = []) {
  return [...new Set(paths.filter(Boolean).map((item) => path.resolve(String(item))))];
}

async function findExistingPath(paths = []) {
  for (const candidate of uniquePaths(paths)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return '';
}

async function resolveEpubExportAsset(task) {
  const asset = task?.asset || {};
  const inferredTaskId = task?.id || (asset.taskDir ? path.basename(asset.taskDir) : '');
  const inferredTaskDir = inferredTaskId ? path.join(TASKS_ROOT, inferredTaskId) : '';
  const taskDir = await findExistingPath([
    asset.taskDir,
    inferredTaskDir,
    asset.extractRoot ? path.dirname(asset.extractRoot) : '',
    asset.sourceArchivePath ? path.dirname(asset.sourceArchivePath) : ''
  ]) || inferredTaskDir;

  const sourceArchivePath = await findExistingPath([
    asset.sourceArchivePath,
    taskDir ? path.join(taskDir, 'source.epub') : '',
    inferredTaskDir ? path.join(inferredTaskDir, 'source.epub') : ''
  ]);

  let extractRoot = await findExistingPath([
    asset.extractRoot,
    taskDir ? path.join(taskDir, 'source') : '',
    inferredTaskDir ? path.join(inferredTaskDir, 'source') : ''
  ]);

  if (!extractRoot && sourceArchivePath && taskDir) {
    await runTool('parse', {
      InputPath: sourceArchivePath,
      TaskDir: taskDir
    });
    extractRoot = await findExistingPath([
      path.join(taskDir, 'source'),
      inferredTaskDir ? path.join(inferredTaskDir, 'source') : ''
    ]);
  }

  if (!extractRoot) {
    throw createError(
      409,
      'epub_assets_missing',
      'EPUB source assets are missing for this task. Re-import or reparse the EPUB before exporting.',
      {
        taskId: task?.id || '',
        checkedTaskDir: taskDir,
        checkedSourceArchivePath: sourceArchivePath || asset.sourceArchivePath || '',
        checkedExtractRoot: asset.extractRoot || ''
      }
    );
  }

  return {
    ...asset,
    taskDir: taskDir || path.dirname(extractRoot),
    sourceArchivePath: sourceArchivePath || (taskDir ? path.join(taskDir, 'source.epub') : ''),
    extractRoot
  };
}

export function taskArtifactsRoot() {
  return TASKS_ROOT;
}

export async function parseEpubArchive({ taskId, contentBase64, contentBuffer }) {
  const buffer = Buffer.isBuffer(contentBuffer)
    ? contentBuffer
    : contentBase64
      ? Buffer.from(contentBase64, 'base64')
      : null;

  if (!buffer?.length) {
    throw createError(400, 'invalid_request', 'contentBase64 or contentBuffer is required for EPUB tasks.');
  }

  await mkdir(TASKS_ROOT, { recursive: true });
  const taskDir = path.join(TASKS_ROOT, taskId);
  await mkdir(taskDir, { recursive: true });

  const uploadPath = path.join(taskDir, 'upload.epub');
  await writeFile(uploadPath, buffer);

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

export async function buildEpubExport(task, options = {}) {
  if (!task?.asset?.taskDir && !task?.asset?.extractRoot && !task?.asset?.sourceArchivePath) {
    throw createError(409, 'epub_assets_missing', 'EPUB assets are missing for this task.');
  }

  const workingDir = await mkdtemp(path.join(os.tmpdir(), `mts-epub-export-${randomUUID()}-`));
  const taskJsonPath = path.join(workingDir, 'task.json');
  const exportLanguage = resolveExportLanguage(task?.config?.targetLanguage);
  const layout = options.layout === 'bilingual' ? 'bilingual' : 'translation-only';
  const outputFilename = `${exportBaseName(task.filename)}.${layout === 'bilingual' ? 'bilingual' : exportLanguage.suffix}.epub`;
  const outputPath = path.join(workingDir, outputFilename);

  try {
    const exportTask = {
      ...task,
      asset: await resolveEpubExportAsset(task)
    };
    await writeFile(taskJsonPath, JSON.stringify(exportTask, null, 2), 'utf8');
    const result = await runTool('export', {
      TaskJsonPath: taskJsonPath,
      OutputPath: outputPath,
      Layout: layout
    });
    const buffer = await readFile(outputPath);
    return {
      filename: outputFilename,
      mimeType: 'application/epub+zip',
      encoding: 'base64',
      previewText: layout === 'bilingual' ? 'Bilingual EPUB export' : 'Translated EPUB export',
      content: buffer.toString('base64'),
      sizeBytes: result.sizeBytes || buffer.length,
      generatedAt: new Date().toISOString(),
      validator: 'internal-xhtml-validator',
      layout
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
