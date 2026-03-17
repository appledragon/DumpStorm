/*
 * DumpStorm Crash Test Program
 *
 * Generates real crash dumps for testing DumpStorm analysis features.
 * Each scenario triggers a specific kind of crash and produces a
 * minidump (.dmp) file via the cross-platform writer in minidump_writer.h.
 *
 * Build:  cmake -B build . && cmake --build build --config Debug
 * Run:    ./crash_test <scenario> [output.dmp]
 *
 * Scenarios:
 *   null_deref          Null pointer read  (SIGSEGV / ACCESS_VIOLATION)
 *   stack_overflow      Infinite recursion (STACK_OVERFLOW)
 *   divide_by_zero      Integer div-by-0   (SIGFPE  / INT_DIVIDE_BY_ZERO)
 *   illegal_instruction Undefined opcode   (SIGILL  / ILLEGAL_INSTRUCTION)
 *   abort               std::abort()       (SIGABRT / BREAKPOINT)
 *   wild_pointer        Read addr 0x42     (SIGSEGV / ACCESS_VIOLATION)
 */

#include "minidump_writer.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#ifdef _MSC_VER
#include <intrin.h>
#endif

// ============================================================================
// Crash Scenarios  (cross-platform C++20)
// ============================================================================

// 1. Null pointer dereference
[[noreturn]] void crash_null_deref() {
    volatile int* p = nullptr;
    volatile int v  = *p;          // read from NULL
    (void)v;
    std::abort();
}

// 2. Stack overflow via infinite recursion
static volatile int g_depth = 0;

static void recursive_overflow() {
    volatile char buf[4096];       // consume 4 KB per frame
    buf[0] = static_cast<char>(++g_depth);
    recursive_overflow();
    buf[1] = static_cast<char>(g_depth); // prevent tail-call opt
}

[[noreturn]] void crash_stack_overflow() {
    recursive_overflow();
    std::abort();
}

// 3. Integer division by zero
//    Note: ARM silently returns 0 on integer div-by-zero (no trap).
//    In that case we fall through to abort().
[[noreturn]] void crash_divide_by_zero() {
    volatile int num  = 42;
    volatile int zero = 0;
    volatile int res  = num / zero;
    (void)res;
    fprintf(stderr, "[crash_test] divide_by_zero: no trap (expected on ARM)\n");
    fflush(stderr);
    std::abort();
}

// 4. Illegal / undefined instruction
[[noreturn]] void crash_illegal_instruction() {
#if defined(_MSC_VER)
    #if defined(_M_X64) || defined(_M_IX86)
        __ud2();
    #else
        // ARM64 MSVC — __debugbreak() generates BKPT (STATUS_BREAKPOINT)
        __debugbreak();
    #endif
#elif defined(__GNUC__) || defined(__clang__)
    #if defined(__x86_64__) || defined(__i386__)
        __asm__ volatile("ud2");
    #elif defined(__aarch64__)
        __asm__ volatile(".inst 0x00000000");   // UDF #0
    #elif defined(__arm__)
        __asm__ volatile(".inst 0xe7f000f0");   // ARM UDF
    #endif
#endif
    std::abort(); // should not reach
}

// 5. Deliberate crash (assertion-style)
//    On Windows, std::abort() bypasses SEH in Debug CRT, so we use
//    RaiseException to ensure the minidump handler fires.
[[noreturn]] void crash_abort() {
#ifdef _WIN32
    RaiseException(0x80000003u /* STATUS_BREAKPOINT */, 0, 0, nullptr);
#else
    std::abort();
#endif
    std::abort(); // unreachable fallback
}

// 6. Wild pointer — read from small non-zero address
[[noreturn]] void crash_wild_pointer() {
    volatile int* p = reinterpret_cast<volatile int*>(
        static_cast<uintptr_t>(0x42));
    volatile int v = *p;
    (void)v;
    std::abort();
}

// ============================================================================
// Scenario table & main
// ============================================================================

struct Scenario {
    const char* name;
    const char* description;
    void (*func)();
};

static const Scenario g_scenarios[] = {
    {"null_deref",          "Null pointer dereference",         crash_null_deref},
    {"stack_overflow",      "Stack overflow (recursion)",       crash_stack_overflow},
    {"divide_by_zero",      "Integer division by zero",         crash_divide_by_zero},
    {"illegal_instruction", "Illegal CPU instruction",          crash_illegal_instruction},
    {"abort",               "Deliberate abort / assertion",     crash_abort},
    {"wild_pointer",        "Wild pointer read (addr 0x42)",    crash_wild_pointer},
};

static void print_usage(const char* prog) {
    fprintf(stderr,
        "DumpStorm Crash Test Generator\n\n"
        "Usage: %s <scenario> [output.dmp]\n\n"
        "Scenarios:\n", prog);
    for (const auto& s : g_scenarios)
        fprintf(stderr, "  %-22s  %s\n", s.name, s.description);
    fprintf(stderr,
        "\nIf output.dmp is omitted, defaults to crash_<scenario>.dmp\n");
}

int main(int argc, char* argv[]) {
    if (argc < 2) { print_usage(argv[0]); return 1; }

    const char* name = argv[1];

    const Scenario* found = nullptr;
    for (const auto& s : g_scenarios) {
        if (strcmp(name, s.name) == 0) { found = &s; break; }
    }
    if (!found) {
        fprintf(stderr, "Unknown scenario: %s\n\n", name);
        print_usage(argv[0]);
        return 1;
    }

    std::string output = (argc > 2)
        ? argv[2]
        : std::string("crash_") + name + ".dmp";

    fprintf(stderr, "[crash_test] Scenario : %s (%s)\n", found->name, found->description);
    fprintf(stderr, "[crash_test] Output   : %s\n", output.c_str());
    fflush(stderr);

    setup_crash_handler(output.c_str());

    found->func();                        // <-- will crash

    fprintf(stderr, "[crash_test] ERROR: scenario did not crash!\n");
    return 2;
}
