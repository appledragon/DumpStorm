# Changelog

All notable changes to the DumpStorm extension will be documented in this file.

## [1.0.5] - 2026-04-12

### Added
- **Tool path tooltips**: Installed tools (nm/llvm-nm, minidump_stackwalk) now show rich Markdown tooltips with binary path and installation status
- **Click to reveal**: Clicking on an installed tool item opens the binary location in the OS file explorer
- Localization support (EN/ZH-CN) for new tooltip strings

## [1.0.4] - 2026-03-10

### Added
- **Use-After-Free detection**: Recognize freed memory fill patterns (0xDDDDDDDD, 0xFEEEFEEE, 0xDEADBEEF) in register values
- **Uninitialized memory detection**: Recognize uninitialized memory patterns (0xCDCDCDCD, 0xCCCCCCCC, 0xBAADF00D, etc.)
- **Heap corruption error code**: Added STATUS_HEAP_CORRUPTION (0xC0000374) to known error codes
- Localization support (EN/ZH-CN) for all new crash detection patterns

### Fixed
- About dialog version is now read dynamically from package.json instead of being hardcoded
- Fixed potential command injection in symbol extraction by using `execFileSync` with argument arrays
- Fixed `chmod` being called unconditionally on non-dumpstorm binaries even on Windows
- Fixed default symbol path (`/tmp/symbols`) not being appropriate for Windows — now uses `~/.dumpstorm/symbols`

### Improved
- Replaced FIFO cache eviction with LRU in `SymbolTableCache` for better cache utilization
- Pre-sorted symbol table entries are now cached to avoid re-sorting on every `findNearestSymbol` call
- Deduplicated `isNmAvailable()` and `getNmCommand()` into a shared `findNmBinaryPath()` helper
- Migrated debug logging from `console.log` to a dedicated VS Code `OutputChannel` ("DumpStorm")
- Unified `require('child_process')` to standard ES module `import` across all files
- Removed deprecated `globals['ts-jest']` from Jest configuration
- `deactivate()` now clears the symbol table cache to release memory
- Added "Debuggers" to VS Code Marketplace categories for better discoverability

## [1.0.3]

### Added
- Initial public release with minidump analysis, symbol extraction, stack trace enhancement
- Register tooltips with crash analysis insights
- Cross-platform support (Windows, macOS, Linux)
- Multi-language support (English, Simplified Chinese)
- Auto-installation of analysis tools (minidump_stackwalk, llvm-nm)
