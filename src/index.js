import { openDB } from "idb";
import { pipeline } from "@xenova/transformers";
import { env } from "@xenova/transformers";

// Specify a custom location for models (defaults to '/models/').
env.localModelPath = "/huggingface";

// Disable the loading of remote models from the Hugging Face Hub:
// env.allowRemoteModels = false;

// Set location of .wasm files. Defaults to use a CDN.
// env.backends.onnx.wasm.wasmPaths = '/path/to/files/';

// Default pipeline (Xenova/all-MiniLM-L6-v2)
const defaultModel = "Xenova/all-MiniLM-L6-v2";
const pipePromise = pipeline("feature-extraction", defaultModel);

// Default IndexedDB name
const defaultDBName = 'EntityDB';

// Cosine similarity function
const cosineSimilarity = (vecA, vecB) => {
  const dotProduct = vecA.reduce(
    (sum, val, index) => sum + val * vecB[index],
    0
  );
  const magnitudeA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
};

// Function to get embeddings from text using HuggingFace pipeline
const getEmbeddingFromText = async (text, model = defaultModel) => {
  const pipe = await pipePromise;
  const output = await pipe(text, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data);
};

// Binarizer function for dense vectors
const binarizeVector = (vector, threshold = null) => {
  if (threshold === null) {
    const sorted = [...vector].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    threshold =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
  }
  return vector.map((val) => (val >= threshold ? 1 : 0));
};

// Function to calculate Hamming distance
const hammingDistance = (vectorA, vectorB) => {
  if (vectorA.length !== vectorB.length) {
    throw new Error("Vectors must be of the same length");
  }
  const length = vectorA.length;
  const bitsA = new BigUint64Array(vectorA.buffer);
  const bitsB = new BigUint64Array(vectorB.buffer);

  let distance = 0n;
  for (let i = 0; i < bitsA.length; i++) {
    const xorResult = bitsA[i] ^ bitsB[i];
    distance += BigInt(xorResult.toString(2).replace(/0/g, "").length); // Popcount equivalent
  }
  return Number(distance);
};

//Load Hamming Distance Over WASM SIMD (128 bits at a time - 2x faster than normal JS using BigUint64Array):
//haming_distance_simd.wat script compiled to WASM and base64 encoded:
const wasmBase64 =
  "AGFzbQEAAAABDAJgAX8AYAN/f38BfwILAQNlbnYDbG9nAAADAgEBBQMBAAEHHQIGbWVtb3J5AgAQaGFtbWluZ19kaXN0YW5jZQABCoYBAYMBAQF/QQAhAwJAA0AgAkUEQAwCCyAAEAAgAyAA/QAEACAB/QAEAP1R/RsAaSAA/QAEACAB/QAEAP1R/RsBaSAA/QAEACAB/QAEAP1R/RsCaSAA/QAEACAB/QAEAP1R/RsDaWpqamohAyAAQRBqIQAgAUEQaiEBIAJBEGshAgwACwsgAwsAPQRuYW1lARgCAANsb2cBEGhhbW1pbmdfZGlzdGFuY2UCHAIAAAEEAARwdHJBAQRwdHJCAgNsZW4DBGRpc3Q=";

function base64ToUint8Array(base64) {
  if (typeof window !== "undefined") {
    // Browser: Use atob to decode Base64
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } else {
    // Node.js: Use Buffer to decode Base64
    return Uint8Array.from(Buffer.from(base64, "base64"));
  }
}

async function loadWasm() {
  const wasmBinary = base64ToUint8Array(wasmBase64); // Decode Base64
  const wasmModule = await WebAssembly.instantiate(wasmBinary, {
    env: {
      memory: new WebAssembly.Memory({ initial: 1 }),
      log: (ptr) => console.log(`Processing pointer at offset: ${ptr}`),
    },
  });

  // Check if memory is exported; if not, use the imported memory
  const memory =
    wasmModule.instance.exports.memory ||
    wasmModule.instance.exports.env.memory;

  if (!memory) {
    throw new Error("WebAssembly module does not export or provide memory.");
  }

  return {
    ...wasmModule.instance.exports,
    memory, // Ensure memory is included
  };
}

class EntityDB {
  constructor({ dbName = defaultDBName, vectorPath, model = defaultModel }) {
    this.dbName = dbName;
    this.vectorPath = vectorPath;
    this.model = model;
    this.dbPromise = this._initDB();
  }

  // Initialize the IndexedDB
  async _initDB() {
    const db = await openDB(this.dbName, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("vectors")) {
          // Require manual id, disable autoIncrement
          db.createObjectStore("vectors", { keyPath: "id" });
        }
      },
    });
    return db;
  }

  // Insert data by generating embeddings from text
  async insert(data) {
    try {
      if (data.id == null) {
        throw new Error('ID is required for insert');
      }
      // Generate embedding if text is provided
      let embedding = data[this.vectorPath];
      if (data.text) {
        embedding = await getEmbeddingFromText(data.text, this.model);
      }

      const db = await this.dbPromise;
      const transaction = db.transaction("vectors", "readwrite");
      const store = transaction.objectStore("vectors");
      const record = { vector: embedding, ...data };
      const key = await store.add(record);
      return key;
    } catch (error) {
      throw new Error(`Error inserting data: ${error}`);
    }
  }

  async insertBinary(data) {
    try {
      if (data.id == null) {
        throw new Error('ID is required for binary insert');
      }
      let embedding = data[this.vectorPath];
      if (data.text) {
        embedding = await getEmbeddingFromText(data.text, this.model);
      }

      // Binarize the embedding and pack into BigUint64Array
      const binaryEmbedding = binarizeVector(embedding);
      const packedEmbedding = new BigUint64Array(
        new ArrayBuffer(Math.ceil(binaryEmbedding.length / 64) * 8)
      );
      for (let i = 0; i < binaryEmbedding.length; i++) {
        const bitIndex = i % 64;
        const arrayIndex = Math.floor(i / 64);
        if (binaryEmbedding[i] === 1) {
          packedEmbedding[arrayIndex] |= 1n << BigInt(bitIndex);
        }
      }

      const db = await this.dbPromise;
      const transaction = db.transaction("vectors", "readwrite");
      const store = transaction.objectStore("vectors");
      const record = { vector: packedEmbedding, ...data };
      const key = await store.add(record);
      return key;
    } catch (error) {
      throw new Error(`Error inserting binary data: ${error}`);
    }
  }

  // Insert manual vectors (no embedding generation, just insert provided vectors)
  async insertManualVectors(data) {
    try {
      if (data.id == null) {
        throw new Error('ID is required for manual vectors insert');
      }
      const db = await this.dbPromise;
      const transaction = db.transaction("vectors", "readwrite");
      const store = transaction.objectStore("vectors");
      const record = { vector: data[this.vectorPath], ...data };
      const key = await store.add(record);
      return key;
    } catch (error) {
      throw new Error(`Error inserting manual vectors: ${error}`);
    }
  }

  // Batch insert manual vectors (no embedding generation)
  async insertManualBatch(dataArray) {
    const db = await this.dbPromise;
    const tx = db.transaction("vectors", "readwrite");
    const store = tx.objectStore("vectors");
    const keys = [];
    for (const data of dataArray) {
      if (data.id == null) {
        throw new Error('ID is required for manual batch insert');
      }
      const embedding = data[this.vectorPath];
      const record = { vector: embedding, ...data };
      const key = await store.add(record);
      keys.push(key);
    }
    await tx.done;
    return keys;
  }

  // Batch insert data (auto embedding or manual vector)
  async insertBatch(dataArray) {
    const db = await this.dbPromise;
    const tx = db.transaction("vectors", "readwrite");
    const store = tx.objectStore("vectors");
    const keys = [];
    for (const data of dataArray) {
      if (data.id == null) {
        throw new Error('ID is required for batch insert');
      }
      let embedding = data[this.vectorPath];
      if (data.text) {
        embedding = await getEmbeddingFromText(data.text, this.model);
      }
      const record = { vector: embedding, ...data };
      const key = await store.add(record);
      keys.push(key);
    }
    await tx.done;
    return keys;
  }

  // Update an existing vector in the database (partial merge to preserve vector)
  async update(key, data) {
    const db = await this.dbPromise;
    const transaction = db.transaction("vectors", "readwrite");
    const store = transaction.objectStore("vectors");
    // Fetch existing record
    const existing = await store.get(key);
    if (!existing) {
      throw new Error(`Cannot update non-existent key ${key}`);
    }
    // Determine new vector: use provided or preserve existing
    const newVec = data[this.vectorPath] ?? data.vector;
    const vecToStore = Array.isArray(newVec) && newVec.length > 0 ? newVec : existing.vector;
    // Merge all fields, ensure key and vector
    const updatedData = { ...existing, ...data, [store.keyPath]: key, vector: vecToStore };
    await store.put(updatedData);
  }

  // Batch update existing vectors
  async updateBatch(updates) {
    const db = await this.dbPromise;
    const tx = db.transaction("vectors", "readwrite");
    const store = tx.objectStore("vectors");
    for (const { key, ...data } of updates) {
      // Load existing record
      const existing = await store.get(key);
      if (!existing) continue;
      // Determine vector to preserve or update
      const newVec = data[this.vectorPath] ?? data.vector;
      const vecToStore = Array.isArray(newVec) && newVec.length > 0 ? newVec : existing.vector;
      // Merge and put
      const merged = { ...existing, ...data, [store.keyPath]: key, vector: vecToStore };
      await store.put(merged);
    }
    await tx.done;
  }

  // Delete a vector by key
  async delete(key) {
    const db = await this.dbPromise;
    const transaction = db.transaction("vectors", "readwrite");
    const store = transaction.objectStore("vectors");
    await store.delete(key);
  }

  async hasEmbedding(key) {
    try {
      const db = await this.dbPromise;
      const transaction = db.transaction("vectors", "readonly");
      const store = transaction.objectStore("vectors");
      const record = await store.get(key);
      // No record => no embedding
      if (!record) {
        return false;
      }
      // Check actual vector field
      const vec = record[this.vectorPath] ?? record.vector;
      if (!Array.isArray(vec) || vec.length === 0) {
        return false;
      }
      return true;
    } catch (error) {
      console.error(`Error checking for embedding with key ${key}:`, error);
      throw new Error(`Failed to check embedding existence for key ${key}: ${error.message}`);
    }
  }

  /**
   * Check existence of multiple embeddings.
   * @param keys Array of keys to check.
   * @returns Mapping from key to boolean indicating non-empty vector existence.
   */
  async hasEmbeddings(keys) {
    const db = await this.dbPromise;
    const transaction = db.transaction("vectors", "readonly");
    const store = transaction.objectStore("vectors");
    const result = {};
    for (const key of keys) {
      const record = await store.get(key);
      if (record) {
        const vec = record[this.vectorPath] ?? record.vector;
        result[key] = Array.isArray(vec) && vec.length > 0;
      } else {
        result[key] = false;
      }
    }
    return result;
  }

  // Query vectors by cosine similarity (using a text input that will be converted into embeddings)
  async query(queryText, { limit = 10 } = {}) {
    try {
      // Get embeddings for the query text
      const queryVector = await getEmbeddingFromText(queryText, this.model);

      const db = await this.dbPromise;
      const transaction = db.transaction("vectors", "readonly");
      const store = transaction.objectStore("vectors");
      const vectors = await store.getAll(); // Retrieve all vectors

      // Calculate cosine similarity for each vector and sort by similarity
      const similarities = vectors.map((entry) => {
        const similarity = cosineSimilarity(queryVector, entry.vector);
        return { ...entry, similarity };
      });

      similarities.sort((a, b) => b.similarity - a.similarity); // Sort by similarity (descending)
      return similarities.slice(0, limit); // Return the top N results based on limit
    } catch (error) {
      throw new Error(`Error querying vectors: ${error}`);
    }
  }

  //Query binarized vectors using Hamming distance nstead of cosine similarity
  async queryBinary(queryText, { limit = 10 } = {}) {
    try {
      // Get embeddings and binarize them
      const queryVector = await getEmbeddingFromText(queryText, this.model);
      const binaryQueryVector = binarizeVector(queryVector);

      // Pack the query vector into BigUint64Array
      const packedQueryVector = new BigUint64Array(
        new ArrayBuffer(Math.ceil(binaryQueryVector.length / 64) * 8)
      );
      for (let i = 0; i < binaryQueryVector.length; i++) {
        const bitIndex = i % 64;
        const arrayIndex = Math.floor(i / 64);
        if (binaryQueryVector[i] === 1) {
          packedQueryVector[arrayIndex] |= 1n << BigInt(bitIndex);
        }
      }

      const db = await this.dbPromise;
      const transaction = db.transaction("vectors", "readonly");
      const store = transaction.objectStore("vectors");
      const vectors = await store.getAll();

      // Calculate Hamming distance
      const distances = vectors.map((entry) => {
        const distance = hammingDistance(packedQueryVector, entry.vector);
        return { ...entry, distance };
      });

      // Sort by Hamming distance (ascending)
      distances.sort((a, b) => a.distance - b.distance);

      // Return the top N results based on limit
      return distances.slice(0, limit);
    } catch (error) {
      throw new Error(`Error querying binary vectors: ${error}`);
    }
  }

  /*Hamming Distance over WebAssembly SIMD:
  The WebAssembly SIMD implementation processes 128 bits per iteration (via v128.xor) 
  compared to 64 bits per iteration in the JavaScript implementation using BigUint64Array.
  This alone gives a theoretical 2x speedup. 
  
  SIMD instructions execute XOR, popcount, and similar operations on multiple data lanes in parallel. 
  This reduces the number of CPU cycles required for the same amount of work compared to sequential 
  bitwise operations in JavaScript. SIMD in WebAssembly is likely 2x to 4x faster or more over big vectors.
  */
  async queryBinarySIMD(queryText, { limit = 10 } = {}) {
    try {
      const queryVector = await getEmbeddingFromText(queryText, this.model);
      const binaryQueryVector = binarizeVector(queryVector);

      const packedQueryVector = new BigUint64Array(
        new ArrayBuffer(Math.ceil(binaryQueryVector.length / 64) * 8)
      );
      for (let i = 0; i < binaryQueryVector.length; i++) {
        const bitIndex = i % 64;
        const arrayIndex = Math.floor(i / 64);
        if (binaryQueryVector[i] === 1) {
          packedQueryVector[arrayIndex] |= 1n << BigInt(bitIndex);
        }
      }

      console.log(
        "Query Vector (binary):",
        [...packedQueryVector].map((v) => v.toString(2))
      );

      const db = await this.dbPromise;
      const transaction = db.transaction("vectors", "readonly");
      const store = transaction.objectStore("vectors");
      const vectors = await store.getAll();

      vectors.forEach((entry, index) => {
        console.log(
          `DB Vector ${index} (binary):`,
          [...new BigUint64Array(entry.vector.buffer)].map((v) => v.toString(2))
        );
      });

      const wasmModule = await loadWasm();
      const { hamming_distance, memory } = wasmModule;

      if (!memory) {
        throw new Error("WebAssembly memory is undefined.");
      }

      const wasmMemory = new Uint8Array(memory.buffer);
      wasmMemory.set(new Uint8Array(packedQueryVector.buffer), 0);

      const distances = vectors.map((entry) => {
        const dbVector = new Uint8Array(entry.vector.buffer);
        wasmMemory.set(dbVector, 16);
        const distance = hamming_distance(0, 16, packedQueryVector.length * 8);
        return { ...entry, distance };
      });

      distances.sort((a, b) => a.distance - b.distance);
      return distances.slice(0, limit);
    } catch (error) {
      console.error("Error querying binary vectors:", error);
      throw error;
    }
  }

  // Query manual vectors directly (query pre-computed embeddings)
  async queryManualVectors(queryVector, { limit = 10 } = {}) {
    try {
      const db = await this.dbPromise;
      const transaction = db.transaction("vectors", "readonly");
      const store = transaction.objectStore("vectors");
      const vectors = await store.getAll(); // Retrieve all vectors

      // Calculate cosine similarity for each vector and sort by similarity
      const similarities = [];
      for (const entry of vectors) {
        // Try dynamic field, fallback to 'vector'
        let vecB = entry[this.vectorPath];
        if (!Array.isArray(vecB)) {
          vecB = entry.vector;
        }
        if (!Array.isArray(vecB)) {
          console.warn(`[EntityDB] Skipping entry ${entry.id}: missing vector`);
          continue;
        }
        const similarity = cosineSimilarity(queryVector, vecB);
        similarities.push({ ...entry, similarity });
      }

      similarities.sort((a, b) => b.similarity - a.similarity); // Sort by similarity (descending)
      return similarities.slice(0, limit); // Return the top N results based on limit
    } catch (error) {
      throw new Error(`Error querying manual vectors: ${error}`);
    }
  }

  // Get all embedding keys
  async getAllKeys() {
    try {
      const db = await this.dbPromise;
      const transaction = db.transaction("vectors", "readonly");
      const store = transaction.objectStore("vectors");
      const keys = await store.getAllKeys();
      return keys;
    } catch (error) {
      throw new Error(`Error getting all embedding keys: ${error}`);
    }
  }

  // Batch delete by keys
  async deleteBatch(keys) {
    const db = await this.dbPromise;
    const tx = db.transaction("vectors", "readwrite");
    const store = tx.objectStore("vectors");
    for (const key of keys) {
      await store.delete(key);
    }
    await tx.done;
  }
}

// Export EntityDB class
export { EntityDB };
