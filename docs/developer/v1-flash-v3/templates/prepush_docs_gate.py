#!/usr/bin/env python3
"""Fail-closed local documentation gate. Does not push, fetch, or run product tests."""
import sys,subprocess,json,hashlib,re
from pathlib import Path

def g(*args): return subprocess.check_output(['git',*args]).decode().strip()
def fail(msg): print('DOC-SYNC BLOCKED: '+msg,file=sys.stderr);sys.exit(1)
def doc(p): return p.endswith(('.md','.mdx','.rst')) or p.startswith(('v1/docs/','docs/','.agents/')) or p.endswith('AGENTS.md')
def changed(base,target=None):
 args=['diff','--name-only',base]
 if target:args.append(target)
 names=set(g(*args).splitlines())
 return sorted(names)
def digest(base,target=None):
 rows=[]
 for p in changed(base,target):
  if doc(p): continue
  try:
   data=subprocess.check_output(['git','show',f'{target}:{p}'],stderr=subprocess.DEVNULL) if target else Path(p).read_bytes()
   h=hashlib.sha256(data).hexdigest()
  except (OSError,subprocess.CalledProcessError): h='deleted'
  rows.append([p,h])
 return hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()
try:
 if len(sys.argv)==3 and sys.argv[1]=='--digest':
  print(digest(sys.argv[2]));sys.exit(0)
 if g('branch','--show-current')!='dev':fail('only dev is allowed')
 if g('status','--porcelain'):fail('commit synchronized code/docs first; working tree must be clean')
 lines=[x.split() for x in sys.stdin.read().splitlines() if x.strip()]
 if not lines:fail('no push refs; invoke through pre-push hook')
 for localref,localsha,remoteref,remotesha in lines:
  if localref!='refs/heads/dev' or remoteref!='refs/heads/dev':fail('only dev -> dev allowed')
  if set(localsha)=={'0'} or set(remotesha)=={'0'}:fail('deletion/new remote branch is outside this workflow')
  subprocess.run(['git','merge-base','--is-ancestor',remotesha,localsha],check=True,stdout=subprocess.DEVNULL)
  report=json.loads(g('show',f'{localsha}:v1/docs/DOC-SYNC.json'))
  if report.get('base')!=remotesha:fail('remote base changed; repeat sync')
  if report.get('sourceDigest')!=digest(remotesha,localsha):fail('source digest stale')
  paths=changed(remotesha,localsha)
  if set(report.get('changedPaths',[]))!=set(paths):fail('changedPaths must cover exact push diff')
  if report.get('unresolved')!=[] or not report.get('summary','').strip():fail('unresolved or missing summary')
  if not re.fullmatch('[0-9a-f]{40}',report.get('skillCommit','')):fail('missing pinned skill provenance')
  provenance=json.loads(g('show',f'{localsha}:.agents/skills/neat-freak/PROVENANCE.json'))
  if report.get('skillCommit')!=provenance.get('commit'):fail('skill provenance mismatch')
  inventory=report.get('inventory',[]);seen=set()
  for row in inventory:
   if row.get('disposition') not in ['updated','reviewed-no-change','not-applicable'] or not row.get('reason','').strip():fail('incomplete inventory row')
   seen.add(row.get('path'))
  tree=g('ls-tree','-r','--name-only',localsha).splitlines()
  needed={p for p in tree if p in ['AGENTS.md','README.md','README.zh-CN.md','CHANGELOG.md','HANDOFF.md'] or p.startswith('v1/') and (p.endswith('.md') or p.startswith('v1/docs/'))}
  needed.update(p for p in tree if p.startswith('docs/developer/v1-flash-v3/') and p.endswith('.md') and not any('/'+v+'/' in p for v in ['reference','archive','.agents']))
  missing=needed-seen
  if missing:fail('inventory missing: '+', '.join(sorted(missing)[:8]))
  if any(not doc(p) for p in paths) and not any(p.startswith('v1/') and p.endswith('.md') for p in paths):fail('code changed without accompanying product documentation')
 print('DOC-SYNC gate passed; this is not product/visual verification.')
except (KeyError,ValueError,OSError,subprocess.CalledProcessError) as e:fail(str(e))
