import assert from "node:assert/strict";
import test from "node:test";

import {
  AT3_HUFFBITS_ERROR,
  createAt3ScxHuffTableSets,
  huffbits,
  packSpecs,
  packStoreFromMsb,
} from "../../../../src/atrac3/scx/huffman.js";

test("createAt3ScxHuffTableSets preserves representative table metadata", () => {
  const sets = createAt3ScxHuffTableSets();
  const tableA = sets.huffTablesA[0][1];
  const tableB = sets.huffTablesB[0][2];
  const tableATail = sets.huffTablesA[0][7];

  assert.deepEqual(
    {
      pairShift: tableA.pairShift,
      mode: tableA.mode,
      initWord10: tableA.initWord10,
      valueMask: tableA.valueMask,
      entrySample: Array.from(tableA.entries.slice(0, 8)),
    },
    {
      pairShift: 2,
      mode: 2,
      initWord10: 1,
      valueMask: 3,
      entrySample: [0, 1, 4, 3, 0, 0, 5, 3],
    }
  );

  assert.deepEqual(
    {
      pairShift: tableB.pairShift,
      mode: tableB.mode,
      initWord10: tableB.initWord10,
      valueMask: tableB.valueMask,
      entrySample: Array.from(tableB.entries.slice(0, 8)),
    },
    {
      pairShift: 3,
      mode: 1,
      initWord10: 1,
      valueMask: 7,
      entrySample: [0, 1, 4, 3, 6, 3, 0, 0],
    }
  );

  assert.deepEqual(
    {
      entryLength: tableATail.entries.length,
      tailSample: Array.from(tableATail.entries.slice(-8)),
    },
    {
      entryLength: 128,
      tailSample: [15, 5, 13, 5, 11, 5, 9, 5],
    }
  );
});

test("huffbits preserves current scalar and pair counting behavior", () => {
  const sets = createAt3ScxHuffTableSets();
  const pairTable = sets.huffTablesA[0][1];
  const scalarTable = sets.huffTablesB[0][2];

  assert.equal(huffbits(pairTable, Uint32Array.of(0, 1, 2, 3), 4), 3);
  assert.equal(huffbits(scalarTable, Uint32Array.of(0, 0, 1, 1), 4), 8);
  assert.equal(huffbits(pairTable, Uint32Array.of(1, 2, 3), 3), AT3_HUFFBITS_ERROR);
});

test("packStoreFromMsb and packSpecs preserve current packed output", () => {
  const sets = createAt3ScxHuffTableSets();
  const pairTable = sets.huffTablesA[0][1];
  const scalarTable = sets.huffTablesB[0][2];

  const dst = new Uint8Array(4);
  const pos = packStoreFromMsb(0b101101, 6, dst, 3);
  assert.equal(pos, 9);
  assert.deepEqual(Array.from(dst), [22, 128, 0, 0]);

  const pairDst = new Uint8Array(8);
  const pairPos = packSpecs(pairTable, Uint32Array.of(0, 1, 2, 3), 4, pairDst, 0);
  assert.equal(pairPos, 3);
  assert.deepEqual(Array.from(pairDst), [128, 0, 0, 0, 0, 0, 0, 0]);

  const scalarDst = new Uint8Array(8);
  const scalarPos = packSpecs(scalarTable, Uint32Array.of(0, 0, 1, 1), 4, scalarDst, 5);
  assert.equal(scalarPos, 13);
});

test("packSpecs rejects odd pair counts and packStoreFromMsb enforces bounds", () => {
  const sets = createAt3ScxHuffTableSets();
  const pairTable = sets.huffTablesA[0][1];

  assert.equal(packSpecs(pairTable, Uint32Array.of(1, 2, 3), 3, new Uint8Array(4), 0), -1);
  assert.throws(() => packStoreFromMsb(0xff, 16, new Uint8Array(1), 0), /wrote past dst bounds/);
});

test("huffbits and packSpecs preserve invalid-table sentinels", () => {
  const invalidTable = {
    pairShift: 0,
    mode: 99,
    initWord10: 0,
    valueMask: 0,
    entries: new Uint32Array(0),
  };

  assert.equal(huffbits(invalidTable, Uint32Array.of(0), 1), AT3_HUFFBITS_ERROR);
  assert.equal(packSpecs(invalidTable, Uint32Array.of(0), 1, new Uint8Array(1), 0), -1);
});

test("huffbits and packSpecs reject truncated entry tables", () => {
  const table = {
    pairShift: 0,
    mode: 1,
    initWord10: 0,
    valueMask: 1,
    entries: Uint32Array.of(0),
  };

  assert.equal(huffbits(table, Uint32Array.of(1), 1), AT3_HUFFBITS_ERROR);
  assert.equal(packSpecs(table, Uint32Array.of(1), 1, new Uint8Array(1), 0), -1);
});
