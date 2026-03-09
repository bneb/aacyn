---
name: run-c-tests
description: Compile and run the native C test suite with multiple configurations (standard, sanitize, eBPF). Use when C code in native/ changes.
---

# /run-c-tests

Run the native C test suite across all relevant configurations.

## Procedure

### 1. Standard Test Suite
```bash
cd native && make clean && make test
```
Expected: 14 tests pass. Any failure is a regression.

### 2. Sanitizer Build (if on Linux or macOS with ASan support)
```bash
cd native && make clean && make sanitize
```
Runs under AddressSanitizer + UndefinedBehaviorSanitizer. Expected: clean exit, no reports.

### 3. eBPF Build (if on Linux with libbpf-dev)
```bash
cd native && make clean && EBPF=1 make
```
Verifies that eBPF probe code compiles. Does not load into kernel (requires root).

### 4. Platform Coverage
If on macOS (ARM64), also verify NEON SIMD path is exercised by the tests.
If on Linux (x86_64), verify AVX-512 path is exercised.

### 5. Report
```
## C Test Results

| Configuration | Tests | Pass | Fail | Notes |
|---------------|-------|------|------|-------|
| Standard      | 14    | 14   | 0    |       |
| ASan/UBSan    | 14    | 14   | 0    |       |
| eBPF build    | N/A   | N/A  | N/A  | [compiles/fails/not available] |

SIMD path exercised: [NEON/AVX-512/AVX2/scalar]
Overall: [PASS/FAIL]
```

If any configuration fails, diagnose and report the root cause before attempting to fix.
