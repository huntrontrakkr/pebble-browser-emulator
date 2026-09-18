// Optional real-browser Worker gate. Requires the same local images as the reset gate.
import { chromium, firefox, webkit } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const [directory, reportPath] = process.argv.slice(2);
if (!directory) {
  console.error('Usage: node scripts/verify-sifli-browser.mjs LOCAL_IMAGE_DIR [report.json]');
  process.exit(2);
}
const wasm = await readFile('public/wasm/sifli-probe.wasm');
const results = [];
const fixtures = await Promise.all(
  ['obelix_pvt', 'getafix_dvt2'].map(async (revision) => {
    const expected = JSON.parse(
      await readFile(
        `docs/evidence/${revision === 'obelix_pvt' ? 'obelix' : 'getafix'}-reset-execution.json`,
      ),
    );
    const image = await readFile(join(directory, `firmware_${revision}_v4.37.0_slot0.bin`));
    assert.equal(createHash('sha256').update(image).digest('hex'), expected.identity.imageSha256);
    return { revision, expected, image: image.toString('base64') };
  }),
);

for (const name of (process.env.PEBBLE_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await { chromium, firefox, webkit }[name].launch({
    ...(name === 'webkit' && process.env.PEBBLE_WEBKIT_EXECUTABLE
      ? { executablePath: process.env.PEBBLE_WEBKIT_EXECUTABLE }
      : {}),
  });
  try {
    const page = await browser.newPage();
    for (const fixture of fixtures) {
      const result = await page.evaluate(
        async ({ wasm, fixture }) => {
          const source = `onmessage = async ({data}) => {
          try {
            const {instance} = await WebAssembly.instantiate(data.wasm, {});
            const e = instance.exports;
            const p = e.sifli_input(data.image.length);
            new Uint8Array(e.memory.buffer,p,data.image.length).set(data.image);
            if (!e.sifli_load(data.revision)) throw new Error('load failed');
            const report = () => JSON.parse(new TextDecoder().decode(new Uint8Array(e.memory.buffer,e.sifli_output_ptr(),e.sifli_output_len())));
            let state;
            for (let n=0;n<100;n++) {
              e.sifli_run(100000,data.expected.startup.registers[15]); state=report();
              if (state.stop || state.registers[15] === data.expected.startup.registers[15]) break;
              await new Promise(resolve=>setTimeout(resolve,0));
            }
            if (state.stop) throw new Error(JSON.stringify(state.stop));
            for (const r of data.expected.copies) {
              for (let i=0;i<r.bytes;i++) {
                if ((e.sifli_read_byte(r.destination+i)>>>0) !== data.image[r.source-0x12020000+i]) throw new Error('RAM initializer mismatch');
              }
            }
            const z = data.expected.zeroFill;
            for(let i=0;i<z.bytes;i++) if(e.sifli_read_byte(z.destination+i)!==0) throw new Error('BSS mismatch');
            let mainEntry;
            for(let n=0;n<100;n++) {
              e.sifli_run(100000,data.expected.mainEntry.registers[15]); mainEntry=report();
              if(mainEntry.stop || mainEntry.registers[15]===data.expected.mainEntry.registers[15]) break;
            }
            let clockStartup;
            for(let n=0;n<100;n++) {
              e.sifli_run(100000,data.expected.clockStartup.registers[15]); clockStartup=report();
              if(clockStartup.stop || clockStartup.registers[15]===data.expected.clockStartup.registers[15]) break;
              await new Promise(resolve=>setTimeout(resolve,0));
            }
            e.sifli_run(100000,0);
            const hardwareBoundary=report();
            const input=e.sifli_input(data.image.length);
            new Uint8Array(e.memory.buffer,input,data.image.length).set(data.image);
            if(!e.sifli_load(data.revision)) throw new Error('reload failed');
            const fixture=Uint8Array.from({length:32},(_,i)=>0x40+i);
            new Uint8Array(e.memory.buffer,e.sifli_efuse_input(),32).set(fixture);
            if(!e.sifli_load_efuse_bank(1) || !e.sifli_set_chip_id(0)) throw new Error('fixture rejected');
            let syntheticTrim;
            for(let n=0;n<100;n++) {
              e.sifli_run(100000,0); syntheticTrim=report();
              if(syntheticTrim.stop) break;
              await new Promise(resolve=>setTimeout(resolve,0));
            }
            for(let i=0;i<32;i++) if((e.sifli_read_cpu_byte(data.expected.syntheticEfuse.destination+i)>>>0)!==fixture[i]) throw new Error('CPU-visible calibration copy mismatch');
            const reload=e.sifli_input(data.image.length);
            new Uint8Array(e.memory.buffer,reload,data.image.length).set(data.image);
            if(!e.sifli_load(data.revision)) throw new Error('NOR reload failed');
            new Uint8Array(e.memory.buffer,e.sifli_efuse_input(),32).set(fixture);
            if(!e.sifli_load_efuse_bank(1) || !e.sifli_set_chip_id(0) || !e.sifli_configure_nor(0xef4018,0,0)) throw new Error('NOR fixture rejected');
            const pages=[1,2,3].map(n=>Uint8Array.from({length:256},(_,i)=>i===0?255:(n*53+i)&255));
            for(let i=0;i<3;i++) {
              new Uint8Array(e.memory.buffer,e.sifli_otp_input(),256).set(pages[i]);
              if(!e.sifli_load_otp(i+1)) throw new Error('OTP fixture rejected');
            }
            let boardConfigComplete;
            for(let n=0;n<100;n++) {
              e.sifli_run(100000,0x20002f7c); boardConfigComplete=report();
              if(boardConfigComplete.stop || boardConfigComplete.registers[15]===0x20002f7c) break;
              await new Promise(resolve=>setTimeout(resolve,0));
            }
            for(const c of data.expected.syntheticNor.copies) {
              for(let i=0;i<c.bytesMatched;i++) if((e.sifli_read_cpu_byte(c.destination+i)>>>0)!==pages[c.page-1][i]) throw new Error('OTP buffer mismatch');
            }
            e.sifli_run(100000,0);const nextBoundary=report();
            postMessage({startup:state,mainEntry,clockStartup,hardwareBoundary,syntheticTrim,boardConfigComplete,nextBoundary,ramMatched:true});
          } catch (e) { postMessage({error:String(e)}); }
        }`;
          const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          const worker = new Worker(url);
          try {
            return await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('Worker timeout')), 30000);
              worker.onmessage = ({ data }) => {
                clearTimeout(timer);
                resolve(data);
              };
              worker.onerror = (event) => {
                clearTimeout(timer);
                reject(new Error(event.message));
              };
              const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
              const image = decode(fixture.image),
                bytes = decode(wasm);
              worker.postMessage(
                {
                  image,
                  wasm: bytes,
                  expected: fixture.expected,
                  revision: fixture.revision === 'obelix_pvt' ? 0 : 1,
                },
                [image.buffer, bytes.buffer],
              );
            });
          } finally {
            worker.terminate();
            URL.revokeObjectURL(url);
          }
        },
        { wasm: wasm.toString('base64'), fixture },
      );
      assert.equal(result.error, undefined);
      assert.deepEqual(result.startup, fixture.expected.startup);
      assert.deepEqual(result.mainEntry, fixture.expected.mainEntry);
      assert.deepEqual(result.clockStartup, fixture.expected.clockStartup);
      assert.deepEqual(result.hardwareBoundary, fixture.expected.hardwareBoundary);
      assert.deepEqual(result.syntheticTrim, fixture.expected.syntheticTrim.state);
      assert.deepEqual(
        result.boardConfigComplete,
        fixture.expected.syntheticNor.boardConfigComplete,
      );
      assert.deepEqual(result.nextBoundary, fixture.expected.syntheticNor.nextBoundary);
      results.push({
        browser: name,
        version: browser.version(),
        revision: fixture.revision,
        ramMatched: result.ramMatched,
        mainEntryMatched: true,
        clockStartupMatched: true,
        syntheticCalibrationMatched: true,
        syntheticNorOtpMatched: true,
        instructions: result.startup.instructionsCompleted,
        hardwareBoundaryMatched: true,
      });
    }
  } finally {
    await browser.close();
  }
}
const report = {
  format: 'pebble-sifli-browser-reset',
  version: 1,
  wasmSha256: createHash('sha256').update(wasm).digest('hex'),
  results,
  scope:
    'Actual desktop browser Workers, unchanged local firmware; reset, SystemInit, early clock/delay, LCPU reset and synthetic calibration transfer/trim and NOR/OTP board-configuration execution. No full boot or physical-phone performance claim.',
};
const text = JSON.stringify(report, null, 2) + '\n';
if (reportPath) await writeFile(reportPath, text);
else console.log(text);
