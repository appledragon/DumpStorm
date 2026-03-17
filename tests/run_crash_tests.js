#!/usr/bin/env node
/**
 * DumpStorm Crash Test Runner
 *
 * Builds the C++ crash test programs, runs each scenario to produce
 * real minidump files, then optionally analyses them with minidump_stackwalk.
 *
 * Usage:  node tests/run_crash_tests.js
 *
 * Prerequisites:
 *   - CMake 3.20+
 *   - A C++20 compiler (MSVC / GCC / Clang)
 *   - (optional) minidump_stackwalk in PATH or ~/.dumpstorm/bin/
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Paths ───────────────────────────────────────────────────────────────────

const CRASHERS_DIR = path.join(__dirname, 'crashers');
const BUILD_DIR    = path.join(CRASHERS_DIR, 'build');
const DUMPS_DIR    = path.join(CRASHERS_DIR, 'dumps');
const ANALYSIS_DIR = path.join(CRASHERS_DIR, 'analysis');

const SCENARIOS = [
    'null_deref',
    'stack_overflow',
    'divide_by_zero',
    'illegal_instruction',
    'abort',
    'wild_pointer',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function which(cmd) {
    try {
        const w = os.platform() === 'win32' ? 'where' : 'which';
        return execSync(`${w} ${cmd}`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim().split(/\r?\n/)[0];
    } catch { return null; }
}

function findBinary() {
    const candidates = [
        path.join(BUILD_DIR, 'crash_test'),
        path.join(BUILD_DIR, 'crash_test.exe'),
        path.join(BUILD_DIR, 'Debug', 'crash_test.exe'),
        path.join(BUILD_DIR, 'Release', 'crash_test.exe'),
        path.join(BUILD_DIR, 'RelWithDebInfo', 'crash_test.exe'),
    ];
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return null;
}

function findMinidumpStackwalk() {
    // Check ~/.dumpstorm/bin/ first
    const binName = os.platform() === 'win32' ? 'minidump_stackwalk.exe' : 'minidump_stackwalk';
    const dumpstormBin = path.join(os.homedir(), '.dumpstorm', 'bin', binName);
    if (fs.existsSync(dumpstormBin)) return dumpstormBin;
    return which('minidump_stackwalk');
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Check prerequisites ─────────────────────────────────────────────────────

function checkPrerequisites() {
    if (!which('cmake')) {
        console.error('ERROR: cmake not found. Please install CMake 3.20+.');
        return false;
    }
    console.log('  cmake  : OK');
    return true;
}

// ── Build ───────────────────────────────────────────────────────────────────

function build() {
    ensureDir(BUILD_DIR);

    console.log('\n--- Configuring (CMake) ---');
    execSync('cmake ..', { cwd: BUILD_DIR, stdio: 'inherit' });

    console.log('\n--- Building ---');
    execSync('cmake --build . --config Debug', { cwd: BUILD_DIR, stdio: 'inherit' });
}

// ── Run scenarios ───────────────────────────────────────────────────────────

function runScenario(binary, scenario) {
    const dumpPath = path.join(DUMPS_DIR, `crash_${scenario}.dmp`);

    // Remove old dump if present
    if (fs.existsSync(dumpPath)) fs.unlinkSync(dumpPath);

    const result = spawnSync(binary, [scenario, dumpPath], {
        cwd:      DUMPS_DIR,
        timeout:  30000,
        encoding: 'utf8',
        stdio:    ['ignore', 'pipe', 'pipe'],
    });

    // The process must crash (non-zero exit)
    if (result.status === 0) {
        console.log(`  WARN  ${scenario} — exited normally (no crash)`);
        return null;
    }

    if (!fs.existsSync(dumpPath)) {
        console.log(`  FAIL  ${scenario} — no dump file created`);
        if (result.stderr) console.log(`        stderr: ${result.stderr.trim()}`);
        return null;
    }

    const buf = fs.readFileSync(dumpPath);
    if (buf.length < 32 || buf.readUInt32LE(0) !== 0x504D444D) {
        console.log(`  FAIL  ${scenario} — invalid MDMP header`);
        return null;
    }

    const sizeKB = (buf.length / 1024).toFixed(1);
    console.log(`  OK    ${scenario}  (${sizeKB} KB)`);
    return dumpPath;
}

// ── Analyse with minidump_stackwalk ─────────────────────────────────────────

function analyseDump(stackwalk, dumpPath) {
    const result = spawnSync(stackwalk, [dumpPath], {
        timeout:  30000,
        encoding: 'utf8',
        stdio:    ['ignore', 'pipe', 'pipe'],
    });

    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    return output;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
    console.log('=========================================');
    console.log(' DumpStorm Crash Test Runner');
    console.log('=========================================\n');

    console.log('Checking prerequisites...');
    if (!checkPrerequisites()) process.exit(1);

    build();

    const binary = findBinary();
    if (!binary) {
        console.error('\nERROR: crash_test binary not found after build.');
        process.exit(1);
    }
    console.log(`\nUsing binary: ${binary}`);

    ensureDir(DUMPS_DIR);
    ensureDir(ANALYSIS_DIR);

    // ── Run each scenario ──

    console.log('\n--- Running crash scenarios ---\n');

    const results = [];
    for (const sc of SCENARIOS) {
        const dumpPath = runScenario(binary, sc);
        results.push({ scenario: sc, dumpPath });
    }

    // ── Analyse dumps with minidump_stackwalk ──

    const stackwalk = findMinidumpStackwalk();
    if (stackwalk) {
        console.log(`\n--- Analysing dumps (${stackwalk}) ---\n`);
        for (const r of results) {
            if (!r.dumpPath) continue;
            const output = analyseDump(stackwalk, r.dumpPath);

            // Save raw output
            const outFile = path.join(ANALYSIS_DIR, `${r.scenario}.txt`);
            fs.writeFileSync(outFile, output, 'utf8');
            console.log(`  ${r.scenario} → ${path.basename(outFile)}`);

            // Quick sanity checks on the output
            const checks = [];
            if (/Crash reason:/i.test(output) || /Thread\s+\d+/i.test(output))
                checks.push('has crash/thread info');
            if (/0x[0-9a-fA-F]{4,}/i.test(output))
                checks.push('has addresses');
            if (/Operating system:/i.test(output))
                checks.push('has OS info');

            if (checks.length > 0) {
                console.log(`         ✓ ${checks.join(', ')}`);
            } else {
                console.log(`         ⚠ output may be limited`);
            }
        }
    } else {
        console.log('\n--- Skipping analysis (minidump_stackwalk not found) ---');
        console.log('    Install minidump_stackwalk or use DumpStorm to analyse the dumps.');
    }

    // ── Summary ──

    const ok   = results.filter(r => r.dumpPath).length;
    const fail = results.length - ok;

    console.log('\n=========================================');
    console.log(` Results: ${ok} passed, ${fail} failed (${results.length} total)`);
    console.log(` Dumps   : ${DUMPS_DIR}`);
    if (stackwalk)
        console.log(` Analysis: ${ANALYSIS_DIR}`);
    console.log('=========================================\n');

    process.exit(fail > 0 ? 1 : 0);
}

main();
