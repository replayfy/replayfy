import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FrameSplitter,
  frameTs,
  splitFrames,
} from "../src/frames/frames-codec";
import { frame, frames } from "./helpers";

describe("frames codec", () => {
  it("splits a batch into whole records and drops a truncated tail", () => {
    const raw = Buffer.concat([frames(10, 20, 30), frame(40).subarray(0, 15)]);
    const records = splitFrames(raw);
    assert.deepEqual(records.map(frameTs), [10, 20, 30]);
    assert.ok(records[1].equals(frame(20)));
  });

  it("reassembles records across arbitrary chunk edges", () => {
    const raw = Buffer.concat([frame(1, 5), frame(2, 300), frame(3, 0), frame(4, 40)]);
    for (const size of [1, 3, 11, 12, 13, 64, raw.length]) {
      const splitter = new FrameSplitter();
      const out: Buffer[] = [];
      for (let i = 0; i < raw.length; i += size) {
        out.push(...splitter.push(raw.subarray(i, i + size)));
      }
      assert.deepEqual(out.map(frameTs), [1, 2, 3, 4], `chunk ${size}`);
      assert.ok(Buffer.concat(out).equals(raw), `chunk ${size} bytes`);
    }
  });
});
