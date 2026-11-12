import { mkdtempSync, readFileSync, writeFileSync, rmSync, rmdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reserveBusinessModelRequest } from '../scripts/agent-business-budget.js';

describe('real business evaluation request cap', () => {
  let directory: string;
  beforeEach(() => { mkdirSync('.cache', { recursive: true }); directory = mkdtempSync(resolve('.cache', 'agent-business-budget-')); });
  afterEach(() => {
    rmSync(join(directory, 'counter.json'), { force: true });
    rmSync(join(directory, 'counter.json.tmp'), { force: true });
    rmdirSync(directory);
  });

  test('allows exactly 100 reservations and refuses the next request before dispatch', () => {
    const path = join(directory, 'counter.json');
    writeFileSync(path, '{"requests":0}');
    let dispatched = 0;
    for (let index = 0; index < 100; index++) {
      reserveBusinessModelRequest(path);
      dispatched++;
    }
    expect(() => { reserveBusinessModelRequest(path); dispatched++; })
      .toThrow('100次模型请求上限');
    expect(dispatched).toBe(100);
    expect(JSON.parse(readFileSync(path, 'utf8')).requests).toBe(100);
  });

  test('uses persisted state and fails closed for an invalid counter', () => {
    const path = join(directory, 'counter.json');
    writeFileSync(path, '{"requests":99}');
    reserveBusinessModelRequest(path);
    expect(() => reserveBusinessModelRequest(path)).toThrow('100次模型请求上限');
    writeFileSync(path, '{"requests":-1}');
    expect(() => reserveBusinessModelRequest(path)).toThrow('调用计数无效');
    expect(JSON.parse(readFileSync(path, 'utf8')).requests).toBe(-1);
  });
});
