# Minidump Parser 🔍

A powerful Visual Studio Code extension for analyzing crash dump files (minidump only) and performing postmortem analysis with an intuitive sidebar interface.

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue)](https://marketplace.visualstudio.com/items?itemName=appledragon.minidump-parser)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform Support](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/appledragon/DumpStorm)

## 🚀 Key Features

- 🔬 **Advanced Crash Analysis**: Comprehensive minidump (.dmp) file analysis with stack traces, registers, and memory dumps
- 🧠 **Intelligent Root Cause Detection**: Pattern matching to identify common crash causes (use-after-free, null pointer, buffer overflow, stack overflow, uninitialized memory, heap corruption)
- 📝 **Text-based Crash Enhancement**: Enhance text-format crash dumps with symbol information
- 🎯 **Register Tooltips**: Interactive hover information for CPU registers with crash analysis insights
- 📊 **Symbol Enhancement**: Extract and apply symbols for better crash analysis
- 🌐 **Cross-Platform Support**: Works seamlessly on Windows, macOS, and Linux
- ⚡ **Auto-Installation**: Automatically installs required analysis tools

## 📦 Installation

### From VS Code Marketplace (Recommended)
1. Open VS Code → Extensions (Ctrl+Shift+X / Cmd+Shift+X)
2. Search for "Minidump Parser" → Click "Install"

### Quick Start
1. Install the extension
2. Click the **Minidump Parser** icon in the Activity Bar
3. Open a crash dump file (.dmp) or text-based crash log
4. Start analyzing!

## 📁 Supported File Types

### ✅ **Minidump Files** (.dmp, .dump)
- Complete crash analysis with stack traces, register dumps, and memory information
- Uses minidump_stackwalk for comprehensive analysis

### ✅ **Text-based Crashes** (.txt, .crash, .log)
- Symbol resolution for addresses in text-based crash logs
- Supports macOS crash reports, Android tombstone logs, custom stack traces

## 🎯 Usage

### Sidebar Panel
1. Click **Minidump Parser** icon in Activity Bar
2. Use panel buttons:
   - **Open Dump File**: Analyze .dmp files
   - **Set Symbol Path**: Configure symbol directory
   - **Extract Symbols**: Extract symbols from binaries
   - **Enhance Stack Trace**: Enhance text-based crashes
   - **Tool Configuration**: Install/configure analysis tools

### Register Tooltips
Hover over register names (e.g., `eax`, `rsp`, `pc`) in analysis results to view:
- Register descriptions and purposes
- Current value interpretation
- Crash analysis insights
- Supported architectures: x86, x64, ARM

## ⚙️ Configuration

```json
{
    "minidump-parser.symbolPath": "/path/to/your/symbols",
    "minidump-parser.customMinidumpStackwalkPath": "/custom/path/to/minidump_stackwalk",
    "minidump-parser.customNmPath": "/custom/path/to/nm",
    "minidump-parser.language": "en"
}
```

## 📋 Requirements

- **VS Code**: Version 1.75.0 or higher
- **Analysis Tool**: `minidump-stackwalk` (auto-installed)
- **Symbol Extraction**: `nm`/`llvm-nm` (auto-installed)

## 🌍 Contributing Translations

Currently supported: English, Chinese (Simplified)

To add new languages:
1. Fork repository → Navigate to `src/localization/locales/`
2. Create language file (e.g., `fr.json`)
3. Translate strings from `en.json`
4. Submit pull request


## 🐛 Known Issues
- First-time tool installation requires internet connection
- **Only supports minidumps
