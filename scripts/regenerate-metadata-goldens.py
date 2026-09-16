#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Regenerate metadata references by executing selected original SDK function ASTs.
# Usage: python scripts/regenerate-metadata-goldens.py --sdk /path/sdk-core --output tests/fixtures/resources
from pathlib import Path
import ast,argparse,json,types,tempfile,copy,sys,tarfile,io,re
parser=argparse.ArgumentParser();parser.add_argument('--sdk',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
sdk=Path(args.sdk).resolve();out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(sdk/'pebble/common/tools'))
from pebble_sdk_platform import pebble_platforms
waf=(sdk/'pebble/waf').read_bytes();start=waf.index(b'#==>\n')+5;end=waf.index(b'\n#<==',start)
encoded=waf[start:end][1:].replace(b'#8',b'\n').replace(b'#2',b'\r').replace(b'#/',b'\0')
archive=tarfile.open(fileobj=io.BytesIO(encoded),mode='r:bz2')
namespace={'json':json,'_get_supported_platforms':lambda conf:list(pebble_platforms),'findall':re.findall,'Logs':types.SimpleNamespace(pprint=lambda *args:None)}
for file,names in [('sdk_helpers.py',['validate_message_keys_object','get_target_platforms']),('pebble_sdk.py',['_extract_project_info','_validate_version']),('process_message_keys.py',['configure'])]:
 source=archive.extractfile('waflib/extras/'+file).read().decode();tree=ast.parse(source)
 functions=[node for node in tree.body if isinstance(node,ast.FunctionDef)and node.name in names]
 exec(compile(ast.Module(body=functions,type_ignores=[]),'SDK:'+file,'exec'),namespace)
class Node:
 def __init__(self,path):self.path=Path(path)
 def get_src(self):return self
 def get_bld(self):return self
 def make_node(self,p):return Node(self.path/p)
 def find_node(self,p):return Node(self.path/p)if(self.path/p).exists()else None
 def abspath(self):return str(self.path)
class Conf:
 def __init__(self,path):self.path=Node(path);self.env=types.SimpleNamespace()
 def fatal(self,msg):raise RuntimeError(msg)
legacy={'shortName':'Short','longName':'The complete old app name','companyName':'Legacy <verbatim>','versionLabel':'1.0','sdkVersion':'3','uuid':'81d7fc6b-55cc-4eb7-bb7a-06466f283a82','appKeys':{'status':5}}
pkg={'name':'test','version':'1.0.0','author':'Some Author <person@example.com> (https://example.com)','pebble':{'displayName':'Modern','sdkVersion':'3','uuid':legacy['uuid']}}
cases=[{'name':'npm-legacy-fallback','files':{'package.json':{'name':'npm-support','dependencies':{'js-package':'1.0.0'}},'appinfo.json':legacy}}, {'name':'modern-precedence','files':{'package.json':pkg,'appinfo.json':legacy}}, {'name':'legacy-empty-targets','files':{'appinfo.json':dict(legacy,targetPlatforms=[])}}, {'name':'legacy-restricted-targets','files':{'appinfo.json':dict(legacy,targetPlatforms=['aplite','flint'])}}]
for case in cases:
 with tempfile.TemporaryDirectory()as temp:
  for file,obj in case['files'].items():(Path(temp)/file).write_text(json.dumps(obj))
  conf=Conf(temp);filename='package.json'if'package.json'in case['files']else'appinfo.json';info=namespace['_extract_project_info'](conf,copy.deepcopy(case['files'][filename]),filename);conf.env.REQUESTED_PLATFORMS=info.get('targetPlatforms',[]);targets=namespace['get_target_platforms'](conf);case['projectInfo']=info;case['targets']=targets
(out/'legacy-goldens.json').write_text(json.dumps(cases,indent=2))
fixtures=[]
for keys in [{}, {'status':0,'big':4294967295}, ['status','ready'], ['Z','A[3]','B','C[2]'], ['block[10]','tail'], ['one']]:
 conf=Conf(out);conf.env=types.SimpleNamespace(BUILD_TYPE='app',PROJECT_INFO={'messageKeys':keys,'enableMultiJS':True},LIB_JSON=[]);namespace['configure'](conf);fixtures.append({'input':keys,'output':conf.env.MESSAGE_KEYS})
(out/'metadata-goldens.json').write_text(json.dumps(fixtures,indent=2))
print('Official SDK metadata and message-key golden fixtures regenerated')
