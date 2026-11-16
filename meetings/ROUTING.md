# Recording routing

Updated September 18, 2026, at Daksh's request after two BUSN5000 recitations
were missed because their generated titles lacked a course code.

The existing exporter now inventories **every recording in the configured
current-term window** as well as recognized course and registered club sessions.
It reads unclassified recordings' transcripts; the generated summary never
establishes course identity. A recognized course code can occur anywhere in a
title, without case sensitivity, but remains a hint subject to the existing
transcript verification before bridge/File Library publication.

An explicit course code in transcript content (including spoken forms such as
“business 5000”) can resolve an unhelpful title. Conflicting or ambiguous content
is held in `Review/` locally and listed in `.routing-review.json`. Broad topic
words alone never authorize publication. Export exit 3 makes the existing daily
routine **deferred**, so unclassified content cannot silently produce an all-clear.
Source-read failures remain failed. Active recordings are not opened.

`routing.json` owns the review dates and individually reviewed session decisions.
Each decision has course or exclusion, reviewer, evidence, and transcript hash.
It survives a rename but is invalidated when transcript content changes. Review
the relevant content before adding a decision; do not infer a class from a title
or use a generic summary as evidence. Unrelated recordings are never sent to class
GPTs. Earlier-term personal/career recordings remain outside this school review.

Useful existing-collector options:

```sh
python3 bin/cluely_export.py --dry-run
python3 bin/cluely_export.py --unclassified
python3 bin/cluely_export.py --session-id <recording-id>
```

The dry-run lists candidates without opening content or writing files. A scoped
run does not establish that every other recording's content was freshly checked.
Existing schedules and club routing are retained; no second collector was added.

September 18 review recovered the September 11 “Exam Review Discussion” and
September 18 “BUSN 5000 test 1 recitation 2” (formerly “Econometrics Exam Review
Lecture”). The other unclassified current-term recordings were a 29-second
software demo and a three-second clip whose source UI says “No transcript.”

Bridge summaries, exact File Library readbacks, and GPT Knowledge publication
are separate delivery stages. A successful local export is not proof of any
remote publication or coursework submission.
