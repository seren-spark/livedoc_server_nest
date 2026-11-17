/**
 * @file Docling 解析适配。调用文档解析进程，将上传文件转换为 Markdown 与资源信息。
 */
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
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * 调用 Docling 解析上传文件，读取生成的 Markdown 与图片资源。
   *
   * @param path 目标文件路径或节点层级路径。
   * @param filename 上传文件的原始名称。
   * @returns ParsedDocument 类型的处理结果。
   */
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
