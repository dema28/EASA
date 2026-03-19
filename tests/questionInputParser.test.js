import test from "node:test";
import assert from "node:assert/strict";
import { parseQuestionBlocks, normalizeOptionText } from "../public/questionInputParser.js";

test("parseQuestionBlocks: parses single 6-line block and '+' correct marker", () => {
  const input = [
    "Q1",
    "What is 2+2?",
    "+ A) 3",
    "B) 4",
    "C) 5",
    "D) 6",
  ].join("\n");

  const out = parseQuestionBlocks(input);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "Q1");
  assert.equal(out[0].question, "What is 2+2?");
  assert.equal(out[0].correct, "A");
});

test("parseQuestionBlocks: supports multiple blocks", () => {
  const input = [
    "Q1",
    "What is 2+2?",
    "+ A) 3",
    "B) 4",
    "C) 5",
    "D) 6",
    "Q2",
    "What is 3+3?",
    "A) 5",
    "+ B) 6",
    "C) 7",
    "D) 8",
  ].join("\n");

  const out = parseQuestionBlocks(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].correct, "A");
  assert.equal(out[1].correct, "B");
});

test("parseQuestionBlocks: rejects incomplete block", () => {
  assert.throws(() => parseQuestionBlocks(["Q1", "Q?", "A", "B"].join("\n")), /Неполный|6 строк/i);
});

test("normalizeOptionText: removes leading ABCD markers", () => {
  assert.equal(normalizeOptionText("A)   Hello"), "Hello");
  assert.equal(normalizeOptionText(" b  ) World "), "World");
});

