import { spawn, type ChildProcess } from 'node:child_process';

const services = [
  {
    name: 'api',
    args: [
      '--enable-source-maps',
      '--watch',
      '--loader',
      'ts-node/esm',
      'src/main.ts',
    ],
  },
  {
    name: 'index-worker',
    args: [
      '--enable-source-maps',
      '--watch',
      '--loader',
      'ts-node/esm',
      'src/worker.ts',
    ],
  },
  {
    name: 'import-worker',
    args: [
      '--enable-source-maps',
      '--watch',
      '--loader',
      'ts-node/esm',
      'src/import-worker.ts',
    ],
  },
] as const;

const children = new Map<string, ChildProcess>();
let shuttingDown = false;

function stopAll(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

for (const service of services) {
  const child = spawn(process.execPath, service.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.set(service.name, child);
  console.log(`[dev] started ${service.name} (pid=${child.pid ?? 'unknown'})`);
  child.once('error', (error) => {
    console.error(`[dev] ${service.name} failed to start: ${error.message}`);
    stopAll(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(service.name);
    if (shuttingDown) return;
    console.error(
      `[dev] ${service.name} exited unexpectedly (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`,
    );
    stopAll(code && code > 0 ? code : 1);
  });
}

process.once('SIGINT', () => stopAll(0));
process.once('SIGTERM', () => stopAll(0));
