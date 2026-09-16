#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Usage: uv run --with pypng==0.20220715.0 python scripts/regenerate-resource-goldens.py --sdk /path/sdk-core --output tests/fixtures/resources
# Executes official locally supplied SDK resource tools against original fixtures.
from pathlib import Path
import sys,io,json,hashlib,random,argparse
from random import Random
parser=argparse.ArgumentParser();parser.add_argument('--sdk',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
sys.path.insert(0,str(Path(args.sdk).resolve()/'pebble/common/tools'))
import png,png2pblpng,bitmapgen,pbpack
out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
fixtures={}
colors=[(255,0,0,255),(0,255,0,255),(0,0,255,255),(255,255,255,255),(0,0,0,255),(80,160,240,130),(10,20,30,0)]
images={
 'rgba':(7,3,[colors[(x+y)%len(colors)] for y in range(3) for x in range(7)]),
 'grey':(5,2,[(v,v,v,255) if v>=0 else (0,0,0,0) for v in [0,85,170,255,-1]*2]),
 'cropped':(6,5,[(255,255,255,255) if x in(1,2,3) and y in(1,2) else (0,0,0,0) for y in range(5) for x in range(6)]),
 'collision':(4,2,[(0,0,0,255),(255,0,0,255),(0,255,0,255),(0,0,255,255),(85,85,85,255),(170,170,170,255),(255,255,255,255),(0,0,0,0)]),
}
for name,(w,h,px) in images.items():
 path=out/(name+'.png');f=io.BytesIO();png.Writer(w,h,alpha=True,greyscale=False,bitdepth=8).write(f,[[c for p in px[y*w:(y+1)*w] for c in p]for y in range(h)]);path.write_bytes(f.getvalue())
 results={}
 for palette in ['pebble64','pebble2']:
  results['png-'+palette]=png2pblpng.convert_png_to_pebble_png_bytes(str(path),palette).hex()
 for fmt in ['bw','color','color_raw']:
  for crop in [False,True]:
   try:results[f'pbi-{fmt}-{crop}']=bitmapgen.PebbleBitmap(str(path),bitmap_format=fmt,crop=crop).convert_to_pbi().hex()
   except Exception as e:results[f'pbi-{fmt}-{crop}']={'error':str(e)}
 fixtures[name]=results
packs={}
for name,items in [('empty',[]),('dedup',[b'abc',b'',b'xyz12',b'abc']),('raw',[bytes([0,127,255,42,1])]),('limit',[bytes([i])for i in range(256)])]:
 pack=pbpack.ResourcePack(False)
 for content in items:pack.add_resource(content)
 f=io.BytesIO();pack.serialize(f);data=f.getvalue();(out/(name+'.pbpack')).write_bytes(data);packs[name]={'inputs':[b.hex()for b in items],'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)}
(out/'goldens.json').write_text(json.dumps({'images':fixtures,'packs':packs},indent=2))
print('Generated official SDK golden fixtures',list(fixtures))

gold=json.loads((out/'goldens.json').read_text());random=Random(761319)
for n in range(20):
 w,h=random.randrange(1,18),random.randrange(1,15)
 palette=[tuple(random.randrange(256)for _ in range(4))for _ in range(random.randrange(2,30))]
 pixels=[random.choice(palette)for _ in range(w*h)]
 path=out/f'random-{n}.png';f=io.BytesIO();png.Writer(w,h,alpha=True,greyscale=False,bitdepth=8,interlace=n%2).write(f,[[c for p in pixels[y*w:(y+1)*w]for c in p]for y in range(h)]);path.write_bytes(f.getvalue())
 results={}
 for pal in ['pebble64','pebble2']:results['png-'+pal]=png2pblpng.convert_png_to_pebble_png_bytes(str(path),pal).hex()
 for fmt in ['bw','color','color_raw']:results[f'pbi-{fmt}-False']=bitmapgen.PebbleBitmap(str(path),bitmap_format=fmt,crop=False).convert_to_pbi().hex()
 gold['images'][f'random-{n}']=results
# Different PNG encodings, including sub-byte palette/grayscale, 16-bit and sBIT.
for n,(grey,alpha,depth)in enumerate([(True,False,1),(True,False,2),(True,False,4),(True,False,16),(False,False,16),(True,True,8),(False,True,5)]):
 w,h=9,5;channels=(1 if grey else 3)+alpha;maxval=(1<<depth)-1
 rows=[[random.randrange(maxval+1)for _ in range(w*channels)]for _ in range(h)];path=out/f'encoding-{n}.png';f=io.BytesIO();png.Writer(w,h,alpha=alpha,greyscale=grey,bitdepth=depth,interlace=n%2).write(f,rows);path.write_bytes(f.getvalue());results={}
 for pal in ['pebble64','pebble2']:results['png-'+pal]=png2pblpng.convert_png_to_pebble_png_bytes(str(path),pal).hex()
 for fmt in ['bw','color','color_raw']:results[f'pbi-{fmt}-False']=bitmapgen.PebbleBitmap(str(path),bitmap_format=fmt,crop=False).convert_to_pbi().hex()
 gold['images'][f'encoding-{n}']=results
(out/'goldens.json').write_text(json.dumps(gold,indent=2))
print('Total images',len(gold['images']))
