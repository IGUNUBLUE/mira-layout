import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgArgs, parseRg, buildRegex, replaceLines } from "../mods/mira-search/search.js";

test("rgArgs maps the options", () => {
  assert.ok(rgArgs("x").includes("--ignore-case") && rgArgs("x").includes("--fixed-strings"));
  const a = rgArgs("x", { matchCase: true, word: true, regex: true });
  assert.ok(a.includes("--case-sensitive") && a.includes("--word-regexp") && !a.includes("--fixed-strings"));
  assert.deepEqual(a.slice(-3), ["--", "x", "."]);
});

test("parseRg on real ripgrep output, respecting .gitignore and unicode offsets", () => {
  const dir = mkdtempSync(join(tmpdir(), "mira-rg-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "a.txt"), "héllo needle\nno\nneedle and NEEDLE\n");
    writeFileSync(join(dir, "ignored.txt"), "needle\n");
    const out = execFileSync("rg", rgArgs("needle"), { cwd: dir, encoding: "utf8" });
    const r = parseRg(out);
    assert.deepEqual(r.files.map((f) => f.path), ["a.txt"]);
    const [first, second] = r.files[0].matches;
    assert.equal(first.line, 1);
    assert.deepEqual(first.ranges, [[6, 12]]);
    assert.equal(first.text.slice(6, 12), "needle");
    assert.equal(second.ranges.length, 2);
    assert.equal(r.count, 3);
    assert.equal(parseRg(out, 1).truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("replaceLines touches only the listed lines, literal vs regex", () => {
  const src = "a foo\r\nfoo foo\nbar foo\n";
  const lit = replaceLines(src, [2], buildRegex("foo"), "$1x");
  assert.equal(lit.text, "a foo\r\n$1x $1x\nbar foo\n");
  assert.equal(lit.count, 2);
  const rx = replaceLines(src, [1, 3], buildRegex("(f)oo", { regex: true }), "$1u", { regex: true });
  assert.equal(rx.text, "a fu\r\nfoo foo\nbar fu\n");
  const word = replaceLines("foo food\n", [1], buildRegex("foo", { word: true }), "X");
  assert.equal(word.text, "X food\n");
  const cased = replaceLines("Foo foo\n", [1], buildRegex("foo", { matchCase: true }), "X");
  assert.equal(cased.text, "Foo X\n");
  assert.throws(() => buildRegex("(", { regex: true }));
});
