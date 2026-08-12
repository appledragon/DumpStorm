# Changelog

All notable changes to the DumpStorm extension will be documented in this file.

## [1.1.0] - 2026-08-13

### Fixed
- **PowerShell extract on Windows**: Archive extraction no longer fails silently when the install path contains spaces; paths are passed through environment variables instead of interpolated into the script
- **Symbol match report**: Look up Breakpad `.sym` files by `debug_file` (PDB) instead of `code_file` (exe/dll) so Windows modules can match
- **Download redirects**: Remove error/timeout listeners from the previous request when following GitHub redirects, and refuse HTTPS→HTTP downgrades
- **Tool install cancellation**: Detect cancel via the cancellation token instead of comparing localized strings; clean up uniquely named temp files on failure; do not treat cancel-after-success as failure
- **Analysis timeout copy**: Timeout message now reports the actual 240s overall limit instead of 120s
- **Diagnostic dedup**: Deduplicate severe diagnostics with a `Set` and cap the number of entries
- **llvm-undname**: Listen for stdin errors so a closed pipe cannot crash the extension; skip demangling when the output line count does not match the input
- **Default symbol path**: Empty `symbolPath` now uses `~/.dumpstorm/symbols` on Windows (the 1.0.4 fix never took effect because package.json still defaulted to `/tmp/symbols`)
- **Language auto**: Language setting defaults to `auto` and follows the VS Code display language

## [1.0.9] - 2026-08-12

### Added
- **Machine-format dump analysis**: Parse minidump_stackwalk `-m` output for crash summaries and more reliable stack reconstruction
- **Stackwalk timeout and cancel**: Bound dump analysis with timeouts and support cancellation
- **Crash summary and symbol match report**: Surface crashing module/exception info and report which modules have matching Breakpad symbols
- **Stack-scan frame folding**: Fold contiguous low-confidence stack-scanning frames; enable `showStackScanFrames` to show every frame
- **Custom tool paths**: `customDumpSymsPath` and `customLlvmUndnamePath` settings for Breakpad dump_syms and llvm-undname
- **Release validation**: `scripts/validate-extension.js` checks locales, commands, and configuration before packaging
- Example dumps and a large unit-test suite covering analysis, installers, and downloads

### Improved
- **Downloader**: Shared `download.ts` with curl-based installers using async downloads and unique temp-file suffixes

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
