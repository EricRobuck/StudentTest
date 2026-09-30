// Calls the AI question generator directly (no server) and prints the result
// or the error. Makes one real, billed API request.
//
//   npm run ai:try -w @linuxlab/server -- "topic" [count]

import { config } from '../src/config.js';
import { QuestionGenerator } from '../src/modules/authoring/questionGenerator.js';

const topic = process.argv[2] ?? 'finding a hidden file with find and copying it somewhere';
const count = Number(process.argv[3] ?? 1);
const generator = new QuestionGenerator(config.ai.model);

try {
  const drafts = await generator.generate({ topic, count, difficulty: 'beginner', pointsEach: 10 }, []);
  console.log(JSON.stringify(drafts, null, 2));
} catch (err) {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
}
