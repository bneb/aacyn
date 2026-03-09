---
name: run-mutation-tests
description: Run mutation testing on changed TypeScript and C code. Verify that tests catch injected faults. Target: 0 surviving mutants.
arguments:
  - name: files
    description: Specific files to mutate (default: all changed files in working tree)
    required: false
---

# /run-mutation-tests

Run mutation testing to verify test quality. Every injected fault must be caught by at least one test.

## Procedure

### 1. Identify Target Files
If `files` argument is provided, use those. Otherwise:
```bash
git diff --name-only HEAD | grep -E '\.(ts|tsx)$' | grep -v '\.test\.'
```
And for C:
```bash
git diff --name-only HEAD | grep -E '^native/.*\.(c|h)$' | grep -v test_
```

### 2. TypeScript Mutation Testing

For each changed TypeScript source file:

#### Manual Mutation (always works, no dependency needed)
Apply each mutation operator, run `cd ts && bun test`, verify at least one test fails:

| Operator | Example |
|----------|---------|
| Conditional boundary | `<` → `<=`, `>` → `>=` |
| Negate conditional | `if (x)` → `if (!x)` |
| Remove null check | Delete `if (obj == null) return` |
| Arithmetic | `+` → `-`, `*` → `/` |
| Return value | `return x` → `return null` |
| Constant | `10000` → `1`, `""` → `"INVALID"` |
| Remove statement | Delete a function call |
| Swap arguments | `fn(a, b)` → `fn(b, a)` |

Apply each mutation to the source file, run tests, verify failure, revert mutation. Do NOT commit mutations.

#### Stryker (if configured)
If `stryker.conf.js` or similar exists:
```bash
cd ts && npx stryker run --mutate "$FILES"
```

### 3. C Mutation Testing

For each changed C source file:
- Compile the test suite
- Apply one mutation to the source
- Recompile: `cd native && make test`
- Run: `./build/test_ouroboros`
- Verify: at least one test fails
- Revert mutation

| Operator | Example |
|----------|---------|
| Invert condition | `if (x > 0)` → `if (x <= 0)` |
| Off-by-one | `i < n` → `i <= n` |
| Null return | `return ptr` → `return NULL` |
| Remove bounds check | Comment out `if (offset + size > capacity) return -1` |
| Wrong constant | `198 * 1024 * 1024` → `198` |
| Remove assignment | Comment out `store->head = new_head` |

### 4. Report
```
## Mutation Test Results

### TypeScript
| File | Mutants | Killed | Survived | Score |
|------|---------|--------|----------|-------|
| [file] | N | N | N | X% |

Surviving mutants:
- [file:line]: [mutation description] — missing test for [scenario]

### C
| File | Mutants | Killed | Survived | Score |
|------|---------|--------|----------|-------|
| [file] | N | N | N | X% |

Surviving mutants:
- [file:line]: [mutation description] — missing test for [scenario]

### Overall
Mutation score: X% (target: 100%)
```

If any mutants survive, write the test that kills them before proceeding.
