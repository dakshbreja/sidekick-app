# Cluely Meeting Archive

Auto-exported from the Cluely desktop app by `bin/cluely_export.py`.
Refreshes recent recordings and reviews unclassified current-term content.
See [routing rules and review queue](ROUTING.md); titles are hints, not an inclusion gate.

## Trust the transcript, not the summary

Cluely records one file per *recording window*, not per meeting, and mixes the
room mic with system audio. Anything playing through the speakers while it runs
lands in the same transcript, and its summariser will then describe that as if
it were class. Separately, the summariser sometimes asserts things the
transcript does not contain at all.

`bin/verify.py` checks a session against its own transcript and is run
automatically by `bin/push_notes.py`, so only material the class portion of the
transcript supports reaches the GPT bridge:

```
python3 bin/verify.py Classes/*.md        # report
python3 bin/push_notes.py --dry-run        # what would be pushed, no KV writes
```

Two caveats it cannot fix. Speaker labels are unreliable - in an in-person
lecture nearly every turn is tagged with your name even when the professor is
talking, so never read attribution off a transcript. And the ASR garbles proper
nouns badly; names and numbers want checking against eLC before you rely on them.

## Class sessions

| Date | Course | Meeting | File |
|---|---|---|---|
| 2026-11-05 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-11-05_MGMT-5850-Performance-Mgmt-Compensation-Guhde_ae372a08-dc55-4ea9-bda8-95c4b7084e75.md](Classes/2026-11-05_MGMT-5850-Performance-Mgmt-Compensation-Guhde_ae372a08-dc55-4ea9-bda8-95c4b7084e75.md) |
| 2026-11-05 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-11-05_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_963bffca-05ec-4679-841f-5f93dce54b63.md](Classes/2026-11-05_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_963bffca-05ec-4679-841f-5f93dce54b63.md) |
| 2026-11-05 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-11-05_MGMT-4280-Supply-Chain-Analytics-Beil_966162b4-9d54-46d5-8e4d-382e921468d2.md](Classes/2026-11-05_MGMT-4280-Supply-Chain-Analytics-Beil_966162b4-9d54-46d5-8e4d-382e921468d2.md) |
| 2026-11-03 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-11-03_MGMT-5850-Performance-Mgmt-Compensation-Guhde_522d987a-f655-48ef-8352-7d7f4269a4cd.md](Classes/2026-11-03_MGMT-5850-Performance-Mgmt-Compensation-Guhde_522d987a-f655-48ef-8352-7d7f4269a4cd.md) |
| 2026-11-03 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-11-03_MGMT-4280-Supply-Chain-Analytics-Beil_80e70779-2e98-4529-a1e5-731a1b8614f5.md](Classes/2026-11-03_MGMT-4280-Supply-Chain-Analytics-Beil_80e70779-2e98-4529-a1e5-731a1b8614f5.md) |
| 2026-10-29 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-10-29_MGMT-5850-Performance-Mgmt-Compensation-Guhde_f54a5010-30ee-42ad-889c-504bad8fb617.md](Classes/2026-10-29_MGMT-5850-Performance-Mgmt-Compensation-Guhde_f54a5010-30ee-42ad-889c-504bad8fb617.md) |
| 2026-10-28 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-10-28_MGMT-5560-International-Strategic-Management-Hill_e9b0aa97-7e9a-40fd-8574-add2b29bcfd2.md](Classes/2026-10-28_MGMT-5560-International-Strategic-Management-Hill_e9b0aa97-7e9a-40fd-8574-add2b29bcfd2.md) |
| 2026-10-27 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-10-27_MGMT-5850-Performance-Mgmt-Compensation-Guhde_fca0cef3-5239-41c0-ba70-a918d2f09568.md](Classes/2026-10-27_MGMT-5850-Performance-Mgmt-Compensation-Guhde_fca0cef3-5239-41c0-ba70-a918d2f09568.md) |
| 2026-10-27 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-10-27_MGMT-4280-Supply-Chain-Analytics-Beil_f61195ee-cac6-4a48-ae9c-6e3a0e4d3015.md](Classes/2026-10-27_MGMT-4280-Supply-Chain-Analytics-Beil_f61195ee-cac6-4a48-ae9c-6e3a0e4d3015.md) |
| 2026-10-26 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-10-26_MGMT-5560-International-Strategic-Management-Hill_93bfafe1-bbe0-4730-ab67-cf7c60cdfe2e.md](Classes/2026-10-26_MGMT-5560-International-Strategic-Management-Hill_93bfafe1-bbe0-4730-ab67-cf7c60cdfe2e.md) |
| 2026-10-22 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-10-22_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_3a0599fc-4904-47a6-b36d-3c258c3918b7.md](Classes/2026-10-22_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_3a0599fc-4904-47a6-b36d-3c258c3918b7.md) |
| 2026-10-20 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-10-20_MGMT-5850-Performance-Mgmt-Compensation-Guhde_b1afc36d-c5ff-4a8b-9bfc-95ab15fc4ef1.md](Classes/2026-10-20_MGMT-5850-Performance-Mgmt-Compensation-Guhde_b1afc36d-c5ff-4a8b-9bfc-95ab15fc4ef1.md) |
| 2026-10-20 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-10-20_MGMT-4280-Supply-Chain-Analytics-Beil_61e72ad0-8125-4147-b8b2-262de300859a.md](Classes/2026-10-20_MGMT-4280-Supply-Chain-Analytics-Beil_61e72ad0-8125-4147-b8b2-262de300859a.md) |
| 2026-10-15 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-10-15_MGMT-5850-Performance-Mgmt-Compensation-Guhde_5aec1b21-4d48-4733-9bd6-06f53b2340b3.md](Classes/2026-10-15_MGMT-5850-Performance-Mgmt-Compensation-Guhde_5aec1b21-4d48-4733-9bd6-06f53b2340b3.md) |
| 2026-10-15 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-10-15_MGMT-4280-Supply-Chain-Analytics-Beil_227185bb-95b0-4e7e-b792-52cb6f073c4e.md](Classes/2026-10-15_MGMT-4280-Supply-Chain-Analytics-Beil_227185bb-95b0-4e7e-b792-52cb6f073c4e.md) |
| 2026-10-14 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-10-14_MGMT-5560-International-Strategic-Management-Hill_f9fa46d3-8ebd-4462-a659-e2391b7c1ca0.md](Classes/2026-10-14_MGMT-5560-International-Strategic-Management-Hill_f9fa46d3-8ebd-4462-a659-e2391b7c1ca0.md) |
| 2026-10-13 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-10-13_MGMT-5850-Performance-Mgmt-Compensation-Guhde_d3c3e79a-ba08-420c-bdbf-ca65bc4f458a.md](Classes/2026-10-13_MGMT-5850-Performance-Mgmt-Compensation-Guhde_d3c3e79a-ba08-420c-bdbf-ca65bc4f458a.md) |
| 2026-10-13 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-10-13_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_526f4af3-6e82-455b-9aec-01d186c0dca3.md](Classes/2026-10-13_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_526f4af3-6e82-455b-9aec-01d186c0dca3.md) |
| 2026-10-13 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-10-13_MGMT-4280-Supply-Chain-Analytics-Beil_6b8997d7-a073-4648-95ed-5e260e08d624.md](Classes/2026-10-13_MGMT-4280-Supply-Chain-Analytics-Beil_6b8997d7-a073-4648-95ed-5e260e08d624.md) |
| 2026-10-12 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-10-12_MGMT-5560-International-Strategic-Management-Hill_d1224372-a2c6-4294-937a-573aa09a613b.md](Classes/2026-10-12_MGMT-5560-International-Strategic-Management-Hill_d1224372-a2c6-4294-937a-573aa09a613b.md) |
| 2026-10-06 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-10-06_MGMT-4280-Supply-Chain-Analytics-Beil_74e47f0c-24ba-400c-9286-315afaa21665.md](Classes/2026-10-06_MGMT-4280-Supply-Chain-Analytics-Beil_74e47f0c-24ba-400c-9286-315afaa21665.md) |
| 2026-10-06 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-10-06_MGMT-5850-Performance-Mgmt-Compensation-Guhde_6a4f0b52-1fb4-4d65-8e22-dc1894869d69.md](Classes/2026-10-06_MGMT-5850-Performance-Mgmt-Compensation-Guhde_6a4f0b52-1fb4-4d65-8e22-dc1894869d69.md) |
| 2026-09-30 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-09-30_MGMT-5560-International-Strategic-Management-Hill_98102ca5-112a-4ab8-a54d-22dcd572cedf.md](Classes/2026-09-30_MGMT-5560-International-Strategic-Management-Hill_98102ca5-112a-4ab8-a54d-22dcd572cedf.md) |
| 2026-09-29 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-09-29_MGMT-4280-Supply-Chain-Analytics-Beil_888e2169-52e1-4fec-8eeb-4b194b59ec0d.md](Classes/2026-09-29_MGMT-4280-Supply-Chain-Analytics-Beil_888e2169-52e1-4fec-8eeb-4b194b59ec0d.md) |
| 2026-09-28 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-09-28_MGMT-5560-International-Strategic-Management-Hill_c42ad030-954f-401f-80f4-24a79663f456.md](Classes/2026-09-28_MGMT-5560-International-Strategic-Management-Hill_c42ad030-954f-401f-80f4-24a79663f456.md) |
| 2026-09-24 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-09-24_MGMT-5850-Performance-Mgmt-Compensation-Guhde_4b76aadf-2ef7-4bdd-8257-7c18f8809e51.md](Classes/2026-09-24_MGMT-5850-Performance-Mgmt-Compensation-Guhde_4b76aadf-2ef7-4bdd-8257-7c18f8809e51.md) |
| 2026-09-23 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-09-23_MGMT-5560-International-Strategic-Management-Hill_519451be-0f8c-4492-ae07-337f68b70cd9.md](Classes/2026-09-23_MGMT-5560-International-Strategic-Management-Hill_519451be-0f8c-4492-ae07-337f68b70cd9.md) |
| 2026-09-22 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-09-22_MGMT-5850-Performance-Mgmt-Compensation-Guhde_26567285-271b-4e45-af74-fa09beb00de6.md](Classes/2026-09-22_MGMT-5850-Performance-Mgmt-Compensation-Guhde_26567285-271b-4e45-af74-fa09beb00de6.md) |
| 2026-09-22 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-09-22_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_078e7b82-c0a1-4fbd-be1f-8d2691a07789.md](Classes/2026-09-22_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_078e7b82-c0a1-4fbd-be1f-8d2691a07789.md) |
| 2026-09-22 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-09-22_MGMT-4280-Supply-Chain-Analytics-Beil_9de7cf5c-d589-4d9c-b8ce-21d31a4c0e83.md](Classes/2026-09-22_MGMT-4280-Supply-Chain-Analytics-Beil_9de7cf5c-d589-4d9c-b8ce-21d31a4c0e83.md) |
| 2026-09-21 | BUSN 5000 | BUSN 5000 test 1 review session | [2026-09-21_BUSN-5000-test-1-review-session_a9b8205a-1c33-4756-a503-17be2cbaa0de.md](Classes/2026-09-21_BUSN-5000-test-1-review-session_a9b8205a-1c33-4756-a503-17be2cbaa0de.md) |
| 2026-09-18 | BUSN 5000 | BUSN 5000 test 1 recitation 2 | [2026-09-18_BUSN-5000-test-1-recitation-2_d566caae-f356-485a-8266-a6492cf1b76c.md](Classes/2026-09-18_BUSN-5000-test-1-recitation-2_d566caae-f356-485a-8266-a6492cf1b76c.md) |
| 2026-09-17 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-09-17_MGMT-5850-Performance-Mgmt-Compensation-Guhde_3145bd7e-dcd6-4997-a9f1-d104194d9e53.md](Classes/2026-09-17_MGMT-5850-Performance-Mgmt-Compensation-Guhde_3145bd7e-dcd6-4997-a9f1-d104194d9e53.md) |
| 2026-09-17 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-09-17_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_2c85b175-439a-4eba-8dd2-f3b145fc6ae1.md](Classes/2026-09-17_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_2c85b175-439a-4eba-8dd2-f3b145fc6ae1.md) |
| 2026-09-17 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-09-17_MGMT-4280-Supply-Chain-Analytics-Beil_915ad3ea-39b3-4bc6-bab0-6218a50755a8.md](Classes/2026-09-17_MGMT-4280-Supply-Chain-Analytics-Beil_915ad3ea-39b3-4bc6-bab0-6218a50755a8.md) |
| 2026-09-16 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-09-16_MGMT-5560_d6167750-4865-46e6-b0ff-f27480dede64.md](Classes/2026-09-16_MGMT-5560_d6167750-4865-46e6-b0ff-f27480dede64.md) |
| 2026-09-15 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-09-15_MGMT-5850-Performance-Mgmt-Compensation-Guhde_18f4a39e-1019-45e5-b0ec-1f7b0c30b3fe.md](Classes/2026-09-15_MGMT-5850-Performance-Mgmt-Compensation-Guhde_18f4a39e-1019-45e5-b0ec-1f7b0c30b3fe.md) |
| 2026-09-15 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-09-15_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_8c4a6a03-cc5d-4121-a65c-68a13a1b7b50.md](Classes/2026-09-15_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_8c4a6a03-cc5d-4121-a65c-68a13a1b7b50.md) |
| 2026-09-15 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-09-15_MGMT-4280-Supply-Chain-Analytics-Beil_4271547f-47cf-48cd-a592-44b5f5046165.md](Classes/2026-09-15_MGMT-4280-Supply-Chain-Analytics-Beil_4271547f-47cf-48cd-a592-44b5f5046165.md) |
| 2026-09-14 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-09-14_MGMT-5560_655aa3d5-44f7-422b-8da7-dea364295a52.md](Classes/2026-09-14_MGMT-5560_655aa3d5-44f7-422b-8da7-dea364295a52.md) |
| 2026-09-11 | BUSN 5000 | Exam Review Discussion | [2026-09-11_Exam-Review-Discussion_760723bd-a186-4de4-955e-3eee381f1c50.md](Classes/2026-09-11_Exam-Review-Discussion_760723bd-a186-4de4-955e-3eee381f1c50.md) |
| 2026-09-10 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-09-10_MGMT-5850-Performance-Mgmt-Compensation-Guhde_d3d356f3-a781-4d08-ba60-828fc7a39b09.md](Classes/2026-09-10_MGMT-5850-Performance-Mgmt-Compensation-Guhde_d3d356f3-a781-4d08-ba60-828fc7a39b09.md) |
| 2026-09-10 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-09-10_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_3a08a24b-3a61-47f8-892e-335ba837a947.md](Classes/2026-09-10_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell_3a08a24b-3a61-47f8-892e-335ba837a947.md) |
| 2026-09-10 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-09-10_MGMT-4280-Supply-Chain-Analytics-Beil_f98c4171-e611-42d3-9a95-0e5940f14f7c.md](Classes/2026-09-10_MGMT-4280-Supply-Chain-Analytics-Beil_f98c4171-e611-42d3-9a95-0e5940f14f7c.md) |
| 2026-09-09 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-09-09_MGMT-5560_94668f7a-aa5e-4fe3-8155-2cfedafbc89f.md](Classes/2026-09-09_MGMT-5560_94668f7a-aa5e-4fe3-8155-2cfedafbc89f.md) |
| 2026-09-03 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-09-03_MGMT-4280-Supply-Chain-Analytics-Beil.md](Classes/2026-09-03_MGMT-4280-Supply-Chain-Analytics-Beil.md) |
| 2026-09-03 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-09-03_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md](Classes/2026-09-03_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md) |
| 2026-09-03 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-09-03_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md](Classes/2026-09-03_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md) |
| 2026-09-02 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-09-02_MGMT-5560-International-Strategic-Management-Hill.md](Classes/2026-09-02_MGMT-5560-International-Strategic-Management-Hill.md) |
| 2026-09-01 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-09-01_MGMT-4280-Supply-Chain-Analytics-Beil.md](Classes/2026-09-01_MGMT-4280-Supply-Chain-Analytics-Beil.md) |
| 2026-09-01 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-09-01_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md](Classes/2026-09-01_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md) |
| 2026-09-01 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-09-01_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md](Classes/2026-09-01_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md) |
| 2026-08-31 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-08-31_MGMT-5560-International-Strategic-Management-Hill.md](Classes/2026-08-31_MGMT-5560-International-Strategic-Management-Hill.md) |
| 2026-08-27 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-08-27_MGMT-4280-Supply-Chain-Analytics-Beil.md](Classes/2026-08-27_MGMT-4280-Supply-Chain-Analytics-Beil.md) |
| 2026-08-27 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-08-27_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md](Classes/2026-08-27_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md) |
| 2026-08-27 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-08-27_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md](Classes/2026-08-27_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md) |
| 2026-08-26 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-08-26_MGMT-5560-International-Strategic-Management-Hill.md](Classes/2026-08-26_MGMT-5560-International-Strategic-Management-Hill.md) |
| 2026-08-25 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-08-25_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md](Classes/2026-08-25_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md) |
| 2026-08-25 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-08-25_MGMT-4280-Supply-Chain-Analytics-Beil.md](Classes/2026-08-25_MGMT-4280-Supply-Chain-Analytics-Beil.md) |
| 2026-08-25 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-08-25_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md](Classes/2026-08-25_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md) |
| 2026-08-24 | MGMT 5560 | MGMT 5560 — International Strategic Management (Hill) | [2026-08-24_MGMT-5560-International-Strategic-Management-Hill.md](Classes/2026-08-24_MGMT-5560-International-Strategic-Management-Hill.md) |
| 2026-08-20 | MGMT 4280 | MGMT 4280 — Supply Chain Analytics (Beil) | [2026-08-20_MGMT-4280-Supply-Chain-Analytics-Beil.md](Classes/2026-08-20_MGMT-4280-Supply-Chain-Analytics-Beil.md) |
| 2026-08-20 | BUSN 5000 | BUSN 5000 — Intro to Data Science for Business (Cornwell) | [2026-08-20_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md](Classes/2026-08-20_BUSN-5000-Intro-to-Data-Science-for-Business-Cornwell.md) |
| 2026-08-20 | MGMT 5850 | MGMT 5850 — Performance Mgmt & Compensation (Guhde) | [2026-08-20_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md](Classes/2026-08-20_MGMT-5850-Performance-Mgmt-Compensation-Guhde.md) |

## Other sessions

| Date | Meeting | File |
|---|---|---|
| 2026-11-04 | IBM Technology Sales And Enterprise AI | [97320e28-dd01-4afb-a6ea-5b00e4414127.json](Clubs/97320e28-dd01-4afb-a6ea-5b00e4414127.json) |
| 2026-09-29 | AI Society — QuantumBlack / McKinsey Speaker Session | [4fa88cf9-e30e-4757-813a-e8c81eb689e1.json](Clubs/4fa88cf9-e30e-4757-813a-e8c81eb689e1.json) |
| 2026-09-22 | AI Society — Amazon Speaker Session | [be28fc56-8cb9-4bad-8572-d051c8c4215b.json](Clubs/be28fc56-8cb9-4bad-8572-d051c8c4215b.json) |
| 2026-09-16 | AI Society Dashboard Workshop | [d7513bbd-e07d-4321-a531-dd2fb4897f1c.json](Clubs/d7513bbd-e07d-4321-a531-dd2fb4897f1c.json) |
| 2026-09-14 | AI Society - EY meeting | [38baf3a3-097e-420e-b28f-b422e9709a73.json](Clubs/38baf3a3-097e-420e-b28f-b422e9709a73.json) |
| 2026-09-03 | Designing Classroom Audio Assistant | [2026-09-03_Designing-Classroom-Audio-Assistant.md](Other/2026-09-03_Designing-Classroom-Audio-Assistant.md) |
| 2026-07-31 | American System Review With Caroline | [2026-07-31_American-System-Review-With-Caroline.md](Other/2026-07-31_American-System-Review-With-Caroline.md) |
| 2026-07-24 | I’d say the long‑term impact was that the liberty debates ne | [2026-07-24_Id-say-the-longterm-impact-was-that-the-liberty-debates-neve.md](Other/2026-07-24_Id-say-the-longterm-impact-was-that-the-liberty-debates-neve.md) |
| 2026-07-17 | Absolutely—women overall had fewer legal rights, but we stil | [2026-07-17_Absolutelywomen-overall-had-fewer-legal-rights-but-we-still.md](Other/2026-07-17_Absolutelywomen-overall-had-fewer-legal-rights-but-we-still.md) |
| 2026-07-10 | Could you recommend a specific primary source I should refer | [2026-07-10_Could-you-recommend-a-specific-primary-source-I-should-refer.md](Other/2026-07-10_Could-you-recommend-a-specific-primary-source-I-should-refer.md) |
| 2026-05-04 | Pre Day-1 Exchange | [2026-05-04_Pre-Day-1-Exchange.md](Other/2026-05-04_Pre-Day-1-Exchange.md) |
| 2026-04-02 | Finance Intern \| Feedback | [2026-04-02_Finance-Intern-Feedback.md](Other/2026-04-02_Finance-Intern-Feedback.md) |
| 2026-03-24 | Panel Interview Finance Intern \| Daksh Breja | [2026-03-24_Panel-Interview-Finance-Intern-Daksh-Breja.md](Other/2026-03-24_Panel-Interview-Finance-Intern-Daksh-Breja.md) |
| 2026-03-16 | Test Review Session with Dr. Loomer | [2026-03-16_Test-Review-Session-with-Dr-Loomer.md](Other/2026-03-16_Test-Review-Session-with-Dr-Loomer.md) |
| 2026-03-05 | Porsche Financial Services Interview Preparation | [2026-03-05_Porsche-Financial-Services-Interview-Preparation.md](Other/2026-03-05_Porsche-Financial-Services-Interview-Preparation.md) |
| 2026-02-09 | Marketing Exam Review with Kyle | [2026-02-09_Marketing-Exam-Review-with-Kyle.md](Other/2026-02-09_Marketing-Exam-Review-with-Kyle.md) |
| 2026-02-02 | Finance & Risk Management Internship – Porsche Financial Ser | [2026-02-02_Finance-Risk-Management-Internship-Porsche-Financial-Service.md](Other/2026-02-02_Finance-Risk-Management-Internship-Porsche-Financial-Service.md) |
| 2026-01-31 | Primaface | [2026-01-31_Primaface.md](Other/2026-01-31_Primaface.md) |
| 2026-01-26 | Angel Oak Summer Internship discussion - Daksh Breja | [2026-01-26_Angel-Oak-Summer-Internship-discussion---Daksh-Breja.md](Other/2026-01-26_Angel-Oak-Summer-Internship-discussion---Daksh-Breja.md) |
| 2026-01-25 | Cluely Demo with CEO Roy Lee | [2026-01-25_Cluely-Demo-with-CEO-Roy-Lee.md](Other/2026-01-25_Cluely-Demo-with-CEO-Roy-Lee.md) |
| 2026-01-21 | Interview: Daksh Breja - Spring Procurement Analyst Co-Op | [2026-01-21_Interview-Daksh-Breja---Spring-Procurement-Analyst-Co-Op.md](Other/2026-01-21_Interview-Daksh-Breja---Spring-Procurement-Analyst-Co-Op.md) |
| 2025-06-30 | User Requests Summary of Recent Recording | [2025-06-30_User-Requests-Summary-of-Recent-Recording.md](Other/2025-06-30_User-Requests-Summary-of-Recent-Recording.md) |
| 2025-06-30 | Beauty Industry Digital Strategy Discussion | [2025-06-30_Beauty-Industry-Digital-Strategy-Discussion.md](Other/2025-06-30_Beauty-Industry-Digital-Strategy-Discussion.md) |
