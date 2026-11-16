"""Read-only routine projections, with only synthetic temporary status files."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

# Both live roots and engineering worktrees keep the routines repository as a sibling.
PATH = Path(__file__).resolve().parents[3] / 'routines/routinectl'
loader = importlib.machinery.SourceFileLoader('school_routinectl', str(PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
routines = importlib.util.module_from_spec(spec)
loader.exec_module(routines)


class MaterialProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'status.json'
        self.row = {'status_file': str(self.path), 'status_kind': 'elc', 'stale_after': 100}
        self.state = {'last_success_epoch': time.time(), 'material_health': {
            'status': 'ok', 'delivery': {'pending': 0}, 'gpt_pending': 0,
            'legacy_delivery_unseeded': 0, 'revision_deferred': 0}}
        guard = patch.object(routines.subprocess, 'run', side_effect=AssertionError('no live commands'))
        guard.start(); self.addCleanup(guard.stop)

    def status(self):
        self.path.write_text(json.dumps(self.state))
        return routines.status_of(self.row)

    def test_complete_and_fresh_is_healthy(self):
        self.assertEqual(self.status()[0], 'ok')

    def test_pending_stages_override_optimistic_listing(self):
        for field in ['gpt_pending', 'legacy_delivery_unseeded', 'revision_deferred']:
            self.state['material_health'][field] = 1
            self.assertEqual(self.status()[0], 'problem')
            self.state['material_health'][field] = 0
        self.state['material_health']['delivery']['pending'] = 1
        self.assertEqual(self.status()[0], 'problem')

    def test_capture_hold_remains_problem_even_if_other_counts_complete(self):
        self.state['material_capture_hold'] = {'capture_id': 'fake'}
        self.assertEqual(self.status()[0], 'problem')

    def test_uninitialized_or_malformed_state_is_unknown(self):
        health = self.state.pop('material_health')
        self.assertEqual(self.status()[0], 'unknown')
        self.state['material_health'] = health
        health['gpt_pending'] = '0'
        self.assertEqual(self.status()[0], 'unknown')

    def test_blocked_and_stale_are_not_healthy(self):
        self.state['material_health']['status'] = 'blocked'
        self.assertEqual(self.status()[0], 'problem')
        self.state['material_health']['status'] = 'ok'
        self.state['last_success_epoch'] -= 200
        self.assertEqual(self.status()[0], 'stale')

    def test_non_elc_json_projection_unchanged(self):
        self.row['status_kind'] = 'json'
        self.state = {'overall': 'ok', 'message': 'synthetic successful check'}
        self.assertEqual(self.status()[:2], ('ok', 'synthetic successful check'))


if __name__ == '__main__': unittest.main()
