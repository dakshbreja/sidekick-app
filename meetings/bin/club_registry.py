"""Only explicitly selected clubs; unrelated non-course audio stays excluded."""
import hashlib, json, re
from pathlib import Path
CLUBS={'ai-society':'AI Society at Terry','openai-uga':'OpenAI Student Collective UGA'}
JOINT={'d7513bbd-e07d-4321-a531-dd2fb4897f1c':['ai-society','openai-uga']}
def classify(title,sid,transcript=None,reviewed=None):
    # Explicit content reviews survive title changes, never transcript changes.
    # No transcript means metadata-only discovery, not review verification.
    if transcript is not None or reviewed is not None:
        if reviewed is None:
            path=Path(__file__).resolve().parents[1]/'routing.json'
            reviewed=json.loads(path.read_text()).get('sessions',{}).get(sid,{}) if path.exists() else {}
        if 'clubs' in reviewed:
            clubs=reviewed.get('clubs')
            if (not isinstance(clubs,list) or not clubs or any(c not in CLUBS for c in clubs)
                    or not reviewed.get('evidence') or
                    (transcript is not None and
                     reviewed.get('transcript_sha256')!=hashlib.sha256(transcript.encode()).hexdigest())):
                return []
            return sorted(set(clubs))
    if sid in JOINT:return JOINT[sid]
    found=[]
    if re.search(r'\bAI\s+Society\b',title,re.I):found.append('ai-society')
    if re.search(r'\bOpen\s*AI\s+Student\s+Collective\b',title,re.I):found.append('openai-uga')
    return found
