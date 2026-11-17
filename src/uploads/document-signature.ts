/**
 * @file 上传文档格式校验。检查文件头和 DOCX 压缩包结构，拦截格式不符或超限文件。
 */
import { promises as fs } from 'node:fs';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';

const PDF_SIGNATURE = Buffer.from('%PDF-');
const REQUIRED_DOCX_ENTRIES = new Set(['[Content_Types].xml', 'word/document.xml']);
const MAX_DOCX_ENTRIES = 10_000;

/**
 * 核对上传类型与文件签名，拒绝扩展名和实际内容不一致的文件。
 *
 * @param path 目标文件路径或节点层级路径。
 * @param extension 需要检查或配置的编辑器扩展。
 */
export async function validateDocumentFile(path: string, extension: '.pdf' | '.docx'): Promise<void> {
  if (extension === '.pdf') {
    const handle = await fs.open(path, 'r');
    try {
      const header = Buffer.alloc(PDF_SIGNATURE.length);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || !header.equals(PDF_SIGNATURE)) {
        throw new Error('Uploaded file is not a valid PDF.');
      }
    } finally {
      await handle.close();
    }
    return;
  }

  await validateDocxArchive(path);
}

/**
 * 检查 DOCX 压缩包的必要结构及安全限制。
 *
 * @param path 目标文件路径或节点层级路径。
 */
function validateDocxArchive(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    openZip(path, { lazyEntries: true, autoClose: true }, (openError, archive) => {
      if (openError || !archive) {
        reject(new Error('Uploaded file is not a valid DOCX archive.'));
        return;
      }
      if (archive.entryCount > MAX_DOCX_ENTRIES) {
        archive.close();
        reject(new Error('DOCX archive contains too many entries.'));
        return;
      }
      inspectDocxEntries(archive, resolve, reject);
    });
  });
}

/**
 * 逐项检查 DOCX 条目与大小，识别不合法或超限压缩包。
 *
 * @param archive 当前需要检查的 DOCX 压缩包。
 * @param resolve 异步操作成功时执行的完成回调。
 * @param reject 异步操作失败时执行的拒绝回调。
 */
function inspectDocxEntries(
  archive: ZipFile,
  resolve: () => void,
  reject: (error: Error) => void,
): void {
  const remaining = new Set(REQUIRED_DOCX_ENTRIES);
  let settled = false;
  /**
   * 关闭压缩包并只结算一次检查结果，防止重复回调。
   *
   * @param error 本次操作捕获的异常（可选）。
   */
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    archive.close();
    error ? reject(error) : resolve();
  };
  archive.on('entry', (entry: Entry) => {
    remaining.delete(entry.fileName.replaceAll('\\', '/'));
    if (!remaining.size) finish();
    else archive.readEntry();
  });
  archive.once('end', () => {
    if (remaining.size) finish(new Error('Uploaded archive is not a DOCX document.'));
  });
  archive.once('error', () => finish(new Error('Uploaded file is not a valid DOCX archive.')));
  archive.readEntry();
}
