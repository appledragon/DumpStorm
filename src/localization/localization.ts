import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface LocalizedStrings {
    registers: { [key: string]: RegisterStrings };
    ui: { [key: string]: string };
    values: { [key: string]: string };
    errors: { [key: string]: string };
    crash: { [key: string]: string };
    debugTips: { [key: string]: string };
    batchExtraction: { [key: string]: string };
    installer: { [key: string]: string };
    [key: string]: unknown;
}

export interface RegisterStrings {
    name: string;
    description: string;
    purpose: string;
    usage: string;
    architecture: string;
}

export class LocalizationManager {
    private static instance: LocalizationManager;
    private currentLocale: string = 'en';
    private strings: LocalizedStrings;
    private readonly defaultLocale = 'en';
    private readonly localesDir: string;
    private readonly availableLocales: string[] = ['en', 'zh-cn']; 
    private constructor() {
        this.localesDir = path.join(__dirname, '..', 'localization', 'locales');
        this.loadCurrentLocale();
        this.strings = this.loadStrings(this.currentLocale);
    }

    public static getInstance(): LocalizationManager {
        if (!LocalizationManager.instance) {
            LocalizationManager.instance = new LocalizationManager();
        }
        return LocalizationManager.instance;
    }

    private loadCurrentLocale(): void {
        // First try to get from VS Code settings
        const config = vscode.workspace.getConfiguration('minidump-parser');
        const configLocale = config.get<string>('language');
        
        if (configLocale) {
            this.currentLocale = configLocale;
            return;
        }

        // Fall back to VS Code's display language
        const vscodeLocale = vscode.env.language;
        
        // Map VS Code locales to our supported locales
        const localeMapping: { [key: string]: string } = {
            'zh-cn': 'zh-cn',
            'zh-tw': 'zh-cn', // Use simplified Chinese for traditional Chinese
            'zh': 'zh-cn',
            'en': 'en',
            'en-us': 'en',
            'en-gb': 'en'
        };

        this.currentLocale = localeMapping[vscodeLocale.toLowerCase()] || this.defaultLocale;
    }

    private loadStrings(locale: string): LocalizedStrings {
        try {
            // Try multiple possible paths to accommodate development and compiled environments
            const possiblePaths = [
                path.join(__dirname, '..', 'localization', 'locales', `${locale}.json`), // Compiled relative path
                path.join(__dirname, '..', '..', 'src', 'localization', 'locales', `${locale}.json`), // Development environment path
                path.join(__dirname, 'locales', `${locale}.json`), // If directly in localization directory
            ];
            
            let content: string | null = null;
            let usedPath: string | null = null;
            
            for (const localeFile of possiblePaths) {
                if (fs.existsSync(localeFile)) {
                    content = fs.readFileSync(localeFile, 'utf8');
                    usedPath = localeFile;
                    break;
                }
            }
            
            if (!content) {
                console.warn(`Locale file not found for ${locale}, falling back to ${this.defaultLocale}`);
                
                // Try to load default language
                if (locale !== this.defaultLocale) {
                    return this.loadStrings(this.defaultLocale);
                }
                
                // If even default language cannot be found, throw error
                throw new Error(`Cannot find locale files. Please check extension installation.`);
            }

            return JSON.parse(content);
        } catch (error) {
            console.error(`Error loading locale ${locale}:`, error);
            
            // If not default language, try to load default language
            if (locale !== this.defaultLocale) {
                return this.loadStrings(this.defaultLocale);
            }
            
            // If even default language has problems, throw error
            throw new Error(`Failed to load locale files. Please check extension installation. Error: ${error}`);
        }
    }

    public setLocale(locale: string): void {
        this.currentLocale = locale;
        this.strings = this.loadStrings(locale);
        
        // Save to VS Code settings
        const config = vscode.workspace.getConfiguration('minidump-parser');
        config.update('language', locale, vscode.ConfigurationTarget.Global);
    }

    public getCurrentLocale(): string {
        return this.currentLocale;
    }

    public getAvailableLocales(): string[] {
        // Return hardcoded list of supported languages to ensure proper functioning in all environments
        return [...this.availableLocales];
    }

    // Get localized register information
    public getRegisterInfo(registerName: string): RegisterStrings | undefined {
        return this.strings.registers[registerName.toLowerCase()];
    }

    // Get localized UI string
    public getString(category: keyof LocalizedStrings, key: string): string {
        const categoryStrings = this.strings[category];
        const categoryValue = this.resolvePath(categoryStrings, key);
        if (typeof categoryValue === 'string') {
            return categoryValue;
        }

        // Some locale sections (for example installer and batchExtraction)
        // are intentionally kept outside "ui". Support namespaced keys such
        // as getUI('installer.downloadFailed') without returning the key.
        const rootValue = this.resolvePath(this.strings, key);
        return typeof rootValue === 'string' ? rootValue : key;
    }

    private resolvePath(value: unknown, key: string): unknown {
        if (!value || typeof value !== 'object') {
            return undefined;
        }

        let current: unknown = value;
        for (const segment of key.split('.')) {
            if (!current || typeof current !== 'object') {
                return undefined;
            }
            current = (current as { [key: string]: unknown })[segment];
        }
        return current;
    }

    // Get UI string with fallback
    public getUI(key: string): string {
        return this.getString('ui', key);
    }

    // Get value interpretation string
    public getValue(key: string): string {
        return this.getString('values', key);
    }

    // Get error string
    public getError(key: string): string {
        return this.getString('errors', key);
    }

    // Get crash analysis string
    public getCrash(key: string): string {
        return this.getString('crash', key);
    }

    // Get debug tip string
    public getDebugTip(key: string): string {
        return this.getString('debugTips', key);
    }

    // Format string with parameters (supports {0}, {1}, etc.)
    public format(template: string, ...args: any[]): string {
        return template.replace(/\{(\d+)\}/g, (match, index) => {
            const argIndex = parseInt(index, 10);
            return argIndex < args.length ? String(args[argIndex]) : match;
        });
    }

    // Get formatted value string
    public getFormattedValue(key: string, ...args: any[]): string {
        const template = this.getValue(key);
        return this.format(template, ...args);
    }

    // Get formatted error string
    public getFormattedError(key: string, ...args: any[]): string {
        const template = this.getError(key);
        return this.format(template, ...args);
    }

    // Reload strings (useful for development or when locale files change)
    public reload(): void {
        this.loadCurrentLocale();
        this.strings = this.loadStrings(this.currentLocale);
    }
}

// Export singleton instance
export const localization = LocalizationManager.getInstance();
