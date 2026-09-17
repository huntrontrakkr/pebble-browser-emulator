"""Bridge the external Dream-RSI harness to a frozen Pebble memory-access experiment.

The research tooling stays local; none of it is an application runtime dependency.
Candidate source is trusted experiment input, not an adversarial sandbox.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

TARGET = 'crates/qemu-emery/src/lib.rs'
START = '    fn read_byte('
END = '    fn set_active_pc('
BEGIN_MARKER = '    // Memory access experiment boundary: begin.\n'
END_MARKER = '    // Memory access experiment boundary: end.\n'


def memory_bounds(source):
    if BEGIN_MARKER in source and END_MARKER in source:
        return source.index(BEGIN_MARKER) + len(BEGIN_MARKER), source.index(END_MARKER)
    return source.index(START), source.index(END)


def memory_fragment(candidate):
    """Accept complete impl containers; remove only their insertion boundary braces."""
    stripped = candidate.strip()
    opening = 'impl PebbleBus {'
    if stripped.startswith(opening) and stripped.endswith('}'):
        return stripped[len(opening):-1].strip('\n') + '\n'
    return candidate


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def prepare(args):
    repo = Path(__file__).resolve().parents[2]
    harness = args.harness.resolve()
    if not (harness / 'dream_rsi/agent.py').is_file():
        raise ValueError('Supply the Dream-RSI checkout from the referenced thread')
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    frozen = out / 'frozen'
    frozen.mkdir()
    for name in ['Cargo.toml', 'Cargo.lock', 'crates', 'vendor']:
        source = repo / name
        if source.is_dir():
            shutil.copytree(source, frozen / name)
        else:
            shutil.copyfile(source, frozen / name)
    shutil.copytree(Path(__file__).parent, frozen / 'evaluator',
                    ignore=shutil.ignore_patterns('__pycache__'))
    files = {str(p.relative_to(frozen)): sha(p) for p in frozen.rglob('*') if p.is_file()}
    shutil.copytree(frozen, out / 'build')
    shutil.copyfile(repo / 'public/wasm/qemu-emery.wasm', out / 'baseline.wasm')
    source = (frozen / TARGET).read_text()
    start, end = memory_bounds(source)
    seed = out / 'seed'
    seed.mkdir()
    (seed / 'memory.rs').write_text('impl PebbleBus {\n' + source[start:end] + '}\n')
    (out / 'task.md').write_text('''Optimize this Rust memory-access fragment for browser WebAssembly performance.
Return both complete impl containers as inherited: impl PebbleBus and impl CoreBus for PebbleBus.
The adapter inserts these methods into the existing impls; protected methods outside the excerpt remain fixed.
The PebbleBus container begins with read_byte (helper methods may precede it); CoreBus ends after write32.
The host freezes all other source, firmware, compiler flags, tests, and evaluator. No test or workload edits are permitted.
Preserve every observable behavior: all byte/halfword/word accesses, unaligned and wrapping addresses,
region ordering (code, flash, RAM, frame), read-only code, first and last fault addresses, partial valid writes,
device MMIO side effects, and completed display snapshots (including monochrome row conversion).
Code Vec length may vary; flash/RAM/frame are public Vecs and tests also vary their lengths.
Do not skip execution, alter pixels or timing, invent register responses, special-case workloads or firmware,
add unsafe code, global caches, dependencies, conditional compilation, I/O, or change public interfaces.
Use safe Rust and bounded work. Helpers, inline annotations, contiguous little-endian slice operations,
and fast ordinary-memory paths with exact byte fallback are possible approaches. Measurements decide.
Available fields and types: code/flash/ram/frame/presented_frame: Vec<u8>; profile: BoardProfile;
devices: Devices; active_pc: u32; failed: Option<(u32,u32,bool)>; atomics: Arc<CoreAtomics>.
RAM is 0x20000000; FRAME is 0x50000000; flash base is 0x10000000.
The score is paired geometric-mean core throughput versus the frozen baseline across three real firmware images.
Invalid behavior, extra memory, or any profile/phase median regression exceeding 3% is rejected.
Reports contain measured per-profile speedups and compile/test failures. Reduce host work without changing guest behavior.
''')
    manifest = {
        'schema_version': 1,
        'repository_commit': subprocess.check_output(
            ['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
        'frozen_files': files,
        'baseline_sha256': sha(out / 'baseline.wasm'),
        'assets': str(args.assets.resolve()),
        'asset_hashes': {p.name: sha(p) for p in args.assets.resolve().glob('*.bin')},
        'harness': str(harness),
        'harness_files': {
            str(p.relative_to(harness)): sha(p)
            for p in (harness / 'dream_rsi').rglob('*.py')
        },
        'cargo': shutil.which('cargo') or str(Path.home() / '.cargo/bin/cargo'),
    }
    write_json(out / 'manifest.json', manifest)
    config = {
        'seed_workspace': 'seed',
        'agent_command': [
            sys.executable, str(harness / 'dream_rsi/agent.py'),
            '--task', str(out / 'task.md'), '--artifact', 'memory.rs',
            '--model', 'gpt-5.6-luna', '--reasoning-effort', 'high',
            '--timeout-seconds', '180',
        ],
        'evaluator_command': [
            sys.executable, str(frozen / 'evaluator/research.py'),
            'evaluate', '--experiment', str(out),
        ],
        'cycles': 2,
        'budget': {'max_rounds': 3, 'max_attempts': 3, 'workers': 1},
        'beta_cost': 0.005,
        'beta_parallel': 0,
        'timeout_seconds': 300,
        'policy_improvement': 'evolve',
        'policy_revisions': 1,
        'policy_timeout_seconds': 2,
        'model': {
            'model': 'gpt-5.6-luna', 'reasoning_effort': 'high',
            'timeout_seconds': 180,
        },
    }
    write_json(out / 'config.json', config)
    print(json.dumps({
        'config': str(out / 'config.json'), 'maximum_discovery_calls': 6,
        'maximum_policy_calls': 1, 'workers': 1,
    }))


def evaluate(args):
    experiment = args.experiment.resolve()
    manifest = json.loads((experiment / 'manifest.json').read_text())
    frozen = experiment / 'frozen'
    result = Path(os.environ['DREAM_RSI_RESULT'])
    diagnostics = {'valid': False}
    try:
        for name, digest in manifest['frozen_files'].items():
            if sha(frozen / name) != digest:
                raise ValueError('Frozen evaluator/source changed: ' + name)
        if sha(experiment / 'baseline.wasm') != manifest['baseline_sha256']:
            raise ValueError('Baseline changed')
        for name, digest in manifest['asset_hashes'].items():
            if sha(Path(manifest['assets']) / name) != digest:
                raise ValueError('Firmware changed: ' + name)
        candidate = Path('memory.rs').read_text()
        if len(candidate) > 60000 or re.search(r'\b(unsafe|extern|include|include_str|include_bytes|mod|cfg|cfg_attr)\b|std::(fs|process|env|thread)|\basm!', candidate):
            raise ValueError('Candidate outside the permitted memory fragment')
        source = (frozen / TARGET).read_text()
        start, end = memory_bounds(source)
        build = experiment / 'build'
        # Restore protected input before every candidate. Only this fragment can vary.
        for name in manifest['frozen_files']:
            if name != TARGET and (not (build / name).is_file() or sha(build / name) != manifest['frozen_files'][name]):
                shutil.copyfile(frozen / name, build / name)
        fragment = memory_fragment(candidate)
        (build / TARGET).write_text(source[:start] + fragment + source[end:])
        env = {**os.environ, 'CARGO_TARGET_DIR': str(experiment / 'target')}

        def command(argv):
            completed = subprocess.run(
                argv, cwd=build, env=env, capture_output=True, text=True, timeout=240)
            if completed.returncode:
                error = completed.stdout + completed.stderr
                raise ValueError(error if len(error) <= 8000 else error[:4000] + '\n[truncated]\n' + error[-4000:])
            return completed.stdout
        command([manifest['cargo'], 'test', '--workspace', '--locked', '--quiet'])
        command([manifest['cargo'], 'build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '-p', 'emulator-qemu'])
        candidate_wasm = experiment / 'target/wasm32-unknown-unknown/release/emulator_qemu.wasm'
        report_path = result.parent / 'benchmark.json'
        command(['node', str(frozen / 'evaluator/benchmark.mjs'), str(experiment / 'baseline.wasm'), str(candidate_wasm), manifest['assets'], str(report_path)])
        report = json.loads(report_path.read_text())
        valid = report['valid'] and all(
            r['medianSpeedup'] >= .97 and min(r['phases'].values()) >= .97
            and all(s['candidate']['memoryBytes'] <= s['baseline']['memoryBytes']
                    for s in r['samples'])
            for r in report['results']
        )
        diagnostics = {
            'valid': valid,
            'candidate_sha256': sha(Path('memory.rs')),
            'wasm_sha256': sha(candidate_wasm),
            'core_speedup': report['score'],
            'profiles': [
                {k: r[k] for k in ['profile', 'medianSpeedup', 'minimumPairedSpeedup', 'phases']}
                for r in report['results']
            ],
            'all_fidelity_traces_equal': True,
            'rust_tests_passed': True,
        }
        shutil.copyfile(candidate_wasm, result.parent / 'candidate.wasm')
        write_json(result, {'score': report['score'], 'diagnostics': diagnostics})
    except Exception as error:
        diagnostics['error'] = str(error)
        write_json(result, {'score': 0, 'diagnostics': diagnostics})
    print(json.dumps(diagnostics))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    setup = sub.add_parser('prepare')
    setup.add_argument('--harness', type=Path, required=True)
    setup.add_argument('--assets', type=Path, required=True)
    setup.add_argument('--output', type=Path, required=True)
    check = sub.add_parser('evaluate')
    check.add_argument('--experiment', type=Path, required=True)
    args = parser.parse_args()
    (prepare if args.command == 'prepare' else evaluate)(args)
