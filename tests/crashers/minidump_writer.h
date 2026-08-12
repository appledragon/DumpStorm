#pragma once
/*
 * Cross-platform minidump writer for DumpStorm crash test programs.
 *
 * Windows : Uses DbgHelp MiniDumpWriteDump (high-quality, no extra deps).
 * Linux   : Custom signal-handler writer producing a valid MDMP file with
 *           SystemInfo, Exception, ThreadList (context + stack), and ModuleList.
 * macOS   : Same approach using Mach register accessors and _dyld APIs.
 *
 * Usage:
 *   setup_crash_handler("output.dmp");
 *   // ... code that will crash ...
 *
 * All POSIX code is async-signal-safe (uses only write/open/close/lseek/_exit).
 */

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

// ============================================================================
// Platform & Architecture Detection
// ============================================================================

#if defined(__x86_64__) || defined(_M_X64)
    #define MDMP_ARCH_AMD64
    static constexpr uint16_t MDMP_PROCESSOR_ARCH   = 9;
    static constexpr uint32_t MDMP_CONTEXT_SIZE      = 1232;
    static constexpr uint32_t MDMP_CONTEXT_FLAGS_VAL = 0x0010000Bu; // AMD64 FULL
#elif defined(__aarch64__) || defined(_M_ARM64)
    #define MDMP_ARCH_ARM64
    static constexpr uint16_t MDMP_PROCESSOR_ARCH   = 12;
    static constexpr uint32_t MDMP_CONTEXT_SIZE      = 912;  // MDRawContextARM64
    static constexpr uint32_t MDMP_CONTEXT_FLAGS_VAL = 0x00400007u; // ARM64 FULL
#elif defined(__i386__) || defined(_M_IX86)
    #define MDMP_ARCH_X86
    static constexpr uint16_t MDMP_PROCESSOR_ARCH   = 0;
    static constexpr uint32_t MDMP_CONTEXT_SIZE      = 716;
    static constexpr uint32_t MDMP_CONTEXT_FLAGS_VAL = 0x0001003Fu; // X86 FULL
#else
    #error "Unsupported architecture for minidump writer"
#endif

// ============================================================================
// Windows Implementation (DbgHelp)
// ============================================================================

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <dbghelp.h>
#pragma comment(lib, "dbghelp.lib")

static char g_dump_path[MAX_PATH] = {};

static LONG WINAPI crash_exception_filter(EXCEPTION_POINTERS* ep) {
    HANDLE hFile = CreateFileA(g_dump_path, GENERIC_WRITE, 0, nullptr,
                               CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile != INVALID_HANDLE_VALUE) {
        MINIDUMP_EXCEPTION_INFORMATION mei = {};
        mei.ThreadId          = GetCurrentThreadId();
        mei.ExceptionPointers = ep;
        mei.ClientPointers    = FALSE;

        MiniDumpWriteDump(
            GetCurrentProcess(), GetCurrentProcessId(), hFile,
            static_cast<MINIDUMP_TYPE>(MiniDumpNormal | MiniDumpWithThreadInfo),
            &mei, nullptr, nullptr
        );
        CloseHandle(hFile);
    }
    return EXCEPTION_EXECUTE_HANDLER;
}

inline void setup_crash_handler(const char* output_path) {
    strncpy_s(g_dump_path, output_path, MAX_PATH - 1);
    // Reserve stack for handling stack-overflow exceptions
    ULONG guarantee = 32768;
    SetThreadStackGuarantee(&guarantee);
    SetUnhandledExceptionFilter(crash_exception_filter);
}

#else
// ============================================================================
// POSIX Implementation (Linux / macOS)
// ============================================================================

#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/types.h>

#ifdef __linux__
    #include <ucontext.h>
#elif defined(__APPLE__)
    #include <sys/ucontext.h>
    #include <mach-o/dyld.h>
#endif

// ── Register-context byte offsets (must match breakpad MDRawContext*) ────────

#ifdef MDMP_ARCH_AMD64
namespace ctx_off {
    static constexpr size_t FLAGS  = 0x30;
    static constexpr size_t EFLAGS = 0x44;
    static constexpr size_t RAX = 0x78, RCX = 0x80, RDX = 0x88, RBX = 0x90;
    static constexpr size_t RSP = 0x98, RBP = 0xA0, RSI = 0xA8, RDI = 0xB0;
    static constexpr size_t R8  = 0xB8, R9  = 0xC0, R10 = 0xC8, R11 = 0xD0;
    static constexpr size_t R12 = 0xD8, R13 = 0xE0, R14 = 0xE8, R15 = 0xF0;
    static constexpr size_t RIP = 0xF8;
}
#elif defined(MDMP_ARCH_ARM64)
namespace ctx_off {
    // MDRawContextARM64 layout: context_flags + x0..x32 (PC).
    static constexpr size_t FLAGS = 0;          // uint64_t context_flags
    static constexpr size_t X0    = 8;          // iregs[0..31]  (x0-x30, sp)
    static constexpr size_t FP    = 8 + 29*8;   // x29
    static constexpr size_t LR    = 8 + 30*8;   // x30
    static constexpr size_t SP    = 8 + 31*8;   // sp = iregs[31]
    static constexpr size_t PC    = 264;
    static constexpr size_t CPSR  = 272;        // uint32_t
}
#elif defined(MDMP_ARCH_X86)
namespace ctx_off {
    static constexpr size_t FLAGS  = 0;
    static constexpr size_t EDI = 156, ESI = 160, EBX = 164, EDX = 168;
    static constexpr size_t ECX = 172, EAX = 176, EBP = 180, EIP = 184;
    static constexpr size_t EFLAGS = 192, ESP = 196;
}
#endif

// ── Global state (written at setup, read-only in signal handler) ────────────

static constexpr int    MAX_MODULES   = 128;
static constexpr int    MAX_PATH_LEN  = 256;
static constexpr uint32_t STACK_CAPTURE = 32768; // 32 KB

struct ModuleEntry {
    uint64_t base;
    uint64_t size;
    char     name[MAX_PATH_LEN];
};

static char        g_dump_path[512]          = {};
static ModuleEntry g_modules[MAX_MODULES]    = {};
static int         g_module_count            = 0;

// ── Module scanning (called once at setup) ──────────────────────────────────

#ifdef __linux__
static void scan_modules() {
    int fd = open("/proc/self/maps", O_RDONLY);
    if (fd < 0) return;

    char buf[16384];
    ssize_t total = 0;
    for (;;) {
        ssize_t n = read(fd, buf + total, sizeof(buf) - 1 - total);
        if (n <= 0) break;
        total += n;
        if (total >= static_cast<ssize_t>(sizeof(buf) - 1)) break;
    }
    close(fd);
    if (total <= 0) return;
    buf[total] = '\0';

    char* line = buf;
    while (line && *line && g_module_count < MAX_MODULES) {
        char* next = strchr(line, '\n');
        if (next) *next = '\0';

        unsigned long start = 0, end = 0, offset = 0;
        char perms[8] = {}, path[MAX_PATH_LEN] = {};

        if (sscanf(line, "%lx-%lx %7s %lx %*s %*s %255s",
                   &start, &end, perms, &offset, path) >= 5 &&
            offset == 0 && path[0] == '/')
        {
            bool dup = false;
            for (int i = 0; i < g_module_count; i++) {
                if (g_modules[i].base == static_cast<uint64_t>(start)) {
                    dup = true; break;
                }
            }
            if (!dup) {
                g_modules[g_module_count].base = start;
                g_modules[g_module_count].size = end - start;
                strncpy(g_modules[g_module_count].name, path, MAX_PATH_LEN - 1);
                g_module_count++;
            }
        }
        line = next ? next + 1 : nullptr;
    }
}

#elif defined(__APPLE__)
static void scan_modules() {
    uint32_t count = _dyld_image_count();
    for (uint32_t i = 0; i < count && g_module_count < MAX_MODULES; i++) {
        const char* name = _dyld_get_image_name(i);
        const struct mach_header* hdr = _dyld_get_image_header(i);
        if (name && hdr) {
            g_modules[g_module_count].base = reinterpret_cast<uint64_t>(hdr);
            g_modules[g_module_count].size = 0x100000; // approximate 1 MB
            strncpy(g_modules[g_module_count].name, name, MAX_PATH_LEN - 1);
            g_module_count++;
        }
    }
}

#else
static void scan_modules() { /* no-op */ }
#endif

// ── Async-signal-safe write helpers ─────────────────────────────────────────

static inline void wr(int fd, const void* data, size_t len) {
    const char* p = static_cast<const char*>(data);
    while (len > 0) {
        ssize_t n = write(fd, p, len);
        if (n <= 0) break;
        p   += static_cast<size_t>(n);
        len -= static_cast<size_t>(n);
    }
}
static inline void wr_u16(int fd, uint16_t v) { wr(fd, &v, 2); }
static inline void wr_u32(int fd, uint32_t v) { wr(fd, &v, 4); }
static inline void wr_u64(int fd, uint64_t v) { wr(fd, &v, 8); }
static inline void wr_zeros(int fd, size_t n) {
    char z[64] = {};
    while (n > 0) {
        size_t chunk = n < sizeof(z) ? n : sizeof(z);
        wr(fd, z, chunk);
        n -= chunk;
    }
}

// ── Fill CPU-register context buffer from ucontext ──────────────────────────

static void fill_context(uint8_t* ctx, const ucontext_t* uc) {
    memset(ctx, 0, MDMP_CONTEXT_SIZE);
    auto set32 = [&](size_t off, uint32_t v) { memcpy(ctx + off, &v, 4); };
    auto set64 = [&](size_t off, uint64_t v) { memcpy(ctx + off, &v, 8); };

#if defined(__linux__) && defined(MDMP_ARCH_AMD64)
    const auto& g = uc->uc_mcontext.gregs;
    set32(ctx_off::FLAGS, MDMP_CONTEXT_FLAGS_VAL);
    set32(ctx_off::EFLAGS, static_cast<uint32_t>(g[REG_EFL]));
    set64(ctx_off::RAX, g[REG_RAX]); set64(ctx_off::RBX, g[REG_RBX]);
    set64(ctx_off::RCX, g[REG_RCX]); set64(ctx_off::RDX, g[REG_RDX]);
    set64(ctx_off::RSI, g[REG_RSI]); set64(ctx_off::RDI, g[REG_RDI]);
    set64(ctx_off::RBP, g[REG_RBP]); set64(ctx_off::RSP, g[REG_RSP]);
    set64(ctx_off::R8,  g[REG_R8]);  set64(ctx_off::R9,  g[REG_R9]);
    set64(ctx_off::R10, g[REG_R10]); set64(ctx_off::R11, g[REG_R11]);
    set64(ctx_off::R12, g[REG_R12]); set64(ctx_off::R13, g[REG_R13]);
    set64(ctx_off::R14, g[REG_R14]); set64(ctx_off::R15, g[REG_R15]);
    set64(ctx_off::RIP, g[REG_RIP]);

#elif defined(__APPLE__) && defined(MDMP_ARCH_AMD64)
    const auto& ss = uc->uc_mcontext->__ss;
    set32(ctx_off::FLAGS, MDMP_CONTEXT_FLAGS_VAL);
    set32(ctx_off::EFLAGS, static_cast<uint32_t>(ss.__rflags));
    set64(ctx_off::RAX, ss.__rax); set64(ctx_off::RBX, ss.__rbx);
    set64(ctx_off::RCX, ss.__rcx); set64(ctx_off::RDX, ss.__rdx);
    set64(ctx_off::RSI, ss.__rsi); set64(ctx_off::RDI, ss.__rdi);
    set64(ctx_off::RBP, ss.__rbp); set64(ctx_off::RSP, ss.__rsp);
    set64(ctx_off::R8,  ss.__r8);  set64(ctx_off::R9,  ss.__r9);
    set64(ctx_off::R10, ss.__r10); set64(ctx_off::R11, ss.__r11);
    set64(ctx_off::R12, ss.__r12); set64(ctx_off::R13, ss.__r13);
    set64(ctx_off::R14, ss.__r14); set64(ctx_off::R15, ss.__r15);
    set64(ctx_off::RIP, ss.__rip);

#elif defined(__linux__) && defined(MDMP_ARCH_ARM64)
    set64(ctx_off::FLAGS, static_cast<uint64_t>(MDMP_CONTEXT_FLAGS_VAL));
    for (int i = 0; i <= 28; i++)
        set64(ctx_off::X0 + i * 8, uc->uc_mcontext.regs[i]);
    set64(ctx_off::FP, uc->uc_mcontext.regs[29]);
    set64(ctx_off::LR, uc->uc_mcontext.regs[30]);
    set64(ctx_off::SP, uc->uc_mcontext.sp);
    set64(ctx_off::PC, uc->uc_mcontext.pc);
    set32(ctx_off::CPSR, static_cast<uint32_t>(uc->uc_mcontext.pstate));

#elif defined(__APPLE__) && defined(MDMP_ARCH_ARM64)
    const auto& ss = uc->uc_mcontext->__ss;
    set64(ctx_off::FLAGS, static_cast<uint64_t>(MDMP_CONTEXT_FLAGS_VAL));
    for (int i = 0; i <= 28; i++)
        set64(ctx_off::X0 + i * 8, ss.__x[i]);
    set64(ctx_off::FP, ss.__fp);
    set64(ctx_off::LR, ss.__lr);
    set64(ctx_off::SP, ss.__sp);
    set64(ctx_off::PC, ss.__pc);
    set32(ctx_off::CPSR, ss.__cpsr);
#endif
}

// ── Get SP / IP from ucontext ───────────────────────────────────────────────

static inline uint64_t get_sp(const ucontext_t* uc) {
#if   defined(__linux__) && defined(MDMP_ARCH_AMD64)
    return static_cast<uint64_t>(uc->uc_mcontext.gregs[REG_RSP]);
#elif defined(__APPLE__) && defined(MDMP_ARCH_AMD64)
    return uc->uc_mcontext->__ss.__rsp;
#elif defined(__linux__) && defined(MDMP_ARCH_ARM64)
    return uc->uc_mcontext.sp;
#elif defined(__APPLE__) && defined(MDMP_ARCH_ARM64)
    return uc->uc_mcontext->__ss.__sp;
#else
    (void)uc; return 0;
#endif
}

static inline uint64_t get_ip(const ucontext_t* uc) {
#if   defined(__linux__) && defined(MDMP_ARCH_AMD64)
    return static_cast<uint64_t>(uc->uc_mcontext.gregs[REG_RIP]);
#elif defined(__APPLE__) && defined(MDMP_ARCH_AMD64)
    return uc->uc_mcontext->__ss.__rip;
#elif defined(__linux__) && defined(MDMP_ARCH_ARM64)
    return uc->uc_mcontext.pc;
#elif defined(__APPLE__) && defined(MDMP_ARCH_ARM64)
    return uc->uc_mcontext->__ss.__pc;
#else
    (void)uc; return 0;
#endif
}

// ── Platform ID for SystemInfoStream ────────────────────────────────────────

static inline uint32_t get_platform_id() {
#ifdef __linux__
    return 0x8201u; // MD_OS_LINUX
#elif defined(__APPLE__)
    return 0x8101u; // MD_OS_MAC_OS_X
#else
    return 0x8000u; // MD_OS_UNIX
#endif
}

// ── Signal handler: writes a minimal but valid MDMP file ────────────────────

static void crash_signal_handler(int sig, siginfo_t* si, void* context) {
    auto* uc = static_cast<ucontext_t*>(context);

    int fd = open(g_dump_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) _exit(128 + sig);

    const bool   has_modules = (g_module_count > 0);
    const uint32_t num_streams = has_modules ? 4u : 3u;

    // ── Pre-compute every section offset ────────────────────────────────
    uint32_t cur = 0;

    const uint32_t hdr_off    = cur;  cur += 32;                        // Header
    const uint32_t dir_off    = cur;  cur += num_streams * 12;          // Directory
    const uint32_t sys_off    = cur;  cur += 56;                        // SystemInfo
    const uint32_t csd_off    = cur;  cur += 4;                         // CSD string (empty)
    const uint32_t exc_off    = cur;  cur += 168;                       // ExceptionStream
    const uint32_t tl_off     = cur;  cur += 4 + 48;                    // ThreadList (1 thread)
    const uint32_t ctx_off_v  = cur;  cur += MDMP_CONTEXT_SIZE;         // Context blob
    const uint32_t stk_off    = cur;  cur += STACK_CAPTURE;             // Stack memory

    uint32_t ml_off = 0;
    if (has_modules) {
        ml_off = cur;  cur += 4 + static_cast<uint32_t>(g_module_count) * 108;
    }

    // Module-name string RVAs
    uint32_t ms_total = 0;
    uint32_t ms_rvas[MAX_MODULES] = {};
    for (int i = 0; i < g_module_count; i++) {
        ms_rvas[i] = cur + ms_total;
        ms_total  += 4 + static_cast<uint32_t>(strlen(g_modules[i].name)) * 2;
    }

    // ── 1. Header ───────────────────────────────────────────────────────
    (void)hdr_off;
    wr_u32(fd, 0x504D444Du);                                   // Signature
    wr_u32(fd, 0x0006A793u);                                   // Version
    wr_u32(fd, num_streams);
    wr_u32(fd, dir_off);
    wr_u32(fd, 0);                                             // CheckSum
    wr_u32(fd, static_cast<uint32_t>(time(nullptr)));
    wr_u64(fd, 0);                                             // Flags

    // ── 2. Stream Directory ─────────────────────────────────────────────
    wr_u32(fd, 7); wr_u32(fd, 56);  wr_u32(fd, sys_off);      // SystemInfo
    wr_u32(fd, 6); wr_u32(fd, 168); wr_u32(fd, exc_off);      // Exception
    wr_u32(fd, 3); wr_u32(fd, 4+48);wr_u32(fd, tl_off);       // ThreadList
    if (has_modules) {
        uint32_t ml_sz = 4 + static_cast<uint32_t>(g_module_count) * 108;
        wr_u32(fd, 4); wr_u32(fd, ml_sz); wr_u32(fd, ml_off); // ModuleList
    }

    // ── 3. SystemInfoStream ─────────────────────────────────────────────
    wr_u16(fd, MDMP_PROCESSOR_ARCH);      // ProcessorArchitecture
    wr_u16(fd, 0);                        // ProcessorLevel
    wr_u16(fd, 0);                        // ProcessorRevision
    { uint8_t v = 1; wr(fd, &v, 1); }    // NumberOfProcessors
    { uint8_t v = 1; wr(fd, &v, 1); }    // ProductType
    wr_u32(fd, 5);                        // MajorVersion
    wr_u32(fd, 0);                        // MinorVersion
    wr_u32(fd, 0);                        // BuildNumber
    wr_u32(fd, get_platform_id());        // PlatformId
    wr_u32(fd, csd_off);                  // CSDVersionRva
    wr_u16(fd, 0);                        // SuiteMask
    wr_u16(fd, 0);                        // Reserved2
    wr_zeros(fd, 24);                     // CPU vendor info

    // ── 4. CSD Version String (empty) ───────────────────────────────────
    wr_u32(fd, 0);                        // Length = 0

    // ── 5. ExceptionStream ──────────────────────────────────────────────
    uint32_t tid = static_cast<uint32_t>(getpid());
    wr_u32(fd, tid);                      // ThreadId
    wr_u32(fd, 0);                        // __alignment
    // ExceptionRecord:
    wr_u32(fd, static_cast<uint32_t>(sig)); // ExceptionCode (= signal number)
    wr_u32(fd, 0);                        // ExceptionFlags
    wr_u64(fd, 0);                        // ExceptionRecord (chained)
    wr_u64(fd, get_ip(uc));               // ExceptionAddress
    uint32_t nparams = (si != nullptr) ? 1u : 0u;
    wr_u32(fd, nparams);                  // NumberParameters
    wr_u32(fd, 0);                        // __alignment
    if (nparams > 0) {
        wr_u64(fd, reinterpret_cast<uint64_t>(si->si_addr));
        wr_zeros(fd, 14 * 8);
    } else {
        wr_zeros(fd, 15 * 8);
    }
    // ThreadContext location
    wr_u32(fd, MDMP_CONTEXT_SIZE);
    wr_u32(fd, ctx_off_v);

    // ── 6. ThreadListStream ─────────────────────────────────────────────
    wr_u32(fd, 1);                        // NumberOfThreads
    // MINIDUMP_THREAD
    wr_u32(fd, tid);                      // ThreadId
    wr_u32(fd, 0);                        // SuspendCount
    wr_u32(fd, 0);                        // PriorityClass
    wr_u32(fd, 0);                        // Priority
    wr_u64(fd, 0);                        // Teb
    // Stack descriptor
    uint64_t sp = get_sp(uc);
    wr_u64(fd, sp);                       // StartOfMemoryRange
    wr_u32(fd, STACK_CAPTURE);            // Memory.DataSize
    wr_u32(fd, stk_off);                  // Memory.Rva
    // ThreadContext
    wr_u32(fd, MDMP_CONTEXT_SIZE);
    wr_u32(fd, ctx_off_v);

    // ── 7. Context blob ─────────────────────────────────────────────────
    uint8_t ctx_buf[1232] = {};  // large enough for any arch
    fill_context(ctx_buf, uc);
    wr(fd, ctx_buf, MDMP_CONTEXT_SIZE);

    // ── 8. Stack memory ─────────────────────────────────────────────────
    //    write() handles EFAULT gracefully (returns -1) if stack is unmapped
    wr(fd, reinterpret_cast<const void*>(static_cast<uintptr_t>(sp)), STACK_CAPTURE);
    // Ensure file position is correct even if partial write
    lseek(fd, static_cast<off_t>(stk_off + STACK_CAPTURE), SEEK_SET);

    // ── 9. ModuleListStream ─────────────────────────────────────────────
    if (has_modules) {
        wr_u32(fd, static_cast<uint32_t>(g_module_count));
        for (int i = 0; i < g_module_count; i++) {
            wr_u64(fd, g_modules[i].base);                     // BaseOfImage
            wr_u32(fd, static_cast<uint32_t>(g_modules[i].size)); // SizeOfImage
            wr_u32(fd, 0);                                     // CheckSum
            wr_u32(fd, 0);                                     // TimeDateStamp
            wr_u32(fd, ms_rvas[i]);                            // ModuleNameRva
            wr_u32(fd, 0xFEEF04BDu);                          // VS_FIXEDFILEINFO.Signature
            wr_zeros(fd, 48);                                  // rest of VS_FIXEDFILEINFO
            wr_u32(fd, 0); wr_u32(fd, 0);                     // cv_record
            wr_u32(fd, 0); wr_u32(fd, 0);                     // misc_record
            wr_u64(fd, 0); wr_u64(fd, 0);                     // reserved
        }
    }

    // ── 10. Module name strings (MINIDUMP_STRING: uint32 Length + UTF-16LE) ──
    for (int i = 0; i < g_module_count; i++) {
        size_t slen = strlen(g_modules[i].name);
        wr_u32(fd, static_cast<uint32_t>(slen * 2));           // Length in bytes
        for (size_t j = 0; j < slen; j++) {
            uint16_t ch = static_cast<uint16_t>(
                static_cast<unsigned char>(g_modules[i].name[j]));
            wr_u16(fd, ch);
        }
    }

    close(fd);
    _exit(128 + sig);
}

// ── Public API ──────────────────────────────────────────────────────────────

inline void setup_crash_handler(const char* output_path) {
    strncpy(g_dump_path, output_path, sizeof(g_dump_path) - 1);

    // Pre-scan loaded modules (safe to call before crash)
    scan_modules();

    // Alternate signal stack so we can handle stack-overflow crashes
    static char alt_stack[SIGSTKSZ + 32768];
    stack_t ss = {};
    ss.ss_sp   = alt_stack;
    ss.ss_size = sizeof(alt_stack);
    ss.ss_flags = 0;
    sigaltstack(&ss, nullptr);

    // Install signal handlers
    struct sigaction sa = {};
    sa.sa_sigaction = crash_signal_handler;
    sa.sa_flags     = SA_SIGINFO | SA_RESETHAND | SA_ONSTACK;
    sigemptyset(&sa.sa_mask);

    sigaction(SIGSEGV, &sa, nullptr);
    sigaction(SIGABRT, &sa, nullptr);
    sigaction(SIGFPE,  &sa, nullptr);
    sigaction(SIGILL,  &sa, nullptr);
    sigaction(SIGBUS,  &sa, nullptr);
    sigaction(SIGTRAP, &sa, nullptr);
}

#endif // _WIN32
