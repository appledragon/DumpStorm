#!/usr/bin/env node
/**
 * Generate small synthetic minidump fixtures for DumpStorm testing.
 *
 * These files contain a valid stream layout, register context, and synthetic
 * stack memory so minidump_stackwalk can walk them. They are not captures of
 * a real process and do not contain code bytes or matching debug symbols.
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

// Historical implementation kept below for format archaeology only. It is
// intentionally not called; buildMinidump() is the validated implementation.
function buildLegacyMinidump(options) {
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

/*
 * The old builder above is retained only as historical context for the
 * original fixture format. The builder below is the one used by the script.
 * It writes the referenced data (contexts, stacks, CSD, and module names)
 * separately from the stream payloads, as required by the minidump format.
 */
const CONTEXT_LAYOUT = {
    [PROCESSOR_ARCH.INTEL]: {
        size: 716,
        flags: 0x0001003F,
        flagsSize: 4,
        instructionPointer: 184,
        stackPointer: 196,
        framePointer: 180,
        wordSize: 4,
    },
    [PROCESSOR_ARCH.AMD64]: {
        size: 1232,
        flags: 0x0010000B,
        flagsSize: 4,
        instructionPointer: 0xF8,
        stackPointer: 0x98,
        framePointer: 0xA0,
        wordSize: 8,
    },
    [PROCESSOR_ARCH.ARM64]: {
        size: 912,
        flags: 0x00400007,
        flagsSize: 8,
        instructionPointer: 264,
        stackPointer: 256,
        framePointer: 240,
        wordSize: 8,
    },
};
const STACK_CAPTURE_SIZE = 0x1000;

function asBigInt(value, fallback = 0n) {
    if (value === undefined || value === null) {
        return fallback;
    }
    return typeof value === 'bigint' ? value : BigInt(value);
}

function writeContextValue(buffer, offset, value, wordSize) {
    const mask = wordSize === 4 ? 0xFFFFFFFFn : 0xFFFFFFFFFFFFFFFFn;
    const normalized = asBigInt(value) & mask;
    if (wordSize === 4) {
        buffer.writeUInt32LE(Number(normalized), offset);
    } else {
        buffer.writeBigUInt64LE(normalized, offset);
    }
}

function createThreadMemory(arch, ip, stackBase, returnAddresses, registers = {}) {
    const layout = CONTEXT_LAYOUT[arch];
    if (!layout) {
        throw new Error(`Unsupported synthetic context architecture: ${arch}`);
    }

    const context = Buffer.alloc(layout.size);
    writeContextValue(context, arch === PROCESSOR_ARCH.AMD64 ? 0x30 : 0, layout.flags, layout.flagsSize);

    const stackPointer = stackBase + 0x20n;
    const framePointer = stackBase + 0x100n;
    const configuredIp = registers.ip ?? registers.rip ?? registers.eip ?? registers.pc ?? ip;
    const configuredSp = registers.sp ?? registers.rsp ?? registers.esp ?? stackPointer;
    const configuredFp = registers.fp ?? registers.rbp ?? registers.ebp ?? framePointer;
    writeContextValue(context, layout.instructionPointer, configuredIp, layout.wordSize);
    writeContextValue(context, layout.stackPointer, configuredSp, layout.wordSize);
    writeContextValue(context, layout.framePointer, configuredFp, layout.wordSize);

    if (arch === PROCESSOR_ARCH.ARM64) {
        // MDRawContextARM64 stores x30/LR immediately before SP.
        writeContextValue(context, 248, returnAddresses[0] ?? 0n, 8);
    }

    const stack = Buffer.alloc(STACK_CAPTURE_SIZE);
    if (layout.wordSize === 4) {
        stack.writeUInt32LE(Number(asBigInt(returnAddresses[0]) & 0xFFFFFFFFn), 0x24);
        stack.writeUInt32LE(0, 0x100);
        stack.writeUInt32LE(Number(asBigInt(returnAddresses[1]) & 0xFFFFFFFFn), 0x104);
    } else {
        stack.writeBigUInt64LE(asBigInt(returnAddresses[0]), 0x28);
        stack.writeBigUInt64LE(0n, 0x100);
        stack.writeBigUInt64LE(asBigInt(returnAddresses[1]), 0x108);
    }

    return { context, stack };
}

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
        modules,
        registers = {},
        includeException = true,
    } = options;
    const layout = CONTEXT_LAYOUT[arch];
    if (!layout) {
        throw new Error(`Unsupported synthetic architecture: ${arch}`);
    }

    const defaultModules = [
        { name: 'app.exe',       baseAddr: 0x00007FF6A1B00000, size: 0x100000 },
        { name: 'ntdll.dll',     baseAddr: 0x00007FFA12340000, size: 0x1F0000 },
        { name: 'kernel32.dll',  baseAddr: 0x00007FFA10000000, size: 0x0B0000 },
        { name: 'ucrtbase.dll',  baseAddr: 0x00007FFA0E000000, size: 0x0F0000 },
    ];
    // An explicit [] is meaningful for the empty boundary fixture.
    const dumpModules = modules === undefined ? defaultModules : modules;
    const streamCount = 3 + (includeException ? 1 : 0);
    const directoryOffset = 32;
    const dataStartOffset = directoryOffset + streamCount * 12;
    const writer = new BinaryWriter(Math.max(8192, dataStartOffset + 4096));
    const streams = [];

    writer.seek(dataStartOffset);

    // ── 1. SystemInfoStream and an empty CSD string ──────────────────────
    const systemInfoOffset = writer.tell();
    const csdOffset = systemInfoOffset + 56;
    writer.writeUInt16LE(arch);
    writer.writeUInt16LE(6);
    writer.writeUInt16LE(0x5E03);
    writer.writeUInt8(8);
    writer.writeUInt8(1);
    writer.writeUInt32LE(osMajor);
    writer.writeUInt32LE(osMinor);
    writer.writeUInt32LE(osBuild);
    writer.writeUInt32LE(platformId);
    writer.writeUInt32LE(csdOffset);
    writer.writeUInt16LE(0);
    writer.writeUInt16LE(0);
    for (let i = 0; i < 24; i++) writer.writeUInt8(0);
    writer.writeUInt32LE(0); // Empty MINIDUMP_STRING.
    streams.push({ streamType: STREAM_TYPE.SystemInfoStream, dataSize: 56, rva: systemInfoOffset });

    // ── 2. Context and stack data referenced by each thread ──────────────
    const threadMemory = [];
    for (let i = 0; i < numberOfThreads; i++) {
        const threadId = crashThreadId + i;
        const stackBase = arch === PROCESSOR_ARCH.INTEL
            ? 0x0012F000n + BigInt(i) * 0x10000n
            : 0x00000050F0000000n + BigInt(i) * 0x100000n;
        const module = dumpModules.length > 0 ? dumpModules[i % dumpModules.length] : undefined;
        const moduleBase = module ? asBigInt(module.baseAddr) : 0n;
        const ip = i === 0 && includeException
            ? asBigInt(exceptionAddress)
            : moduleBase + 0x1000n + BigInt(i * 0x10);
        const returnAddresses = [
            moduleBase + 0x2000n + BigInt(i * 0x10),
            moduleBase + 0x3000n + BigInt(i * 0x10),
        ];

        writer.pad(4);
        const contextRva = writer.tell();
        const memory = createThreadMemory(
            arch,
            ip,
            stackBase,
            returnAddresses,
            i === 0 ? registers : {},
        );
        writer.writeBytes(memory.context);
        writer.pad(4);
        const stackRva = writer.tell();
        writer.writeBytes(memory.stack);
        threadMemory.push({
            threadId,
            contextRva,
            contextSize: layout.size,
            stackBase,
            stackRva,
            stackSize: memory.stack.length,
        });
    }

    // ── 3. ThreadListStream ──────────────────────────────────────────────
    writer.pad(4);
    const threadListOffset = writer.tell();
    writer.writeUInt32LE(numberOfThreads);
    for (const thread of threadMemory) {
        writer.writeUInt32LE(thread.threadId);
        writer.writeUInt32LE(0);
        writer.writeUInt32LE(0);
        writer.writeUInt32LE(0);
        writer.writeUInt64LE(0);
        writer.writeUInt64LE(thread.stackBase);
        writer.writeUInt32LE(thread.stackSize);
        writer.writeUInt32LE(thread.stackRva);
        writer.writeUInt32LE(thread.contextSize);
        writer.writeUInt32LE(thread.contextRva);
    }
    streams.push({
        streamType: STREAM_TYPE.ThreadListStream,
        dataSize: 4 + numberOfThreads * 48,
        rva: threadListOffset,
    });

    // ── 4. ExceptionStream ───────────────────────────────────────────────
    if (includeException) {
        writer.pad(4);
        const exceptionOffset = writer.tell();
        const crashThread = threadMemory[0];
        writer.writeUInt32LE(crashThreadId);
        writer.writeUInt32LE(0);
        writer.writeUInt32LE(exceptionCode);
        writer.writeUInt32LE(0);
        writer.writeUInt64LE(0);
        writer.writeUInt64LE(asBigInt(exceptionAddress));
        const numParams = exceptionCode === EXCEPTION_CODE.ACCESS_VIOLATION ? 2 : 0;
        writer.writeUInt32LE(numParams);
        writer.writeUInt32LE(0);
        for (let i = 0; i < 15; i++) writer.writeUInt64LE(0);
        writer.writeUInt32LE(crashThread.contextSize);
        writer.writeUInt32LE(crashThread.contextRva);
        streams.push({ streamType: STREAM_TYPE.ExceptionStream, dataSize: 168, rva: exceptionOffset });
    }

    // ── 5. ModuleListStream and referenced module-name strings ────────────
    writer.pad(4);
    const moduleListOffset = writer.tell();
    writer.writeUInt32LE(dumpModules.length);
    const moduleEntryOffsets = [];
    for (const mod of dumpModules) {
        moduleEntryOffsets.push(writer.tell());
        writer.writeUInt64LE(asBigInt(mod.baseAddr));
        writer.writeUInt32LE(mod.size);
        writer.writeUInt32LE(0);
        writer.writeUInt32LE(Math.floor(Date.now() / 1000));
        writer.writeUInt32LE(0); // ModuleNameRva, patched below.
        writer.writeUInt32LE(0xFEEF04BD);
        for (let i = 0; i < 12; i++) writer.writeUInt32LE(0);
        for (let i = 0; i < 4; i++) writer.writeUInt32LE(0);
        writer.writeUInt64LE(0);
        writer.writeUInt64LE(0);
    }
    const moduleListSize = 4 + dumpModules.length * 108;
    const moduleNameOffsets = [];
    for (const mod of dumpModules) {
        writer.pad(4);
        const nameRva = writer.tell();
        moduleNameOffsets.push(nameRva);
        const nameUtf16 = Buffer.from(mod.name, 'utf16le');
        writer.writeUInt32LE(nameUtf16.length);
        writer.writeBytes(nameUtf16);
    }
    const afterNames = writer.tell();
    for (let i = 0; i < moduleEntryOffsets.length; i++) {
        writer.seek(moduleEntryOffsets[i] + 20);
        writer.writeUInt32LE(moduleNameOffsets[i]);
    }
    writer.seek(afterNames);
    streams.push({
        streamType: STREAM_TYPE.ModuleListStream,
        // Name strings are referenced data, not part of MINIDUMP_MODULE_LIST.
        dataSize: moduleListSize,
        rva: moduleListOffset,
    });

    // ── Write header and stream directory ─────────────────────────────────
    const totalSize = writer.tell();
    writer.seek(0);
    writer.writeUInt32LE(MDMP_SIGNATURE);
    writer.writeUInt16LE(MDMP_VERSION);
    writer.writeUInt16LE(IMPLEMENTATION_VERSION);
    writer.writeUInt32LE(streams.length);
    writer.writeUInt32LE(directoryOffset);
    writer.writeUInt32LE(0);
    writer.writeUInt32LE(Math.floor(Date.now() / 1000));
    writer.writeUInt64LE(0); // MiniDumpNormal; no full-memory claim.
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

    for (const legacyFixture of ['corrupted.dmp', 'truncated.dmp']) {
        const legacyPath = path.join(outputDir, legacyFixture);
        if (fs.existsSync(legacyPath)) {
            fs.unlinkSync(legacyPath);
            console.log(`  - removed obsolete fixture ${legacyFixture}`);
        }
    }

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

    console.log('\nDone! Generated files in:', outputDir);
}

generateAllTestDumps();
