export { migrateComponent, formatCode } from './generate.js';
export { migrateProject, type ProjectResult } from './project.js';
export { analyzeViewModel } from './vm.js';
export { AnthropicProvider, AiNotConfiguredError, aiConfigured, getAiProvider, refineWithAi, type AiProvider } from './ai.js';
export type { MigrationInput, MigrationOutput, MigrationWarning, MigrateOptions, Severity } from './types.js';
