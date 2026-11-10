// Starter snippets per grammar id. Anything without an entry starts empty;
// paste your own code in.

export const SAMPLES: Record<string, string> = {
	markdown: `# Injection test

Markdown with **strong**, _emphasis_, \`inline code\` and a [link](https://example.com).

\`\`\`js
// injected javascript
const greet = (name) => \`hello, \${name}!\`;
console.log(greet("world"), 42);
\`\`\`

\`\`\`rust
fn main() {
    let xs: Vec<u32> = (1..=3).collect();
    println!("{:?}", xs);
}
\`\`\`

\`\`\`html
<style>.box { color: red; }</style>
<script>document.title = "nested";</script>
\`\`\`

- [ ] unchecked
- [x] checked
`,
	javascript: `import { readFile } from "node:fs/promises";

/** Count the lines in a file. */
export async function countLines(path) {
	const text = await readFile(path, "utf8");
	return text.split(/\\r?\\n/).length;
}

class Counter extends EventTarget {
	#n = 0;
	increment(by = 1) {
		this.#n += by;
		return this.#n > 10 ? null : this.#n;
	}
}

const re = /[a-z]+\\d*/gi;
const tpl = \`value: \${new Counter().increment()}\`;
`,
	typescript: `type Shape =
	| { kind: "circle"; radius: number }
	| { kind: "rect"; width: number; height: number };

export function area(s: Shape): number {
	switch (s.kind) {
		case "circle":
			return Math.PI * s.radius ** 2;
		case "rect":
			return s.width * s.height;
	}
}

interface Repo<T extends { id: string }> {
	get(id: string): Promise<T | undefined>;
	readonly size: number;
}

enum Color { Red, Green = "green" }
const shapes = [] as const satisfies readonly Shape[];
`,
	tsx: `import { useState } from "react";

export function Counter({ start = 0 }: { start?: number }) {
	const [n, setN] = useState(start);
	return (
		<button className="counter" onClick={() => setN(n + 1)}>
			Clicked {n} {n === 1 ? "time" : "times"}
		</button>
	);
}
`,
	rust: `use std::collections::HashMap;

/// A word counter.
#[derive(Debug, Default)]
pub struct Counter<'a> {
    words: HashMap<&'a str, usize>,
}

impl<'a> Counter<'a> {
    pub fn add(&mut self, text: &'a str) -> &mut Self {
        for w in text.split_whitespace() {
            *self.words.entry(w).or_insert(0) += 1;
        }
        self
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut c = Counter::default();
    c.add("a b a");
    println!("{c:?} {}", 0x1f_u8 as char);
    Ok(())
}
`,
	python: `from dataclasses import dataclass
import re

@dataclass(frozen=True)
class Token:
    kind: str
    value: str

def tokenize(src: str) -> list[Token]:
    """Split src into words and numbers."""
    out = []
    for m in re.finditer(r"\\d+|\\w+", src):
        kind = "num" if m.group().isdigit() else "word"
        out.append(Token(kind, m.group()))
    return out

if __name__ == "__main__":
    print(f"{tokenize('abc 123')!r}", None, True, 3.14)
`,
	go: `package main

import (
	"fmt"
	"strings"
)

type Greeter interface {
	Greet(name string) string
}

type english struct{}

func (english) Greet(name string) string {
	return fmt.Sprintf("Hello, %s!", strings.TrimSpace(name))
}

func main() {
	var g Greeter = english{}
	ch := make(chan int, 1)
	go func() { ch <- 42 }()
	fmt.Println(g.Greet(" gopher "), <-ch)
}
`,
	c: `#include <stdio.h>
#define MAX(a, b) ((a) > (b) ? (a) : (b))

typedef struct {
    const char *name;
    int age;
} person_t;

static int oldest(const person_t *ps, size_t n) {
    int best = 0;
    for (size_t i = 0; i < n; i++) best = MAX(best, ps[i].age);
    return best;
}

int main(void) {
    person_t ps[] = {{"ada", 36}, {"alan", 41}};
    printf("%d\\n", oldest(ps, sizeof ps / sizeof *ps));
    return 0;
}
`,
	html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Injection test</title>
    <style>
      body { font: 14px/1.4 sans-serif; color: #333; }
      .box:hover { outline: 2px solid rebeccapurple; }
    </style>
  </head>
  <body>
    <!-- a comment -->
    <div class="box" data-n="1">Hello &amp; welcome</div>
    <script>
      const el = document.querySelector(".box");
      el.addEventListener("click", () => alert(el.dataset.n));
    </script>
  </body>
</html>
`,
	css: `@import url("base.css");

:root {
  --accent: #7aa2f7;
}

.card > h2::before,
a[href^="https"]:not(.plain) {
  content: "→ ";
  margin: 0 calc(1rem + 2px);
  color: var(--accent) !important;
}

@media (max-width: 600px) {
  .card { display: none; }
}
`,
	json: `{
  "name": "arborium-rt",
  "version": "0.1.10",
  "private": true,
  "nested": { "list": [1, 2.5, -3e10, null, false] },
  "escaped": "tab\\tnewline\\n\\u00e9"
}
`,
	yaml: `# CI config
name: Build
on:
  push:
    branches: [main]
env:
  NODE_VERSION: 24
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: |
          pnpm install --frozen-lockfile
          pnpm test
anchors:
  base: &base { retries: 3, enabled: true }
  derived: *base
`,
	toml: `[package]
name = "arborium-rt"
version = "0.1.0"
edition = "2024"

[dependencies]
serde = { version = "1", features = ["derive"] }

[[bin]]
name = "demo"
path = "src/main.rs"
`,
	bash: `#!/usr/bin/env bash
set -euo pipefail

name="\${1:-world}"
for f in ./*.txt; do
  if [[ -f "$f" ]]; then
    echo "found $f" | tr a-z A-Z
  fi
done

count=$(ls | wc -l)
greet() { printf 'hello, %s (%d files)\\n' "$name" "$count"; }
greet >&2
`,
	sql: `-- monthly active users
WITH active AS (
  SELECT user_id, date_trunc('month', created_at) AS month
  FROM events
  WHERE kind = 'login' AND created_at >= NOW() - INTERVAL '1 year'
)
SELECT month, COUNT(DISTINCT user_id) AS mau
FROM active
GROUP BY month
ORDER BY month DESC
LIMIT 12;
`,
	diff: `diff --git a/src/lib.rs b/src/lib.rs
index 1a2b3c4..5d6e7f8 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,4 +1,4 @@
 fn main() {
-    println!("hello");
+    println!("hello, world");
 }
`,
	kotlin: `data class User(val name: String, val age: Int)

fun main() {
    val users = listOf(User("ada", 36), User("alan", 41))
    val oldest = users.maxByOrNull { it.age }?.name ?: "nobody"
    println("oldest: $oldest")
}
`,
};
