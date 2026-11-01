export type Severity = 'info' | 'warning' | 'error';

export interface MigrationWarning {
  severity: Severity;
  message: string;
  line?: number;
  /** True when a model could plausibly resolve this (custom logic, DI, mutation, converters). */
  needsAi?: boolean;
}

export interface MigrationInput {
  /** File base name without extension, e.g. "user-card". */
  name: string;
  html: string;
  code?: string;
  language?: 'ts' | 'js';
}

export interface MigrationOutput {
  componentName: string;
  fileName: string;
  tsx: string;
  warnings: MigrationWarning[];
  usedAi: boolean;
}

export interface MigrateOptions {
  /** Relative import prefix to the folder holding services.tsx / valueConverters.ts. Default ".". */
  rootRelative?: string;
  /** Map of kebab-case custom element tag -> import path (already resolved, PascalCase file). */
  requires?: Map<string, string>;
  ai?: import('./ai.js').AiProvider;
}
