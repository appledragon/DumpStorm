import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RegisterTooltipProvider } from './analysis/registers';
import { analyzeDumpFile } from './analysis/stackwalk';
import { DEFAULT_CONFIG, isValidLlvmNmPath, isValidMinidumpStackwalkPath, isValidNmPath } from './config/config';
import { localization } from './localization/localization';
import { enhanceStackTraceWithSymbols } from './symbols/enhancer';
import { extractSymbolsFromBinary, extractSymbolsFromDirectory } from './symbols/extractor';
import { clearSymbolCache } from './symbols/enhancer';
import { installLlvmNmWithCurl } from './tools/llvm-nm-installer-curl';
import { BreakpadPanelProvider } from './ui/panel';

export function activate(context: vscode.ExtensionContext) {
    // Create and register the panel provider
    const panelProvider = new BreakpadPanelProvider(context);
    vscode.window.registerTreeDataProvider('minidump-parser-panel', panelProvider);

    // Register register tooltip provider for crash dump analysis files
    const registerTooltipProvider = new RegisterTooltipProvider();
    const hoverDisposable = vscode.languages.registerHoverProvider(
        [
            { scheme: 'untitled' }, // For untitled documents (analysis results)
            { pattern: '**/*.{txt,log,crash,dmp,dump}' }, // For crash dump related files
            { language: 'plaintext' }, // For plaintext documents
            { language: 'text' } // For text documents
        ],
        registerTooltipProvider
    );

    // Register set symbol path command
    const setSymbolPathCommand = vscode.commands.registerCommand('minidump-parser.setSymbolPath', async () => {
        const folders = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Symbol Directory'
        });

        if (folders && folders.length > 0) {
            const symbolPath = folders[0].fsPath;
            const config = vscode.workspace.getConfiguration('minidump-parser');
            await config.update('symbolPath', symbolPath, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(localization.format(localization.getUI('symbolPathSet'), symbolPath));
            panelProvider.refresh();
        }
    });

    // Register open dump file command
    const openDumpFileCommand = vscode.commands.registerCommand('minidump-parser.openDumpFile', async () => {
        try {
            // Get the last directory path
            const lastDirectory = panelProvider.getLastDumpFileDirectory();
            
            // Show file picker for dump files
            const openDialogOptions: vscode.OpenDialogOptions = {
                filters: { 'Dump Files': ['dmp', 'dump'], 'All Files': ['*'] },
                canSelectMany: false,
                title: localization.getUI('selectCrashDumpFile')
            };
            
            // If there's a last directory, set it as the default open location
            if (lastDirectory && fs.existsSync(lastDirectory)) {
                openDialogOptions.defaultUri = vscode.Uri.file(lastDirectory);
            }
            
            const dumpUri = await vscode.window.showOpenDialog(openDialogOptions);

            if (!dumpUri || dumpUri.length === 0) {
                return; // User canceled
            }

            const dumpPath = dumpUri[0].fsPath;
            
            // Check if dump file exists
            if (!fs.existsSync(dumpPath)) {
                vscode.window.showErrorMessage(localization.format(localization.getUI('dumpFileNotFound'), dumpPath));
                return;
            }

            // Get symbol path from configuration
            const config = vscode.workspace.getConfiguration('minidump-parser');
            let symbolPath = config.get<string>('symbolPath') || DEFAULT_CONFIG.SYMBOL_PATH;
            
            // Check if symbol path exists, if not, ask user to set it
            if (!fs.existsSync(symbolPath)) {
                const response = await vscode.window.showWarningMessage(
                    localization.format(localization.getUI('symbolPathNotExist'), symbolPath),
                    localization.getUI('yes'), localization.getUI('useDefault'), localization.getUI('cancel')
                );
                
                if (response === localization.getUI('yes')) {
                    const folders = await vscode.window.showOpenDialog({
                        canSelectFiles: false,
                        canSelectFolders: true,
                        canSelectMany: false,
                        openLabel: 'Select Symbol Directory'
                    });
                    
                    if (folders && folders.length > 0) {
                        symbolPath = folders[0].fsPath;
                        await config.update('symbolPath', symbolPath, vscode.ConfigurationTarget.Global);
                    } else {
                        return; // User canceled
                    }
                } else if (response === localization.getUI('useDefault')) {
                    symbolPath = DEFAULT_CONFIG.SYMBOL_PATH;
                    // Create default directory if it doesn't exist
                    if (!fs.existsSync(symbolPath)) {
                        fs.mkdirSync(symbolPath, { recursive: true });
                    }
                } else {
                    return; // User canceled
                }
            }

            // Update the panel to show current dump file
            panelProvider.setCurrentDumpFile(dumpPath);

            // Run the analysis
            await analyzeDumpFile(context, dumpPath, symbolPath);
            
        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('errorAnalyzingDumpFile'), error.message || error));
        }
    });

    // Register extract symbols command
    const extractSymbolsCommand = vscode.commands.registerCommand('minidump-parser.extractSymbols', async () => {
        try {
            // Ask user whether to extract symbols from a single file or a directory
            const choice = await vscode.window.showQuickPick([
                {
                    label: localization.getUI('singleFile'),
                    description: localization.getUI('singleFileDesc'),
                    detail: localization.getUI('singleFileDetail')
                },
                {
                    label: localization.getUI('directoryBatch'),
                    description: localization.getUI('directoryBatchDesc'),
                    detail: localization.getUI('directoryBatchDetail')
                }
            ], {
                title: localization.getUI('symbolExtractionMode'),
                placeHolder: localization.getUI('chooseExtractionMode')
            });

            if (!choice) {
                return; // User canceled
            }

            // Get symbol path from configuration  
            const config = vscode.workspace.getConfiguration('minidump-parser');
            const symbolPath = config.get<string>('symbolPath') || DEFAULT_CONFIG.SYMBOL_PATH;
            
            // Ensure symbol path exists
            if (!fs.existsSync(symbolPath)) {
                fs.mkdirSync(symbolPath, { recursive: true });
            }

            if (choice.label === localization.getUI('singleFile')) {
                // Single file mode - remember last used binary path
                const lastBinaryPath = context.globalState.get<string>('lastBinaryPath');
                let defaultUri: vscode.Uri | undefined;
                
                if (lastBinaryPath && fs.existsSync(lastBinaryPath)) {
                    defaultUri = vscode.Uri.file(path.dirname(lastBinaryPath));
                }
                
                const binaryUri = await vscode.window.showOpenDialog({
                    filters: { 
                        'Executable Files': ['exe', 'dll', 'so', 'dylib', 'app'], 
                        'All Files': ['*'] 
                    },
                    canSelectMany: false,
                    title: localization.getUI('selectBinaryFile'),
                    defaultUri: defaultUri
                });

                if (!binaryUri || binaryUri.length === 0) {
                    return; // User canceled
                }

                const binaryPath = binaryUri[0].fsPath;
                
                // Save the selected path for next time
                await context.globalState.update('lastBinaryPath', binaryPath);
                
                // Check if binary file exists
                if (!fs.existsSync(binaryPath)) {
                    vscode.window.showErrorMessage(localization.format(localization.getUI('binaryFileNotFound'), binaryPath));
                    return;
                }

                await extractSymbolsFromBinary(binaryPath, symbolPath);
                
            } else {
                // Directory batch mode - remember last used directory path
                const lastDirectoryPath = context.globalState.get<string>('lastDirectoryPath');
                let defaultUri: vscode.Uri | undefined;
                
                if (lastDirectoryPath && fs.existsSync(lastDirectoryPath)) {
                    defaultUri = vscode.Uri.file(lastDirectoryPath);
                }
                
                const directoryUri = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    title: localization.getUI('selectDirectory'),
                    defaultUri: defaultUri
                });

                if (!directoryUri || directoryUri.length === 0) {
                    return; // User canceled
                }

                const directoryPath = directoryUri[0].fsPath;
                
                // Save the selected path for next time
                await context.globalState.update('lastDirectoryPath', directoryPath);
                
                // Check if directory exists
                if (!fs.existsSync(directoryPath)) {
                    vscode.window.showErrorMessage(localization.format(localization.getUI('directoryNotFound'), directoryPath));
                    return;
                }

                await extractSymbolsFromDirectory(directoryPath, symbolPath);
            }
            
        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('errorExtractingSymbols'), error.message || error));
        }
    });

    // Register enhance stack trace command
    const enhanceStackTraceCommand = vscode.commands.registerCommand('minidump-parser.enhanceStackTrace', async () => {
        try {
            // Get the active text editor
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage(localization.getUI('noTextFileOpen'));
                return;
            }

            const document = editor.document;
            let textToEnhance = '';

            // Check if there's a selection
            if (!editor.selection.isEmpty) {
                textToEnhance = document.getText(editor.selection);
            } else {
                textToEnhance = document.getText();
            }

            if (!textToEnhance.trim()) {
                vscode.window.showErrorMessage(localization.getUI('noTextFoundToEnhance'));
                return;
            }

            // Get symbol path from configuration
            const config = vscode.workspace.getConfiguration('minidump-parser');
            const symbolPath = config.get<string>('symbolPath') || DEFAULT_CONFIG.SYMBOL_PATH;

            if (!fs.existsSync(symbolPath)) {
                vscode.window.showErrorMessage(localization.format(localization.getUI('symbolPathNotExistForEnhance'), symbolPath));
                return;
            }

            // Show progress
            const enhancedText = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: localization.getUI('enhancingStackTrace'),
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 50, message: localization.getUI('loadingSymbolTables') });
                const result = await enhanceStackTraceWithSymbols(textToEnhance, symbolPath);
                progress.report({ increment: 100, message: localization.getUI('enhancementComplete') });
                return result;
            });

            // Create a new document with the enhanced text
            const doc = await vscode.workspace.openTextDocument({
                content: enhancedText,
                language: 'plaintext'  // Use plaintext to ensure hover provider works correctly
            });

            await vscode.window.showTextDocument(doc);
            vscode.window.showInformationMessage(localization.getUI('stackTraceEnhanced'));

        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('errorEnhancingStackTrace'), error.message || error));
        }
    });

    // Register custom tool path configuration commands
    const setCustomMinidumpStackwalkPathCommand = vscode.commands.registerCommand('minidump-parser.setCustomMinidumpStackwalkPath', async () => {
        // Remember last tool selection path
        const lastToolPath = context.globalState.get<string>('lastToolPath');
        let defaultUri: vscode.Uri | undefined;
        
        if (lastToolPath && fs.existsSync(lastToolPath)) {
            defaultUri = vscode.Uri.file(path.dirname(lastToolPath));
        }
        
        const fileUri = await vscode.window.showOpenDialog({
            filters: { 'Executable Files': ['exe', '*'], 'All Files': ['*'] },
            canSelectMany: false,
            title: localization.getUI('selectMinidumpStackwalkExecutable'),
            defaultUri: defaultUri
        });

        if (fileUri && fileUri.length > 0) {
            const executablePath = fileUri[0].fsPath;
            
            // Save the selected path for next time
            await context.globalState.update('lastToolPath', executablePath);
            
            if (isValidMinidumpStackwalkPath(executablePath)) {
                const config = vscode.workspace.getConfiguration('minidump-parser');
                await config.update('customMinidumpStackwalkPath', executablePath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(localization.format(localization.getUI('customMinidumpPathSet'), executablePath));
                panelProvider.refresh();
            } else {
                vscode.window.showErrorMessage(localization.getUI('invalidMinidumpExecutable'));
            }
        }
    });

    const setCustomNmPathCommand = vscode.commands.registerCommand('minidump-parser.setCustomNmPath', async () => {
        // Remember last tool selection path
        const lastToolPath = context.globalState.get<string>('lastToolPath');
        let defaultUri: vscode.Uri | undefined;
        
        if (lastToolPath && fs.existsSync(lastToolPath)) {
            defaultUri = vscode.Uri.file(path.dirname(lastToolPath));
        }
        
        const fileUri = await vscode.window.showOpenDialog({
            filters: { 'Executable Files': ['exe', '*'], 'All Files': ['*'] },
            canSelectMany: false,
            title: localization.getUI('selectNmExecutable'),
            defaultUri: defaultUri
        });

        if (fileUri && fileUri.length > 0) {
            const executablePath = fileUri[0].fsPath;
            
            // Save the selected path for next time
            await context.globalState.update('lastToolPath', executablePath);
            
            if (isValidNmPath(executablePath)) {
                const config = vscode.workspace.getConfiguration('minidump-parser');
                await config.update('customNmPath', executablePath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(localization.format(localization.getUI('customNmPathSet'), executablePath));
                panelProvider.refresh();
            } else {
                vscode.window.showErrorMessage(localization.getUI('invalidNmExecutable'));
            }
        }
    });

    const setCustomLlvmNmPathCommand = vscode.commands.registerCommand('minidump-parser.setCustomLlvmNmPath', async () => {
        // Remember last tool selection path
        const lastToolPath = context.globalState.get<string>('lastToolPath');
        let defaultUri: vscode.Uri | undefined;
        
        if (lastToolPath && fs.existsSync(lastToolPath)) {
            defaultUri = vscode.Uri.file(path.dirname(lastToolPath));
        }
        
        const fileUri = await vscode.window.showOpenDialog({
            filters: { 'Executable Files': ['exe', '*'], 'All Files': ['*'] },
            canSelectMany: false,
            title: localization.getUI('selectLlvmNmExecutable'),
            defaultUri: defaultUri
        });

        if (fileUri && fileUri.length > 0) {
            const executablePath = fileUri[0].fsPath;
            
            // Save the selected path for next time
            await context.globalState.update('lastToolPath', executablePath);
            
            if (isValidLlvmNmPath(executablePath)) {
                const config = vscode.workspace.getConfiguration('minidump-parser');
                await config.update('customLlvmNmPath', executablePath, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(localization.format(localization.getUI('customLlvmNmPathSet'), executablePath));
                panelProvider.refresh();
            } else {
                vscode.window.showErrorMessage(localization.getUI('invalidLlvmNmExecutable'));
            }
        }
    });

    const resetCustomPathsCommand = vscode.commands.registerCommand('minidump-parser.resetCustomPaths', async () => {
        const response = await vscode.window.showWarningMessage(
            localization.getUI('resetCustomPathsConfirm'),
            localization.getUI('yes'), localization.getUI('cancel')
        );

        if (response === localization.getUI('yes')) {
            const config = vscode.workspace.getConfiguration('minidump-parser');
            await config.update('customMinidumpStackwalkPath', undefined, vscode.ConfigurationTarget.Global);
            await config.update('customNmPath', undefined, vscode.ConfigurationTarget.Global);
            await config.update('customLlvmNmPath', undefined, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(localization.getUI('customPathsReset'));
            panelProvider.refresh();
        }
    });

    // Register install stackwalk command
    const installStackwalkCommand = vscode.commands.registerCommand('minidump-parser.installStackwalk', async () => {
        await panelProvider.installStackwalk();
    });

    // Register install llvm-nm command
    const installLlvmNmCommand = vscode.commands.registerCommand('minidump-parser.installLlvmNm', async () => {
        await panelProvider.installLlvmNm();
    });

    // Register install llvm-nm with curl command (more reliable)
    const installLlvmNmCurlCommand = vscode.commands.registerCommand('minidump-parser.installLlvmNmCurl', async () => {
        await installLlvmNmWithCurl();
    });

    // Register switch dump file command
    const switchDumpFileCommand = vscode.commands.registerCommand('minidump-parser.switchDumpFile', async (filePath: string) => {
        try {
            // Switch to the specified dump file
            panelProvider.switchToDumpFile(filePath);
            
            // Re-analyze the file
            const config = vscode.workspace.getConfiguration('minidump-parser');
            const symbolPath = config.get<string>('symbolPath') || DEFAULT_CONFIG.SYMBOL_PATH;
            
            await analyzeDumpFile(context, filePath, symbolPath);
            
        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('errorSwitchingDumpFile'), error.message || error));
        }
    });

    // Register close single dump file command (for inline action)
    const closeSingleDumpFileCommand = vscode.commands.registerCommand('minidump-parser.closeSingleDumpFile', async (item: any) => {
        try {
            // Extract file path from the tree item
            let filePath: string;
            if (typeof item === 'string') {
                filePath = item;
            } else if (item && item.filePath) {
                filePath = item.filePath;
            } else {
                vscode.window.showErrorMessage(localization.getUI('unableToDetermineFilePath'));
                return;
            }
            
            panelProvider.closeDumpFile(filePath);
            const fileName = path.basename(filePath);
            vscode.window.showInformationMessage(localization.format(localization.getUI('dumpFileClosed'), fileName));
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error closing dump file: ${error.message || error}`);
        }
    });

    // Register close all dump files command
    const closeAllDumpFilesCommand = vscode.commands.registerCommand('minidump-parser.closeAllDumpFiles', async () => {
        try {
            const openDumpFiles = panelProvider.getOpenDumpFiles();
            
            if (openDumpFiles.size === 0) {
                vscode.window.showWarningMessage(localization.getUI('noDumpFilesOpen'));
                return;
            }

            const response = await vscode.window.showWarningMessage(
                localization.format(localization.getUI('closeAllDumpFilesConfirm'), openDumpFiles.size.toString()),
                localization.getUI('yes'), localization.getUI('cancel')
            );

            if (response === localization.getUI('yes')) {
                panelProvider.closeAllDumpFiles();
                vscode.window.showInformationMessage(localization.getUI('allDumpFilesClosed'));
            }
            
        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('errorClosingAllDumpFiles'), error.message || error));
        }
    });

    // Register switch language command
    const switchLanguageCommand = vscode.commands.registerCommand('minidump-parser.switchLanguage', async () => {
        try {
            const availableLocales = localization.getAvailableLocales();
            const currentLocale = localization.getCurrentLocale();
            
            // Create quick pick items with localized names
            const languageItems = availableLocales.map(locale => {
                const isActive = locale === currentLocale;
                let localizedName: string;
                let nativeName: string;
                
                switch (locale) {
                    case 'en':
                        localizedName = localization.getUI('english');
                        nativeName = 'English';
                        break;
                    case 'zh-cn':
                        localizedName = localization.getUI('chineseSimplified');
                        nativeName = 'Simplified Chinese';
                        break;
                    default:
                        localizedName = locale;
                        nativeName = locale;
                        break;
                }
                
                return {
                    label: `${localizedName} (${nativeName})`,
                    description: isActive ? '✓ Current Language' : locale.toUpperCase(),
                    detail: isActive ? 'Currently selected language for tooltips' : `Switch to ${localizedName}`,
                    locale: locale
                };
            });

            const selectedItem = await vscode.window.showQuickPick(languageItems, {
                title: 'Select Language / 选择语言',
                placeHolder: localization.getUI('chooseLanguage'),
                ignoreFocusOut: false
            });

            if (selectedItem && selectedItem.locale !== currentLocale) {
                localization.setLocale(selectedItem.locale);
                
                // Show success message in both languages
                const successMessage = selectedItem.locale === 'zh-cn' 
                    ? localization.getUI('languageChangedChinese')
                    : localization.format(localization.getUI('languageChanged'), selectedItem.label.split(' (')[0]);
                    
                vscode.window.showInformationMessage(successMessage);
                
                // Refresh the panel to show the new language
                panelProvider.refresh();
            }
            
        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('languageSwitchError'), error.message || error));
        }
    });

    // Register test register tooltip command for debugging
    const testRegisterTooltipCommand = vscode.commands.registerCommand('minidump-parser.testRegisterTooltip', async () => {
        const testContent = `Thread 0 (crashed)
Exception: EXCEPTION_ACCESS_VIOLATION at 0x00401000

CPU Context:
eax = 0x00000000
ebx = 0x7ffd3000
ecx = 0x12345678
edx = 0xc0000005
esi = 0x004010a0
edi = 0x004010b0
esp = 0x0012ff70
ebp = 0x0012ff84
eip = 0x00000000

64-bit registers:
rax = 0x0000000000000000
rbx = 0x00007ffd30001234
rcx = 0x0000000012345678
rdx = 0x00000000c0000005
rsi = 0x00000000004010a0
rdi = 0x00000000004010b0
rsp = 0x000000000012ff70
rbp = 0x000000000012ff84
rip = 0x0000000000401000

Extended registers:
r8  = 0x0000000000000001
r9  = 0x0000000000000002
r10 = 0xdeadbeefcafebabe
r11 = 0x0000000000000004

Alternative formats:
eflags: 0x00010202
xmm0   12345678abcdef00

Stack trace:
 0  0x00000000 [eip]
 1  0x00401234 [return address] 
 2  main!main + 0x45 [ebp + 4]`;

        const doc = await vscode.workspace.openTextDocument({
            content: testContent,
            language: 'plaintext'
        });

        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(localization.getUI('testDocumentCreated'));
    });

    // Register all commands
    context.subscriptions.push(
        hoverDisposable,
        setSymbolPathCommand,
        openDumpFileCommand,
        extractSymbolsCommand,
        enhanceStackTraceCommand,
        setCustomMinidumpStackwalkPathCommand,
        setCustomNmPathCommand,
        setCustomLlvmNmPathCommand,
        resetCustomPathsCommand,
        installStackwalkCommand,
        installLlvmNmCommand,
        installLlvmNmCurlCommand,
        switchDumpFileCommand,
        closeSingleDumpFileCommand,
        closeAllDumpFilesCommand,
        switchLanguageCommand,
        testRegisterTooltipCommand,
        vscode.commands.registerCommand('minidump-parser.about', () => {
            const version = context.extension.packageJSON.version || 'unknown';
            vscode.window.showInformationMessage(
                `Minidump Parser\n\nVersion: ${version}\nAuthor: AppleDragon\n\nGitHub: https://github.com/appledragon/DumpStorm`,
                'GitHub', 'Close'
            ).then(choice => {
                if (choice === 'GitHub') {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/appledragon/DumpStorm'));
                }
            });
        })
    );
}

export function deactivate() {
    clearSymbolCache();
}
