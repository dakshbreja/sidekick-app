#!/usr/bin/env python3
"""Restore Cluely's existing local export connection only after fresh idle checks.

Never force quits, clicks recording controls, changes permissions, or accepts a
cached state. The native guard and recorder-process veto protect active sessions.
"""
import fcntl
import json
from pathlib import Path
import subprocess
import time
import urllib.request
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
APP = '/Applications/Cluely (New).app'
EXECUTABLE = APP + '/Contents/MacOS/Cluely (New)'
STATE = HERE.parent / '.launch-state.json'

class Platform:
    def run(self, args, timeout=12):
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout)

    def processes(self):
        r=self.run(['/bin/ps','-ax','-o','pid=,ppid=,comm='])
        if r.returncode: raise RuntimeError('process_state_unavailable')
        rows=[]
        for line in r.stdout.splitlines():
            parts=line.strip().split(None,2)
            if len(parts)==3: rows.append((int(parts[0]),int(parts[1]),parts[2]))
        return rows

    def pid(self):
        rows=[pid for pid,_,cmd in self.processes() if cmd==EXECUTABLE]
        if len(rows)>1: raise RuntimeError('multiple_app_instances')
        return rows[0] if rows else None

    def capture_active(self,pid):
        rows=self.processes();descendants={pid}
        for _ in range(10):
            next_ids=descendants|{p for p,parent,_ in rows if parent in descendants}
            if next_ids==descendants:break
            descendants=next_ids
        return any(p in descendants and Path(cmd).name in ('sox','rec','audiotee') for p,_,cmd in rows)

    def ready(self,pid):
        if pid is None:return False
        r=self.run(['/usr/sbin/lsof','-nP','-t','-iTCP:9222','-sTCP:LISTEN'])
        if str(pid) not in r.stdout.split():return False
        try:
            with urllib.request.urlopen('http://127.0.0.1:9222/json/version',timeout=2) as r:
                data=json.loads(r.read(16000))
            return bool(data.get('webSocketDebuggerUrl','').startswith('ws://127.0.0.1:9222/'))
        except Exception:return False

    def guard(self,quit=False):
        r=self.run([str(HERE/'Cluely Recording Guard.app/Contents/MacOS/cluely-recording-state')]+(['--quit-if-idle'] if quit else []),timeout=15)
        data=json.loads(r.stdout)
        if data.get('state') not in ('idle','active','unknown','not_running'):raise RuntimeError('invalid_guard_result')
        # Helper exit status is part of its contract, never trust stdout alone.
        if data['state']=='idle' and r.returncode!=0:raise RuntimeError('guard_failed')
        return data

    def launch(self):
        r=self.run(['/usr/bin/open','-g','-a',APP,'--args','--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1'])
        return r.returncode==0

    def sleep(self,seconds):time.sleep(seconds)


def restore(platform):
    pid=platform.pid()
    if platform.ready(pid):return 0,{'state':'ready','reason':'export_connection_available','restarted':False}
    restarted=False
    if pid is not None:
        if platform.capture_active(pid):return 2,{'state':'deferred','reason':'recording_active','restarted':False}
        first=platform.guard()
        if first.get('pid')!=pid or first['state']!='idle':
            return 2,{'state':'deferred','reason':'recording_active' if first['state']=='active' else first.get('reason','recording_state_unknown'),'restarted':False}
        platform.sleep(1)
        if platform.pid()!=pid or platform.capture_active(pid):
            return 2,{'state':'deferred','reason':'state_changed_before_restart','restarted':False}
        # Native helper re-reads live controls before sending graceful termination.
        final=platform.guard(quit=True)
        if final.get('pid')!=pid or final['state']!='idle':
            return 2,{'state':'deferred','reason':final.get('reason','recording_state_changed'),'restarted':False}
        for _ in range(15):
            if platform.pid() is None:break
            platform.sleep(1)
        if platform.pid() is not None:return 2,{'state':'deferred','reason':'app_did_not_quit_cleanly','restarted':False}
        restarted=True
    if not platform.launch():return 1,{'state':'failed','reason':'app_launch_failed','restarted':restarted}
    for _ in range(20):
        if platform.ready(platform.pid()):return 0,{'state':'ready','reason':'idle_restart_restored_export' if restarted else 'export_connection_opened','restarted':restarted}
        platform.sleep(1)
    return 1,{'state':'failed','reason':'export_connection_unavailable','restarted':restarted}


def main():
    with (HERE.parent/'.cluely-launch.lock').open('w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            print('DEFERRED: another Cluely recovery is in progress.');return 2
        try:code,result=restore(Platform())
        except Exception:code,result=2,{'state':'deferred','reason':'recording_state_unavailable','restarted':False}
        result['observed_at']=datetime.now(timezone.utc).isoformat()
        tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(result,indent=2)+'\n');tmp.replace(STATE)
        print('Cluely recovery: '+result['state']+' — '+result['reason'])
        return code

if __name__=='__main__':raise SystemExit(main())
