// SPDX-FileCopyrightText: 2024 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Header and platform conventions follow Apache-2.0 PebbleOS SDK source (Google LLC, 2024).
import { packagePbw } from './portable-pbw.mjs';
const text = new TextEncoder(),
  read = new TextDecoder();
const PLATFORM_DEFINES = [
  'PBL_PLATFORM_EMERY',
  'PBL_COLOR',
  'PBL_RECT',
  'PBL_MICROPHONE',
  'PBL_SMARTSTRAP',
  'PBL_HEALTH',
  'PBL_SMARTSTRAP_POWER',
  'PBL_COMPASS',
  'PBL_TOUCH',
  'PBL_RGB_BACKLIGHT',
  'PBL_SPEAKER',
  'PBL_DISPLAY_WIDTH=200',
  'PBL_DISPLAY_HEIGHT=228',
  'PBL_SDK_3',
  'RELEASE',
];
const CFLAGS = [
  '--target=arm-none-eabi',
  '-mcpu=cortex-m3',
  '-mthumb',
  '-std=c99',
  '-fshort-enums',
  '-fno-builtin',
  '-ffunction-sections',
  '-fdata-sections',
  '-fcommon',
  '-g',
  '-fPIE',
  '-Os',
  '-D_TIME_H_',
  '-Dtime_t=long',
  '-D_DEFAULT_SOURCE',
  '-D__time_t_defined',
  '-D_TIME_T_DECLARED',
  '-include',
  'sys/types.h',
  '--sysroot=/usr',
  '-I/sdk/include',
  '-I/project/build',
  '-I/project/src',
  '-I/project/include',
  '-I/project',
  ...PLATFORM_DEFINES.map((d) => '-D' + d),
];
const STANDARD_WSCRIPTS = [
  `top = '.'
out = 'build'
def options(ctx):
 ctx.load('pebble_sdk')
def configure(ctx):
 ctx.load('pebble_sdk')
def build(ctx):
 ctx.load('pebble_sdk')
 binaries = []
 original_env = ctx.env
 for platform in ctx.env.TARGET_PLATFORMS:
  ctx.env = ctx.all_envs[platform]
  ctx.set_group(ctx.env.PLATFORM_NAME)
  app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
  ctx.pbl_build(source=ctx.path.ant_glob('src/c/**/*.c'),target=app_elf,bin_type='app')
  binaries.append({'platform': platform, 'app_elf': app_elf})
 ctx.env = original_env
 ctx.set_group('bundle')
 ctx.pbl_bundle(binaries=binaries,js=ctx.path.ant_glob('src/pkjs/**/*.js'),js_entry_file='src/pkjs/index.js')`,
  `import os.path
top = '.'
out = 'build'
def options(ctx):
 ctx.load('pebble_sdk')
def configure(ctx):
 ctx.load('pebble_sdk')
def build(ctx):
 ctx.load('pebble_sdk')
 build_worker = os.path.exists('worker_src')
 binaries = []
 cached_env = ctx.env
 for platform in ctx.env.TARGET_PLATFORMS:
  ctx.env = ctx.all_envs[platform]
  ctx.set_group(ctx.env.PLATFORM_NAME)
  app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
  ctx.pbl_build(source=ctx.path.ant_glob('src/c/**/*.c'),target=app_elf,bin_type='app')
  if build_worker:
   worker_elf = '{}/pebble-worker.elf'.format(ctx.env.BUILD_DIR)
   binaries.append({'platform':platform,'app_elf':app_elf,'worker_elf':worker_elf})
   ctx.pbl_build(source=ctx.path.ant_glob('worker_src/c/**/*.c'),target=worker_elf,bin_type='worker')
  else:
   binaries.append({'platform':platform,'app_elf':app_elf})
 ctx.env = cached_env
 ctx.set_group('bundle')
 ctx.pbl_bundle(binaries=binaries,js=ctx.path.ant_glob(['src/pkjs/**/*.js','src/pkjs/**/*.json','src/common/**/*.js']),js_entry_file='src/pkjs/index.js')`,
];
// Exact known statement templates, ignoring whitespace, comments and docstrings.
// No project Python is run or silently approximated.
const normalizeWscript = (s) =>
  s
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '')
    .replace(/#[^\n]*/g, '')
    .replace(/"/g, "'")
    .replace(/\s+/g, '');
function cString(value) {
  return (
    '"' + [...text.encode(value)].map((b) => '\\' + b.toString(8).padStart(3, '0')).join('') + '"'
  );
}
export function normalizePackage(pkg) {
  if (!pkg || typeof pkg !== 'object' || !pkg.pebble)
    throw new Error('Expected a package.json with Pebble metadata');
  const p = pkg.pebble;
  if (p.projectType && p.projectType !== 'native')
    throw new Error('This build profile supports native C projects only');
  if (p.sdkVersion !== '3') throw new Error('This build profile supports sdkVersion "3" projects');
  if (Object.keys(pkg.dependencies || {}).length || Object.keys(pkg.devDependencies || {}).length)
    throw new Error('External package dependencies are not supported by this build profile');
  if (!Array.isArray(p.targetPlatforms) || !p.targetPlatforms.includes('emery'))
    throw new Error('The project does not declare the emery platform');
  if ((p.resources?.media || []).length || p.resources?.publishedMedia || p.publishedMedia)
    throw new Error('Custom resources are not yet supported; use firmware system fonts');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p.uuid || ''))
    throw new Error('Invalid app UUID');
  const name = p.displayName || pkg.name,
    company = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  for (const [label, value] of [
    ['displayName', name],
    ['author', company],
  ])
    if (
      typeof value !== 'string' ||
      !value.length ||
      value.includes('\0') ||
      text.encode(value).length > 31
    )
      throw new Error(`${label} must contain 1–31 UTF-8 bytes`);
  const version = String(pkg.version || '1.0.0');
  if (
    !/^\d+\.\d+(?:\.\d+)?$/.test(version) ||
    version
      .split('.')
      .slice(0, 2)
      .some((n) => Number(n) > 255)
  )
    throw new Error('Version major and minor must be integers from 0 to 255');
  const keys = p.messageKeys || {};
  if (
    Array.isArray(keys) ||
    Object.entries(keys).some(
      ([k, v]) =>
        !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(k) || !Number.isInteger(v) || v < 0 || v > 0xffffffff,
    )
  )
    throw new Error('This build profile requires explicitly numbered messageKeys');
  return {
    ...p,
    shortName: name,
    longName: name,
    companyName: company,
    versionLabel: version,
    appKeys: keys,
  };
}
export function generateAppinfoC(appinfo) {
  const [major, minor] = appinfo.versionLabel.split('.').map(Number);
  const uuid = appinfo.uuid
    .replaceAll('-', '')
    .match(/../g)
    .map((byte) => '0x' + byte)
    .join(', ');
  const flags = ['PROCESS_INFO_PLATFORM_EMERY'];
  if (appinfo.watchapp?.watchface) flags.push('PROCESS_INFO_WATCH_FACE');
  if (appinfo.watchapp?.hiddenApp) flags.push('PROCESS_INFO_VISIBILITY_HIDDEN');
  if (appinfo.watchapp?.onlyShownOnCommunication)
    flags.push('PROCESS_INFO_VISIBILITY_SHOWN_ON_COMMUNICATION');
  return `#include "pebble_process_info.h"\n#include "src/resource_ids.auto.h"\nconst PebbleProcessInfo __pbl_app_info __attribute__((section(".pbl_header"))) = {
.header="PBLAPP",
.struct_version={PROCESS_INFO_CURRENT_STRUCT_VERSION_MAJOR,PROCESS_INFO_CURRENT_STRUCT_VERSION_MINOR},
.sdk_version={PROCESS_INFO_CURRENT_SDK_VERSION_MAJOR,PROCESS_INFO_CURRENT_SDK_VERSION_MINOR},
.process_version={${major},${minor}},.load_size=0xb6b6,.offset=0xb6b6b6b6,.crc=0xb6b6b6b6,
.name=${cString(appinfo.shortName)},.company=${cString(appinfo.companyName)},.icon_resource_id=DEFAULT_MENU_ICON,
.sym_table_addr=0xa7a7a7a7,.flags=${flags.join('|')},.num_reloc_entries=0xdeadcafe,.uuid={${uuid}},.virtual_size=0xb6b6
};\n`;
}
/** No fetch/fs imports. sourceFiles and sdkFiles are maps of paths to Uint8Array.
 * The caller imports the SDK archive and creates an isolated compiler session.
 * Returns {pbw, elf, files, manifest, metadata, log, appinfo}; all artifacts are bytes.
 */
export async function buildPebbleApp({
  sourceFiles,
  sdkFiles,
  session,
  projectRoot = '',
  timestamp = Math.floor(Date.now() / 1000),
  log = () => {},
}) {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff)
    throw new Error('Invalid build timestamp');
  const prefix = projectRoot ? projectRoot.replace(/\/$/, '') + '/' : '';
  const files = {};
  for (const [path, bytes] of Object.entries(sourceFiles))
    if (path.startsWith(prefix)) files[path.slice(prefix.length)] = bytes;
  const getText = (path) => {
    if (!files[path]) throw new Error('Missing project file ' + path);
    return read.decode(files[path]);
  };
  const appinfo = normalizePackage(JSON.parse(getText('package.json')));
  if (
    files.wscript &&
    !STANDARD_WSCRIPTS.some(
      (s) => normalizeWscript(s) === normalizeWscript(read.decode(files.wscript)),
    )
  )
    throw new Error(
      'Custom wscript is not supported by this build profile; use the standard SDK template',
    );
  if (Object.keys(files).some((p) => p.startsWith('worker_src/')))
    throw new Error('Background workers are not supported by this build profile');
  if (Object.keys(files).some((p) => /^src\/.*\.(?:S|s|cpp|cc|cxx)$/.test(p)))
    throw new Error('Assembly and C++ sources are not supported by this build profile');
  const sources = Object.keys(files)
    .filter((p) => /^src\/c\/.*\.c$/.test(p))
    .sort();
  if (!sources.length) throw new Error('No C sources found under src/c');
  const jsPaths = Object.keys(files).filter((p) =>
    /^src\/(?:pkjs|common)\/.*\.(?:js|json)$/.test(p),
  );
  if (jsPaths.length && (jsPaths.length !== 1 || jsPaths[0] !== 'src/pkjs/index.js'))
    throw new Error('This profile supports one PebbleKit JS entry without modules');
  let js = jsPaths.length ? getText('src/pkjs/index.js') : null;
  if (js && /\brequire\s*\(|\bimport\s|\bexport\s/.test(js))
    throw new Error('JavaScript modules require a bundling profile not yet enabled');
  const sdkPrefix = sdkFiles['sdk-core/manifest.json'] ? 'sdk-core/' : '';
  const sdkGet = (path) => {
    const bytes = sdkFiles[sdkPrefix + path];
    if (!bytes) throw new Error('SDK is missing ' + path);
    return bytes;
  };
  const sdkManifest = JSON.parse(read.decode(sdkGet('manifest.json')));
  if (sdkManifest.version !== '4.33.1')
    throw new Error('This verified build profile requires SDK 4.33.1');
  for (const [path, bytes] of Object.entries(sdkFiles)) {
    const relative = path.slice(sdkPrefix.length);
    if (
      relative.startsWith('pebble/emery/include/') &&
      !relative.split('/').some((p) => p.startsWith('._'))
    )
      await session.writeFile(
        '/sdk/include/' + relative.slice('pebble/emery/include/'.length),
        bytes,
      );
  }
  await session.writeFile('/sdk/lib/libpebble.a', sdkGet('pebble/emery/lib/libpebble.a'));
  for (const [path, bytes] of Object.entries(files))
    if ((path.startsWith('src/') || path.startsWith('include/')) && !path.split('/').includes('..'))
      await session.writeFile('/project/' + path, bytes);
  await session.writeFile(
    '/project/build/src/resource_ids.auto.h',
    '#pragma once\n#define DEFAULT_MENU_ICON 0\n',
  );
  await session.writeFile(
    '/project/build/message_keys.auto.h',
    '#pragma once\n' +
      Object.entries(appinfo.appKeys)
        .map(([k, v]) => `#define MESSAGE_KEY_${k} ${v}u`)
        .join('\n') +
      '\n',
  );
  await session.writeFile('/project/build/appinfo.auto.c', generateAppinfoC(appinfo));
  const linker = read
    .decode(sdkGet('pebble/common/pebble_app.ld.template'))
    .replace('@MAX_APP_MEMORY_SIZE@', '131072');
  if (linker.includes('@MAX_APP_MEMORY_SIZE@')) throw new Error('Unsupported linker template');
  await session.writeFile('/project/build/app.ld', linker);
  let buildLog = '',
    pending = '';
  const diagnosticDecoder = new TextDecoder();
  const output = (bytes) => {
    if (bytes) {
      const chunk = diagnosticDecoder.decode(bytes, { stream: true });
      buildLog += chunk;
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        log(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    }
  };
  const run = async (argv) => {
    log(argv.join(' '));
    const code = await session.run(argv, { stdout: output, stderr: output });
    if (pending) {
      log(pending);
      pending = '';
    }
    if (code) throw new Error(`${argv[0]} failed (${code})\n${buildLog.slice(-6000)}`);
  };
  const objects = [];
  for (const [i, source] of [...sources, 'build/appinfo.auto.c'].entries()) {
    const object = `/project/build/source-${i}.o`;
    await run(['clang', ...CFLAGS, '-c', '/project/' + source, '-o', object]);
    objects.push(object);
  }
  await run([
    'ld.lld',
    '--gc-sections',
    '--warn-common',
    '--build-id=sha1',
    '--emit-relocs',
    '-Bstatic',
    '-EL',
    '--target2=rel',
    '-T',
    '/project/build/app.ld',
    ...objects,
    '-L/sdk/lib',
    '-lpebble',
    '-o',
    '/project/build/pebble-app.elf',
  ]);
  const elf = await session.readFile('/project/build/pebble-app.elf');
  if (!elf) throw new Error('Compiler produced no ELF');
  if (js) js = read.decode(sdkGet('pebble/common/include/_pkjs_shared_additions.js')) + '\n' + js;
  return { ...packagePbw({ elf, appinfo, js, timestamp }), appinfo, log: buildLog };
}
