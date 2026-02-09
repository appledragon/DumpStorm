# DumpStorm 测试用 Dump 文件

此目录包含用于测试 DumpStorm 扩展的示例 minidump (.dmp) 文件。

## 文件列表

### 正常崩溃场景

| 文件名 | 架构 | 异常类型 | 说明 |
|--------|------|----------|------|
| `crash_access_violation_x64.dmp` | x64 | ACCESS_VIOLATION (0xC0000005) | 访问违例，包含 5 个模块 |
| `crash_stack_overflow_x64.dmp` | x64 | STACK_OVERFLOW (0xC00000FD) | 栈溢出 |
| `crash_illegal_instruction_x64.dmp` | x64 | ILLEGAL_INSTRUCTION (0xC000001D) | 非法指令 |
| `crash_divide_by_zero_x86.dmp` | x86 | INTEGER_DIVIDE_BY_ZERO (0xC0000094) | 整数除零，32位应用 |
| `crash_breakpoint_x64.dmp` | x64 | BREAKPOINT (0x80000003) | 断点/断言失败，包含 7 个模块、8 个线程 |
| `crash_heap_corruption_x64.dmp` | x64 | HEAP_CORRUPTION (0xC0000374) | 堆损坏，游戏引擎场景 |
| `crash_stack_buffer_overrun_x64.dmp` | x64 | STACK_BUFFER_OVERRUN (0xC0000409) | 栈缓冲区溢出 (/GS 安全检查) |
| `crash_access_violation_arm64.dmp` | ARM64 | ACCESS_VIOLATION (0xC0000005) | ARM64 架构访问违例 |
| `crash_multithread_x64.dmp` | x64 | ACCESS_VIOLATION (0xC0000005) | 32 线程多线程压力测试 |

### 边界测试

| 文件名 | 说明 |
|--------|------|
| `empty.dmp` | 最小化空 dump（有效头部，无模块/线程/异常） |
| `corrupted.dmp` | 损坏的文件（无效数据，用于错误处理测试） |
| `truncated.dmp` | 截断的 dump 文件（仅 64 字节，有效头但内容不完整） |

## 使用方法

### 在 VS Code 中测试

1. 打开 DumpStorm 扩展
2. 使用 `DumpStorm: Analyze Dump File` 命令
3. 选择此目录中的 `.dmp` 文件

### 重新生成

```bash
cd examples
node generate-test-dumps.js
```

## 注意事项

- 这些是结构上有效的 minidump 文件，包含正确的 MDMP 头部签名和流目录
- 文件不包含实际的内存数据或线程上下文（寄存器值），仅包含结构性元数据
- `minidump_stackwalk` 可以识别这些文件的头部信息，但分析输出会比较有限
- 用于测试扩展的文件加载、解析、错误处理和 UI 展示功能
