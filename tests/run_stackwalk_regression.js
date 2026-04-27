#!/usr/bin/env node
/**
 * DumpStorm — Stackwalk regression runner.
 *
 * For every minidump under tests/crashers/dumps/, this script:
 *   1. Runs `minidump_stackwalk -m <dump> [<symbolPath>]`  (machine format)
 *   2. Runs `minidump_stackwalk    <dump> [<symbolPath>]`  (human format)
 *   3. Pipes both outputs through the *exact* helpers the extension uses
 *      (parseMachineFormat + cleanStackwalkOutput) loaded from `out/`.
 *   4. Writes the cleaned output to tests/crashers/analysis/<name>.cleaned.txt
 *   5. Asserts a small set of invariants per dump.
 *
 * Run after `npm run compile`. minidump_stackwalk must be on PATH or under
 * ~/.dumpstorm/bin/.
 *
 * Exit code is the number of failed invariants across all dumps (0 = pass).
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const Module = require('module');

// The compiled out/ modules (loaded later via require) transitively pull in
// `vscode`, which is supplied by the host editor at runtime — not by Node.
// Inject a tiny shim so the regression script can run from a plain shell.
const vscodeShim = {
    workspace: {
        getConfiguration: () => ({ get: () => undefined }),
    },
    window: { showInformationMessage: () => {}, showErrorMessage: () => {} },
    env: { language: 'en' },
    Uri: { file: (p) => ({ fsPath: p }) },
    ProgressLocation: { Notification: 15 },
};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return 'vscode';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeShim };

const ROOT          = path.resolve(__dirname, '..');
const DUMPS_DIR     = path.join(__dirname, 'crashers', 'dumps');
const ANALYSIS_DIR  = path.join(__dirname, 'crashers', 'analysis');
const SYMBOL_PATH   = path.join(os.homedir(), '.dumpstorm', 'symbols');

function which(cmd) {
    try {
        const w = os.platform() === 'win32' ? 'where' : 'which';
        return require('child_process').execSync(`${w} ${cmd}`, {
            encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim().split(/\r?\n/)[0];
    } catch { return null; }
}

function findStackwalk() {
    const binName = os.platform() === 'win32' ? 'minidump_stackwalk.exe' : 'minidump_stackwalk';
    const local = path.join(os.homedir(), '.dumpstorm', 'bin', binName);
    if (fs.existsSync(local)) return local;
    return which('minidump_stackwalk');
}

function loadCompiledHelpers() {
    const stackwalkOut = path.join(ROOT, 'out', 'analysis', 'stackwalk.js');
    const machineOut   = path.join(ROOT, 'out', 'analysis', 'machine-format.js');
    if (!fs.existsSync(stackwalkOut) || !fs.existsSync(machineOut)) {
        console.error('ERROR: out/ missing. Run `npm run compile` first.');
        process.exit(2);
    }
    return {
        cleanStackwalkOutput: require(stackwalkOut).cleanStackwalkOutput,
        parseMachineFormat:   require(machineOut).parseMachineFormat,
    };
}

function runStackwalk(stackwalk, args) {
    const r = spawnSync(stackwalk, args, {
        timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function checkInvariants(name, cleaned) {
    const failures = [];
    if (!/=== CRASH SUMMARY ===/.test(cleaned)) {
        failures.push('missing CRASH SUMMARY block');
    }
    if (!/Thread\s+\d+/.test(cleaned)) {
        failures.push('no Thread N line');
    }
    if (!/0x[0-9a-fA-F]{2,}/.test(cleaned)) {
        failures.push('no hex addresses present');
    }
    if (/INFO:|DEBUG:/.test(cleaned)) {
        failures.push('debug noise leaked into cleaned output');
    }
    return failures;
}

function main() {
    if (!fs.existsSync(DUMPS_DIR)) {
        console.error(`ERROR: ${DUMPS_DIR} does not exist. Run tests/run_crash_tests.js first.`);
        process.exit(2);
    }
    const dumps = fs.readdirSync(DUMPS_DIR).filter(f => f.toLowerCase().endsWith('.dmp'));
    if (dumps.length === 0) {
        console.error('ERROR: no .dmp files found.');
        process.exit(2);
    }
    const stackwalk = findStackwalk();
    if (!stackwalk) {
        console.error('ERROR: minidump_stackwalk not found.');
        process.exit(2);
    }

    const { cleanStackwalkOutput, parseMachineFormat } = loadCompiledHelpers();
    if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR, { recursive: true });

    let totalFailures = 0;
    const symbolPathArg = fs.existsSync(SYMBOL_PATH) ? [SYMBOL_PATH] : [];

    console.log(`Stackwalk : ${stackwalk}`);
    console.log(`SymbolPath: ${symbolPathArg.length ? SYMBOL_PATH : '(none)'}`);
    console.log(`Dumps     : ${dumps.length}\n`);

    for (const dump of dumps) {
        const dumpPath = path.join(DUMPS_DIR, dump);
        const baseName = path.basename(dump, '.dmp');

        const machine = runStackwalk(stackwalk, ['-m', dumpPath, ...symbolPathArg]);
        const human   = runStackwalk(stackwalk, [dumpPath, ...symbolPathArg]);

        let machineDump = null;
        try { machineDump = parseMachineFormat(machine.stdout); } catch { /* tolerated */ }

        const cleaned = cleanStackwalkOutput(human.stdout, human.stderr, {
            machineDump,
            symbolPath: symbolPathArg[0],
        });

        const outFile = path.join(ANALYSIS_DIR, `${baseName}.cleaned.txt`);
        fs.writeFileSync(outFile, cleaned, 'utf8');

        const failures = checkInvariants(baseName, cleaned);
        if (failures.length === 0) {
            console.log(`  PASS  ${baseName}`);
        } else {
            console.log(`  FAIL  ${baseName}`);
            for (const f of failures) console.log(`        - ${f}`);
            totalFailures += failures.length;
        }
    }

    console.log(`\nTotal failures: ${totalFailures}`);
    process.exit(totalFailures > 0 ? 1 : 0);
}

main();
