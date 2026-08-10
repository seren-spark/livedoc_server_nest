import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../config/app-config.js';
import type { ParsedDocument } from './document-import.types.js';

const execFileAsync = promisify(execFile);

@Injectable()
export class DoclingParserService {
  constructor(private readonly config: AppConfig) {}

  async parse(path: string, filename: string): Promise<ParsedDocument> {
    const output = resolve('data', 'tmp', `docling-${randomUUID()}.json`);
    try {
      await execFileAsync(this.config.doclingPython, [
        resolve(this.config.doclingScript), '--input', path, '--filename', filename, '--output', output,
      ], {
        timeout: 30 * 60 * 1000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          OPENBLAS_NUM_THREADS: String(this.config.doclingNumThreads),
          OMP_NUM_THREADS: String(this.config.doclingNumThreads),
          MKL_NUM_THREADS: String(this.config.doclingNumThreads),
          NUMEXPR_NUM_THREADS: String(this.config.doclingNumThreads),
        },
      });
      return JSON.parse(await readFile(output, 'utf8')) as ParsedDocument;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Docling parser failed: ${detail}`);
    } finally {
      await rm(output, { force: true });
    }
  }
}
