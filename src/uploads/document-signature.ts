import { promises as fs } from 'node:fs';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';

const PDF_SIGNATURE = Buffer.from('%PDF-');
const REQUIRED_DOCX_ENTRIES = new Set(['[Content_Types].xml', 'word/document.xml']);
const MAX_DOCX_ENTRIES = 10_000;

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

function inspectDocxEntries(
  archive: ZipFile,
  resolve: () => void,
  reject: (error: Error) => void,
): void {
  const remaining = new Set(REQUIRED_DOCX_ENTRIES);
  let settled = false;
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
