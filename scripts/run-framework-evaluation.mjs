import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.LIVEDOC_EVAL_PYTHON || resolve(root, process.platform === 'win32'
  ? 'evals/.venv/Scripts/python.exe' : 'evals/.venv/bin/python');
if (!existsSync(python)) throw new Error('请先运行 npm run eval:setup 创建独立评测环境');
const args = process.argv.slice(2);
const quality = args.includes('--quality-report');
if (quality) args.splice(args.indexOf('--quality-report'), 1);
if (!args.some(a => a === '--out' || a.startsWith('--out='))) args.push('--out', `evals/results/${quality ? 'quality' : 'frameworks'}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const child = spawn(python, [quality ? 'evals/summarize_quality.py' : 'evals/run_frameworks.py', ...args], { cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
