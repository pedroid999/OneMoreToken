-- Synthetic reconstruction of the OpenCode SQLite shapes (odd/tasks/phase-2-explorer.md L4, L9).
-- Fake ids, /synthetic paths and PRIVATE_SENTINEL text only: content must never leave the reader.
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  directory TEXT NOT NULL,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_compacting INTEGER,
  cost REAL,
  tokens_input INTEGER,
  tokens_output INTEGER
);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);

INSERT INTO session VALUES
  ('ses_parent', 'prj_synthetic', NULL, '/synthetic/project', 'PRIVATE_SENTINEL title', '1.0.0-synthetic', 1767225600000, 1767226200000, 1767225900000, 9.99, 999, 999),
  ('ses_child', 'prj_synthetic', 'ses_parent', '/synthetic/project', 'PRIVATE_SENTINEL subtask', '1.0.0-synthetic', 1767225660000, 1767225720000, NULL, 9.99, 999, 999),
  ('ses_legacy_dup', 'prj_synthetic', NULL, '/synthetic/migrated', 'PRIVATE_SENTINEL migrated', '0.9.0-synthetic', 1764547200000, 1764547260000, NULL, 9.99, 999, 999);

-- Inserted out of order: the reader sorts by time then id.
INSERT INTO message VALUES
  ('msg_p2', 'ses_parent', 1767225610000, 1767225640000, '{"role":"assistant","time":{"created":1767225610000,"completed":1767225640000},"parentID":"msg_p1","modelID":"model-a","providerID":"synthetic","mode":"build","agent":"build","variant":"high","path":{"cwd":"/synthetic/project","root":"/synthetic/project"},"cost":0.5,"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":30,"write":40}},"finish":"tool-calls","system":["PRIVATE_SENTINEL system"]}'),
  ('msg_p1', 'ses_parent', 1767225600000, 1767225600000, '{"role":"user","time":{"created":1767225600000},"agent":"build","model":{"providerID":"synthetic","modelID":"model-a"},"summary":{"title":"PRIVATE_SENTINEL summary","diffs":[]}}'),
  ('msg_p3', 'ses_parent', 1767225900000, 1767225900000, '{"role":"user","time":{"created":1767225900000},"agent":"build","model":{"providerID":"synthetic","modelID":"model-a"}}'),
  ('msg_p4', 'ses_parent', 1767225910000, 1767225950000, '{"role":"assistant","time":{"created":1767225910000,"completed":1767225950000},"parentID":"msg_p3","modelID":"model-a","providerID":"synthetic","mode":"compaction","agent":"compaction","summary":true,"cost":0,"tokens":{"input":1000,"output":200,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}'),
  ('msg_p5', 'ses_parent', 1767226000000, 1767226000000, '{"role":"assistant","time":{"created":1767226000000},"parentID":"msg_p3","modelID":"model-b","providerID":"other","mode":"build","agent":"build","cost":0,"error":{"name":"PRIVATE_SENTINEL error"}}'),
  ('msg_c1', 'ses_child', 1767225660000, 1767225660000, '{"role":"user","time":{"created":1767225660000},"agent":"explore","model":{"providerID":"synthetic","modelID":"model-a"}}'),
  ('msg_c2', 'ses_child', 1767225670000, 1767225700000, '{"role":"assistant","time":{"created":1767225670000,"completed":1767225700000},"parentID":"msg_c1","modelID":"model-a","providerID":"synthetic","mode":"explore","agent":"explore","cost":0.125,"tokens":{"input":10,"output":2,"reasoning":0,"cache":{"read":0,"write":0}},"finish":"stop"}'),
  ('msg_d1', 'ses_legacy_dup', 1764547200000, 1764547230000, '{"role":"assistant","time":{"created":1764547200000,"completed":1764547230000},"modelID":"model-a","providerID":"synthetic","mode":"build","cost":0.25,"tokens":{"input":7,"output":3,"reasoning":0,"cache":{"read":0,"write":0}}}');

INSERT INTO part VALUES
  ('prt_p1a', 'msg_p1', 'ses_parent', 1767225600000, 1767225600000, '{"type":"text","text":"PRIVATE_SENTINEL prompt"}'),
  ('prt_p2a', 'msg_p2', 'ses_parent', 1767225610000, 1767225610000, '{"type":"step-start","snapshot":"PRIVATE_SENTINEL"}'),
  ('prt_p2b', 'msg_p2', 'ses_parent', 1767225611000, 1767225611000, '{"type":"reasoning","text":"PRIVATE_SENTINEL reasoning","time":{"start":1767225611000,"end":1767225612000}}'),
  ('prt_p2c', 'msg_p2', 'ses_parent', 1767225612000, 1767225613500, '{"type":"tool","callID":"call_read","tool":"read","state":{"status":"completed","input":{"filePath":"/synthetic/PRIVATE_SENTINEL"},"output":"PRIVATE_SENTINEL","title":"PRIVATE_SENTINEL","metadata":{},"time":{"start":1767225612000,"end":1767225613500}}}'),
  ('prt_p2d', 'msg_p2', 'ses_parent', 1767225614000, 1767225614012, '{"type":"tool","callID":"call_bash","tool":"bash","state":{"status":"error","input":{"command":"PRIVATE_SENTINEL"},"error":"PRIVATE_SENTINEL","time":{"start":1767225614000,"end":1767225614012}}}'),
  ('prt_p2e', 'msg_p2', 'ses_parent', 1767225615000, 1767225615000, '{"type":"tool","callID":"call_edit","tool":"edit","state":{"status":"running","input":{},"time":{"start":1767225615000}}}'),
  ('prt_p2f', 'msg_p2', 'ses_parent', 1767225616000, 1767225616000, '{"type":"text","text":"PRIVATE_SENTINEL answer"}'),
  ('prt_p2g', 'msg_p2', 'ses_parent', 1767225640000, 1767225640000, '{"type":"step-finish","reason":"tool-calls","cost":0.5,"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":30,"write":40}}}'),
  ('prt_p3a', 'msg_p3', 'ses_parent', 1767225900000, 1767225900000, '{"type":"compaction","auto":true,"overflow":true,"tail_start_id":"msg_p1"}'),
  ('prt_p4a', 'msg_p4', 'ses_parent', 1767225910000, 1767225950000, '{"type":"text","text":"PRIVATE_SENTINEL compaction summary"}'),
  ('prt_c2a', 'msg_c2', 'ses_child', 1767225680000, 1767225690000, '{"type":"tool","callID":"call_grep","tool":"grep","state":{"status":"completed","input":{},"output":"PRIVATE_SENTINEL","time":{"start":1767225680000,"end":1767225690000}}}'),
  ('prt_d1a', 'msg_d1', 'ses_legacy_dup', 1764547200000, 1764547200000, '{"type":"text","text":"PRIVATE_SENTINEL"}');
