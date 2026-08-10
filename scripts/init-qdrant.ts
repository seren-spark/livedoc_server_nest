import { AppConfig } from '../src/config/app-config.js';
import { SparseEmbeddingService } from '../src/retrieval/sparse-embedding.service.js';
import { VectorStoreService } from '../src/retrieval/vector-store.service.js';

const config = new AppConfig();
config.validateRuntime();

if (config.vectorStore !== 'qdrant') {
  throw new Error(`VECTOR_STORE must be qdrant, received ${config.vectorStore}`);
}

const vectorStore = new VectorStoreService(
  config,
  new SparseEmbeddingService(),
);

await vectorStore.ensureCollection();

console.log(JSON.stringify({
  status: 'ok',
  qdrant_url: config.qdrantUrl,
  collection: config.qdrantCollection,
  dense_vector: {
    name: 'dense',
    size: config.embeddingDim,
    distance: 'Cosine',
  },
  sparse_vector: {
    name: 'sparse',
    modifier: 'idf',
  },
}, null, 2));
