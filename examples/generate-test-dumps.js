#!/usr/bin/env node
/**
 * Generate test minidump (.dmp) files for DumpStorm extension testing.
 * 
 * Minidump format reference:
 * https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/ns-minidumpapiset-minidump_header
 * 
 * Usage: node generate-test-dumps.js
 */

const fs = require('fs');
const path = require('path');

// ─── Constants ───────────────────────────────────────────────────────────────

const MDMP_SIGNATURE = 0x504D444D; // "MDMP" in little-endian
const MDMP_VERSION = 0xA793;       // Minidump version
const IMPLEMENTATION_VERSION = 0x0006; // Implementation-specific version (Windows)

// Stream types
const STREAM_TYPE = {
    UnusedStream:           0,
    ThreadListStream:       3,
    ModuleListStream:       4,
    ExceptionStream:        6,
    SystemInfoStream:       7,
    MiscInfoStream:         15,
    MemoryInfoListStream:   16,
};

// Processor architectures
const PROCESSOR_ARCH = {
    INTEL:   0,   // x86
    AMD64:   9,   // x64
    ARM:     5,
    ARM64:   12,
};

// OS Platform IDs
const PLATFORM_ID = {
    WIN32_NT: 2,
    LINUX:    0x8000 | 1,  // Custom ID for Linux
    MACOS:    0x8000 | 2,  // Custom ID for macOS
};

// Exception codes
const EXCEPTION_CODE = {
    ACCESS_VIOLATION:        0xC0000005,
    STACK_OVERFLOW:          0xC00000FD,
    ILLEGAL_INSTRUCTION:     0xC000001D,
    INTEGER_DIVIDE_BY_ZERO:  0xC0000094,
    BREAKPOINT:              0x80000003,
    STACK_BUFFER_OVERRUN:    0xC0000409,
    HEAP_CORRUPTION:         0xC0000374,
};

// ─── Buffer helpers ──────────────────────────────────────────────────────────

class BinaryWriter {
    constructor(size = 4096) {
        this.buffer = Buffer.alloc(size);
        this.offset = 0;
    }

    ensureCapacity(needed) {
        while (this.offset + needed > this.buffer.length) {
            const newBuf = Buffer.alloc(this.buffer.length * 2);
            this.buffer.copy(newBuf);
            this.buffer = newBuf;
        }
    }

    writeUInt8(val) {
        this.ensureCapacity(1);
        this.buffer.writeUInt8(val, this.offset);
        this.offset += 1;
    }

    writeUInt16LE(val) {
        this.ensureCapacity(2);
        this.buffer.writeUInt16LE(val, this.offset);
        this.offset += 2;
    }

    writeUInt32LE(val) {
        this.ensureCapacity(4);
        this.buffer.writeUInt32LE(val >>> 0, this.offset);
        this.offset += 4;
    }

    writeUInt64LE(val) {
        // Use BigInt for proper 64-bit unsigned handling
        this.ensureCapacity(8);
        const big = BigInt(val) & 0xFFFFFFFFFFFFFFFFn;
        const lo = Number(big & 0xFFFFFFFFn);
        const hi = Number((big >> 32n) & 0xFFFFFFFFn);
        this.buffer.writeUInt32LE(lo >>> 0, this.offset);
        this.buffer.writeUInt32LE(hi >>> 0, this.offset + 4);
        this.offset += 8;
    }

    writeBytes(buf) {
        this.ensureCapacity(buf.length);
        buf.copy(this.buffer, this.offset);
        this.offset += buf.length;
    }

    writeUTF16LE(str, maxBytes) {
        const buf = Buffer.alloc(maxBytes, 0);
        for (let i = 0; i < str.length && i * 2 + 1 < maxBytes; i++) {
            buf.writeUInt16LE(str.charCodeAt(i), i * 2);
        }
        this.writeBytes(buf);
    }

    pad(alignment) {
        const remainder = this.offset % alignment;
        if (remainder !== 0) {
            const padding = alignment - remainder;
            this.ensureCapacity(padding);
            this.offset += padding;
        }
    }

    seek(offset) {
        this.offset = offset;
    }

    tell() {
        return this.offset;
    }

    getBuffer() {
        return this.buffer.slice(0, this.offset);
    }
}

// ─── Minidump builder ────────────────────────────────────────────────────────

function buildMinidump(options) {
    const {
        arch = PROCESSOR_ARCH.AMD64,
        platformId = PLATFORM_ID.WIN32_NT,
        osMajor = 10,
        osMinor = 0,
        osBuild = 19041,
        exceptionCode = EXCEPTION_CODE.ACCESS_VIOLATION,
        exceptionAddress = 0x00007FF6A1B23456,
        crashThreadId = 0x1234,
        numberOfThreads = 3,
        modules = [],
        registers = {},
        includeException = true,
    } = options;

    const writer = new BinaryWriter(8192);
    const streams = [];

    // ── Build stream data first, we'll write the header + directory later ──

    // Reserve space for header (32 bytes) and stream directory
    const maxStreams = 4; // SystemInfo, ThreadList, ModuleList, Exception
    const headerSize = 32;
    const directoryEntrySize = 12; // each MINIDUMP_DIRECTORY entry
    const directoryOffset = headerSize;
    const dataStartOffset = directoryOffset + maxStreams * directoryEntrySize;

    writer.seek(dataStartOffset);

    // ── 1. SystemInfoStream ──────────────────────────────────────────────

    const systemInfoOffset = writer.tell();
    // MINIDUMP_SYSTEM_INFO
    writer.writeUInt16LE(arch);                         // ProcessorArchitecture
    writer.writeUInt16LE(6);                            // ProcessorLevel
    writer.writeUInt16LE(0x5E03);                       // ProcessorRevision
    writer.writeUInt8(8);                               // NumberOfProcessors
    writer.writeUInt8(1);                               // ProductType (Workstation)
    writer.writeUInt32LE(osMajor);                      // MajorVersion
    writer.writeUInt32LE(osMinor);                      // MinorVersion
    writer.writeUInt32LE(osBuild);                      // BuildNumber
    writer.writeUInt32LE(platformId);                   // PlatformId
    writer.writeUInt32LE(0);                            // CSDVersionRva (no service pack string)
    writer.writeUInt16LE(0);                            // SuiteMask
    writer.writeUInt16LE(0);                            // Reserved2
    // Cpu info (processor features) - simplified
    for (let i = 0; i < 24; i++) writer.writeUInt8(0);
    const systemInfoSize = writer.tell() - systemInfoOffset;

    streams.push({
        streamType: STREAM_TYPE.SystemInfoStream,
        dataSize: systemInfoSize,
        rva: systemInfoOffset,
    });

    // ── 2. ThreadListStream ──────────────────────────────────────────────

    writer.pad(4);
    const threadListOffset = writer.tell();

    writer.writeUInt32LE(numberOfThreads); // NumberOfThreads

    for (let i = 0; i < numberOfThreads; i++) {
        const threadId = crashThreadId + i;
        const stackBase = 0x00000050F0000000 + i * 0x100000;

        writer.writeUInt32LE(threadId);        // ThreadId
        writer.writeUInt32LE(0);               // SuspendCount
        writer.writeUInt32LE(0);               // PriorityClass
        writer.writeUInt32LE(0);               // Priority
        writer.writeUInt64LE(0);               // Teb

        // MINIDUMP_MEMORY_DESCRIPTOR - Stack
        writer.writeUInt64LE(stackBase);       // StartOfMemoryRange
        writer.writeUInt32LE(0);               // Memory.DataSize (no actual memory data)
        writer.writeUInt32LE(0);               // Memory.Rva

        // MINIDUMP_LOCATION_DESCRIPTOR - ThreadContext
        writer.writeUInt32LE(0);               // ThreadContext.DataSize
        writer.writeUInt32LE(0);               // ThreadContext.Rva
    }

    const threadListSize = writer.tell() - threadListOffset;
    streams.push({
        streamType: STREAM_TYPE.ThreadListStream,
        dataSize: threadListSize,
        rva: threadListOffset,
    });

    // ── 3. ModuleListStream ──────────────────────────────────────────────

    writer.pad(4);
    const moduleListOffset = writer.tell();

    const defaultModules = modules.length > 0 ? modules : [
        { name: 'app.exe',       baseAddr: 0x00007FF6A1B00000, size: 0x100000 },
        { name: 'ntdll.dll',     baseAddr: 0x00007FFA12340000, size: 0x1F0000 },
        { name: 'kernel32.dll',  baseAddr: 0x00007FFA10000000, size: 0x0B0000 },
        { name: 'ucrtbase.dll',  baseAddr: 0x00007FFA0E000000, size: 0x0F0000 },
    ];

    writer.writeUInt32LE(defaultModules.length); // NumberOfModules

    // We need to write module names after the module entries, so collect name offsets
    const moduleNameOffsets = [];
    const moduleEntryStartOffset = writer.tell();
    const moduleEntrySize = 108; // MINIDUMP_MODULE is 108 bytes
    // Reserve space for module entries
    const moduleNamesStartOffset = moduleEntryStartOffset + defaultModules.length * moduleEntrySize;
    writer.seek(moduleNamesStartOffset);

    // Write module name strings
    for (const mod of defaultModules) {
        writer.pad(4);
        const nameRva = writer.tell();
        moduleNameOffsets.push(nameRva);
        const nameUtf16 = Buffer.from(mod.name, 'utf16le');
        writer.writeUInt32LE(nameUtf16.length); // Length of name in bytes
        writer.writeBytes(nameUtf16);
        writer.writeUInt16LE(0); // Null terminator
    }

    const afterNames = writer.tell();

    // Now go back and write module entries
    writer.seek(moduleEntryStartOffset);
    for (let i = 0; i < defaultModules.length; i++) {
        const mod = defaultModules[i];
        writer.writeUInt64LE(mod.baseAddr);        // BaseOfImage
        writer.writeUInt32LE(mod.size);             // SizeOfImage
        writer.writeUInt32LE(0);                    // CheckSum
        writer.writeUInt32LE(Math.floor(Date.now() / 1000)); // TimeDateStamp
        writer.writeUInt32LE(moduleNameOffsets[i]); // ModuleNameRva
        
        // VS_FIXEDFILEINFO (52 bytes)
        writer.writeUInt32LE(0xFEEF04BD);          // dwSignature
        writer.writeUInt32LE(0x00010000);           // dwStrucVersion
        writer.writeUInt32LE(1);                    // dwFileVersionMS
        writer.writeUInt32LE(0);                    // dwFileVersionLS
        writer.writeUInt32LE(1);                    // dwProductVersionMS
        writer.writeUInt32LE(0);                    // dwProductVersionLS
        writer.writeUInt32LE(0x3F);                 // dwFileFlagsMask
        writer.writeUInt32LE(0);                    // dwFileFlags
        writer.writeUInt32LE(0x40004);              // dwFileOS
        writer.writeUInt32LE(1);                    // dwFileType
        writer.writeUInt32LE(0);                    // dwFileSubtype
        writer.writeUInt32LE(0);                    // dwFileDateMS
        writer.writeUInt32LE(0);                    // dwFileDateLS

        // CvRecord (MINIDUMP_LOCATION_DESCRIPTOR)
        writer.writeUInt32LE(0);                    // CvRecord.DataSize
        writer.writeUInt32LE(0);                    // CvRecord.Rva
        // MiscRecord (MINIDUMP_LOCATION_DESCRIPTOR)
        writer.writeUInt32LE(0);                    // MiscRecord.DataSize
        writer.writeUInt32LE(0);                    // MiscRecord.Rva
        // Reserved
        writer.writeUInt64LE(0);                    // Reserved0
        writer.writeUInt64LE(0);                    // Reserved1
    }

    writer.seek(afterNames);
    const moduleListSize = afterNames - moduleListOffset;

    streams.push({
        streamType: STREAM_TYPE.ModuleListStream,
        dataSize: moduleListSize,
        rva: moduleListOffset,
    });

    // ── 4. ExceptionStream ───────────────────────────────────────────────

    if (includeException) {
        writer.pad(4);
        const exceptionOffset = writer.tell();

        writer.writeUInt32LE(crashThreadId);             // ThreadId
        writer.writeUInt32LE(0);                         // __alignment

        // MINIDUMP_EXCEPTION
        writer.writeUInt32LE(exceptionCode);             // ExceptionCode
        writer.writeUInt32LE(0);                         // ExceptionFlags
        writer.writeUInt64LE(0);                         // ExceptionRecord (chained)
        writer.writeUInt64LE(exceptionAddress);          // ExceptionAddress

        const numParams = exceptionCode === EXCEPTION_CODE.ACCESS_VIOLATION ? 2 : 0;
        writer.writeUInt32LE(numParams);                 // NumberParameters
        writer.writeUInt32LE(0);                         // __unusedAlignment

        // EXCEPTION_MAXIMUM_PARAMETERS = 15, each is uint64
        for (let i = 0; i < 15; i++) {
            if (i === 0 && exceptionCode === EXCEPTION_CODE.ACCESS_VIOLATION) {
                writer.writeUInt64LE(0); // 0 = read violation
            } else if (i === 1 && exceptionCode === EXCEPTION_CODE.ACCESS_VIOLATION) {
                writer.writeUInt64LE(0x0000000000000000); // Address causing violation
            } else {
                writer.writeUInt64LE(0);
            }
        }

        // ThreadContext (MINIDUMP_LOCATION_DESCRIPTOR)
        writer.writeUInt32LE(0);                         // ThreadContext.DataSize
        writer.writeUInt32LE(0);                         // ThreadContext.Rva

        const exceptionSize = writer.tell() - exceptionOffset;
        streams.push({
            streamType: STREAM_TYPE.ExceptionStream,
            dataSize: exceptionSize,
            rva: exceptionOffset,
        });
    }

    // ── Write header and stream directory ────────────────────────────────

    const actualStreamCount = streams.length;
    const totalSize = writer.tell();

    writer.seek(0);

    // MINIDUMP_HEADER
    writer.writeUInt32LE(MDMP_SIGNATURE);                // Signature ("MDMP")
    writer.writeUInt16LE(MDMP_VERSION);                  // Version
    writer.writeUInt16LE(IMPLEMENTATION_VERSION);        // Implementation version
    writer.writeUInt32LE(actualStreamCount);              // NumberOfStreams
    writer.writeUInt32LE(directoryOffset);               // StreamDirectoryRva
    writer.writeUInt32LE(0);                             // CheckSum
    writer.writeUInt32LE(Math.floor(Date.now() / 1000)); // TimeDateStamp
    writer.writeUInt64LE(0x00000002);                    // Flags (MiniDumpWithFullMemory = 2)

    // Stream directory entries
    writer.seek(directoryOffset);
    for (const stream of streams) {
        writer.writeUInt32LE(stream.streamType);
        writer.writeUInt32LE(stream.dataSize);
        writer.writeUInt32LE(stream.rva);
    }

    writer.seek(totalSize);
    return writer.getBuffer();
}

// ─── Generate test dump files ────────────────────────────────────────────────

function generateAllTestDumps() {
    const outputDir = __dirname;

    const dumpConfigs = [
        {
            filename: 'crash_access_violation_x64.dmp',
            description: 'x64 ACCESS_VIOLATION in app.exe',
            options: {
                arch: PROCESSOR_ARCH.AMD64,
                exceptionCode: EXCEPTION_CODE.ACCESS_VIOLATION,
                exceptionAddress: 0x00007FF6A1B23456,
                crashThreadId: 0x1A2C,
                numberOfThreads: 4,
                modules: [
                    { name: 'myapp.exe',       baseAddr: 0x00007FF6A1B00000, size: 0x200000 },
                    { name: 'ntdll.dll',       baseAddr: 0x00007FFA12340000, size: 0x1F0000 },
                    { name: 'kernel32.dll',    baseAddr: 0x00007FFA10000000, size: 0x0B0000 },
                    { name: 'user32.dll',      baseAddr: 0x00007FFA0F000000, size: 0x1A0000 },
                    { name: 'vcruntime140.dll', baseAddr: 0x00007FFA0D000000, size: 0x020000 },
                ],
            },
        },
        {
            filename: 'crash_stack_overflow_x64.dmp',
            description: 'x64 STACK_OVERFLOW',
            options: {
                arch: PROCESSOR_ARCH.AMD64,
                exceptionCode: EXCEPTION_CODE.STACK_OVERFLOW,
                exceptionAddress: 0x00007FF6A1B10020,
                crashThreadId: 0x0FA0,
                numberOfThreads: 2,
            },
        },
        {
            filename: 'crash_illegal_instruction_x64.dmp',
            description: 'x64 ILLEGAL_INSTRUCTION',
            options: {
                arch: PROCESSOR_ARCH.AMD64,
                exceptionCode: EXCEPTION_CODE.ILLEGAL_INSTRUCTION,
                exceptionAddress: 0x00007FF6A1C00100,
                crashThreadId: 0x2F00,
                numberOfThreads: 3,
            },
        },
        {
            filename: 'crash_divide_by_zero_x86.dmp',
            description: 'x86 INTEGER_DIVIDE_BY_ZERO',
            options: {
                arch: PROCESSOR_ARCH.INTEL,
                exceptionCode: EXCEPTION_CODE.INTEGER_DIVIDE_BY_ZERO,
                exceptionAddress: 0x00401234,
                crashThreadId: 0x0B10,
                numberOfThreads: 1,
                osBuild: 7601,
                modules: [
                    { name: 'calculator.exe', baseAddr: 0x00400000, size: 0x050000 },
                    { name: 'ntdll.dll',      baseAddr: 0x77000000, size: 0x1F0000 },
                    { name: 'kernel32.dll',   baseAddr: 0x76000000, size: 0x110000 },
                    { name: 'msvcrt.dll',     baseAddr: 0x75F00000, size: 0x0C0000 },
                ],
            },
        },
        {
            filename: 'crash_breakpoint_x64.dmp',
            description: 'x64 BREAKPOINT (debug break / assertion failure)',
            options: {
                arch: PROCESSOR_ARCH.AMD64,
                exceptionCode: EXCEPTION_CODE.BREAKPOINT,
                exceptionAddress: 0x00007FF6A1B50000,
                crashThreadId: 0x3C40,
                numberOfThreads: 8,
                modules: [
                    { name: 'server.exe',       baseAddr: 0x00007FF6A1B00000, size: 0x500000 },
                    { name: 'ntdll.dll',        baseAddr: 0x00007FFA12340000, size: 0x1F0000 },
                    { name: 'kernel32.dll',     baseAddr: 0x00007FFA10000000, size: 0x0B0000 },
                    { name: 'ws2_32.dll',       baseAddr: 0x00007FFA0C000000, size: 0x090000 },
                    { name: 'mswsock.dll',      baseAddr: 0x00007FFA0B000000, size: 0x060000 },
                    { name: 'libssl-3.dll',     baseAddr: 0x00007FFA0A000000, size: 0x0C0000 },
                    { name: 'libcrypto-3.dll',  baseAddr: 0x00007FFA09000000, size: 0x200000 },
                ],
            },
        },
        {
            filename: 'crash_heap_corruption_x64.dmp',
            description: 'x64 HEAP_CORRUPTION',
            options: {
                arch: PROCESSOR_ARCH.AMD64,
                exceptionCode: EXCEPTION_CODE.HEAP_CORRUPTION,
                exceptionAddress: 0x00007FFA12345678,
                crashThreadId: 0x1100,
                numberOfThreads: 6,
                modules: [
                    { name: 'game_engine.exe',    baseAddr: 0x00007FF6B0000000, size: 0x800000 },
                    { name: 'ntdll.dll',          baseAddr: 0x00007FFA12340000, size: 0x1F0000 },
                    { name: 'kernel32.dll',       baseAddr: 0x00007FFA10000000, size: 0x0B0000 },
                    { name: 'renderer_d3d12.dll', baseAddr: 0x00007FFA08000000, size: 0x300000 },
                    { name: 'physics.dll',        baseAddr: 0x00007FFA07000000, size: 0x150000 },
                    { name: 'audio_engine.dll',   baseAddr: 0x00007FFA06000000, size: 0x080000 },
                ],
            },
        },
        {
            filename: 'crash_stack_buffer_overrun_x64.dmp',
            description: 'x64 STACK_BUFFER_OVERRUN (/GS security check)',
            options: {
                arch: PROCESSOR_ARCH.AMD64,
                exceptionCode: EXCEPTION_CODE.STACK_BUFFER_OVERRUN,
                exceptionAddress: 0x00007FF6A1B20ABC,
                crashThreadId: 0x2200,
                numberOfThreads: 3,
            },
        },
        {
            filename: 'crash_access_violation_arm64.dmp',
            description: 'ARM64 ACCESS_VIOLATION',
            options: {
                arch: PROCESSOR_ARCH.ARM64,
                exceptionCode: EXCEPTION_CODE.ACCESS_VIOLATION,
                exceptionAddress: 0x0000AABB10203040,
                crashThreadId: 0x0800,
                numberOfThreads: 2,
                modules: [
                    { name: 'mobile_app.exe',   baseAddr: 0x0000AABB10000000, size: 0x400000 },
                    { name: 'ntdll.dll',        baseAddr: 0x00007FFA12340000, size: 0x1F0000 },
                    { name: 'combase.dll',      baseAddr: 0x00007FFA0E000000, size: 0x350000 },
                ],
            },
        },
        {
            filename: 'crash_multithread_x64.dmp',
            description: 'x64 ACCESS_VIOLATION with many threads (stress test)',
            options: {
                arch: PROCESSOR_ARCH.AMD64,
                exceptionCode: EXCEPTION_CODE.ACCESS_VIOLATION,
                exceptionAddress: 0x00007FF6C0D0E0F0,
                crashThreadId: 0x0010,
                numberOfThreads: 32,
                modules: [
                    { name: 'webserver.exe',     baseAddr: 0x00007FF6C0000000, size: 0x600000 },
                    { name: 'ntdll.dll',         baseAddr: 0x00007FFA12340000, size: 0x1F0000 },
                    { name: 'kernel32.dll',      baseAddr: 0x00007FFA10000000, size: 0x0B0000 },
                    { name: 'httpapi.dll',       baseAddr: 0x00007FFA0D000000, size: 0x080000 },
                    { name: 'libuv.dll',         baseAddr: 0x00007FFA0C000000, size: 0x060000 },
                    { name: 'node.dll',          baseAddr: 0x00007FFA0B000000, size: 0xA00000 },
                ],
            },
        },
        {
            filename: 'empty.dmp',
            description: 'Minimal empty dump (header only, no modules/threads)',
            options: {
                arch: PROCESSOR_ARCH.AMD64,
                includeException: false,
                numberOfThreads: 0,
                modules: [],
            },
        },
    ];

    console.log('Generating test minidump files...\n');

    for (const config of dumpConfigs) {
        const filePath = path.join(outputDir, config.filename);
        try {
            const dumpBuffer = buildMinidump(config.options);
            fs.writeFileSync(filePath, dumpBuffer);
            const sizeKB = (dumpBuffer.length / 1024).toFixed(1);
            console.log(`  ✓ ${config.filename} (${sizeKB} KB) - ${config.description}`);
        } catch (err) {
            console.error(`  ✗ ${config.filename} - ERROR: ${err.message}`);
        }
    }

    // Also generate a corrupted file for negative testing
    const corruptedPath = path.join(outputDir, 'corrupted.dmp');
    const corruptedData = Buffer.from('This is not a valid minidump file. Random garbage data for testing error handling.\x00\xFF\xFE\xFD');
    fs.writeFileSync(corruptedPath, corruptedData);
    console.log(`  ✓ corrupted.dmp (${corruptedData.length} bytes) - Corrupted/invalid file for error handling tests`);

    // Generate a truncated dump (valid header but truncated content)
    const truncatedPath = path.join(outputDir, 'truncated.dmp');
    const fullDump = buildMinidump({
        arch: PROCESSOR_ARCH.AMD64,
        exceptionCode: EXCEPTION_CODE.ACCESS_VIOLATION,
    });
    // Keep only first 64 bytes (header + partial directory)
    fs.writeFileSync(truncatedPath, fullDump.slice(0, 64));
    console.log(`  ✓ truncated.dmp (64 bytes) - Truncated dump file for robustness testing`);

    console.log('\nDone! Generated files in:', outputDir);
}

generateAllTestDumps();
