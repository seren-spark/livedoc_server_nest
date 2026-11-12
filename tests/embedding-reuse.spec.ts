import { describe, expect, jest, test } from '@jest/globals';
import { EmbeddingService } from '../src/inference/embedding.service.js';
import { AppConfig } from '../src/config/app-config.js';

function setup() {
  const config = new AppConfig();
  Object.assign(config, { embeddingProvider: 'transformers', embeddingModel: 'model-a', embeddingDim: 2 });
  const embed = jest.fn<any>().mockImplementation(async (texts: string[]) => texts.map((text) => [text.length, 1]));
  return { config, embed, service: new EmbeddingService(config, { embed } as any) };
}

describe('content-keyed embedding reuse', () => {
  test('computes only changed passages and preserves input order and independent vectors', async () => {
    const { service, embed } = setup();
    const first = await service.embedBatch(['first', 'second', 'third', 'first']);
    first[0]![0] = -1;
    expect(first[3]).toEqual([5, 1]);
    expect(await service.embedBatch(['third', 'changed', 'first'])).toEqual([[5, 1], [7, 1], [5, 1]]);
    expect(embed.mock.calls).toEqual([[['first', 'second', 'third']], [['changed']]]);
  });

  test('shares in-flight work and retries after a failed batch', async () => {
    const { service, embed } = setup();
    await Promise.all([service.embedBatch(['same']), service.embedBatch(['same'])]);
    expect(embed).toHaveBeenCalledTimes(1);
    embed.mockRejectedValueOnce(new Error('worker unavailable'));
    await expect(service.embedBatch(['new'])).rejects.toThrow('worker unavailable');
    expect(await service.embedBatch(['new'])).toEqual([[3, 1]]);
    expect(embed).toHaveBeenCalledTimes(3);
  });

  test('isolates model fingerprints and bounds retained entries', async () => {
    const { config, service, embed } = setup();
    await service.embedBatch(['first']);
    Object.assign(config, { embeddingModel: 'model-b' });
    await service.embedBatch(['first']);
    expect(embed).toHaveBeenCalledTimes(2);
    await service.embedBatch(Array.from({ length: 1025 }, (_, index) => `passage-${index}`));
    await service.embedBatch(['first']);
    expect(embed).toHaveBeenCalledTimes(4);
  });

  test('does not cache invalid vector batches', async () => {
    const { service, embed } = setup();
    embed.mockResolvedValueOnce([[Number.NaN, 1]]);
    await expect(service.embedBatch(['bad'])).rejects.toThrow('invalid vectors');
    expect(await service.embedBatch(['bad'])).toEqual([[3, 1]]);
    expect(await service.embedBatch([])).toEqual([]);
  });
});
