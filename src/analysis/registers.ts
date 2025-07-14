import * as vscode from 'vscode';
import { localization } from '../localization/localization';

export interface RegisterInfo {
    name: string;
    description: string;
    purpose: string;
    usage: string;
    architecture: string;
}

export class RegisterTooltipProvider implements vscode.HoverProvider {
    private registerDatabase: Map<string, RegisterInfo> = new Map();

    constructor() {
        this.initializeRegisterDatabase();
        
        // Listen for configuration changes to reload when language changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('minidump-parser.language')) {
                localization.reload();
                this.initializeRegisterDatabase();
            }
        });
    }

    private initializeRegisterDatabase() {
        // Clear existing database
        this.registerDatabase.clear();
        
        // Get all available register names from localization
        const allRegisterNames = [
            // x86/x64 General Purpose Registers
            'eax', 'rax', 'ebx', 'rbx', 'ecx', 'rcx', 'edx', 'rdx',
            'esi', 'rsi', 'edi', 'rdi', 'esp', 'rsp', 'ebp', 'rbp',
            'eip', 'rip',
            
            // x64 Extended Registers
            'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
            
            // Flag Registers
            'eflags', 'efl', 'rflags', 'rfl', 'flags',
            
            // ARM Registers
            'r0', 'r1', 'r2', 'r3', 'fp', 'sp', 'lr', 'pc',
            
            // ARM numbered registers
            'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
            
            // x64 32-bit parts
            'r8d', 'r9d', 'r10d', 'r11d',
            
            // x87 FPU stack registers
            'st0', 'st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7',
            
            // MMX registers
            'mm0', 'mm1', 'mm2', 'mm3', 'mm4', 'mm5', 'mm6', 'mm7',
            
            // Debug registers
            'dr0', 'dr1', 'dr2', 'dr3', 'dr6', 'dr7',
            
            // Control registers
            'cr0', 'cr2', 'cr3', 'cr4',
            
            // Segment registers
            'cs', 'ds', 'es', 'fs', 'gs', 'ss',
            
            // SSE registers
            'mxcsr'
        ];
        
        // Add XMM registers (0-15)
        for (let i = 0; i <= 15; i++) {
            allRegisterNames.push(`xmm${i}`);
        }
        
        // Add YMM registers (0-15)
        for (let i = 0; i <= 15; i++) {
            allRegisterNames.push(`ymm${i}`);
        }
        
        // Add ARM64 registers (x0-x28)
        for (let i = 0; i <= 28; i++) {
            allRegisterNames.push(`x${i}`);
        }
        
        // Add ARM64 32-bit registers (w0-w28)
        for (let i = 0; i <= 28; i++) {
            allRegisterNames.push(`w${i}`);
        }
        
        // Load register information from localization
        for (const regName of allRegisterNames) {
            const regInfo = localization.getRegisterInfo(regName);
            if (regInfo) {
                this.registerDatabase.set(regName, regInfo);
            } else {
                // Fallback: create basic info for registers not in localization files
                this.registerDatabase.set(regName, this.createFallbackRegisterInfo(regName));
            }
        }
        
        // Add register aliases and variants
        this.addRegisterAliases();
        this.addRegisterVariants();
    }

    private createFallbackRegisterInfo(registerName: string): RegisterInfo {
        // Create basic fallback information for registers not in localization files
        const name = registerName.toUpperCase();
        
        // Determine architecture and basic info based on register name patterns
        let architecture = 'Unknown';
        let description = `Register ${name}`;
        let purpose = 'General purpose register';
        let usage = 'Used for general data storage and operations';
        
        if (registerName.startsWith('r') && /^r\d+/.test(registerName)) {
            architecture = registerName.includes('d') ? 'x64' : 'x64';
            description = `64-bit general purpose register ${name}`;
        } else if (registerName.startsWith('x') && /^x\d+/.test(registerName)) {
            architecture = 'ARM64';
            description = `64-bit ARM64 general purpose register ${name}`;
            purpose = 'General purpose register';
            usage = 'Used for general data storage and operations in ARM64 architecture';
        } else if (registerName.startsWith('w') && /^w\d+/.test(registerName)) {
            architecture = 'ARM64';
            description = `32-bit ARM64 general purpose register ${name}`;
            purpose = '32-bit data operations';
            usage = 'Lower 32 bits of ARM64 X register, automatically zeros upper 32 bits when operated on';
        } else if (registerName.startsWith('xmm')) {
            architecture = 'x86/x64';
            description = `128-bit SIMD register ${name}`;
            purpose = 'SIMD floating point operations';
            usage = 'Used for SSE floating point and vector operations';
        } else if (registerName.startsWith('ymm')) {
            architecture = 'x86/x64';
            description = `256-bit AVX register ${name}`;
            purpose = 'AVX vector operations';
            usage = 'Used for AVX 256-bit vector operations';
        } else if (registerName.startsWith('st')) {
            architecture = 'x86/x64';
            description = `x87 floating point stack register ${name}`;
            purpose = 'Floating point operations';
            usage = 'Stack-based register in x87 FPU';
        } else if (registerName.startsWith('mm')) {
            architecture = 'x86/x64';
            description = `64-bit MMX register ${name}`;
            purpose = 'Multimedia data processing';
            usage = '64-bit register for MMX instruction set';
        } else if (registerName.startsWith('dr')) {
            architecture = 'x86/x64';
            description = `Debug register ${name}`;
            purpose = 'Hardware debugging';
            usage = 'Used for hardware breakpoints and debugging';
        } else if (registerName.startsWith('cr')) {
            architecture = 'x86/x64';
            description = `Control register ${name}`;
            purpose = 'System control';
            usage = 'Controls processor operating mode and state';
        }
        
        return {
            name,
            description,
            purpose,
            usage,
            architecture
        };
    }

    private addRegisterAliases() {
        // Add common aliases
        const aliases = [
            // Flag register aliases
            ['efl', 'eflags'],
            ['rfl', 'rflags'],
            ['flags', 'eflags'],
            
            // ARM aliases
            ['r11', 'fp'],
            ['r13', 'sp'],
            ['r14', 'lr'],
            ['r15', 'pc'],
            ['ip', 'r12'] // ARM intra-procedure call register
        ];
        
        for (const [alias, original] of aliases) {
            const originalInfo = this.registerDatabase.get(original);
            if (originalInfo) {
                this.registerDatabase.set(alias, {
                    ...originalInfo,
                    name: alias.toUpperCase()
                });
            }
        }
    }

    private addRegisterVariants() {
        // Add 16-bit and 8-bit register variants
        const variants = new Map([
            ['ax', 'eax'], ['bx', 'ebx'], ['cx', 'ecx'], ['dx', 'edx'],
            ['al', 'eax'], ['bl', 'ebx'], ['cl', 'ecx'], ['dl', 'edx'],
            ['ah', 'eax'], ['bh', 'ebx'], ['ch', 'ecx'], ['dh', 'edx'],
            ['si', 'esi'], ['di', 'edi'], ['sp', 'esp'], ['bp', 'ebp'],
        ]);

        for (const [variant, base] of variants) {
            const baseInfo = this.registerDatabase.get(base);
            if (baseInfo) {
                this.registerDatabase.set(variant, {
                    ...baseInfo,
                    name: variant.toUpperCase(),
                    description: `Sub-register of ${baseInfo.description}`
                });
            }
        }
        
        // Add x64 32-bit parts that aren't in localization
        for (let i = 12; i <= 15; i++) {
            const base = `r${i}`;
            const variant = `r${i}d`;
            const baseInfo = this.registerDatabase.get(base);
            if (baseInfo) {
                this.registerDatabase.set(variant, {
                    ...baseInfo,
                    name: variant.toUpperCase(),
                    description: `32-bit part of ${baseInfo.description}`,
                    purpose: '32-bit data operations',
                    usage: `Lower 32 bits of R${i} register, automatically zeros upper 32 bits when operated on`
                });
            }
        }
        
        // Add ARM numbered registers with basic info
        for (let i = 4; i <= 12; i++) {
            if (!this.registerDatabase.has(`r${i}`)) {
                this.registerDatabase.set(`r${i}`, {
                    name: `R${i}`,
                    description: `ARM general purpose register R${i}`,
                    purpose: i <= 7 ? 'General register, local variables' : 'General register, callee-saved',
                    usage: i <= 7 ? 'Working register in ARM calling convention' : 'Register that callee must save in ARM calling convention',
                    architecture: 'ARM'
                });
            }
        }
        
        // Add ARM64 numbered registers with basic info
        for (let i = 0; i <= 28; i++) {
            if (!this.registerDatabase.has(`x${i}`)) {
                this.registerDatabase.set(`x${i}`, {
                    name: `X${i}`,
                    description: `ARM64 general purpose register X${i}`,
                    purpose: i <= 7 ? 'General register, function arguments' : 
                            i <= 15 ? 'General register, caller-saved' : 
                            i <= 28 ? 'General register, callee-saved' : 'General register',
                    usage: i <= 7 ? `Function argument/return value register in ARM64 calling convention` : 
                          i <= 15 ? 'Temporary register in ARM64 calling convention' : 
                          'Callee-saved register in ARM64 calling convention',
                    architecture: 'ARM64'
                });
            }
        }
    }

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        const range = document.getWordRangeAtPosition(position);
        if (!range) {
            return;
        }

        const word = document.getText(range);
        const line = document.lineAt(position.line).text;

        // Check if in register context
        if (!this.isRegisterContext(line, word, document)) {
            return;
        }

        const registerInfo = this.getRegisterInfo(word);
        if (!registerInfo) {
            return;
        }

        const markdown = new vscode.MarkdownString();
        markdown.isTrusted = true;
        
        markdown.appendMarkdown(`## ${registerInfo.name}\n\n`);
        markdown.appendMarkdown(`**${localization.getUI('description')}**: ${registerInfo.description}\n\n`);
        markdown.appendMarkdown(`**${localization.getUI('mainPurpose')}**: ${registerInfo.purpose}\n\n`);
        markdown.appendMarkdown(`**${localization.getUI('usageScenarios')}**: ${registerInfo.usage}\n\n`);
        markdown.appendMarkdown(`**${localization.getUI('architecture')}**: ${registerInfo.architecture}\n\n`);

        // Add value information (if can be parsed)
        const registerValue = this.extractRegisterValue(line, word);
        if (registerValue) {
            markdown.appendMarkdown(`**${localization.getUI('currentValue')}**: \`${registerValue}\`\n\n`);
            
            // Try to interpret value meaning
            const valueInfo = this.interpretRegisterValue(registerValue);
            if (valueInfo) {
                markdown.appendMarkdown(`**${localization.getUI('valueMeaning')}**: ${valueInfo}\n\n`);
            }

            // Add crash analysis related information
            const crashInfo = this.analyzeCrashContext(word, registerValue, line);
            if (crashInfo) {
                markdown.appendMarkdown(`**${localization.getUI('crashAnalysis')}**: ${crashInfo}\n\n`);
            }
        } else {
            // If value not found in current line, try searching in document
            const documentLines = document.getText().split('\n');
            const foundValue = this.searchRegisterValueInDocument(documentLines, word);
            if (foundValue) {
                markdown.appendMarkdown(`**${localization.getUI('currentValue')}**: \`${foundValue}\`\n\n`);
                
                const valueInfo = this.interpretRegisterValue(foundValue);
                if (valueInfo) {
                    markdown.appendMarkdown(`**${localization.getUI('valueMeaning')}**: ${valueInfo}\n\n`);
                }
            } else {
                // Add debug info showing why value was not extracted
                const debugMsg = `Register "${word}" value not found in line "${line.trim()}"`;
                markdown.appendMarkdown(`**${localization.getUI('debugInfo')}**: ${debugMsg}\n\n`);
            }
        }

        // Add debugging suggestions
        const debugTips = this.getDebugTips(registerInfo, registerValue);
        if (debugTips.length > 0) {
            markdown.appendMarkdown(`**${localization.getUI('debugTips')}**:\n`);
            debugTips.forEach(tip => {
                markdown.appendMarkdown(`- ${tip}\n`);
            });
        }

        return new vscode.Hover(markdown, range);
    }

    private isRegisterContext(line: string, word: string, document?: vscode.TextDocument): boolean {
        // Check if in register-related line - updated complete register pattern
        const registerPattern = /\b(eax|rax|ebx|rbx|ecx|rcx|edx|rdx|esi|rsi|edi|rdi|esp|rsp|ebp|rbp|eip|rip|r\d+|r\d+d|x\d+|eflags|rflags|efl|rfl|flags|xmm\d+|ymm\d+|st\d+|mm\d+|dr\d+|cr\d+|cs|ds|es|fs|gs|ss|fp|sp|lr|pc|ip|mxcsr)\b/i;
        
        // Check if line contains register information
        const isRegisterLine = registerPattern.test(line) && 
               (line.includes('=') || line.includes(':') || line.includes('Register') || 
                line.includes('CPU Context') || line.includes('Thread') ||
                line.includes('0x') || this.registerDatabase.has(word.toLowerCase()));

        // Additional check: whether in dump analysis result context
        const isDumpContext = line.toLowerCase().includes('cpu context') ||
                             line.toLowerCase().includes('registers') ||
                             line.toLowerCase().includes('crashed thread') ||
                             line.toLowerCase().includes('exception') ||
                             line.toLowerCase().includes('stack pointer') ||
                             line.includes('Thread ') ||
                             /^\s*[a-z0-9]+\s*[=:]\s*0x[0-9a-f]+/i.test(line);

        // If document info available, check document content to determine if it's dump analysis result
        if (document) {
            const documentContent = document.getText();
            const isDumpAnalysisDocument = 
                documentContent.includes('CPU Context') ||
                documentContent.includes('Exception') ||
                documentContent.includes('Thread') ||
                documentContent.includes('Crash') ||
                documentContent.includes('minidump') ||
                documentContent.includes('Stack trace') ||
                /crashed thread/i.test(documentContent) ||
                /register/i.test(documentContent);
            
            // If document looks like dump analysis result and current word is known register, show tooltip
            if (isDumpAnalysisDocument && this.registerDatabase.has(word.toLowerCase())) {
                return true;
            }
        }

        return isRegisterLine || (isDumpContext && this.registerDatabase.has(word.toLowerCase()));
    }

    private getRegisterInfo(word: string): RegisterInfo | undefined {
        const lowerWord = word.toLowerCase();
        
        // Direct lookup
        if (this.registerDatabase.has(lowerWord)) {
            return this.registerDatabase.get(lowerWord);
        }

        // Handle registers with numbers (like r8d, r9d etc.)
        const numericRegisterMatch = word.match(/^r(\d+)[dwb]?$/i);
        if (numericRegisterMatch) {
            const baseRegister = `r${numericRegisterMatch[1]}`;
            if (this.registerDatabase.has(baseRegister)) {
                const baseInfo = this.registerDatabase.get(baseRegister)!;
                return {
                    ...baseInfo,
                    name: word.toUpperCase(),
                    description: `Sub-register of ${baseInfo.description}`
                };
            }
        }

        // Handle ARM64 registers with numbers (like x0-x28, w0-w28 etc.)
        const arm64RegisterMatch = word.match(/^([xw])(\d+)$/i);
        if (arm64RegisterMatch) {
            const prefix = arm64RegisterMatch[1].toLowerCase();
            const regNum = arm64RegisterMatch[2];
            const baseRegister = `x${regNum}`;
            
            if (this.registerDatabase.has(baseRegister)) {
                const baseInfo = this.registerDatabase.get(baseRegister)!;
                if (prefix === 'w') {
                    // W register is 32-bit part of X register
                    return {
                        ...baseInfo,
                        name: word.toUpperCase(),
                        description: `32-bit part of ${baseInfo.description}`,
                        purpose: '32-bit data operations',
                        usage: `Lower 32 bits of X${regNum} register, automatically zeros upper 32 bits when operated on`
                    };
                } else {
                    // X register - return base info
                    return {
                        ...baseInfo,
                        name: word.toUpperCase()
                    };
                }
            }
        }

        // Handle 16-bit/8-bit register variants
        const registerVariants = new Map([
            ['ax', 'eax'], ['bx', 'ebx'], ['cx', 'ecx'], ['dx', 'edx'],
            ['al', 'eax'], ['bl', 'ebx'], ['cl', 'ecx'], ['dl', 'edx'],
            ['ah', 'eax'], ['bh', 'ebx'], ['ch', 'ecx'], ['dh', 'edx'],
            ['si', 'esi'], ['di', 'edi'], ['sp', 'esp'], ['bp', 'ebp'],
        ]);

        const baseRegister = registerVariants.get(lowerWord);
        if (baseRegister && this.registerDatabase.has(baseRegister)) {
            const baseInfo = this.registerDatabase.get(baseRegister)!;
            return {
                ...baseInfo,
                name: word.toUpperCase(),
                description: `Sub-register of ${baseInfo.description}`
            };
        }

        return undefined;
    }

    private extractRegisterValue(line: string, registerName: string): string | undefined {
        // Try to extract register value, supporting multiple formats
        const patterns = [
            // Format: eax = 0x12345678 or eax = 12345678
            new RegExp(`\\b${registerName}\\s*[=:]\\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)\\b`, 'i'),
            // Format: eax 0x12345678 (space separated)
            new RegExp(`\\b${registerName}\\s+(0x[0-9a-fA-F]+|[0-9a-fA-F]+)\\b`, 'i'),
            // Format: eax: 0x12345678 (colon separated)
            new RegExp(`\\b${registerName}:\\s*(0x[0-9a-fA-F]+|[0-9a-fA-F]+)\\b`, 'i'),
        ];

        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) {
                let value = match[1];
                // Ensure value starts with 0x, add if not present
                if (!value.startsWith('0x') && /^[0-9a-fA-F]+$/.test(value)) {
                    value = '0x' + value;
                }
                return value;
            }
        }

        return undefined;
    }

    private searchRegisterValueInDocument(lines: string[], registerName: string): string | undefined {
        // Search for register value in entire document
        for (const line of lines) {
            const value = this.extractRegisterValue(line, registerName);
            if (value) {
                return value;
            }
        }
        return undefined;
    }

    private interpretRegisterValue(value: string): string | undefined {
        let numValue: number;
        
        // Parse hexadecimal value
        if (value.startsWith('0x')) {
            numValue = parseInt(value, 16);
        } else {
            numValue = parseInt(value, 16);
        }

        if (isNaN(numValue)) {
            return undefined;
        }

        const interpretations: string[] = [];

        // Check if it's null pointer
        if (numValue === 0) {
            interpretations.push(localization.getValue('nullPointer'));
        }

        // Check if it's common memory address range
        if (numValue >= 0x400000 && numValue <= 0x7FFFFFFF) {
            interpretations.push(localization.getValue('userSpaceAddress'));
        } else if (numValue >= 0x80000000) {
            interpretations.push(localization.getValue('kernelSpaceAddress'));
        }

        // Check if it's small integer value
        if (numValue > 0 && numValue < 1000) {
            interpretations.push(localization.getFormattedValue('smallInteger', numValue));
        }

        // Check if it's ASCII character
        if (numValue >= 32 && numValue <= 126) {
            interpretations.push(localization.getFormattedValue('asciiCharacter', String.fromCharCode(numValue)));
        }

        // Check if it's boolean value
        if (numValue === 1) {
            interpretations.push(localization.getValue('booleanValue'));
        }

        return interpretations.length > 0 ? interpretations.join(', ') : undefined;
    }

    private analyzeCrashContext(registerName: string, value: string, line: string): string | undefined {
        const lowerRegisterName = registerName.toLowerCase();
        let numValue: number;
        
        if (value.startsWith('0x')) {
            numValue = parseInt(value, 16);
        } else {
            numValue = parseInt(value, 16);
        }

        if (isNaN(numValue)) {
            return undefined;
        }

        const crashAnalysis: string[] = [];

        // Crash analysis for specific registers
        if ((lowerRegisterName === 'eip' || lowerRegisterName === 'rip') && numValue === 0) {
            crashAnalysis.push(localization.getCrash('nullInstructionPointer'));
        }

        if ((lowerRegisterName === 'esp' || lowerRegisterName === 'rsp') && numValue < 0x1000) {
            crashAnalysis.push(localization.getCrash('lowStackPointer'));
        }

        if (lowerRegisterName === 'eax' || lowerRegisterName === 'rax') {
            if (numValue === 0xC0000005) {
                crashAnalysis.push(localization.getCrash('accessViolationReturn'));
            } else if (numValue === 0xC0000001) {
                crashAnalysis.push(localization.getCrash('unimplementedFunction'));
            }
        }

        // Check if it's common error code
        if (this.isCommonErrorCode(numValue)) {
            crashAnalysis.push(this.getErrorCodeDescription(numValue));
        }

        // Check pointer-related issues
        if (numValue > 0 && numValue < 0x1000) {
            crashAnalysis.push(localization.getCrash('lowAddressValue'));
        }

        return crashAnalysis.length > 0 ? crashAnalysis.join(', ') : undefined;
    }

    private getDebugTips(registerInfo: RegisterInfo, value?: string): string[] {
        const tips: string[] = [];
        const lowerName = registerInfo.name.toLowerCase();

        // Give debugging suggestions based on register type
        if (lowerName.includes('eip') || lowerName.includes('rip')) {
            tips.push(localization.getDebugTip('checkDisassembly'));
            tips.push(localization.getDebugTip('verifyCodeAddress'));
            if (value) {
                tips.push(localization.getDebugTip('useSymbolTable'));
            }
        }

        if (lowerName.includes('esp') || lowerName.includes('rsp')) {
            tips.push(localization.getDebugTip('checkStackIntegrity'));
            tips.push(localization.getDebugTip('checkStackTrace'));
            tips.push(localization.getDebugTip('checkStackOverflow'));
        }

        if (lowerName.includes('ebp') || lowerName.includes('rbp')) {
            tips.push(localization.getDebugTip('checkStackFrame'));
            tips.push(localization.getDebugTip('checkLocalVariables'));
        }

        if (lowerName.includes('eax') || lowerName.includes('rax')) {
            tips.push(localization.getDebugTip('functionReturnValue'));
            tips.push(localization.getDebugTip('checkErrorStatus'));
        }

        if (registerInfo.architecture === 'x64' && (lowerName.includes('rcx') || lowerName.includes('rdx') || lowerName.includes('r8') || lowerName.includes('r9'))) {
            tips.push(localization.getDebugTip('functionParameter'));
            tips.push(localization.getDebugTip('checkCallingConvention'));
        }

        // Add value-related suggestions if value exists
        if (value) {
            const numValue = value.startsWith('0x') ? parseInt(value, 16) : parseInt(value, 16);
            if (!isNaN(numValue)) {
                if (numValue === 0) {
                    tips.push(localization.getDebugTip('nullValueWarning'));
                }
                if (numValue > 0x400000 && numValue < 0x7FFFFFFF) {
                    tips.push(localization.getDebugTip('useMemoryViewer'));
                }
            }
        }

        return tips;
    }

    private isCommonErrorCode(value: number): boolean {
        const commonErrorCodes = [
            0xC0000005, // ACCESS_VIOLATION
            0xC0000001, // STATUS_UNSUCCESSFUL
            0xC000001D, // STATUS_ILLEGAL_INSTRUCTION
            0xC0000094, // STATUS_INTEGER_DIVIDE_BY_ZERO
            0xC00000FD, // STATUS_STACK_OVERFLOW
            0x80000003, // STATUS_BREAKPOINT
            0x80000004, // STATUS_SINGLE_STEP
        ];
        
        return commonErrorCodes.includes(value);
    }

    private getErrorCodeDescription(value: number): string {
        const errorMap = new Map([
            [0xC0000005, 'accessViolation'],
            [0xC0000001, 'statusUnsuccessful'],
            [0xC000001D, 'illegalInstruction'],
            [0xC0000094, 'divideByZero'],
            [0xC00000FD, 'stackOverflow'],
            [0x80000003, 'breakpoint'],
            [0x80000004, 'singleStep']
        ]);

        const errorKey = errorMap.get(value);
        if (errorKey) {
            return localization.getError(errorKey);
        }

        return localization.getFormattedError('errorCode', value.toString(16).toUpperCase());
    }
}
