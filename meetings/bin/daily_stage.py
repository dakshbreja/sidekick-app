#!/usr/bin/env python3
"""Bound collector children and checkpoint evidence; never manage the recording app."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from datetime import datetime, timezone

def now():
    return datetime.now(timezone.utc).isoformat()

def read(path):
    return json.loads(path.read_text())

def save(path, data):
    tmp=path.with_suffix(path.suffix+'.tmp')
    tmp.write_text(json.dumps(data,indent=2)+'\n')
    tmp.replace(path)

def start(path):
    save(path,{'ran_at':now(),'overall':'in_progress','stages':{},'stage_timing':{},
               'incident_keys':[],'message':'Sync is running; current delivery is not established.'})

def interrupted(path, code):
    data=read(path)
    if data.get('overall')=='in_progress':
        data.update(overall='failed',message='Sync interrupted; delivery is incomplete.',finished_at=now())
        data['incident_keys'].append('run:interrupted')
        for name,state in data['stages'].items():
            if state=='in_progress':data['stages'][name]='failed'
        save(path,data)

def run(path, name, seconds, command):
    data=read(path);data['stages'][name]='in_progress'
    data['stage_timing'][name]={'started_at':now()};save(path,data)
    child=subprocess.Popen(command,start_new_session=True)
    timed_out=False
    def stop(signum, frame):
        os.killpg(child.pid,signal.SIGTERM)
        try:child.wait(timeout=3)
        except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
        raise SystemExit(128+signum)
    old={s:signal.signal(s,stop) for s in (signal.SIGTERM,signal.SIGINT)}
    try:
        try:code=child.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            timed_out=True
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=3)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
            code=124
    finally:
        for s,handler in old.items():signal.signal(s,handler)
    data=read(path);data['stages'][name]='ok' if code==0 else 'failed'
    data['stage_timing'][name].update(finished_at=now(),exit_code=code,timed_out=timed_out)
    if code:data['incident_keys'].append(name+(':timeout' if timed_out else ':exit_'+str(code)))
    save(path,data)
    return code

def classify(path, name, output):
    data=read(path)
    if not any(key.startswith(name+':exit_') for key in data['incident_keys']):return
    text=output.lower()
    cause=('timeout' if any(x in text for x in ('timed out','timeout','deadline reached')) else
           'unreadable' if any(x in text for x in ('errno 11','edeadlk','eagain','resource deadlock')) else
           'transport' if any(x in text for x in ('connection refused','connection reset','websocket','urlerror','http error','bridge returned http','remote discovery unavailable')) else None)
    if cause:
        data['incident_keys']=[k for k in data['incident_keys'] if not k.startswith(name+':exit_')]+[name+':'+cause]
        save(path,data)

def finish(path, incoming):
    prior=read(path);data=json.loads(incoming)
    data['stage_timing']=prior['stage_timing'];data['incident_keys']=prior['incident_keys']
    data['started_at']=prior['ran_at'];data['finished_at']=now();save(path,data)

if __name__=='__main__':
    action=sys.argv[1];path=Path(sys.argv[2])
    if action=='start':start(path)
    elif action=='interrupt':interrupted(path,int(sys.argv[3]))
    elif action=='classify':classify(path,sys.argv[3],sys.stdin.read())
    elif action=='finish':finish(path,sys.stdin.read())
    elif action=='run':sys.exit(run(path,sys.argv[3],float(sys.argv[4]),sys.argv[5:]))
