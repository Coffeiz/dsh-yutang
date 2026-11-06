import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const promptSource = resolve(scriptDir, '../src/prompt');
const promptOutput = resolve(scriptDir, '../lib/prompt');
rmSync(promptOutput, { recursive: true, force: true });

function copyMarkdown(sourceDir, outputDir) {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = resolve(sourceDir, entry.name);
    const outputPath = resolve(outputDir, entry.name);
    if (entry.isDirectory()) copyMarkdown(sourcePath, outputPath);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      mkdirSync(outputDir, { recursive: true });
      copyFileSync(sourcePath, outputPath);
    }
  }
}

copyMarkdown(promptSource, promptOutput);
