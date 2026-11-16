"""Validate probe content without printing private status data."""
import json
import sys


def problems(payload, kind, course=None):
    if not isinstance(payload, dict) or payload.get('error'):
        return ['invalid or failed bridge payload']
    errors = []
    feeds = payload.get('feeds' if kind == 'health' else 'feed_health')
    if not isinstance(feeds, list) or len(feeds) != 2:
        errors.append('expected both configured calendar feed results')
    elif any(not isinstance(feed, dict) or feed.get('ok') is not True for feed in feeds):
        errors.append('one or more calendar feeds failed')
    if kind == 'health':
        if payload.get('ok') is not True or payload.get('configured_feeds') != 2:
            errors.append('health reports failed or incomplete feed configuration')
    else:
        actual_course = payload.get('course')
        if not isinstance(actual_course, dict) or actual_course.get('code') != course:
            errors.append('status returned the wrong course scope')
        actionable = payload.get('actionable')
        coverage = actionable.get('coverage', {}) if isinstance(actionable, dict) else {}
        if coverage.get('feeds_status') != 'ok' or coverage.get('feeds_total') != 2:
            errors.append('status has incomplete calendar coverage')
        if not payload.get('generated_at') or not isinstance(payload.get('briefing'), str):
            errors.append('status payload is incomplete')
    return errors


if __name__ == '__main__':
    try:
        payload = json.load(sys.stdin)
        errors = problems(payload, sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    except (ValueError, IndexError):
        errors = ['unparseable bridge payload']
    print('\n'.join(errors), end='\n' if errors else '')
