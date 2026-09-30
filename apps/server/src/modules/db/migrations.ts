// Schema migrations, applied in order and recorded in schema_migrations.
// Never edit a migration that has shipped; add a new one instead.
//
// Portability rules (so PostgreSQL can replace SQLite later):
//  - text UUID primary keys, ISO-8601 UTC timestamps stored as TEXT
//  - JSON stored as TEXT
//  - booleans as INTEGER 0/1 (maps to BOOLEAN)
//  - no SQLite-only SQL outside this file

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'attempts, sessions, submissions',
    sql: `
      -- One student's sitting of one exam.
      CREATE TABLE exam_attempts (
        id                  TEXT PRIMARY KEY,
        exam_id             TEXT NOT NULL,
        student_id          TEXT,            -- null until authentication exists
        status              TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
        end_reason          TEXT CHECK (end_reason IN ('finished', 'time_expired')),
        started_at          TEXT NOT NULL,
        deadline_at         TEXT,            -- null = untimed
        completed_at        TEXT,
        current_question_id TEXT
      );

      -- The concrete questions of an attempt. Holds per-student randomized
      -- variables ({{random_directory}} etc.) once randomization exists.
      CREATE TABLE attempt_questions (
        attempt_id  TEXT NOT NULL REFERENCES exam_attempts(id),
        question_id TEXT NOT NULL,
        position    INTEGER NOT NULL,
        max_points  REAL NOT NULL,
        variables   TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (attempt_id, question_id)
      );

      -- A browser's connection to an attempt. The cookie token is stored only as a hash.
      CREATE TABLE sessions (
        id             TEXT PRIMARY KEY,
        token_hash     TEXT NOT NULL UNIQUE,
        attempt_id     TEXT NOT NULL REFERENCES exam_attempts(id),
        container_id   TEXT,                 -- null once the environment is gone
        container_name TEXT,
        created_at     TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );
      CREATE INDEX sessions_container ON sessions(container_id);

      -- Every Submit click. Scores are fractions (0..1) so partial credit fits later.
      CREATE TABLE submissions (
        id             TEXT PRIMARY KEY,
        attempt_id     TEXT NOT NULL REFERENCES exam_attempts(id),
        question_id    TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        passed         INTEGER NOT NULL,
        score          REAL NOT NULL,
        points_awarded REAL NOT NULL,
        max_points     REAL NOT NULL,
        rule_results   TEXT NOT NULL,        -- JSON, includes instructor-only detail
        submitted_at   TEXT NOT NULL,
        UNIQUE (attempt_id, question_id, attempt_number)
      );
      CREATE INDEX submissions_attempt ON submissions(attempt_id, question_id);
    `,
  },
  {
    version: 2,
    name: 'command log',
    sql: `
      -- Every command line a student ran (requirements §14). Reported by the
      -- in-container bash hook, so it is advisory evidence, not tamper-proof.
      CREATE TABLE command_log (
        id          TEXT PRIMARY KEY,
        attempt_id  TEXT NOT NULL REFERENCES exam_attempts(id),
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        question_id TEXT,                    -- question open at the time
        seq         INTEGER NOT NULL,        -- order within the attempt
        command     TEXT NOT NULL,
        cwd         TEXT NOT NULL,
        exit_code   INTEGER,
        flags       TEXT NOT NULL DEFAULT '', -- e.g. 'logging-tamper'
        executed_at TEXT NOT NULL,           -- server clock
        UNIQUE (attempt_id, seq)
      );
    `,
  },
  {
    version: 3,
    name: 'question visits, filesystem snapshots',
    sql: `
      -- Each time a question becomes the open one; gives time spent per question.
      CREATE TABLE question_visits (
        attempt_id  TEXT NOT NULL REFERENCES exam_attempts(id),
        question_id TEXT NOT NULL,
        entered_at  TEXT NOT NULL
      );
      CREATE INDEX question_visits_attempt ON question_visits(attempt_id, entered_at);

      -- The student's files when the exam ended (the container is removed after).
      CREATE TABLE fs_snapshots (
        attempt_id TEXT NOT NULL REFERENCES exam_attempts(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        taken_at   TEXT NOT NULL,
        data       TEXT NOT NULL,            -- JSON FsSnapshotView
        PRIMARY KEY (attempt_id, session_id)
      );
    `,
  },
  {
    version: 4,
    name: 'student name and class',
    sql: `
      -- Self-reported on the start screen. student_id stays reserved for real accounts.
      ALTER TABLE exam_attempts ADD COLUMN student_name TEXT;
      ALTER TABLE exam_attempts ADD COLUMN class_name TEXT;
      CREATE INDEX exam_attempts_class ON exam_attempts(class_name);
    `,
  },
  {
    version: 5,
    name: 'exams and questions in the database',
    sql: `
      CREATE TABLE exams (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT,
        settings    TEXT NOT NULL,           -- JSON ExamSettings
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE exam_questions (
        id           TEXT PRIMARY KEY,       -- also referenced by submissions/command_log
        exam_id      TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        position     INTEGER NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('draft', 'approved')),
        source       TEXT NOT NULL CHECK (source IN ('sample', 'manual', 'ai')),
        content      TEXT NOT NULL,          -- JSON QuestionContent (includes the answers)
        verification TEXT NOT NULL,          -- JSON QuestionVerification
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX exam_questions_exam ON exam_questions(exam_id, position);

      CREATE TABLE app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- The exam exactly as the student got it (approved questions only), so
      -- later edits never change an exam in progress or its grading.
      ALTER TABLE exam_attempts ADD COLUMN exam_snapshot TEXT;
    `,
  },
  {
    version: 6,
    name: 'several exams can be open at once',
    sql: `
      -- Replaces the single "active exam": students choose among enabled exams.
      ALTER TABLE exams ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
      UPDATE exams SET enabled = 1
        WHERE id = (SELECT value FROM app_settings WHERE key = 'active_exam_id');
    `,
  },
  {
    version: 7,
    name: 'lock the test when the student leaves the screen',
    sql: `
      ALTER TABLE exam_attempts ADD COLUMN locked_at TEXT;      -- null = not locked
      ALTER TABLE exam_attempts ADD COLUMN lock_reason TEXT;

      -- Every time a student left the screen and every unlock, for the instructor.
      CREATE TABLE integrity_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id TEXT NOT NULL REFERENCES exam_attempts(id),
        type       TEXT NOT NULL CHECK (type IN ('left', 'unlocked')),
        reason     TEXT NOT NULL,
        at         TEXT NOT NULL
      );
      CREATE INDEX integrity_events_attempt ON integrity_events(attempt_id, at);
    `,
  },
];
