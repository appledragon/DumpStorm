'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHECK_BUILT_OUTPUT = process.argv.includes('--built');
const errors = [];
const warnings = [];

function addError(message) {
    errors.push(message);
}

function addWarning(message) {
    warnings.push(message);
}

function readJson(filePath, label) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        addError(`${label} 无法读取或不是有效 JSON：${error.message}`);
        return null;
    }
}

function isFile(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function relative(filePath) {
    return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function collectFiles(directory, extension) {
    if (!fs.existsSync(directory)) {
        return [];
    }

    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(fullPath, extension));
        } else if (!extension || entry.name.endsWith(extension)) {
            files.push(fullPath);
        }
    }
    return files;
}

function readSourceFiles() {
    return collectFiles(path.join(ROOT, 'src'), '.ts')
        .map(filePath => fs.readFileSync(filePath, 'utf8'))
        .join('\n');
}

function collectMatches(text, expression) {
    const matches = new Set();
    expression.lastIndex = 0;
    let match;
    while ((match = expression.exec(text)) !== null) {
        matches.add(match[1]);
    }
    return matches;
}

function sorted(values) {
    return [...values].sort();
}

function difference(left, right) {
    return sorted([...left].filter(value => !right.has(value)));
}

function formatList(values) {
    return values.length > 0 ? values.join(', ') : '(无)';
}

function flattenKeys(value, prefix = '', output = new Set()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        if (prefix) {
            output.add(prefix);
        }
        return output;
    }

    for (const key of Object.keys(value)) {
        const current = prefix ? `${prefix}.${key}` : key;
        flattenKeys(value[key], current, output);
    }
    return output;
}

function flattenLocaleValues(value, prefix = '', output = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        if (prefix) {
            output[prefix] = value;
        }
        return output;
    }

    for (const key of Object.keys(value)) {
        const current = prefix ? `${prefix}.${key}` : key;
        flattenLocaleValues(value[key], current, output);
    }
    return output;
}

function getManifestConfiguration(manifest) {
    return manifest?.contributes?.configuration?.properties ?? {};
}

function checkIcon(manifest) {
    const icon = manifest.icon;
    if (typeof icon !== 'string' || icon.trim() === '') {
        addError('package.json 未配置 icon，Marketplace 发布需要 PNG 图标。');
        return;
    }

    const iconPath = path.resolve(ROOT, icon);
    if (!isFile(iconPath)) {
        addError(`图标文件不存在：${icon}（package.json.icon）`);
        return;
    }

    if (path.extname(iconPath).toLowerCase() !== '.png') {
        addError(`图标必须是 PNG 文件：${icon}`);
    }
}

function checkLocales(manifest, sourceText) {
    const localesDir = path.join(ROOT, 'src', 'localization', 'locales');
    const localeFiles = fs.existsSync(localesDir)
        ? fs.readdirSync(localesDir)
            .filter(file => file.endsWith('.json'))
            .sort()
        : [];

    if (localeFiles.length === 0) {
        addError('src/localization/locales 中没有 locale JSON 文件。');
        return;
    }

    const localeData = new Map();
    for (const file of localeFiles) {
        const locale = path.basename(file, '.json');
        const data = readJson(path.join(localesDir, file), `locale ${file}`);
        if (!data) {
            continue;
        }
        for (const requiredSection of ['registers', 'ui', 'values', 'errors', 'crash', 'debugTips']) {
            if (!Object.prototype.hasOwnProperty.call(data, requiredSection)) {
                addError(`locale ${file} 缺少顶层节点：${requiredSection}`);
            }
        }
        localeData.set(locale, data);
    }

    const baseLocale = localeData.get('en');
    if (!baseLocale) {
        addError('缺少基准语言文件：src/localization/locales/en.json');
    } else {
        const baseKeys = flattenKeys(baseLocale);
        for (const [locale, data] of localeData) {
            if (locale === 'en') {
                continue;
            }
            const keys = flattenKeys(data);
            const missing = difference(baseKeys, keys);
            const extra = difference(keys, baseKeys);
            if (missing.length > 0 || extra.length > 0) {
                addError(
                    `locale ${locale}.json 与 en.json 的 key 不一致；` +
                    `缺少：${formatList(missing)}；多余：${formatList(extra)}`,
                );
            }
        }

        for (const [locale, data] of localeData) {
            for (const [key, value] of Object.entries(flattenLocaleValues(data))) {
                if (typeof value !== 'string') {
                    addError(`locale ${locale}.json 的 ${key} 必须是字符串。`);
                }
            }
        }
    }

    const languageProperty = getManifestConfiguration(manifest)['minidump-parser.language'];
    const manifestLocales = new Set(Array.isArray(languageProperty?.enum) ? languageProperty.enum : []);
    const fileLocales = new Set(localeData.keys());
    const missingFiles = difference(manifestLocales, fileLocales);
    const unlistedFiles = difference(fileLocales, manifestLocales);
    if (missingFiles.length > 0 || unlistedFiles.length > 0) {
        addError(
            `package.json 的 language enum 与 locale 文件不一致；` +
            `缺少文件：${formatList(missingFiles)}；未列入 enum：${formatList(unlistedFiles)}`,
        );
    }

    const availableMatch = sourceText.match(
        /availableLocales\s*:\s*string\[\]\s*=\s*\[([\s\S]*?)\]/,
    );
    if (!availableMatch) {
        addError('无法检查 LocalizationManager.availableLocales。');
    } else {
        const availableLocales = new Set(
            [...availableMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map(match => match[1]),
        );
        const missingFromManager = difference(fileLocales, availableLocales);
        const missingFromFiles = difference(availableLocales, fileLocales);
        if (missingFromManager.length > 0 || missingFromFiles.length > 0) {
            addError(
                `LocalizationManager.availableLocales 与 locale 文件不一致；` +
                `未注册：${formatList(missingFromManager)}；不存在文件：${formatList(missingFromFiles)}`,
            );
        }
    }
}

function collectManifestMenuCommands(value, output = new Set()) {
    if (!value || typeof value !== 'object') {
        return output;
    }
    if (Array.isArray(value)) {
        value.forEach(item => collectManifestMenuCommands(item, output));
        return output;
    }
    if (typeof value.command === 'string') {
        output.add(value.command);
    }
    Object.values(value).forEach(item => collectManifestMenuCommands(item, output));
    return output;
}

function collectSourceCommandReferences(sourceText) {
    return collectMatches(
        sourceText,
        /(?:\bcommand\s*:|\bexecuteCommand\s*\(\s*)['"`](minidump-parser\.[^'"`]+)['"`]/g,
    );
}

function checkCommands(manifest, sourceText) {
    const contributed = new Set(
        (manifest?.contributes?.commands ?? [])
            .map(command => command?.command)
            .filter(command => typeof command === 'string'),
    );
    const registered = collectMatches(
        sourceText,
        /registerCommand\s*\(\s*['"`](minidump-parser\.[^'"`]+)['"`]/g,
    );
    const sourceReferences = collectSourceCommandReferences(sourceText);
    const menuCommands = collectManifestMenuCommands(manifest?.contributes?.menus);

    const duplicateCommands = (manifest?.contributes?.commands ?? [])
        .map(command => command?.command)
        .filter((command, index, commands) => command && commands.indexOf(command) !== index);
    if (duplicateCommands.length > 0) {
        addError(`package.json 存在重复 command：${formatList([...new Set(duplicateCommands)])}`);
    }

    const unregistered = difference(contributed, registered);
    if (unregistered.length > 0) {
        addError(`package.json 中贡献但未在 extension.ts 注册的 command：${formatList(unregistered)}`);
    }

    const menuUnregistered = difference(menuCommands, registered);
    if (menuUnregistered.length > 0) {
        addError(`菜单引用但未注册的 command：${formatList(menuUnregistered)}`);
    }

    const sourceUnregistered = difference(sourceReferences, registered);
    if (sourceUnregistered.length > 0) {
        addError(`源码引用但未注册的 command：${formatList(sourceUnregistered)}`);
    }

    // revealToolPath is intentionally internal: it is used by TreeItem
    // actions but should not appear in the Command Palette.
    const internalCommands = new Set(['minidump-parser.revealToolPath']);
    const unlistedRegistered = difference(registered, contributed);
    const unexpectedUnlisted = unlistedRegistered.filter(command => !internalCommands.has(command));
    if (unexpectedUnlisted.length > 0) {
        addError(`代码注册但未贡献且未标记为 internal 的 command：${formatList(unexpectedUnlisted)}`);
    }
    const internalUsed = unlistedRegistered.filter(command => internalCommands.has(command));
    if (internalUsed.length > 0) {
        addWarning(`检测到内部 command（不会出现在 Command Palette）：${formatList(internalUsed)}`);
    }

    return { contributed, registered };
}

function checkConfiguration(manifest, sourceText) {
    const prefix = 'minidump-parser.';
    const properties = getManifestConfiguration(manifest);
    const declared = new Set(
        Object.keys(properties)
            .filter(key => key.startsWith(prefix))
            .map(key => key.slice(prefix.length)),
    );

    const duplicateProperties = Object.keys(properties)
        .filter((key, index, keys) => keys.indexOf(key) !== index);
    if (duplicateProperties.length > 0) {
        addError(`package.json 存在重复配置项：${formatList([...new Set(duplicateProperties)])}`);
    }

    const used = new Set();
    const configVariables = collectMatches(
        sourceText,
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*vscode\.workspace\.getConfiguration\(\s*['"]minidump-parser['"]\s*\)/g,
    );
    for (const variable of configVariables) {
        const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const variableExpression = new RegExp(
            `\\b${escapedVariable}\\s*\\.\\s*(?:get|update|inspect)\\s*(?:<[^>\\r\\n]+>)?\\s*\\(\\s*['"]([^'"]+)['"]`,
            'g',
        );
        for (const key of collectMatches(sourceText, variableExpression)) {
            used.add(key);
        }
    }
    for (const key of collectMatches(
        sourceText,
        /affectsConfiguration\(\s*['"]minidump-parser\.([^'"]+)['"]/g,
    )) {
        used.add(key);
    }
    for (const match of sourceText.matchAll(/getCustomSettingPath\s*\(\s*['"]([^'"]+)['"]/g)) {
        used.add(match[1]);
    }

    const undeclared = difference(used, declared);
    const unused = difference(declared, used);
    if (undeclared.length > 0) {
        addError(`代码使用但 package.json 未声明的配置项：${formatList(undeclared)}`);
    }
    if (unused.length > 0) {
        addError(`package.json 声明但代码未使用的配置项：${formatList(unused)}`);
    }
}

function checkBuiltOutput(manifest, localeFiles) {
    const main = manifest.main;
    if (typeof main !== 'string' || !isFile(path.resolve(ROOT, main))) {
        addError(`编译产物不存在：${main || '(package.json.main 未配置)'}`);
    }

    const outputLocaleDir = path.join(ROOT, 'out', 'localization', 'locales');
    for (const localeFile of localeFiles) {
        if (!isFile(path.join(outputLocaleDir, localeFile))) {
            addError(`locale 未复制到编译产物：out/localization/locales/${localeFile}`);
        }
    }
}

function main() {
    const packagePath = path.join(ROOT, 'package.json');
    const manifest = readJson(packagePath, 'package.json');
    if (!manifest) {
        process.exitCode = 1;
        return;
    }

    const sourceText = readSourceFiles();
    checkIcon(manifest);
    checkLocales(manifest, sourceText);
    checkCommands(manifest, sourceText);
    checkConfiguration(manifest, sourceText);

    const localeDir = path.join(ROOT, 'src', 'localization', 'locales');
    const localeFiles = fs.existsSync(localeDir)
        ? fs.readdirSync(localeDir).filter(file => file.endsWith('.json'))
        : [];
    if (CHECK_BUILT_OUTPUT) {
        checkBuiltOutput(manifest, localeFiles);
    }

    if (warnings.length > 0) {
        console.warn('\n发布前校验提示：');
        warnings.forEach(message => console.warn(`  ⚠ ${message}`));
    }

    if (errors.length > 0) {
        console.error('\n发布前校验失败：');
        errors.forEach(message => console.error(`  ✖ ${message}`));
        process.exitCode = 1;
        return;
    }

    console.log(
        `发布前校验通过：图标、${localeFiles.length} 个 locale、命令注册和配置项均一致。` +
        (CHECK_BUILT_OUTPUT ? ' 编译产物也已检查。' : ''),
    );
}

main();

