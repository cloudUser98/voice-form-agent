// One JSONL file per session holding every event, ours and OpenAI's. This is
// the debugging story: when a conversation goes wrong, you replay the file.
// Audio deltas are recorded as byte counts so traces stay readable.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.TRACE_DIR || path.join(process.cwd(), 'traces');

export function openTrace(sessionId, meta = {}) {
  if (process.env.TRACE === 'off') {
    return { write() {}, close() {}, file: null };
  }

  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${sessionId}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  const write = (entry) => stream.write(JSON.stringify({ t: Date.now(), ...entry }) + '\n');

  write({ dir: 'session', type: 'start', ...meta });

  return {
    file,
    write(entry) {
      if (entry.delta && typeof entry.delta === 'string' && entry.delta.length > 200) {
        write({ ...entry, delta: `<${entry.delta.length} b64 chars>` });
      } else {
        write(entry);
      }
    },
    close() { write({ dir: 'session', type: 'end' }); stream.end(); },
  };
}
