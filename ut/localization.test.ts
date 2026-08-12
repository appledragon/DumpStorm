// vscode is mocked globally via jest.config.js moduleNameMapper
import { LocalizationManager } from '../src/localization/localization';

describe('LocalizationManager', () => {
  let manager: LocalizationManager;

  beforeEach(() => {
    // Reset the singleton for each test by accessing it fresh  
    manager = LocalizationManager.getInstance();
  });

  describe('format', () => {
    it('should replace {0} with first argument', () => {
      const result = manager.format('Hello {0}!', 'World');
      expect(result).toBe('Hello World!');
    });

    it('should replace multiple placeholders', () => {
      const result = manager.format('{0} and {1}', 'foo', 'bar');
      expect(result).toBe('foo and bar');
    });

    it('should handle missing arguments gracefully', () => {
      const result = manager.format('Missing {0} and {1}', 'first');
      expect(result).toBe('Missing first and {1}');
    });

    it('should handle no placeholders', () => {
      const result = manager.format('No placeholders here');
      expect(result).toBe('No placeholders here');
    });

    it('should handle repeated placeholder indices', () => {
      const result = manager.format('{0} is {0}', 'same');
      expect(result).toBe('same is same');
    });

    it('should convert non-string arguments', () => {
      const result = manager.format('Number: {0}, Boolean: {1}', 42, true);
      expect(result).toBe('Number: 42, Boolean: true');
    });
  });

  describe('getString', () => {
    it('should return key as fallback when key not found in UI', () => {
      const result = manager.getUI('nonExistentKeyXYZ123');
      expect(result).toBe('nonExistentKeyXYZ123');
    });

    it('should resolve nested locale keys from other sections', () => {
      expect(manager.getUI('installer.downloadFailed')).not.toBe('installer.downloadFailed');
      expect(manager.getUI('batchExtraction.failedFiles')).not.toBe('batchExtraction.failedFiles');
    });
  });

  describe('getAvailableLocales', () => {
    it('should return available locales', () => {
      const locales = manager.getAvailableLocales();
      expect(locales).toContain('en');
      expect(locales).toContain('zh-cn');
    });

    it('should return a copy (not the original array)', () => {
      const locales1 = manager.getAvailableLocales();
      const locales2 = manager.getAvailableLocales();
      expect(locales1).not.toBe(locales2);
      expect(locales1).toEqual(locales2);
    });
  });

  describe('getCurrentLocale', () => {
    it('should return current locale', () => {
      const locale = manager.getCurrentLocale();
      expect(typeof locale).toBe('string');
      expect(['en', 'zh-cn']).toContain(locale);
    });
  });

  describe('language preference', () => {
    const vscode = require('vscode');

    function mockLanguageSetting(value: string | undefined, envLanguage = 'en') {
      let stored = value;
      vscode.env.language = envLanguage;
      vscode.workspace.getConfiguration.mockReturnValue({
        get: jest.fn((key: string) => key === 'language' ? stored : undefined),
        update: jest.fn().mockImplementation((_key: string, newValue: string) => {
          stored = newValue;
          return Promise.resolve();
        })
      });
    }

    afterEach(() => {
      vscode.env.language = 'en';
      vscode.workspace.getConfiguration.mockReturnValue({
        get: jest.fn().mockReturnValue(undefined),
        update: jest.fn().mockResolvedValue(undefined)
      });
      manager.reload();
    });

    it('follows VS Code display language when the setting is auto', () => {
      mockLanguageSetting('auto', 'zh-cn');
      manager.reload();
      expect(manager.getLanguagePreference()).toBe('auto');
      expect(manager.getCurrentLocale()).toBe('zh-cn');
    });

    it('follows VS Code display language when the setting is empty', () => {
      mockLanguageSetting('', 'zh-cn');
      manager.reload();
      expect(manager.getLanguagePreference()).toBe('auto');
      expect(manager.getCurrentLocale()).toBe('zh-cn');
    });

    it('uses an explicit locale instead of VS Code display language', () => {
      mockLanguageSetting('en', 'zh-cn');
      manager.reload();
      expect(manager.getLanguagePreference()).toBe('en');
      expect(manager.getCurrentLocale()).toBe('en');
    });

    it('writes auto to settings and reloads from VS Code display language', async () => {
      mockLanguageSetting('en', 'zh-cn');
      manager.reload();
      await manager.setLocale('auto');
      expect(manager.getLanguagePreference()).toBe('auto');
      expect(manager.getCurrentLocale()).toBe('zh-cn');
    });
  });

  describe('getFormattedValue', () => {
    it('should format value template with arguments', () => {
      // This calls getValue then format
      const result = manager.getFormattedValue('smallInteger', 42);
      expect(typeof result).toBe('string');
    });
  });

  describe('getFormattedError', () => {
    it('should format error template with arguments', () => {
      const result = manager.getFormattedError('errorCode', 'C0000005');
      expect(typeof result).toBe('string');
    });
  });

  describe('getString categories', () => {
    it('should access different string categories', () => {
      // These should all return strings (possibly fallback to key)
      expect(typeof manager.getValue('nullPointer')).toBe('string');
      expect(typeof manager.getError('accessViolation')).toBe('string');
      expect(typeof manager.getCrash('nullInstructionPointer')).toBe('string');
      expect(typeof manager.getDebugTip('checkDisassembly')).toBe('string');
    });
  });
});
