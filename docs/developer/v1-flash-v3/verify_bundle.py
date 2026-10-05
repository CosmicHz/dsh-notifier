from pathlib import Path
import csv,hashlib,json
r=Path(__file__).resolve().parent
m=json.loads((r/'MANIFEST.json').read_text())
for x in m['files']:
 p=r/x['path']; assert p.is_file(),str(p)
 assert hashlib.sha256(p.read_bytes()).hexdigest()==x['sha256'],str(p)
with (r/'TASKS.csv').open() as f: tasks=list(csv.DictReader(f))
seen=set()
for t in tasks:
 assert t['id'] not in seen
 assert set(filter(None,t['depends_on'].split(';')))<=seen,t['id']
 for p in t['read_first'].split(';'): assert (r/p).is_file(),p
 assert all(t[k] for k in ['new_files','command','acceptance'])
 seen.add(t['id'])
channels=json.loads((r/'spec/CHANNELS.json').read_text())
assert len(channels)==29 and sum(c['outbound'] for c in channels)==28 and sum(c['inbound'] for c in channels)==6
for c in channels:
 for key in ['outboundSource','inboundSource']:
  if c[key]:assert (r/'reference/source'/c[key]).is_file(),c[key]
fields=json.loads((r/'spec/EDITOR-FIELDS.json').read_text())
assert len({f['id'] for f in fields})==len(fields)
for f in fields:
 for locale in ['zh','en']:assert all(f[locale][k] for k in ['label','help','placeholder','errorRequired'])
cases=json.loads((r/'spec/WIRING-CASES.json').read_text())
assert {c['id'] for c in cases}=={f'W{i:02}' for i in range(1,36)}
for c in cases: assert set(c['tasks'])<=seen
rpc=json.loads((r/'spec/RPC-METHODS.json').read_text())
assert {x['name'] for x in rpc['methods']}==set(rpc['native']+rpc['localOnly'])
print(f'STATIC PACKAGE OK: {len(tasks)} tasks, {len(fields)} editor fields, 35 design review mappings. No product tests performed.')
