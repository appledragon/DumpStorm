import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
    getSymbolPath,
    isNmAvailable,
    getNmCommand,
    getCustomMinidumpStackwalkPath,
    getCustomNmPath,
    getCustomLlvmNmPath,
    getCustomDumpSymsPath,
    getCustomLlvmUndnamePath,
    MINIDUMP_STACKWALK_CONFIG,
    getBinaryName,
    getLlvmNmBinaryName,
} from '../config/config';
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
            const symbolPath = getSymbolPath();
            const customMinidumpPath = getCustomMinidumpStackwalkPath();
            const customNmPath = getCustomNmPath();
            const customLlvmNmPath = getCustomLlvmNmPath();
            const customDumpSymsPath = getCustomDumpSymsPath();
            const customLlvmUndnamePath = getCustomLlvmUndnamePath();
            const currentLanguage = localization.getCurrentLocale();
            const languagePreference = localization.getLanguagePreference();
            const resolvedLanguageName = currentLanguage === 'en'
                ? localization.getUI('english')
                : currentLanguage === 'zh-cn'
                    ? localization.getUI('chineseSimplified')
                    : currentLanguage;
            const languageDisplayName = languagePreference === 'auto'
                ? `${localization.getUI('autoLanguage')} (${resolvedLanguageName})`
                : resolvedLanguageName;
            
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

            items.push(
                new BreakpadItem(
                    `${localization.getUI('customDumpSymsPath')}: ${customDumpSymsPath ? path.basename(customDumpSymsPath) : localization.getUI('notConfigured')}`,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.setCustomDumpSymsPath',
                        title: localization.getUI('setCustomDumpSymsPath'),
                        arguments: [],
                    },
                    'customDumpSymsPath',
                ),
                new BreakpadItem(
                    `${localization.getUI('customLlvmUndnamePath')}: ${customLlvmUndnamePath ? path.basename(customLlvmUndnamePath) : localization.getUI('notConfigured')}`,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.setCustomLlvmUndnamePath',
                        title: localization.getUI('setCustomLlvmUndnamePath'),
                        arguments: [],
                    },
                    'customLlvmUndnamePath',
                ),
            );

            if (customMinidumpPath || customNmPath || customLlvmNmPath || customDumpSymsPath || customLlvmUndnamePath) {
                items.push(new BreakpadItem(
                    localization.getUI('resetCustomPaths'),
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'minidump-parser.resetCustomPaths',
                        title: localization.getUI('resetCustomPaths'),
                        arguments: [],
                    },
                    'resetCustomPaths',
                ));
            }

            return items;
        } else if (element.contextValue === 'tools') {
            // Tool status items
            const items: BreakpadItem[] = [];
            
            // Check if nm is available
            let nmBinaryPath: string | undefined;
            let nmIsAvailable = false;
            try {
                const nmPath = getNmCommand();
                nmIsAvailable = true;
                if (nmPath !== 'nm' && nmPath !== 'llvm-nm') {
                    nmBinaryPath = nmPath;
                }
            } catch {
                // nm not available
            }
            const nmStatus = nmIsAvailable ? localization.getUI('autoInstalled') : localization.getUI('notFound');
            
            const nmItem = new BreakpadItem(
                `${localization.getUI('nmToolLabel')}: ${nmStatus}`,
                vscode.TreeItemCollapsibleState.None,
                nmBinaryPath ? {
                    command: 'minidump-parser.revealToolPath',
                    title: localization.getUI('clickToOpenInstallFolder'),
                    arguments: [nmBinaryPath]
                } : undefined,
                'nmStatus'
            );
            
            if (nmIsAvailable) {
                const nmTooltip = new vscode.MarkdownString();
                nmTooltip.appendMarkdown(`**\u2705 nm/llvm-nm**\n\n`);
                nmTooltip.appendMarkdown(`---\n\n`);
                if (nmBinaryPath) {
                    nmTooltip.appendMarkdown(`\uD83D\uDCC2 \`${nmBinaryPath}\`\n\n`);
                    nmTooltip.appendMarkdown(`\uD83D\uDC46 *${localization.getUI('clickToOpenInstallFolder')}*`);
                } else {
                    nmTooltip.appendMarkdown(`${localization.getUI('systemPath')}`);
                }
                nmItem.tooltip = nmTooltip;
            }
            
            items.push(nmItem);

            // Add install llvm-nm button if nm is not found
            if (!nmIsAvailable) {
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
                let stackwalkBinaryPath: string | undefined;
                
                if (customPath && fs.existsSync(customPath)) {
                    stackwalkStatus = localization.getUI('customPathStatus');
                    stackwalkBinaryPath = customPath;
                } else {
                    // Check if auto-installed version exists in ~/.dumpstorm/bin
                    const platform = os.platform();
                    const binaryName = getBinaryName(platform, 'minidump_stackwalk');
                    const autoInstalledPath = path.join(os.homedir(), MINIDUMP_STACKWALK_CONFIG.INSTALL_PATHS.DUMPSTORM_BIN, binaryName);
                    if (fs.existsSync(autoInstalledPath)) {
                        stackwalkStatus = localization.getUI('autoInstalled');
                        stackwalkBinaryPath = autoInstalledPath;
                    }
                }
                
                const stackwalkItem = new BreakpadItem(
                    `${localization.getUI('stackwalkToolLabel')}: ${stackwalkStatus}`,
                    vscode.TreeItemCollapsibleState.None,
                    stackwalkBinaryPath ? {
                        command: 'minidump-parser.revealToolPath',
                        title: localization.getUI('clickToOpenInstallFolder'),
                        arguments: [stackwalkBinaryPath]
                    } : undefined,
                    'stackwalkStatus'
                );
                
                if (stackwalkBinaryPath) {
                    const swTooltip = new vscode.MarkdownString();
                    swTooltip.appendMarkdown(`**\u2705 minidump_stackwalk**\n\n`);
                    swTooltip.appendMarkdown(`---\n\n`);
                    swTooltip.appendMarkdown(`\uD83D\uDCC2 \`${stackwalkBinaryPath}\`\n\n`);
                    swTooltip.appendMarkdown(`\uD83D\uDC46 *${localization.getUI('clickToOpenInstallFolder')}*`);
                    stackwalkItem.tooltip = swTooltip;
                }
                
                items.push(stackwalkItem);

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
            const options: Array<vscode.QuickPickItem & { method: 'curl' | 'standard' | 'manual' }> = [
                {
                    label: isWindows ? `${localization.getUI('recommendedForWindows')} ${localization.getUI('alternativeInstallation')}` : localization.getUI('alternativeInstallation'),
                    description: localization.getUI('alternativeInstallationDesc'),
                    detail: localization.getUI('alternativeInstallationDetail'),
                    method: 'curl',
                },
                {
                    label: localization.getUI('standardInstallation'),
                    description: localization.getUI('standardInstallationDesc'),
                    detail: localization.getUI('standardInstallationDetail'),
                    method: 'standard',
                },
                {
                    label: localization.getUI('manualInstallation'),
                    description: localization.getUI('manualInstallationDesc'),
                    detail: localization.getUI('manualInstallationDetail'),
                    method: 'manual',
                }
            ];

            if (isWindows) {
                const guidance = await vscode.window.showInformationMessage(
                    localization.getUI('recommendedInstallMethodWindows'),
                    localization.getUI('yes'), localization.getUI('cancel')
                );
                
                if (guidance !== localization.getUI('yes')) {
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

            let installed = false;
            if (method.method === 'standard') {
                installed = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: localization.getUI('installingStackwalkStandard'),
                    cancellable: false
                }, async (progress) => {
                    return installMinidumpStackwalk();
                });
            } else if (method.method === 'curl') {
                installed = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: localization.getUI('installingStackwalkAlternative'),
                    cancellable: false
                }, async (progress) => {
                    return installMinidumpStackwalkWithCurl();
                });
            } else if (method.method === 'manual') {
                // Show manual installation guide
                this.showManualInstallationGuide();
                return;
            }

            if (!installed) {
                return;
            }

            vscode.window.showInformationMessage(localization.getUI('installSuccess'));
            this.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('installFailed'), error?.message ?? error));
        }
    }

    private async showManualInstallationGuide() {
        const platform = os.platform();
        const isWindows = platform === 'win32';
        const archSuffix = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
        const downloadUrl = isWindows
            ? 'https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-windows-x64.zip'
            : `https://github.com/appledragon/breakpad/releases/download/nightly/breakpad-${platform === 'darwin' ? 'macos' : 'linux'}-${archSuffix}.tar.gz`;
        const instructions = isWindows
            ? localization.format(localization.getUI('manualGuide.stackwalkWindows'), downloadUrl)
            : localization.format(
                localization.getUI('manualGuide.stackwalkUnix'),
                platform === 'darwin' ? 'macOS' : 'Linux',
                downloadUrl,
            );

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
            const options: Array<vscode.QuickPickItem & { method: 'curl' | 'standard' | 'manual' }> = [
                {
                    label: isWindows ? `${localization.getUI('recommendedForWindows')} ${localization.getUI('alternativeInstallationLlvm')}` : localization.getUI('alternativeInstallationLlvm'),
                    description: localization.getUI('alternativeInstallationLlvmDesc'),
                    detail: localization.getUI('alternativeInstallationLlvmDetail'),
                    method: 'curl',
                },
                {
                    label: localization.getUI('standardInstallationLlvm'),
                    description: localization.getUI('standardInstallationLlvmDesc'),
                    detail: localization.getUI('standardInstallationLlvmDetail'),
                    method: 'standard',
                },
                {
                    label: localization.getUI('manualInstallation'),
                    description: localization.getUI('manualInstallationDesc'),
                    detail: localization.getUI('manualInstallationDetail'),
                    method: 'manual',
                }
            ];

            if (isWindows) {
                const guidance = await vscode.window.showInformationMessage(
                    localization.getUI('recommendedInstallMethodWindows'),
                    localization.getUI('yes'), localization.getUI('cancel')
                );
                
                if (guidance !== localization.getUI('yes')) {
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

            let installed = false;
            if (method.method === 'standard') {
                installed = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: localization.getUI('installingLlvmNmStandard'),
                    cancellable: false
                }, async (progress) => {
                    return installLlvmNm();
                });
            } else if (method.method === 'curl') {
                installed = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: localization.getUI('installingLlvmNmAlternative'),
                    cancellable: false
                }, async (progress) => {
                    return installLlvmNmWithCurl();
                });
            } else if (method.method === 'manual') {
                // Show manual installation guide for llvm-nm
                this.showLlvmNmManualInstallationGuide();
                return;
            }

            if (!installed) {
                return;
            }

            vscode.window.showInformationMessage(localization.getUI('llvmNmInstalledSuccessfully'));
            this.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(localization.format(localization.getUI('installer.llvmNmInstallationFailed'), error?.message ?? error));
        }
    }

    private showLlvmNmManualInstallationGuide() {
        const platform = os.platform();
        const isWindows = platform === 'win32';
        const archSuffix = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
        const instructions = isWindows
            ? localization.getUI('manualGuide.llvmNmWindows')
            : localization.format(
                localization.getUI('manualGuide.llvmNmUnix'),
                platform === 'darwin' ? 'macOS' : 'Linux',
                `${platform === 'darwin' ? 'macos' : 'linux'}-${archSuffix}`,
            );

        // Create and show document
        vscode.workspace.openTextDocument({
            content: instructions,
            language: 'markdown'
        }).then(doc => {
            vscode.window.showTextDocument(doc);
        });

        vscode.window.showInformationMessage(localization.getUI('manualLlvmNmGuideOpened'));
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
