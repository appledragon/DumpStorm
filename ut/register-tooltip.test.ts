import * as assert from 'assert';
import * as vscode from 'vscode';
import { RegisterTooltipProvider } from '../src/analysis/registers';

// Helper: create a mock text document from content
function createMockDocument(content: string): vscode.TextDocument {
    const lines = content.split('\n');
    return {
        getText: (range?: any) => {
            if (!range) { return content; }
            return lines[range.start.line].substring(range.start.character, range.end.character);
        },
        lineAt: (line: number) => ({ text: lines[line], range: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, lines[line].length)) }),
        getWordRangeAtPosition: (position: vscode.Position) => {
            const line = lines[position.line] || '';
            // Find the word boundary around the position
            const wordPattern = /[a-zA-Z_]\w*/g;
            let match;
            while ((match = wordPattern.exec(line)) !== null) {
                const start = match.index;
                const end = start + match[0].length;
                if (position.character >= start && position.character < end) {
                    return new vscode.Range(
                        new vscode.Position(position.line, start),
                        new vscode.Position(position.line, end)
                    );
                }
            }
            return undefined;
        },
        uri: vscode.Uri.file('test.txt'),
        fileName: 'test.txt',
        isUntitled: true,
        languageId: 'plaintext',
        version: 1,
        isDirty: false,
        isClosed: false,
        eol: 1,
        lineCount: lines.length,
        save: () => Promise.resolve(true),
        offsetAt: () => 0,
        positionAt: () => new vscode.Position(0, 0),
        validateRange: (r: any) => r,
        validatePosition: (p: any) => p,
    } as any;
}

describe('RegisterTooltipProvider', () => {
    let provider: RegisterTooltipProvider;
    const cancelToken: vscode.CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: new vscode.EventEmitter<any>().event
    };

    beforeEach(() => {
        provider = new RegisterTooltipProvider();
    });

    describe('ARM64 Register Support', () => {
        it('should recognize x0-x28 registers', () => {
            // Create a mock document with ARM64 register content
            const content = 'CPU Context:\nx0 = 0x0000000100000000\nx15 = 0x0000000200000000\nx28 = 0x0000000300000000';
            const document = createMockDocument(content);

            // Test x0 register
            const position0 = new vscode.Position(1, 0);
            const hover0 = provider.provideHover(document, position0, cancelToken);
            assert.notStrictEqual(hover0, undefined, 'Should provide hover for x0 register');

            // Test x15 register
            const position15 = new vscode.Position(2, 0);
            const hover15 = provider.provideHover(document, position15, cancelToken);
            assert.notStrictEqual(hover15, undefined, 'Should provide hover for x15 register');

            // Test x28 register
            const position28 = new vscode.Position(3, 0);
            const hover28 = provider.provideHover(document, position28, cancelToken);
            assert.notStrictEqual(hover28, undefined, 'Should provide hover for x28 register');
        });

        it('should recognize w0-w28 registers (32-bit ARM64)', () => {
            // Create a mock document with ARM64 32-bit register content
            const content = 'CPU Context:\nw0 = 0x12345678\nw15 = 0x87654321\nw28 = 0xABCDEF00';
            const document = createMockDocument(content);

            // Test w0 register
            const position0 = new vscode.Position(1, 0);
            const hover0 = provider.provideHover(document, position0, cancelToken);
            assert.notStrictEqual(hover0, undefined, 'Should provide hover for w0 register');

            // Test w15 register
            const position15 = new vscode.Position(2, 0);
            const hover15 = provider.provideHover(document, position15, cancelToken);
            assert.notStrictEqual(hover15, undefined, 'Should provide hover for w15 register');

            // Test w28 register
            const position28 = new vscode.Position(3, 0);
            const hover28 = provider.provideHover(document, position28, cancelToken);
            assert.notStrictEqual(hover28, undefined, 'Should provide hover for w28 register');
        });

        it('should handle mixed ARM64 and x86/x64 registers', () => {
            // Create a mock document with mixed architecture registers
            const content = 'CPU Context:\neax = 0x12345678\nx0 = 0x0000000100000000\nrax = 0x0000000200000000\nw5 = 0x87654321';
            const document = createMockDocument(content);

            // Test each register type
            const positionEax = new vscode.Position(1, 0);
            const hoverEax = provider.provideHover(document, positionEax, cancelToken);
            assert.notStrictEqual(hoverEax, undefined, 'Should provide hover for eax register');

            const positionX0 = new vscode.Position(2, 0);
            const hoverX0 = provider.provideHover(document, positionX0, cancelToken);
            assert.notStrictEqual(hoverX0, undefined, 'Should provide hover for x0 register');

            const positionRax = new vscode.Position(3, 0);
            const hoverRax = provider.provideHover(document, positionRax, cancelToken);
            assert.notStrictEqual(hoverRax, undefined, 'Should provide hover for rax register');

            const positionW5 = new vscode.Position(4, 0);
            const hoverW5 = provider.provideHover(document, positionW5, cancelToken);
            assert.notStrictEqual(hoverW5, undefined, 'Should provide hover for w5 register');
        });
    });

    describe('Use-After-Free Detection', () => {
        it('should detect MSVC freed heap memory pattern (0xDDDDDDDD)', () => {
            const content = 'CPU Context:\neax = 0xDDDDDDDD';
            const document = createMockDocument(content);
            const position = new vscode.Position(1, 0);
            const hover = provider.provideHover(document, position, cancelToken);
            assert.notStrictEqual(hover, undefined, 'Should provide hover for freed memory pattern');
            const markdown = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
            assert.ok(markdown.value.toLowerCase().includes('free') || markdown.value.includes('freed'),
                'Should mention use-after-free in hover content');
        });

        it('should detect Windows HeapFree pattern (0xFEEEFEEE)', () => {
            const content = 'CPU Context:\nrax = 0xFEEEFEEE';
            const document = createMockDocument(content);
            const position = new vscode.Position(1, 0);
            const hover = provider.provideHover(document, position, cancelToken);
            assert.notStrictEqual(hover, undefined, 'Should provide hover for HeapFree pattern');
            const markdown2 = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
            assert.ok(markdown2.value.toLowerCase().includes('free') || markdown2.value.includes('freed'),
                'Should mention use-after-free in hover content');
        });

        it('should detect DEADBEEF freed memory marker', () => {
            const content = 'CPU Context:\nebx = 0xDEADBEEF';
            const document = createMockDocument(content);
            const position = new vscode.Position(1, 0);
            const hover = provider.provideHover(document, position, cancelToken);
            assert.notStrictEqual(hover, undefined, 'Should provide hover for DEADBEEF pattern');
            const markdown3 = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
            assert.ok(markdown3.value.toLowerCase().includes('free') || markdown3.value.includes('freed'),
                'Should mention use-after-free in hover content');
        });
    });

    describe('Uninitialized Memory Detection', () => {
        it('should detect MSVC uninitialized heap memory pattern (0xCDCDCDCD)', () => {
            const content = 'CPU Context:\neax = 0xCDCDCDCD';
            const document = createMockDocument(content);
            const position = new vscode.Position(1, 0);
            const hover = provider.provideHover(document, position, cancelToken);
            assert.notStrictEqual(hover, undefined, 'Should provide hover for uninitialized heap pattern');
            const markdown4 = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
            assert.ok(markdown4.value.toLowerCase().includes('uninitial'),
                'Should mention uninitialized memory in hover content');
        });

        it('should detect MSVC uninitialized stack memory pattern (0xCCCCCCCC)', () => {
            const content = 'CPU Context:\nesp = 0xCCCCCCCC';
            const document = createMockDocument(content);
            const position = new vscode.Position(1, 0);
            const hover = provider.provideHover(document, position, cancelToken);
            assert.notStrictEqual(hover, undefined, 'Should provide hover for uninitialized stack pattern');
            const markdown5 = (hover as vscode.Hover).contents as unknown as vscode.MarkdownString;
            assert.ok(markdown5.value.toLowerCase().includes('uninitial'),
                'Should mention uninitialized memory in hover content');
        });
    });

    describe('Register Context Detection', () => {
        it('should detect ARM64 registers in different contexts', () => {
            const contexts = [
                'Thread 0 crashed with ARM Thread State (64-bit):\nx0: 0x0000000100000000',
                'CPU Context:\n  x15 = 0x0000000200000000',
                'Exception Information:\nRegister x28: 0x0000000300000000'
            ];

            for (const context of contexts) {
                const document = createMockDocument(context);

                // Find position of x register in content
                const lines = context.split('\n');
                let registerPosition: vscode.Position | undefined;
                
                for (let i = 0; i < lines.length; i++) {
                    const match = lines[i].match(/x\d+/);
                    if (match) {
                        registerPosition = new vscode.Position(i, lines[i].indexOf(match[0]));
                        break;
                    }
                }

                assert.notStrictEqual(registerPosition, undefined, 'Should find register position');
                if (registerPosition) {
                    const hover = provider.provideHover(document, registerPosition, cancelToken);
                    assert.notStrictEqual(hover, undefined, `Should provide hover in context: ${context.split('\n')[0]}`);
                }
            }
        });
    });
});
