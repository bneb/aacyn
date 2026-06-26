# libaacyn — Native Columnar Store + eBPF Probes
#
# Build:
#   make              → macOS ARM (NEON, FlatBuffer reader, eBPF stubs)
#   make              → Linux x86 (auto-detect AVX-512 via -march=native)
#   make EBPF=1       → Linux x86 + eBPF probe compilation (requires libbpf-dev)
#   make clean        → Remove build artifacts
#
# Output:
#   build/libaacyn.dylib      (macOS)
#   build/libaacyn.so          (Linux)
#   build/aacyn_probes.bpf.o   (Linux + EBPF=1 only)

CC       := cc
CFLAGS   := -O3 -Wall -Wextra -Wpedantic -fPIC -std=c17
SRC      := libaacyn.c
BUILD    := ../build

# Platform detection
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

# ─── Platform-Specific Configuration ─────────────────────────────────────────

ifeq ($(UNAME_S),Darwin)
  # ── macOS: NEON intrinsics, no eBPF ────────────────────────────────────────
  TARGET   := $(BUILD)/libaacyn.dylib
  LDFLAGS  := -dynamiclib
  CFLAGS   += -march=native
  BPF_TARGET :=

else ifeq ($(UNAME_S),Linux)
  # ── Linux: AVX-512 + optional eBPF ────────────────────────────────────────

  TARGET   := $(BUILD)/libaacyn.so
  LDFLAGS  := -shared

  # Portable baseline: AVX2 (universal on x86_64 from 2013+)
  # For local benchmarks with AVX-512: make NATIVE=1
  ifeq ($(UNAME_M),x86_64)
    ifdef NATIVE
      CFLAGS += -march=native
    else
      CFLAGS += -march=x86-64-v3
    endif
  else
    CFLAGS += -march=armv8-a+crc
  endif

  # eBPF probe compilation (requires: libbpf-dev libelf-dev)
  ifdef EBPF
    BPF_TARGET := $(BUILD)/aacyn_probes.bpf.o $(BUILD)/aacyn_auto.bpf.o
    CFLAGS     += -DAACYN_HAS_LIBBPF
    LDLIBS     := -lbpf -lelf -lz
  else
    BPF_TARGET :=
    LDLIBS     :=
  endif

else
  # ── Unknown platform ──────────────────────────────────────────────────────
  TARGET   := $(BUILD)/libaacyn.so
  LDFLAGS  := -shared
  CFLAGS   += -march=native
  BPF_TARGET :=
  LDLIBS   :=
endif

# ─── Targets ─────────────────────────────────────────────────────────────────

.PHONY: all clean test sanitize fuzz benchmark coverage

# TARGET_ONLY=1 builds just the shared library (no BPF object)
ifdef TARGET_ONLY
all: $(BUILD) $(TARGET)
else
all: $(BUILD) $(TARGET) $(BPF_TARGET)
endif
	@echo ""
	@echo "╔══════════════════════════════════════════════════════╗"
	@echo "║  ✓ libaacyn build complete                          ║"
	@echo "╠══════════════════════════════════════════════════════╣"
	@echo "║  Platform: $(UNAME_S)/$(UNAME_M)"
	@echo "║  Library:  $(TARGET)"
	@echo "║  CFLAGS:   $(CFLAGS)"
ifdef BPF_TARGET
	@echo "║  eBPF:     $(BPF_TARGET)"
else
	@echo "║  eBPF:     disabled (set EBPF=1 on Linux to enable)"
endif
	@echo "╚══════════════════════════════════════════════════════╝"
	@file $(TARGET)

$(BUILD):
	mkdir -p $(BUILD)

# ─── Shared Library ──────────────────────────────────────────────────────────
# CRITICAL: LDLIBS (-lbpf -lelf -lz) MUST come AFTER the source file ($<).
# GCC reads left-to-right; placing -lbpf before the .c file causes the linker
# to discard libbpf symbols before it sees the code that references them.

$(TARGET): $(SRC) | $(BUILD)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $< $(LDLIBS)

# ─── eBPF BPF Object (Linux only, requires clang + libbpf-dev) ───────────────
#
# Compiles the BPF C code into a BPF object file that can be loaded at runtime
# via bpf_object__open_file() in the user-space libaacyn.so.
#
# Prerequisites:
#   apt install -y clang llvm libbpf-dev linux-headers-$(uname -r)
#   bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h

$(BUILD)/aacyn_probes.bpf.o: aacyn_probes.bpf.c | $(BUILD)
	clang \
		-target bpf \
		$(if $(filter aarch64,$(UNAME_M)),-D__TARGET_ARCH_arm64,-D__TARGET_ARCH_x86) \
		-I/usr/include/$(shell uname -m)-linux-gnu \
		-O2 -g \
		-mllvm -bpf-stack-size=4096 \
		-c $< -o $@
	@echo "✓ BPF object compiled: $@"

$(BUILD)/aacyn_auto.bpf.o: aacyn_auto.bpf.c | $(BUILD)
	clang \
		-target bpf \
		$(if $(filter aarch64,$(UNAME_M)),-D__TARGET_ARCH_arm64,-D__TARGET_ARCH_x86) \
		-I/usr/include/$(shell uname -m)-linux-gnu \
		-O2 -g \
		-mllvm -bpf-stack-size=4096 \
		-c $< -o $@
	@echo "✓ Auto-discovery BPF object compiled: $@"

# ─── Test Suite ──────────────────────────────────────────────────────────────
# Compiles test_ouroboros.c + libaacyn.c as a standalone binary (not shared lib).
# Links statically — no dlopen needed. Runs all ring-buffer tests.

TEST_BIN := $(BUILD)/test_ouroboros
TEST_SRC := test_ouroboros.c

# For test builds, we compile libaacyn.c directly into the test binary
# (not as a shared library). We strip eBPF symbols on macOS via stubs.
TEST_CFLAGS := -O2 -Wall -Wextra -std=c17 -march=native -DAACYN_TEST

test: $(BUILD) $(TEST_BIN)
	@echo ""
	@echo "Running Ouroboros ring-buffer tests..."
	@echo ""
	@$(TEST_BIN)

$(TEST_BIN): $(TEST_SRC) $(SRC) | $(BUILD)
	$(CC) $(TEST_CFLAGS) -o $@ $(TEST_SRC) $(SRC)

# ─── Benchmark --------------------------------------------------------------

BENCH_BIN := $(BUILD)/benchmark_ouroboros
BENCH_SRC := benchmark_ouroboros.c

benchmark: $(BUILD) $(BENCH_BIN)
	@echo ""
	@echo "Running Ouroboros benchmark..."
	@echo ""
	@$(BENCH_BIN)

$(BENCH_BIN): $(BENCH_SRC) $(SRC) | $(BUILD)
	$(CC) -O3 -march=native -Wall -Wextra -std=c17 -o $@ $(BENCH_SRC) $(SRC)

# ─── Sanitize Build (ASan + UBSan) ──────────────────────────────────────────
# Compiles the test binary with AddressSanitizer and UndefinedBehaviorSanitizer.
# Run it to detect memory errors and undefined behavior.
# Requires: clang (or gcc with -fsanitize support)

SANITIZE_CFLAGS := -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
                   -Wall -Wextra -std=c17 -march=native -DAACYN_TEST

SANITIZE_BIN := $(BUILD)/test_ouroboros_sanitize
SANITIZE_SRC := test_ouroboros.c

sanitize: $(BUILD) $(SANITIZE_BIN)
	@echo ""
	@echo "Running Ouroboros ring-buffer tests with ASan+UBSan..."
	@echo ""
	@$(SANITIZE_BIN)

$(SANITIZE_BIN): $(SANITIZE_SRC) $(SRC) | $(BUILD)
	$(CC) $(SANITIZE_CFLAGS) -o $@ $(SANITIZE_SRC) $(SRC)

# ─── Fuzz Harness -----------------------------------------------------------
# Compiles the fuzz harness (requires clang for best ASan support).
# Runs for FUZZ_DURATION seconds (default: 60).
# The fuzzer creates stores, inserts random events, runs scans, and tests
# edge cases to find crashes and assertion failures.

FUZZ_DURATION ?= 60
FUZZ_CFLAGS := -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
               -Wall -Wextra -std=c17 -march=native -DAACYN_TEST -lm

FUZZ_BIN := $(BUILD)/fuzz_ouroboros
FUZZ_SRC := fuzz_ouroboros.c

fuzz: $(BUILD) $(FUZZ_BIN)
	@echo ""
	@echo "Running Ouroboros fuzz harness ($(FUZZ_DURATION)s)..."
	@echo ""
	@$(FUZZ_BIN) $(FUZZ_DURATION)

$(FUZZ_BIN): $(FUZZ_SRC) $(SRC) | $(BUILD)
	$(CC) $(FUZZ_CFLAGS) -o $@ $(FUZZ_SRC) $(SRC)

# ─── Coverage Build ──────────────────────────────────────────────────────────
# Builds test binary with code coverage instrumentation and reports line coverage.
# Uses Clang source-based coverage on macOS and GCC gcov-style on Linux.
#
# Usage:
#   make -C native coverage          → measure coverage using the default compiler
#
# Prerequisites:
#   Linux:  gcc + gcov   (bundled with GCC)
#   macOS:  Xcode CLT    (llvm-profdata, llvm-cov, provides gcov alias)

COVERAGE_BIN := $(BUILD)/test_ouroboros_coverage

# Detect the compiler family to select appropriate coverage flags and tools
CC_IS_CLANG := $(shell $(CC) --version 2>/dev/null | head -1 | grep -qi "clang" && echo 1 || echo 0)

ifeq ($(CC_IS_CLANG),1)
# ── Clang / LLVM (macOS): source-based code coverage ──────────────────────

$(COVERAGE_BIN): $(TEST_SRC) $(SRC) | $(BUILD)
	$(CC) -fprofile-instr-generate -fcoverage-mapping \
	  -O1 -g -Wall -Wextra -std=c17 -march=native -DAACYN_TEST \
	  -o $@ $(TEST_SRC) $(SRC)

coverage: $(BUILD) $(COVERAGE_BIN)
	@echo ""
	@echo "Running Ouroboros tests with code coverage (Clang)..."
	@echo ""
	LLVM_PROFILE_FILE="$(BUILD)/test_ouroboros_coverage.profraw" $(COVERAGE_BIN)
	xcrun llvm-profdata merge -sparse "$(BUILD)/test_ouroboros_coverage.profraw" \
	  -o "$(BUILD)/test_ouroboros_coverage.profdata"
	@echo ""
	@echo "=== Coverage Report ==="
	xcrun llvm-cov report "$(COVERAGE_BIN)" \
	  -instr-profile="$(BUILD)/test_ouroboros_coverage.profdata" libaacyn.c

else
# ── GCC (Linux): gcov-style coverage ─────────────────────────────────────

$(COVERAGE_BIN): $(TEST_SRC) $(SRC) | $(BUILD)
	$(CC) --coverage -O1 -g -Wall -Wextra -std=c17 -march=native -DAACYN_TEST \
	  -o $@ $(TEST_SRC) $(SRC)

coverage: $(BUILD) $(COVERAGE_BIN)
	@echo ""
	@echo "Running Ouroboros tests with code coverage (GCC)..."
	@echo ""
	$(COVERAGE_BIN)
	gcov libaacyn.c
	@echo ""
	@echo "=== Coverage Report ==="
	@grep -E "Lines executed:" libaacyn.c.gcov || true

endif

# ─── Cleanup ─────────────────────────────────────────────────────────────────

clean:
	rm -f $(BUILD)/libaacyn.* $(BUILD)/aacyn_probes.bpf.o \
	      $(BUILD)/aacyn_auto.bpf.o \
	      $(BUILD)/test_ouroboros $(BUILD)/benchmark_ouroboros \
	      $(BUILD)/test_ouroboros_sanitize $(BUILD)/fuzz_ouroboros \
	      $(BUILD)/test_ouroboros_coverage
	rm -f $(BUILD)/*.profraw $(BUILD)/*.profdata
	rm -f *.gcda *.gcno *.gcov
