# DumpStorm 测试用 Dump 文件

此目录包含用于测试 DumpStorm 扩展的**合成** minidump (.dmp) 文件。

这些文件现在包含可读取的 stream、线程 context 和合成栈内存，因此
`minidump_stackwalk` 可以正常读取并输出至少一个 context 栈帧。但它们不是
真实进程捕获的崩溃转储，不包含真实代码或匹配的调试符号，不能用来验证
真实应用的符号化结果。

## 文件列表

### 正常崩溃场景

| 文件名 | 架构 | 异常类型 | 说明 |
|--------|------|----------|------|
| `crash_access_violation_x64.dmp` | x64 | ACCESS_VIOLATION (0xC0000005) | 合成访问违例，包含 5 个模块 |
| `crash_stack_overflow_x64.dmp` | x64 | STACK_OVERFLOW (0xC00000FD) | 合成栈溢出 |
| `crash_illegal_instruction_x64.dmp` | x64 | ILLEGAL_INSTRUCTION (0xC000001D) | 合成非法指令 |
| `crash_divide_by_zero_x86.dmp` | x86 | INTEGER_DIVIDE_BY_ZERO (0xC0000094) | 合成整数除零，32 位应用 |
| `crash_breakpoint_x64.dmp` | x64 | BREAKPOINT (0x80000003) | 合成断点/断言失败，包含 7 个模块、8 个线程 |
| `crash_heap_corruption_x64.dmp` | x64 | HEAP_CORRUPTION (0xC0000374) | 合成堆损坏，游戏引擎场景 |
| `crash_stack_buffer_overrun_x64.dmp` | x64 | STACK_BUFFER_OVERRUN (0xC0000409) | 合成栈缓冲区溢出 (/GS 安全检查) |
| `crash_access_violation_arm64.dmp` | ARM64 | ACCESS_VIOLATION (0xC0000005) | 合成 ARM64 访问违例 |
| `crash_multithread_x64.dmp` | x64 | ACCESS_VIOLATION (0xC0000005) | 合成 32 线程压力测试 |

### 边界测试

| 文件名 | 说明 |
|--------|------|
| `empty.dmp` | 最小化空 dump（有效头部，无模块/线程/异常，仅用于边界测试） |

## 使用方法

### 在 VS Code 中测试

1. 打开 DumpStorm 扩展
2. 使用 `DumpStorm: Analyze Dump File` 命令
3. 选择此目录中的 `.dmp` 文件

### 重新生成合成 fixture

```bash
cd examples
node generate-test-dumps.js
```

### 生成真实崩溃 dump

如果需要验证真实寄存器、栈内存、代码和符号，请使用
`tests/crashers/` 中的原生崩溃测试程序：

```bash
node tests/run_crash_tests.js
```

## 注意事项

- 合成 fixture 不包含真实代码和 `.sym` 文件；没有符号时出现 symbol lookup
  警告是预期行为，不等同于 dump 结构损坏。
- 如果 stderr 出现 `ReadString`、`size mismatch`、无效 context/memory region
  或 `No stackwalker` 等严重诊断，结果应在扩展中显示为“部分分析”或“分析无效”，
  而不是“分析完成”。
- 这些文件用于测试扩展的文件加载、基本 stackwalk、错误处理和 UI 展示。
