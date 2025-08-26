import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { DEFAULT_CONFIG, isNmAvailable, getCustomMinidumpStackwalkPath, getCustomNmPath, getCustomLlvmNmPath, MINIDUMP_STACKWALK_CONFIG, getBinaryName, getLlvmNmBinaryName } from '../config/config';
import { installMinidumpStackwalk } from '../tools/minidump-stackwalk-installer';
import { installLlvmNm } from '../tools/llvm-nm-installer';
import { installMinidumpStackwalkWithCurl } from '../tools/minidump-stackwalk-installer-curl';
import { installLlvmNmWithCurl } from '../tools/llvm-nm-installer-curl';
import { localization } from '../localization/localization';

export class BreakpadPanelProvider implements vscode.TreeDataProvider<BreakpadItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<BreakpadItem | undefined | null | void> = new vscode.EventEmitter<BreakpadItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<BreakpadItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private _context: vscode.ExtensionContext;
    private openDumpFiles: Map<string, { filePath: string; displayName: string; isActive: boolean }> = new Map();
    private lastDumpFileDirectory: string | undefined;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this.lastDumpFileDirectory = context.workspaceState.get<string>('lastDumpFileDirectory');
        
        const savedDumpFiles = context.workspaceState.get<Array<{ filePath: string; displayName: string; isActive: boolean }>>('openDumpFiles') || [];
        savedDumpFiles.forEach(dumpFile => {
            if (fs.existsSync(dumpFile.filePath)) {
                this.openDumpFiles.set(dumpFile.filePath, dumpFile);
            }
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BreakpadItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: BreakpadItem): Promise<BreakpadItem[]> {
        if (!element) {
            // Root items
            const dumpFilesContextValue = this.openDumpFiles.size > 0 ? 'dumpFilesWithFiles' : 'dumpFiles';
            
            const items: BreakpadItem[] = [
                new BreakpadItem(
                    localization.getUI('configuration'),
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    'config'
                ),
                new BreakpadItem(
                    localization.getUI('analysisTools'),
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    'tools'
                ),
                new BreakpadItem(
                    localization.getUI('symbolOperations'),
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    'symbols'
                ),
                new BreakpadItem(
                    localization.getUI('dumpFiles'),
                    vscode.TreeItemCollapsibleState.Expanded,
                    undefined,
                    dumpFilesContextValue
                )
            ];
            return items;
        } else if (element.contextValue === 'config') {
            // Configuration items
            const config = vscode.workspace.getConfiguration('minidump-parser');
            const symbolPath = config.get<string>('symbolPath') || DEFAULT_CONFIG.SYMBOL_PATH;
            const customMinidumpPath = getCustomMinidumpStackwalkPath();
            const customNmPath = getCustomNmPath();
            const customLlvmNmPath = getCustomLlvmNmPath();
            const currentLanguage = localization.getCurrentLocale();
            const languageDisplayName = currentLanguage === 'en' ? 'English' : 
                                       currentLanguage === 'zh-cn' ? '简体中文' : currentLanguage;
            
            const items: BreakpadItem[] = [
                new BreakpadItem(
                    `${localization.getUI('symbolPath')}: ${symbolPath}`,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.setSymbolPath',
                        title: localization.getUI('setSymbolPath'),
                        arguments: []
                    },
                    'symbolPath'
                ),
                new BreakpadItem(
                    `${localization.getUI('language')}: ${languageDisplayName} ${localization.getUI('clickToSwitch')}`,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.switchLanguage',
                        title: localization.getUI('switchLanguage'),
                        arguments: []
                    },
                    'language'
                )
            ];

            // Add custom tool paths if configured
            if (customMinidumpPath) {
                items.push(new BreakpadItem(
                    `${localization.getUI('customMinidumpPath')}: ${path.basename(customMinidumpPath)}`,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.setCustomMinidumpStackwalkPath',
                        title: localization.getUI('updateMinidumpPath'),
                        arguments: []
                    },
                    'customMinidumpPath'
                ));
            }

            if (customNmPath) {
                items.push(new BreakpadItem(
                    `${localization.getUI('customNmPath')}: ${path.basename(customNmPath)}`,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.setCustomNmPath',
                        title: localization.getUI('updateNmPath'),
                        arguments: []
                    },
                    'customNmPath'
                ));
            }

            // Only show customLlvmNmPath if customNmPath is not set (to avoid confusion)
            if (customLlvmNmPath && !customNmPath) {
                items.push(new BreakpadItem(
                    `${localization.getUI('customLlvmNmPath')}: ${path.basename(customLlvmNmPath)}`,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.setCustomLlvmNmPath',
                        title: localization.getUI('updateLlvmNmPath'),
                        arguments: []
                    },
                    'customLlvmNmPath'
                ));
            }

            return items;
        } else if (element.contextValue === 'tools') {
            // Tool status items
            const items: BreakpadItem[] = [];
            
            // Check if nm is available
            const nmAvailable = isNmAvailable();
            const nmStatus = nmAvailable ? localization.getUI('autoInstalled') : localization.getUI('notFound');
            items.push(new BreakpadItem(
                `nm/llvm-nm: ${nmStatus}`,
                vscode.TreeItemCollapsibleState.None,
                undefined,
                'nmStatus'
            ));

            // Add install llvm-nm button if nm is not found
            if (!nmAvailable) {
                items.push(new BreakpadItem(
                    localization.getUI('installLlvmNm'),
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.installLlvmNm',
                        title: localization.getUI('installLlvmNm'),
                        arguments: []
                    },
                    'installLlvmNm'
                ));
            }

            // Check minidump_stackwalk status
            try {
                // Try to find minidump_stackwalk
                const customPath = getCustomMinidumpStackwalkPath();
                let stackwalkStatus = localization.getUI('notFound');
                
                if (customPath && fs.existsSync(customPath)) {
                    stackwalkStatus = '✅ Custom Path';
                } else {
                    // Check if auto-installed version exists in ~/.dumpstorm/bin
                    const platform = os.platform();
                    const binaryName = getBinaryName(platform, 'minidump_stackwalk');
                    const autoInstalledPath = path.join(os.homedir(), MINIDUMP_STACKWALK_CONFIG.INSTALL_PATHS.DUMPSTORM_BIN, binaryName);
                    if (fs.existsSync(autoInstalledPath)) {
                        stackwalkStatus = localization.getUI('autoInstalled');
                    }
                }
                
                items.push(new BreakpadItem(
                    `minidump_stackwalk: ${stackwalkStatus}`,
                    vscode.TreeItemCollapsibleState.None,
                    undefined,
                    'stackwalkStatus'
                ));

                // Add install button if not found
                if (stackwalkStatus === localization.getUI('notFound')) {
                    items.push(new BreakpadItem(
                        localization.getUI('installMinidumpStackwalk'),
                        vscode.TreeItemCollapsibleState.None,
                        {
                            command: 'minidump-parser.installStackwalk',
                            title: localization.getUI('installMinidumpStackwalk'),
                            arguments: []
                        },
                        'installStackwalk'
                    ));
                }
            } catch (error) {
                items.push(new BreakpadItem(
                    `minidump_stackwalk: ${localization.getUI('errorChecking')}`,
                    vscode.TreeItemCollapsibleState.None,
                    undefined,
                    'stackwalkError'
                ));
            }

            return items;
        } else if (element.contextValue === 'dumpFiles' || element.contextValue === 'dumpFilesWithFiles') {
            // Dump files items
            const items: BreakpadItem[] = [];
            
            if (this.openDumpFiles.size > 0) {
                for (const [filePath, dumpInfo] of this.openDumpFiles) {
                    const displayName = dumpInfo.isActive ? 
                        `🟢 ${dumpInfo.displayName}` : 
                        `⚪ ${dumpInfo.displayName}`;
                    
                    items.push(new BreakpadItem(
                        displayName,
                        vscode.TreeItemCollapsibleState.None,
                        {
                            command: 'minidump-parser.switchDumpFile',
                            title: localization.getUI('switchToDumpFile'),
                            arguments: [filePath]
                        },
                        'dumpFileItem',
                        filePath  // for close button
                    ));
                }
                
                items.push(new BreakpadItem(
                    localization.getUI('separator'),
                    vscode.TreeItemCollapsibleState.None,
                    undefined,
                    'separator'
                ));
                
                items.push(new BreakpadItem(
                    localization.getUI('openNewDumpFile'),
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.openDumpFile',
                        title: localization.getUI('openNewDumpFile'),
                        arguments: []
                    },
                    'openNewDump'
                ));
            } else {
                items.push(new BreakpadItem(
                    localization.getUI('clickToOpenDumpFile'),
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.openDumpFile',
                        title: localization.getUI('openDumpFile'),
                        arguments: []
                    },
                    'noDump'
                ));
            }

            return items;
        } else if (element.contextValue === 'symbols') {
            // Symbol operations items
            const items: BreakpadItem[] = [
                new BreakpadItem(
                    localization.getUI('extractSymbolsDesc'),
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.extractSymbols',
                        title: localization.getUI('extractSymbols'),
                        arguments: []
                    },
                    'extractSymbols'
                ),
                new BreakpadItem(
                    localization.getUI('enhanceStackTrace'),
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.enhanceStackTrace',
                        title: localization.getUI('enhanceStackTrace'),
                        arguments: []
                    },
                    'enhanceStackTrace'
                )
            ];

            return items;
        }

        return [];
    }

    setCurrentDumpFile(filePath: string | undefined) {
        if (filePath) {
            this.openDumpFiles.forEach((dumpInfo) => {
                dumpInfo.isActive = false;
            });
            
            const displayName = path.basename(filePath);
            this.openDumpFiles.set(filePath, {
                filePath,
                displayName,
                isActive: true
            });
            
            this.lastDumpFileDirectory = path.dirname(filePath);
            this._context.workspaceState.update('lastDumpFileDirectory', this.lastDumpFileDirectory);
            
            this.saveDumpFilesToWorkspace();
        }
        
        this.refresh();
    }

    getCurrentDumpFile(): string | undefined {
        for (const [filePath, dumpInfo] of this.openDumpFiles) {
            if (dumpInfo.isActive) {
                return filePath;
            }
        }
        return undefined;
    }

    switchToDumpFile(filePath: string) {
        if (this.openDumpFiles.has(filePath)) {
            this.openDumpFiles.forEach((dumpInfo) => {
                dumpInfo.isActive = false;
            });
            
            const dumpInfo = this.openDumpFiles.get(filePath);
            if (dumpInfo) {
                dumpInfo.isActive = true;
                this.saveDumpFilesToWorkspace();
                this.refresh();
            }
        }
    }

    closeDumpFile(filePath: string) {
        if (this.openDumpFiles.has(filePath)) {
            this.openDumpFiles.delete(filePath);
            this.saveDumpFilesToWorkspace();
            this.refresh();
        }
    }

    // close all dump files
    closeAllDumpFiles() {
        this.openDumpFiles.clear();
        this.saveDumpFilesToWorkspace();
        this.refresh();
    }

    getOpenDumpFiles(): Map<string, { filePath: string; displayName: string; isActive: boolean }> {
        return this.openDumpFiles;
    }

    private saveDumpFilesToWorkspace() {
        const dumpFilesArray = Array.from(this.openDumpFiles.values());
        this._context.workspaceState.update('openDumpFiles', dumpFilesArray);
    }

    getLastDumpFileDirectory(): string | undefined {
        return this.lastDumpFileDirectory;
    }

    async installStackwalk() {
        try {
            const platform = os.platform();
            const isWindows = platform === 'win32';
            
            // Prepare installation options with Windows-specific highlighting
            const options = [
                {
                    label: isWindows ? `${localization.getUI('recommendedForWindows')} ${localization.getUI('alternativeInstallation')}` : localization.getUI('alternativeInstallation'),
                    description: localization.getUI('alternativeInstallationDesc'),
                    detail: localization.getUI('alternativeInstallationDetail')
                },
                {
                    label: localization.getUI('standardInstallation'),
                    description: localization.getUI('standardInstallationDesc'),
                    detail: localization.getUI('standardInstallationDetail')
                },
                {
                    label: localization.getUI('manualInstallation'),
                    description: localization.getUI('manualInstallationDesc'),
                    detail: localization.getUI('manualInstallationDetail')
                }
            ];

            // For Windows, show additional guidance
            if (isWindows) {
                const guidance = await vscode.window.showInformationMessage(
                    localization.getUI('recommendedInstallMethodWindows'),
                    localization.getUI('yes'), localization.getUI('cancel')
                );
                
                if (guidance === localization.getUI('cancel')) {
                    return;
                }
            }

            // Ask user which installation method to use
            const method = await vscode.window.showQuickPick(options, {
                title: localization.getUI('chooseInstallationMethodStackwalk'),
                placeHolder: isWindows ? localization.getUI('recommendedInstallMethodWindows') : localization.getUI('installationMethod')
            });

            if (!method) {
                return; // User canceled
            }

            // Handle the method selection, accounting for Windows highlighting
            const isRecommendedMethod = method.label.includes('⭐') || method.label === localization.getUI('alternativeInstallation');
            const isStandardMethod = method.label === localization.getUI('standardInstallation');
            const isManualMethod = method.label === localization.getUI('manualInstallation');

            if (isStandardMethod) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: localization.getUI('installingStackwalkStandard'),
                    cancellable: false
                }, async (progress) => {
                    await installMinidumpStackwalk();
                });
            } else if (isRecommendedMethod) {
                // Use curl-based installer
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: localization.getUI('installingStackwalkAlternative'),
                    cancellable: false
                }, async (progress) => {
                    await installMinidumpStackwalkWithCurl();
                });
            } else if (isManualMethod) {
                // Show manual installation guide
                this.showManualInstallationGuide();
                return;
            }
            
            vscode.window.showInformationMessage(localization.getUI('installSuccess'));
            this.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('installFailed'), error.message));
        }
    }

    private async showManualInstallationGuide() {
        const platform = os.platform();
        let instructions = '';
        
        if (platform === 'win32') {
            instructions = `# Windows Manual Installation

1. Download the tool package:
   URL: https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-windows-x64.zip

2. Extract the downloaded zip file

3. Create installation directory:
   mkdir %USERPROFILE%\\.dumpstorm\\bin

4. Copy minidump_stackwalk.exe to:
   %USERPROFILE%\\.dumpstorm\\bin\\minidump_stackwalk.exe

5. Restart VS Code and try again

Alternative: Use PowerShell commands:
\`\`\`powershell
# Download
Invoke-WebRequest -Uri "https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-windows-x64.zip" -OutFile "breakpad.zip"

# Extract
Expand-Archive -Path "breakpad.zip" -DestinationPath "breakpad-extract"

# Install
mkdir $env:USERPROFILE\\.dumpstorm\\bin
copy breakpad-extract\\*\\minidump_stackwalk.exe $env:USERPROFILE\\.dumpstorm\\bin\\
\`\`\``;
        } else if (platform === 'darwin') {
            const arch = os.arch();
            const archSuffix = arch === 'arm64' ? 'arm64' : 'x86_64';
            instructions = `# macOS Manual Installation

1. Download the tool package:
   URL: https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-macos-${archSuffix}.tar.gz

2. Extract and install:
\`\`\`bash
# Download
curl -L -o breakpad-macos-${archSuffix}.tar.gz https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-macos-${archSuffix}.tar.gz

# Extract
tar -xzf breakpad-macos-${archSuffix}.tar.gz

# Install
mkdir -p ~/.dumpstorm/bin
cp */minidump_stackwalk ~/.dumpstorm/bin/
chmod +x ~/.dumpstorm/bin/minidump_stackwalk
\`\`\`

3. Restart VS Code and try again`;
        } else {
            instructions = `# Linux Manual Installation

1. Download the tool package:
   URL: https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-linux-x86_64.tar.gz

2. Extract and install:
\`\`\`bash
# Download
curl -L -o breakpad-linux-x86_64.tar.gz https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-linux-x86_64.tar.gz

# Extract
tar -xzf breakpad-linux-x86_64.tar.gz

# Install
mkdir -p ~/.dumpstorm/bin
cp */minidump_stackwalk ~/.dumpstorm/bin/
chmod +x ~/.dumpstorm/bin/minidump_stackwalk
\`\`\`

3. Restart VS Code and try again`;
        }

        // Create a new document with the instructions
        const doc = await vscode.workspace.openTextDocument({
            content: instructions,
            language: 'markdown'
        });

        await vscode.window.showTextDocument(doc);
        
        vscode.window.showInformationMessage(localization.getUI('manualGuideOpened'));
    }

    async installLlvmNm() {
        try {
            const platform = os.platform();
            const isWindows = platform === 'win32';
            
            // Prepare installation options with Windows-specific highlighting
            const options = [
                {
                    label: isWindows ? `${localization.getUI('recommendedForWindows')} ${localization.getUI('alternativeInstallationLlvm')}` : localization.getUI('alternativeInstallationLlvm'),
                    description: localization.getUI('alternativeInstallationLlvmDesc'),
                    detail: localization.getUI('alternativeInstallationLlvmDetail')
                },
                {
                    label: localization.getUI('standardInstallationLlvm'),
                    description: localization.getUI('standardInstallationLlvmDesc'),
                    detail: localization.getUI('standardInstallationLlvmDetail')
                },
                {
                    label: localization.getUI('manualInstallation'),
                    description: localization.getUI('manualInstallationDesc'),
                    detail: localization.getUI('manualInstallationDetail')
                }
            ];

            // For Windows, reorder to put curl method first and add guidance
            if (isWindows) {
                // Show additional guidance for Windows users
                const guidance = await vscode.window.showInformationMessage(
                    localization.getUI('recommendedInstallMethodWindows'),
                    localization.getUI('yes'), localization.getUI('cancel')
                );
                
                if (guidance === localization.getUI('cancel')) {
                    return;
                }
            }

            // Let user choose installation method
            const method = await vscode.window.showQuickPick(options, {
                title: localization.getUI('chooseInstallationMethodLlvm'),
                placeHolder: isWindows ? localization.getUI('recommendedInstallMethodWindows') : undefined
            });

            if (!method) {
                return; // User canceled
            }

            // Handle the method selection, accounting for Windows highlighting
            const isRecommendedMethod = method.label.includes('⭐') || method.label === localization.getUI('alternativeInstallationLlvm');
            const isStandardMethod = method.label === localization.getUI('standardInstallationLlvm');
            const isManualMethod = method.label === localization.getUI('manualInstallation');

            if (isStandardMethod) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: localization.getUI('installingLlvmNmStandard'),
                    cancellable: false
                }, async (progress) => {
                    await installLlvmNm();
                });
            } else if (isRecommendedMethod) {
                // Use curl-based installer
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: localization.getUI('installingLlvmNmAlternative'),
                    cancellable: false
                }, async (progress) => {
                    await installLlvmNmWithCurl();
                });
            } else if (isManualMethod) {
                // Show manual installation guide for llvm-nm
                this.showLlvmNmManualInstallationGuide();
                return;
            }
            
            vscode.window.showInformationMessage(localization.getUI('llvmNmInstalledSuccessfully'));
            this.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('installer.llvmNmInstallationFailed'), error.message));
        }
    }

    private showLlvmNmManualInstallationGuide() {
        const platform = os.platform();
        let instructions = '';
        
        if (platform === 'win32') {
            instructions = `
# Manual LLVM-NM Installation for Windows

## Method 1: Download from GitHub
1. Visit: https://github.com/appledragon/llvm-project/releases/tag/nightly
2. Download: llvm-nm-windows-x64.zip (or x86 for 32-bit)
3. Extract the zip file
4. Copy llvm-nm.exe to: %USERPROFILE%\\.dumpstorm\\bin\\
5. Restart VS Code

## Method 2: Use PowerShell
\`\`\`powershell
# Create directory
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.dumpstorm\\bin"

# Download and extract
$url = "https://github.com/appledragon/llvm-project/releases/download/nightly/llvm-nm-windows-x64.zip"
$zip = "$env:TEMP\\llvm-nm.zip"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath "$env:TEMP\\llvm-nm" -Force
Copy-Item "$env:TEMP\\llvm-nm\\*\\llvm-nm.exe" "$env:USERPROFILE\\.dumpstorm\\bin\\" -Force
\`\`\`

## Method 3: Use curl (if available)
\`\`\`cmd
curl -L -o %TEMP%\\llvm-nm.zip "https://github.com/appledragon/llvm-project/releases/download/nightly/llvm-nm-windows-x64.zip"
\`\`\`
`;
        } else if (platform === 'darwin') {
            const arch = os.arch();
            const archSuffix = arch === 'arm64' ? 'arm64' : 'x86_64';
            instructions = `
# Manual LLVM-NM Installation for macOS

## Download and Install
1. Visit: https://github.com/appledragon/llvm-project/releases/tag/nightly
2. Download: llvm-nm-macos-${archSuffix}.tar.gz
3. Extract: tar -xzf llvm-nm-macos-${archSuffix}.tar.gz
4. Copy llvm-nm to: ~/.dumpstorm/bin/
5. Make executable: chmod +x ~/.dumpstorm/bin/llvm-nm

## Using Terminal
\`\`\`bash
mkdir -p ~/.dumpstorm/bin
curl -L -o /tmp/llvm-nm.tar.gz "https://github.com/appledragon/llvm-project/releases/download/nightly/llvm-nm-macos-${archSuffix}.tar.gz"
tar -xzf /tmp/llvm-nm.tar.gz -C /tmp
cp /tmp/*/llvm-nm ~/.dumpstorm/bin/
chmod +x ~/.dumpstorm/bin/llvm-nm
\`\`\`
`;
        } else {
            instructions = `
# Manual LLVM-NM Installation for Linux

## Download and Install
1. Visit: https://github.com/appledragon/llvm-project/releases/tag/nightly
2. Download: llvm-nm-linux-x86_64.tar.gz
3. Extract: tar -xzf llvm-nm-linux-x86_64.tar.gz
4. Copy llvm-nm to: ~/.dumpstorm/bin/
5. Make executable: chmod +x ~/.dumpstorm/bin/llvm-nm

## Using Terminal
\`\`\`bash
mkdir -p ~/.dumpstorm/bin
curl -L -o /tmp/llvm-nm.tar.gz "https://github.com/appledragon/llvm-project/releases/download/nightly/llvm-nm-linux-x86_64.tar.gz"
tar -xzf /tmp/llvm-nm.tar.gz -C /tmp
cp /tmp/*/llvm-nm ~/.dumpstorm/bin/
chmod +x ~/.dumpstorm/bin/llvm-nm
\`\`\`
`;
        }

        // Create and show document
        vscode.workspace.openTextDocument({
            content: instructions,
            language: 'markdown'
        }).then(doc => {
            vscode.window.showTextDocument(doc);
        });

        vscode.window.showInformationMessage('LLVM-NM manual installation guide opened');
    }
}

export class BreakpadItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command,
        public readonly contextValue?: string,
        public readonly filePath?: string  // for close file
    ) {
        super(label, collapsibleState);
        this.tooltip = this.label;

        // Set icons based on context
        if (contextValue === 'config') {
            this.iconPath = new vscode.ThemeIcon('settings-gear');
        } else if (contextValue === 'tools') {
            this.iconPath = new vscode.ThemeIcon('tools');
        } else if (contextValue === 'symbols') {
            this.iconPath = new vscode.ThemeIcon('symbol-class');
        } else if (contextValue === 'dumpFiles' || contextValue === 'dumpFilesWithFiles') {
            this.iconPath = new vscode.ThemeIcon('files');
        } else if (contextValue === 'symbolPath') {
            this.iconPath = new vscode.ThemeIcon('folder');
        } else if (contextValue === 'language') {
            this.iconPath = new vscode.ThemeIcon('globe');
        } else if (contextValue === 'extractSymbols') {
            this.iconPath = new vscode.ThemeIcon('symbol-method');
        } else if (contextValue === 'enhanceStackTrace') {
            this.iconPath = new vscode.ThemeIcon('sparkle');
        } else if (contextValue === 'dumpFileItem') {
            this.iconPath = new vscode.ThemeIcon('file');
        } else if (contextValue === 'separator') {
            this.iconPath = new vscode.ThemeIcon('dash');
        } else if (contextValue === 'openNewDump') {
            this.iconPath = new vscode.ThemeIcon('file-add');
        } else if (contextValue === 'installStackwalk') {
            this.iconPath = new vscode.ThemeIcon('cloud-download');
        } else if (contextValue === 'nmStatus' || contextValue === 'stackwalkStatus') {
            this.iconPath = new vscode.ThemeIcon('check');
        } else if (contextValue === 'stackwalkError') {
            this.iconPath = new vscode.ThemeIcon('error');
        } else if (contextValue === 'noDump') {
            this.iconPath = new vscode.ThemeIcon('folder-opened');
        }
    }
}
