// Contracts shared by apps/web and apps/server.
// Anything that crosses the network boundary is defined here once, so the
// client and server can never drift apart. The server must still validate
// every incoming payload at runtime; these types are not a security boundary.

export * from './api.js';
export * from './exam.js';
export * from './instructor.js';
export * from './terminal.js';
