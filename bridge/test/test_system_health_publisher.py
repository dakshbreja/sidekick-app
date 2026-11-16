import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).resolve().parents[1]/'scripts/publish_system_health.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def result(self, rid, data, report=None):
        state = self.root/'state.json'
        state.write_text(json.dumps(data))
        row = {'id':rid,'status_file':str(state)}
        if report:
            output=self.root/'report.md'; output.write_text(report); row['report']=str(output)
        return p.read_result(row)

    def test_old_success_not_replaced_by_upload_time(self):
        r=self.result('board-refresh',{'overall':'ok','ran_at':'2026-08-01T12:00:00Z'})
        self.assertEqual(r['last_attempt_at'],'2026-08-01T12:00:00+00:00')
        self.assertEqual(r['last_success_at'],r['last_attempt_at'])

    def test_partial_grades_redact_private_data(self):
        r=self.result('grade-check',{'overall':'problem','ran_at':'2026-09-05T00:00:00Z','sources':{'elc':{'ok':False,'error':'secret'},'other':{'ok':True,'score':99}},'assignments':['private']})
        self.assertEqual((r['outcome'],r['reason']),('degraded','partial'))
        self.assertIsNone(r['last_success_at'])
        for private in ('score','secret','assignments','99'): self.assertNotIn(private,json.dumps(r))

    def test_empty_drive_mount_is_failure(self):
        r=self.result('drive-sync-check',{'overall':'ok','at':'2026-09-05T00:00:00Z','local_files':0,'cloud_files':151})
        self.assertEqual(r['reason'],'mount'); self.assertIsNone(r['last_success_at'])

    def test_calendar_failure_is_visible_despite_fresh_globus_read(self):
        r=self.result('globus-watch',{'checked_epoch':1000000000,'calendar_health':{'ok':False}})
        self.assertEqual((r['outcome'],r['reason']),('degraded','calendar'))
        self.assertIsNone(r['last_success_at'])

    def test_elc_failure_keeps_real_observation_times(self):
        r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000,'session_dead_since':1000001000})
        self.assertEqual(r['reason'],'session')
        self.assertEqual(r['last_attempt_at'],p.stamp(1000001000))
        self.assertEqual(r['last_success_at'],p.stamp(1000000000))

    def test_elc_partial_report_not_full_success(self):
        r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000},'# Sweep\n## PROBLEMS\nprivate url')
        self.assertEqual(r['reason'],'report_problem'); self.assertIsNone(r['last_success_at'])

    def test_naive_dates_and_bad_files_unknown(self):
        self.assertIsNone(p.stamp('2026-09-05 00:00:00'))
        r=self.result('globus-watch',{'last_skipped':1000000000})
        self.assertEqual(r['outcome'],'unknown'); self.assertIsNone(r['last_attempt_at'])
        state=self.root/'broken'; state.write_text('{')
        self.assertEqual(p.read_result({'id':'board-refresh','status_file':str(state)})['reason'],'unreadable')

    def test_failed_stage_cannot_be_hidden_by_ok(self):
        r=self.result('cluely-gpt-sync',{'overall':'ok','ran_at':'2026-09-05T00:00:00Z','stages':{'push':'deferred'}})
        self.assertEqual(r['outcome'],'degraded'); self.assertIsNone(r['last_success_at'])

    def test_registry_is_whitelisted_and_does_not_query_launchctl(self):
        registry=self.root/'registry.json'; registry.write_text(json.dumps({'routines':[{'id':'unrelated'}]}))
        result=p.collect(registry)
        self.assertEqual([c['id'] for c in result['checks']],list(p.IDS))
        self.assertTrue(all(c['loaded'] is None for c in result['checks']))

    def queue(self, filename, value):
        (self.root/filename).write_text(json.dumps(value))

    def delivery(self, statuses, aggregate='pending'):
        return {'version':1, 'entries':{'BUSN3040:fake':{
            'status':aggregate, 'title':'private title', 'last_error':'secret token',
            'stages':{name:{'status':statuses.get(name,'done')} for name in p.MATERIAL_STAGES}}}}

    def test_empty_gpt_queue_does_not_hide_failed_extraction_or_library_readback(self):
        self.queue('.pending-upload.json',{'files':[]})
        for stage in ('extraction','library'):
            with self.subTest(stage=stage):
                self.queue('.material-delivery.json',self.delivery({stage:'pending'}))
                r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000},'# Sweep clean')
                self.assertEqual((r['outcome'],r['reason']),('degraded','deferred'))
                self.assertIsNone(r['last_success_at'])
                for private in ('private title','secret token','BUSN3040','fake'):
                    self.assertNotIn(private,json.dumps(r))

    def test_old_gpt_exhaustion_and_missing_text_remain_visible(self):
        self.queue('.pending-upload.json',{'files':[{'course':'BUSN3040','text':'/missing/private.txt',
                                                   'attempts':99,'last_error':'private failure'}]})
        r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000})
        self.assertEqual(r['reason'],'deferred')
        self.assertIsNone(r['last_success_at'])
        self.assertNotIn('private',json.dumps(r))

    def test_corrupt_queues_are_unknown_not_empty_success(self):
        for name in ('.material-delivery.json','.pending-upload.json'):
            with self.subTest(name=name):
                path=self.root/name
                path.write_text('{broken secret}')
                before=path.read_bytes()
                r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000})
                self.assertEqual((r['outcome'],r['reason']),('unknown','unreadable'))
                self.assertIsNone(r['last_success_at'])
                self.assertEqual(path.read_bytes(),before)
                path.unlink()

    def test_queue_shape_and_incomplete_stage_override_optimistic_complete(self):
        self.queue('.material-delivery.json',self.delivery({'library':'running'},aggregate='complete'))
        r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000})
        self.assertEqual(r['reason'],'deferred')
        self.queue('.material-delivery.json',{'version':1,'entries':{'a':{}}})
        r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000})
        self.assertEqual(r['reason'],'unreadable')

    def test_revision_backlog_and_blocked_metadata_remain_visible_without_queue(self):
        for health,reason in (({'status':'pending','revision_deferred':3},'deferred'),
                              ({'status':'blocked','reason':'private details'},'partial'),
                              ({'status':'ok','gpt_pending':'unknown'},'unreadable')):
            with self.subTest(health=health):
                r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000,'material_health':health})
                self.assertEqual(r['reason'],reason)
                self.assertIsNone(r['last_success_at'])
                self.assertNotIn('private details',json.dumps(r))

    def test_recovered_queues_use_actual_collector_times_and_no_files_are_created(self):
        self.queue('.material-delivery.json',self.delivery({},aggregate='complete'))
        self.queue('.pending-upload.json',{'files':[]})
        before=set(self.root.iterdir())
        r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000,'last_attempt_epoch':1000000900,
                                       'material_health':{'status':'ok','gpt_pending':0,
                                                          'revision_deferred':0,'delivery':{'pending':0}}})
        self.assertEqual((r['outcome'],r['reason']),('healthy','ok'))
        self.assertEqual(r['last_success_at'],p.stamp(1000000000))
        self.assertEqual(r['last_attempt_at'],p.stamp(1000000900))
        self.assertEqual(set(self.root.iterdir())-before,{self.root/'state.json'})

    def test_session_reason_remains_primary_but_pending_is_not_success(self):
        self.queue('.pending-upload.json',{'files':[{'course':'BUSN3040','text':'private.txt'}]})
        r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000,'session_dead_since':1000001000})
        self.assertEqual(r['reason'],'session')
        self.assertIsNone(r['last_success_at'])

    def test_new_recovery_attempt_time_is_used_without_inventing_success(self):
        r=self.result('elc-daily-sweep',{'last_success_epoch':1000000000,
            'session_dead_since':1000001000,'last_material_attempt_epoch':1000002000,
            'material_health':{'status':'pending','gpt_pending':1}})
        self.assertEqual(r['last_attempt_at'],p.stamp(1000002000))
        self.assertEqual(r['reason'],'session')
        self.assertIsNone(r['last_success_at'])

if __name__=='__main__': unittest.main()
